// Meta handler.
//
// Five id flavours:
//   tg:<chatId>:<messageId>    → one Telegram video (movie)
//   tgchat:<chatId>            → catalog of recent videos in chat (series)
//   tmdb:movie:<id>            → TMDB movie, streams resolved via Telegram search
//   tmdb:series:<id>           → TMDB series (same story, one season grouping)
//   tt<imdbid>                 → standard IMDB id (Cinemeta compat, optional)

import * as tg from '../api/telegram';
import * as tmdb from '../api/tmdb';
import { decodeMsgId, decodeChatId } from '../utils/ids';
import { chatToSeriesMeta, messageToMovieMeta } from '../mappers/metaMapper';
import type { StremioMeta } from '../types';
import { config } from '../config';
import { NotFoundError } from '../utils/errors';

export interface MetaArgs { type: string; id: string }

export async function metaHandler({ type, id }: MetaArgs): Promise<{ meta: StremioMeta }> {
  if (id.startsWith('tg:')) return { meta: await metaForTgMessage(id) };
  if (id.startsWith('tgchat:')) return { meta: await metaForTgChat(id) };
  if (id.startsWith('tmdb:')) return { meta: await metaForTmdb(id) };
  // For IMDB (tt...) ids Cinemeta owns meta — return a minimal stub so the SDK
  // doesn't emit a 404 that spooks Stremio into ignoring our streams.
  return {
    meta: {
      id,
      type: (type === 'series' ? 'series' : 'movie') as StremioMeta['type'],
      name: '',
    },
  };
}

async function metaForTgMessage(id: string): Promise<StremioMeta> {
  const { chatId, messageId } = decodeMsgId(id);
  const msg = await tg.fetchMessage(chatId, messageId);
  const meta = messageToMovieMeta(msg);
  if (!meta) throw new NotFoundError(`No media in ${id}`);
  return meta;
}

async function metaForTgChat(id: string): Promise<StremioMeta> {
  const chatId = decodeChatId(id);
  const { messages } = await tg.searchChatVideos(chatId, '', 50);
  return chatToSeriesMeta(chatId, 'Telegram chat', messages);
}

// For TMDB-origin ids we surface TMDB metadata but we don't embed Telegram
// videos here — those are discovered at stream-time by title search. That
// mirrors default.py's search_movies() flow (mode==15).
async function metaForTmdb(id: string): Promise<StremioMeta> {
  const [, kind, tmdbIdStr] = id.split(':');
  const tmdbId = Number(tmdbIdStr);
  const data = await tmdb.tmdbMeta(tmdbId, kind === 'movie' ? 'movie' : 'tv');
  const base: StremioMeta = {
    id,
    type: kind === 'movie' ? 'movie' : 'series',
    name: data.title ?? data.name ?? 'Untitled',
    poster: data.poster_path
      ? `https://image.tmdb.org/t/p/w500${data.poster_path}`
      : undefined,
    background: data.backdrop_path
      ? `https://image.tmdb.org/t/p/w1280${data.backdrop_path}`
      : undefined,
    description: data.overview,
    releaseInfo: (data.release_date ?? data.first_air_date ?? '').slice(0, 4),
    imdbRating: data.vote_average ? data.vote_average.toFixed(1) : undefined,
  };

  // For series, expand the videos[] so Stremio shows the episode picker.
  // We fetch every season in parallel; each stream id encodes season+episode.
  if (kind === 'series' && data.seasons?.length) {
    const seasons = data.seasons.filter((s) => s.season_number > 0); // drop "Season 0" specials
    const seasonData = await Promise.all(
      seasons.map((s) =>
        tmdb.tmdbSeason(tmdbId, s.season_number).catch(() => ({ episodes: [] })),
      ),
    );
    const videos = [];
    for (const sd of seasonData) {
      for (const ep of sd.episodes ?? []) {
        videos.push({
          id: `${id}:${ep.season_number}:${ep.episode_number}`,
          title: ep.name || `Episode ${ep.episode_number}`,
          season: ep.season_number,
          episode: ep.episode_number,
          released: ep.air_date,
          overview: ep.overview,
          thumbnail: ep.still_path
            ? `https://image.tmdb.org/t/p/w300${ep.still_path}`
            : undefined,
        });
      }
    }
    base.videos = videos;
  }

  void config;
  return base;
}
