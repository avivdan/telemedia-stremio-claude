// Stream handler. Maps to default.py's play() / playTeleFile() — instead of
// kicking off a TDLib download and pointing Kodi at 127.0.0.1:<port>/<file_id>,
// we emit Stremio `stream` objects whose URLs target our in-process proxy
// (handlers/proxy.ts).
//
// Four id flavours accepted:
//   tg:<chatId>:<messageId>
//   tgchat:<chatId>:ep<messageId>  (rare — Stremio constructs this from series meta)
//   tmdb:<movie|series>:<id>       → search the user's dialogs for a matching file
//   tt<imdbid>                     → treat as TMDB series/movie title lookup

import * as tg from '../api/telegram';
import * as tmdb from '../api/tmdb';
import { decodeMsgId } from '../utils/ids';
import { extractMedia } from '../api/telegram';
import { mediaToStream } from '../mappers/streamMapper';
import type { StremioStream, TgMediaRef } from '../types';
import { log } from '../utils/logger';

export interface StreamArgs { type: string; id: string }

export async function streamHandler({ type, id }: StreamArgs) {
  log.info('stream', { type, id });
  if (id.startsWith('tg:')) return { streams: await tgStreams(id) };

  // tgchat:<chatId>:ep<messageId>  — Stremio sends the video id from meta.videos[]
  if (id.startsWith('tgchat:')) {
    const parts = id.split(':');
    if (parts.length >= 3) {
      const rebuilt = `tg:${parts[1]}:${parts[2].replace(/^ep/, '')}`;
      return { streams: await tgStreams(rebuilt) };
    }
  }

  if (id.startsWith('tmdb:')) return { streams: await tmdbStreams(id) };
  if (/^tt\d+/.test(id)) return { streams: await imdbStreams(id) };
  return { streams: [] };
}

async function imdbStreams(id: string): Promise<StremioStream[]> {
  try {
    // Stremio series stream ids look like "tt1234567:2:5" = season 2, episode 5.
    const [imdbId, seasonStr, episodeStr] = id.split(':');
    const season = seasonStr ? Number(seasonStr) : undefined;
    const episode = episodeStr ? Number(episodeStr) : undefined;

    const found = await tmdb.findByImdb(imdbId);
    if (!found?.title) {
      log.warn('imdbStreams: no TMDB match for', imdbId);
      return [];
    }
    const titles = await collectTitles(
      found.tmdbId,
      found.type === 'movie' ? 'movie' : 'tv',
      found.title,
    );
    log.info('imdbStreams', { id, titles, season, episode });
    return await searchByTitles(titles, season, episode);
  } catch (err) {
    log.warn('imdbStreams failed', id, (err as Error).message);
    return [];
  }
}

// Query TMDB /translations to get every localized title (English, Hebrew,
// original language, etc.). Falls back to just the primary title on error.
async function collectTitles(
  tmdbId: number,
  kind: 'movie' | 'tv',
  fallback: string,
): Promise<string[]> {
  try {
    const variants = await tmdb.tmdbTitles(tmdbId, kind);
    const all = new Set<string>([fallback, ...variants]);
    return [...all].filter((t) => t && t.trim().length > 0);
  } catch (err) {
    log.warn('tmdbTitles failed', tmdbId, (err as Error).message);
    return [fallback];
  }
}

// Build queries for every title variant × every episode-tag format, run each
// against Telegram, then filter. A file matches the episode only if its name
// contains BOTH the S/E tag AND one of the title variants — this blocks
// false positives like "The Boy Band S01E01" ≠ "The Boys".
async function searchByTitles(
  titles: string[],
  season: number | undefined,
  episode: number | undefined,
): Promise<StremioStream[]> {
  const hasHebrew = (s: string) => /[\u0590-\u05FF]/.test(s);
  const hasLatin = (s: string) => /[a-zA-Z]/.test(s);

  // Sort titles by script priority: Hebrew first (user's actual source
  // language), then Latin (English/Spanish/Portuguese/etc), then everything
  // else. This matters because MAX_QUERIES will cut off the tail, and most
  // users don't have Cyrillic/CJK/Arabic/Thai sources.
  const scriptScore = (t: string): number => {
    if (hasHebrew(t)) return 0;
    if (hasLatin(t)) return 1;
    return 2;
  };
  const sortedTitles = [...titles].sort(
    (a, b) => scriptScore(a) - scriptScore(b),
  );

  // Build a tier list per title. Hebrew titles get Hebrew-format tags as
  // tier-0 because Hebrew uploaders tag "ע4 פ2", not "S04E02". Latin titles
  // get SxxExx as tier-0.
  const queriesForTitle = (t: string): string[] => {
    if (season == null || episode == null) return [t];
    const list: string[] = [];
    if (hasHebrew(t)) {
      list.push(`${t} ע${season} פ${episode}`);
      list.push(`${t} עונה ${season} פרק ${episode}`);
    }
    list.push(`${t} S${pad(season)}E${pad(episode)}`);
    list.push(`${t} ${season}x${pad(episode)}`);
    list.push(t);
    return list;
  };
  const perTitle = sortedTitles.map(queriesForTitle);

  // Round-robin: tier-0 for every title first, then tier-1 for every
  // title, etc. So Hebrew's "ע4 פ2" runs before English's "4x02", and
  // both run before any language's bare-title fallback.
  const rawQueries: string[] = [];
  const maxDepth = perTitle.reduce((m, a) => Math.max(m, a.length), 0);
  for (let d = 0; d < maxDepth; d++) {
    for (const list of perTitle) {
      if (d < list.length) rawQueries.push(list[d]);
    }
  }

  // Dedupe (case/whitespace insensitive) so ALL-CAPS vs Capitalized vs
  // lowercased variants of the same title don't waste a SearchGlobal call.
  const seenQ = new Set<string>();
  const queries = rawQueries.filter((q) => {
    const k = q.trim().toLowerCase();
    if (!k || seenQ.has(k)) return false;
    seenQ.add(k);
    return true;
  });

  // Hard cap on SearchGlobal calls. FLOOD_WAIT hits fast on Telegram.
  const MAX_QUERIES = 12;
  // Stop after we have this many episode-tagged matches — Stremio only
  // displays a handful anyway, and Telegram's rate limits are brutal.
  const ENOUGH_EP_HITS = 5;

  const seen = new Set<string>();
  const preferred: StremioStream[] = [];
  const rest: StremioStream[] = [];
  let fired = 0;
  for (const q of queries) {
    if (fired >= MAX_QUERIES) {
      log.info(`searchByTitles: hit MAX_QUERIES=${MAX_QUERIES}, stopping`);
      break;
    }
    if (
      season != null &&
      episode != null &&
      preferred.length >= ENOUGH_EP_HITS
    ) {
      log.info(
        `searchByTitles: have ${preferred.length} episode-tagged, stopping early`,
      );
      break;
    }
    fired++;
    const msgs = await tg.globalSearchVideos(q, 40);
    log.info(`searchByTitles: query "${q}" -> ${msgs.length} messages`);
    for (const msg of msgs) {
      const media = extractMedia(msg as never);
      if (!media) {
        // Diagnose why: usually DocumentEmpty / media stripped because the
        // underlying channel isn't accessible to this account. We try a
        // direct refetch via channels.GetMessages — Telegram sometimes
        // populates the media on a direct call even when SearchGlobal
        // returned a stub.
        const anyMsg = msg as unknown as {
          id?: number;
          className?: string;
          media?: { className?: string; document?: { className?: string } };
          peerId?: {
            className?: string;
            channelId?: { toString(): string };
            chatId?: { toString(): string };
            userId?: { toString(): string };
          };
        };
        const peer =
          anyMsg.peerId?.channelId?.toString() ??
          anyMsg.peerId?.chatId?.toString() ??
          anyMsg.peerId?.userId?.toString() ??
          'none';

        // Attempt refetch. If the peer is inaccessible this will throw
        // and we'll give up.
        let refetched: TgMediaRef | null = null;
        if (anyMsg.peerId?.channelId && anyMsg.id) {
          try {
            const fresh = await tg.fetchMessage(
              `-100${anyMsg.peerId.channelId.toString()}`,
              anyMsg.id,
            );
            refetched = extractMedia(fresh);
          } catch (err) {
            log.info(
              `  [skip] id=${anyMsg.id} peer=${peer} refetch-failed: ${(err as Error).message}`,
            );
          }
        }
        if (!refetched) {
          log.info(
            `  [skip] id=${anyMsg.id} peer=${peer} ` +
              `msg=${anyMsg.className ?? '?'} ` +
              `media=${anyMsg.media?.className ?? 'none'} ` +
              `doc=${anyMsg.media?.document?.className ?? 'none'}`,
          );
          continue;
        }
        // Refetch succeeded — fall through with the fresh media.
        const key = `${refetched.chatId}:${refetched.messageId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const s = mediaToStream(refetched);
        const hasEp =
          season != null && episode != null
            ? matchesEpisode(refetched.fileName, season, episode) &&
              titles.some((t) => matchesTitle(refetched.fileName, t))
            : false;
        log.info(
          `  ${hasEp ? '[EP]' : '[  ]'} (refetched) ${refetched.fileName}`,
        );
        (hasEp ? preferred : rest).push(s);
        continue;
      }
      const key = `${media.chatId}:${media.messageId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const s = mediaToStream(media);
      const hasEp =
        season != null && episode != null
          ? matchesEpisode(media.fileName, season, episode) &&
            titles.some((t) => matchesTitle(media.fileName, t))
          : false;
      log.info(`  ${hasEp ? '[EP]' : '[  ]'} ${media.fileName}`);
      (hasEp ? preferred : rest).push(s);
    }
  }

  const streams = season != null && episode != null ? preferred : rest;
  log.info(
    `searchByTitles: produced ${streams.length} streams (${preferred.length} episode-tagged) across ${titles.length} title variants, ${fired} queries fired`,
  );
  return streams;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

// Normalize for substring matching: lowercase, collapse non-letter/digit runs
// to a single space. Unicode-aware so Hebrew/Arabic/CJK titles survive —
// `[^\p{L}\p{N}]+` keeps letters in any script. "The Boys" → "the boys";
// "השוטר_הטירון" → "השוטר הטירון"; "Dirty_Pop_The_Boy_Band" → "dirty pop the boy band".
function norm(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// True when the filename contains the show title as a distinct run of words,
// e.g. "the boys" must appear bounded by non-word chars — blocks false
// positives like "The Boy Band" matching "The Boys".
function matchesTitle(fileName: string, title: string): boolean {
  const fn = ` ${norm(fileName)} `;
  const t = norm(title);
  if (!t) return false;
  return fn.includes(` ${t} `);
}

// Accepts S01E02, s1e2, 1x02, 01x02, "Season 1 Episode 2", plus Hebrew
// "ע3 פ8" / "עונה 3 פרק 8" (ע = עונה = season, פ = פרק = episode).
// We can't use \b because underscores are \w in JS regex — filenames like
// "Invincible_S01E05_..." would fail the boundary. Use explicit non-digit
// lookahead and a non-digit lookbehind.
function matchesEpisode(fileName: string, season: number, episode: number): boolean {
  const s = fileName.toLowerCase();
  const patterns = [
    new RegExp(`s0*${season}[._\\s-]?e0*${episode}(?![0-9])`, 'i'),
    new RegExp(`(?<![0-9])0*${season}x0*${episode}(?![0-9])`, 'i'),
    new RegExp(`season[^a-z0-9]*0*${season}[^a-z0-9]+episode[^a-z0-9]*0*${episode}(?![0-9])`, 'i'),
    // Hebrew short form: ע3 פ8 / ע.3 פ.8 / ע 3 פ 8
    new RegExp(`ע[\\s._-]*0*${season}[^\\p{L}\\p{N}]+פ[\\s._-]*0*${episode}(?![0-9])`, 'iu'),
    // Hebrew long form: עונה 3 פרק 8
    new RegExp(`עונה[^\\p{L}\\p{N}]*0*${season}[^\\p{L}\\p{N}]+פרק[^\\p{L}\\p{N}]*0*${episode}(?![0-9])`, 'iu'),
  ];
  return patterns.some((p) => p.test(s));
}

async function tgStreams(id: string): Promise<StremioStream[]> {
  try {
    const { chatId, messageId } = decodeMsgId(id);
    const msg = await tg.fetchMessage(chatId, messageId);
    const media = extractMedia(msg);
    if (!media) return [];
    return [mediaToStream(media)];
  } catch (err) {
    log.warn('tgStreams failed', id, (err as Error).message);
    return [];
  }
}

// Given a TMDB id, pull title + year, then globalSearchVideos() for it.
// Handles both `tmdb:movie:<id>` and `tmdb:series:<id>[:<season>:<episode>]`.
async function tmdbStreams(id: string): Promise<StremioStream[]> {
  const parts = id.split(':');
  const kind = parts[1];
  const tmdbId = Number(parts[2]);
  const season = parts[3] ? Number(parts[3]) : undefined;
  const episode = parts[4] ? Number(parts[4]) : undefined;

  const meta = await tmdb.tmdbMeta(tmdbId, kind === 'movie' ? 'movie' : 'tv');
  const primary = meta.title ?? meta.name;
  if (!primary) {
    log.warn('tmdbStreams: no title for', id);
    return [];
  }
  const titles = await collectTitles(tmdbId, kind === 'movie' ? 'movie' : 'tv', primary);
  log.info('tmdbStreams', { id, titles, season, episode });
  return await searchByTitles(titles, season, episode);
}
