// TMDB helpers — mirrors resources/modules/tmdb.py + the TMDB URLs scattered
// around default.py (movies_menu / tv_show_menu / search_movies / search_tv).
//
// Optional: only used when TMDB_API_KEY is set (streaming-provider catalogs,
// tmdb: ids, extra search titles). Streams always come from Telegram.

import { http } from './client';
import { config } from '../config';
import { makeCache, cached } from '../utils/cache';
import type { TitleInfo } from '../search/matching';
import type { StremioMetaPreview } from '../types';

const BASE = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p';

function url(path: string, params: Record<string, string | number> = {}) {
  if (!config.tmdb.enabled) throw new Error('TMDB is disabled (TMDB_API_KEY not set)');
  const qs = new URLSearchParams({
    api_key: config.tmdb.apiKey,
    language: config.tmdb.language,
    ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
  });
  return `${BASE}${path}?${qs.toString()}`;
}

interface TmdbItem {
  id: number;
  title?: string;
  name?: string;
  poster_path?: string;
  backdrop_path?: string;
  overview?: string;
  release_date?: string;
  first_air_date?: string;
  vote_average?: number;
  genre_ids?: number[];
}

interface TmdbList {
  results: TmdbItem[];
}

// TMDB `/discover` filtered by watch-provider. Region governs availability.
export async function discoverByProvider(
  kind: 'movie' | 'tv',
  providerId: number,
  page = 1,
  region = 'US',
): Promise<StremioMetaPreview[]> {
  const data = await http.getJson<TmdbList>(
    url(`/discover/${kind}`, {
      page,
      with_watch_providers: providerId,
      watch_region: region,
      sort_by: 'popularity.desc',
    }),
  );
  return withImdbIds(data.results, kind === 'movie' ? 'movie' : 'series');
}

// Resolve imdb_id for each TMDB result in parallel so our catalog previews use
// tt* ids — this lets Cinemeta own the meta (including the full episode list
// for series) and we only provide streams. Items without an IMDB match keep
// the tmdb: id as a fallback.
async function withImdbIds(
  items: TmdbItem[],
  type: 'movie' | 'series',
): Promise<StremioMetaPreview[]> {
  const kind = type === 'movie' ? 'movie' : 'tv';
  const resolved = await Promise.all(
    items.map(async (r) => {
      try {
        const ids = await http.getJson<{ imdb_id?: string }>(
          url(`/${kind}/${r.id}/external_ids`),
        );
        return { r, imdb: ids.imdb_id };
      } catch {
        return { r, imdb: undefined };
      }
    }),
  );
  return resolved.map(({ r, imdb }) => {
    const p = toPreview(r, type);
    if (imdb) p.id = imdb; // use IMDB id so Cinemeta handles meta
    return p;
  });
}

interface TmdbSeason {
  season_number: number;
  episode_count: number;
  name?: string;
  air_date?: string;
}

export async function tmdbMeta(id: number, type: 'movie' | 'tv') {
  return http.getJson<
    TmdbItem & {
      imdb_id?: string;
      external_ids?: { imdb_id?: string };
      seasons?: TmdbSeason[];
    }
  >(url(`/${type}/${id}`, { append_to_response: 'external_ids' }));
}

interface TmdbEpisode {
  episode_number: number;
  season_number: number;
  name?: string;
  overview?: string;
  still_path?: string;
  air_date?: string;
}

export async function tmdbSeason(seriesId: number, seasonNumber: number) {
  return http.getJson<{ episodes?: TmdbEpisode[] }>(
    url(`/tv/${seriesId}/season/${seasonNumber}`),
  );
}

interface TmdbTitleDetails {
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  release_date?: string;
  first_air_date?: string;
  translations?: {
    translations?: {
      iso_639_1?: string;
      data?: { title?: string; name?: string };
    }[];
  };
  alternative_titles?: {
    titles?: { iso_3166_1?: string; title?: string }[];  // movies
    results?: { iso_3166_1?: string; title?: string }[]; // tv
  };
}

// Titles change rarely; stream lookups repeat constantly.
const TITLE_TTL_MS = 24 * 60 * 60 * 1000;
const titleInfoCache = makeCache<TitleInfo>(500, TITLE_TTL_MS);
const findCache = makeCache<{ type: 'movie' | 'series'; tmdbId: number }>(1000, TITLE_TTL_MS);

const TITLE_LANGS = new Set(['en', 'he', 'iw']); // user's channels source these
const ALT_TITLE_COUNTRIES = ['IL', 'US', 'GB'];   // order = priority

// Everything TMDB knows for searching Telegram, in one call: official titles
// (localized, original, en/he translations) plus alternative titles for
// IL/US/GB. Optional extra source — see api/titles.ts.
export function tmdbTitleInfo(id: number, type: 'movie' | 'tv'): Promise<TitleInfo> {
  return cached(titleInfoCache, `${type}:${id}`, async () => {
    const d = await http.getJson<TmdbTitleDetails>(
      url(`/${type}/${id}`, { append_to_response: 'translations,alternative_titles' }),
    );
    const titles = [d.title ?? d.name, d.original_title ?? d.original_name];
    for (const tr of d.translations?.translations ?? []) {
      if (tr.iso_639_1 && TITLE_LANGS.has(tr.iso_639_1)) titles.push(tr.data?.title || tr.data?.name);
    }
    const alts = d.alternative_titles?.titles ?? d.alternative_titles?.results ?? [];
    const altTitles = ALT_TITLE_COUNTRIES.flatMap((c) =>
      alts.filter((a) => a.iso_3166_1 === c).map((a) => a.title),
    );
    const clean = (list: (string | undefined)[]) =>
      [...new Set(list.map((t) => t?.trim()).filter((t): t is string => !!t))];
    const year = Number((d.release_date || d.first_air_date || '').slice(0, 4));
    return { titles: clean(titles), altTitles: clean(altTitles), year: year || undefined };
  });
}

// Resolve an IMDB id (tt1234567) → { type, tmdbId } via TMDB's /find endpoint.
// Used by the stream handler when Stremio asks for streams using a Cinemeta id.
export async function findByImdb(
  imdbId: string,
): Promise<{ type: 'movie' | 'series'; tmdbId: number } | null> {
  const hit = findCache.get(imdbId);
  if (hit) return hit;
  const data = await http.getJson<{
    movie_results: TmdbItem[];
    tv_results: TmdbItem[];
  }>(url(`/find/${imdbId}`, { external_source: 'imdb_id' }));
  const m = data.movie_results?.[0];
  const t = data.tv_results?.[0];
  const found = m
    ? { type: 'movie' as const, tmdbId: m.id }
    : t
      ? { type: 'series' as const, tmdbId: t.id }
      : null;
  if (found) findCache.set(imdbId, found);
  return found;
}

function toPreview(
  r: TmdbItem,
  type: 'movie' | 'series',
): StremioMetaPreview {
  return {
    id: `tmdb:${type}:${r.id}`,
    type,
    name: r.title ?? r.name ?? 'Untitled',
    poster: r.poster_path ? `${IMG}/w500${r.poster_path}` : undefined,
    background: r.backdrop_path ? `${IMG}/w1280${r.backdrop_path}` : undefined,
    description: r.overview,
    releaseInfo: (r.release_date ?? r.first_air_date ?? '').slice(0, 4),
    imdbRating: r.vote_average ? r.vote_average.toFixed(1) : undefined,
  };
}
