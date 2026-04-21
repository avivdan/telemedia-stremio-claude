// TMDB helpers — mirrors resources/modules/tmdb.py + the TMDB URLs scattered
// around default.py (movies_menu / tv_show_menu / search_movies / search_tv).
//
// We only use TMDB for catalog/meta shaping. Streams always come from Telegram.

import { http } from './client';
import { config } from '../config';
import type { StremioMetaPreview } from '../types';

const BASE = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p';

function url(path: string, params: Record<string, string | number> = {}) {
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

export async function popularMovies(page = 1): Promise<StremioMetaPreview[]> {
  const data = await http.getJson<TmdbList>(url('/movie/popular', { page }));
  return withImdbIds(data.results, 'movie');
}

export async function popularTv(page = 1): Promise<StremioMetaPreview[]> {
  const data = await http.getJson<TmdbList>(url('/tv/popular', { page }));
  return withImdbIds(data.results, 'series');
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

export async function searchTmdb(
  query: string,
  type: 'movie' | 'tv',
): Promise<StremioMetaPreview[]> {
  const data = await http.getJson<TmdbList>(
    url(`/search/${type}`, { query, page: 1 }),
  );
  return withImdbIds(data.results, type === 'movie' ? 'movie' : 'series');
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

interface TmdbTranslationsResponse {
  translations?: {
    iso_639_1?: string;
    iso_3166_1?: string;
    data?: { title?: string; name?: string };
  }[];
}

// Return every distinct title TMDB knows for the item, across languages.
// Used so we can search Telegram in Hebrew / original language / English
// when the user has Hebrew-sourced channels.
export async function tmdbTitles(id: number, type: 'movie' | 'tv'): Promise<string[]> {
  const data = await http.getJson<TmdbTranslationsResponse>(
    url(`/${type}/${id}/translations`),
  );
  const names = new Set<string>();
  // Only English + Hebrew. User's channels source those.
  const allowed = new Set(['en', 'he', 'iw']);
  for (const tr of data.translations ?? []) {
    if (!tr.iso_639_1 || !allowed.has(tr.iso_639_1)) continue;
    const n = tr.data?.title || tr.data?.name;
    if (n && n.trim()) names.add(n.trim());
  }
  return [...names];
}

// Resolve an IMDB id (tt1234567) → { type, title, tmdbId } via TMDB's /find endpoint.
// Used by the stream handler when Stremio asks for streams using a Cinemeta id.
// tmdbId is returned so callers can fetch language translations (tmdbTitles).
export async function findByImdb(
  imdbId: string,
): Promise<{ type: 'movie' | 'series'; title: string; tmdbId: number } | null> {
  const data = await http.getJson<{
    movie_results: TmdbItem[];
    tv_results: TmdbItem[];
  }>(url(`/find/${imdbId}`, { external_source: 'imdb_id' }));
  const m = data.movie_results?.[0];
  if (m) return { type: 'movie', title: m.title ?? m.name ?? '', tmdbId: m.id };
  const t = data.tv_results?.[0];
  if (t) return { type: 'series', title: t.name ?? t.title ?? '', tmdbId: t.id };
  return null;
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
