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

import { Api } from 'telegram';
import * as tg from '../api/telegram';
import * as tmdb from '../api/tmdb';
import { titleInfoForImdb } from '../api/titles';
import { config } from '../config';
import { decodeMsgId } from '../utils/ids';
import { extractMedia } from '../api/telegram';
import { mediaToStream } from '../mappers/streamMapper';
import {
  buildQueries,
  classify,
  dedupeStreams,
  hasHebrew,
  hasLatin,
  norm,
  rankStreams,
  type TitleInfo,
} from '../search/matching';
import { makeCache } from '../utils/cache';
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
  if (/^tt\d+/.test(id)) return { streams: await imdbStreams(type, id) };
  return { streams: [] };
}

// Cinemeta ids: "tt1234567" (movie) or "tt1234567:2:5" (series S2E5).
// Titles come from the keyless lookup in api/titles.ts.
async function imdbStreams(type: string, id: string): Promise<StremioStream[]> {
  try {
    const [imdbId, seasonStr, episodeStr] = id.split(':');
    const season = seasonStr ? Number(seasonStr) : undefined;
    const episode = episodeStr ? Number(episodeStr) : undefined;
    const kind = type === 'series' || season != null ? 'series' : 'movie';

    const info = await titleInfoForImdb(kind, imdbId);
    log.info('imdbStreams', { id, ...info, season, episode });
    return await searchByTitles(info, season, episode);
  } catch (err) {
    log.warn('imdbStreams failed', id, (err as Error).message);
    return [];
  }
}

// Handles both `tmdb:movie:<id>` and `tmdb:series:<id>[:<season>:<episode>]`.
// These ids only come from the TMDB provider catalogs (TMDB key set).
async function tmdbStreams(id: string): Promise<StremioStream[]> {
  if (!config.tmdb.enabled) return [];
  try {
    const parts = id.split(':');
    const kind = parts[1] === 'movie' ? 'movie' : 'tv';
    const tmdbId = Number(parts[2]);
    const season = parts[3] ? Number(parts[3]) : undefined;
    const episode = parts[4] ? Number(parts[4]) : undefined;

    const info = await tmdb.tmdbTitleInfo(tmdbId, kind);
    log.info('tmdbStreams', { id, ...info, season, episode });
    return await searchByTitles(info, season, episode);
  } catch (err) {
    log.warn('tmdbStreams failed', id, (err as Error).message);
    return [];
  }
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

// ---------------------------------------------------------------------------
// Title search
// ---------------------------------------------------------------------------

// Hard cap on SearchGlobal queries per request (each costs two API calls —
// video + document filters). FLOOD_WAIT hits fast on Telegram.
const MAX_QUERIES = 12;
// Stop once we have this many best matches — Stremio only shows a handful.
const ENOUGH_BEST_HITS = 5;
// Alternative titles add recall but each costs queries.
const MAX_ALT_TITLES = 3;

// Keep only Hebrew/Latin titles (the user's channels), dedupe by normalized
// form, and drop alt titles that duplicate an official one or are too short
// to match safely.
function searchTitles(info: TitleInfo): { main: string[]; alt: string[] } {
  const keepScript = (t: string) => hasHebrew(t) || hasLatin(t);
  const uniq = (list: string[], seen: Set<string>) =>
    list.filter((t) => {
      const k = norm(t);
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  const seen = new Set<string>();
  const main = uniq(info.titles.filter(keepScript), seen);
  const alt = uniq(info.altTitles.filter(keepScript), seen)
    .filter((t) => norm(t).length >= 3)
    .slice(0, MAX_ALT_TITLES);
  return { main, alt };
}

async function searchByTitles(
  info: TitleInfo,
  season: number | undefined,
  episode: number | undefined,
): Promise<StremioStream[]> {
  const { main, alt } = searchTitles(info);
  const titles = [...main, ...alt];
  const year = season == null ? info.year : undefined; // year only matters for movies
  const queries = buildQueries(main, alt, season, episode, year);

  const best: StremioStream[] = [];
  const ok: StremioStream[] = [];
  const seen = new Set<string>();
  let fired = 0;

  for (const q of queries) {
    if (fired >= MAX_QUERIES || best.length >= ENOUGH_BEST_HITS) break;
    fired++;
    const msgs = await tg.globalSearchVideos(q, 40);
    let unavailable = 0;
    let kept = 0;
    for (const msg of msgs) {
      const resolved = await resolveMedia(msg);
      if (!resolved) {
        unavailable++;
        continue;
      }
      const { media, caption } = resolved;
      const key = `${media.chatId}:${media.messageId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const bucket = classify(`${media.fileName} ${caption}`, titles, season, episode, year);
      if (!bucket) continue;
      kept++;
      log.info(`  [${bucket}] ${media.fileName}`);
      (bucket === 'best' ? best : ok).push(mediaToStream(media));
    }
    log.info(
      `searchByTitles: "${q}" -> ${msgs.length} messages, ${kept} kept` +
        (unavailable ? `, ${unavailable} unavailable` : ''),
    );
  }

  const streams = dedupeStreams([...rankStreams(best), ...rankStreams(ok)]);
  log.info(
    `searchByTitles: ${streams.length} streams (${best.length} best, ${ok.length} ok before dedupe), ` +
      `${titles.length} titles, ${fired}/${queries.length} queries`,
  );
  return streams;
}

// ---------------------------------------------------------------------------
// Media resolution with a negative cache.
//
// SearchGlobal returns some messages without media: copyright-stripped
// ("This message couldn't be displayed on your device due to copyright…") or
// from channels we can't read. A direct channels.GetMessages occasionally
// recovers the media, so we try once — then remember failures, and stop
// trying a channel altogether after a few, so repeated lookups (Stremio
// re-requests streams every time an episode page opens) don't spend dozens of
// serial API calls on known-dead messages.
// ---------------------------------------------------------------------------
const DEAD_TTL_MS = 6 * 60 * 60 * 1000;
const PEER_BLOCK_AFTER = 3;
const deadMessages = makeCache<true>(5000, DEAD_TTL_MS);
const deadCountPerPeer = makeCache<number>(1000, DEAD_TTL_MS);

async function resolveMedia(
  msg: Api.Message,
): Promise<{ media: TgMediaRef; caption: string } | null> {
  const media = extractMedia(msg);
  if (media) return { media, caption: msg.message ?? '' };

  const peer = msg.peerId;
  if (!(peer instanceof Api.PeerChannel) || !msg.id) return null;
  const channel = peer.channelId.toString();
  const key = `${channel}:${msg.id}`;
  if (deadMessages.get(key) || (deadCountPerPeer.get(channel) ?? 0) >= PEER_BLOCK_AFTER) {
    return null;
  }

  try {
    const fresh = await tg.fetchMessage(`-100${channel}`, msg.id, true);
    const freshMedia = extractMedia(fresh);
    if (freshMedia) return { media: freshMedia, caption: fresh.message ?? '' };
  } catch {
    // inaccessible — treated as dead below
  }
  deadMessages.set(key, true);
  const count = (deadCountPerPeer.get(channel) ?? 0) + 1;
  deadCountPerPeer.set(channel, count);
  if (count === PEER_BLOCK_AFTER) {
    log.info(`resolveMedia: channel ${channel} returns no media (copyright/inaccessible), skipping it for 6h`);
  }
  return null;
}
