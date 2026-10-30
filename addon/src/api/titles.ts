// Keyless title lookup for stream search.
//
//   Cinemeta (Stremio's own metadata service) → English title, year
//   Wikidata (by IMDb id, SPARQL)             → Hebrew + English labels and aliases
//   TMDB (only if TMDB_API_KEY is set)        → extra translations/alternative titles
//
// Sources are queried in parallel; any of them may fail without breaking the
// lookup. Results are cached for 24h — titles rarely change, while Stremio
// re-requests streams every time an episode page opens.

import { http } from './client';
import * as tmdb from './tmdb';
import { config } from '../config';
import { makeCache, cached } from '../utils/cache';
import { log } from '../utils/logger';
import { mergeTitleSources, parseYear, type TitleInfo } from '../search/matching';

const CINEMETA = 'https://v3-cinemeta.strem.io';
const WIKIDATA_SPARQL = 'https://query.wikidata.org/sparql';
// Wikimedia requires a descriptive User-Agent with contact info.
const WIKIDATA_UA = 'Telemedia-Stremio-Addon/0.1 (https://github.com/avivdan/telemedia-stremio-claude)';

const TTL_MS = 24 * 60 * 60 * 1000;
const cache = makeCache<TitleInfo>(1000, TTL_MS);

export function titleInfoForImdb(type: 'movie' | 'series', imdbId: string): Promise<TitleInfo> {
  return cached(cache, `${type}:${imdbId}`, async () => {
    const results = await Promise.allSettled([
      fromCinemeta(type, imdbId),
      fromWikidata(imdbId),
      fromTmdb(imdbId),
    ]);
    const names = ['cinemeta', 'wikidata', 'tmdb'];
    results.forEach((r, i) => {
      if (r.status === 'rejected') log.warn(`titles: ${names[i]} failed for ${imdbId}:`, (r.reason as Error).message);
    });
    const info = mergeTitleSources(results.map((r) => (r.status === 'fulfilled' ? r.value : null)));
    // Throwing keeps an all-sources-down result out of the cache.
    if (info.titles.length === 0 && info.altTitles.length === 0) {
      throw new Error(`no titles found for ${imdbId}`);
    }
    return info;
  });
}

async function fromCinemeta(type: 'movie' | 'series', imdbId: string): Promise<Partial<TitleInfo>> {
  const { meta } = await http.getJson<{ meta?: { name?: string; year?: string; releaseInfo?: string } }>(
    `${CINEMETA}/meta/${type}/${imdbId}.json`,
    { headers: { Accept: 'application/json' } },
  );
  return { titles: [meta?.name ?? ''], year: parseYear(meta?.year ?? meta?.releaseInfo) };
}

interface SparqlRow {
  label: { value: string };
  lang: { value: string };
  kind: { value: 'label' | 'alias' };
  year?: { value: string };
}

async function fromWikidata(imdbId: string): Promise<Partial<TitleInfo>> {
  if (!/^tt\d+$/.test(imdbId)) return {};
  // P345 = IMDb ID, P577 = publication date. Labels are official names,
  // altLabels the aliases.
  const query = `
    SELECT ?label ?lang ?kind (YEAR(MIN(?date)) AS ?year) WHERE {
      ?item wdt:P345 "${imdbId}" .
      OPTIONAL { ?item wdt:P577 ?date }
      { ?item rdfs:label ?label . BIND("label" AS ?kind) }
      UNION { ?item skos:altLabel ?label . BIND("alias" AS ?kind) }
      FILTER(LANG(?label) IN ("he", "en"))
      BIND(LANG(?label) AS ?lang)
    } GROUP BY ?label ?lang ?kind`;
  const data = await http.getJson<{ results: { bindings: SparqlRow[] } }>(
    `${WIKIDATA_SPARQL}?format=json&query=${encodeURIComponent(query)}`,
    { headers: { 'User-Agent': WIKIDATA_UA, Accept: 'application/sparql-results+json' } },
  );
  const rows = data.results.bindings;
  // Hebrew first: it's what the user's channels mostly use.
  const pick = (kind: string) =>
    ['he', 'en'].flatMap((lang) =>
      rows.filter((r) => r.kind.value === kind && r.lang.value === lang).map((r) => r.label.value),
    );
  const year = rows.map((r) => Number(r.year?.value)).find((y) => y > 0);
  return { titles: pick('label'), altTitles: pick('alias'), year };
}

async function fromTmdb(imdbId: string): Promise<Partial<TitleInfo> | null> {
  if (!config.tmdb.enabled) return null;
  const found = await tmdb.findByImdb(imdbId);
  if (!found) return null;
  return tmdb.tmdbTitleInfo(found.tmdbId, found.type === 'movie' ? 'movie' : 'tv');
}
