// Hebrew title search for Stremio's search box, without API keys.
//
// Stremio's built-in search (Cinemeta) only knows English names, so "פאודה"
// finds nothing. Wikidata has Hebrew labels plus the IMDb id (P345) for most
// films and series, so: Hebrew text → Wikidata items → IMDb ids. Results are
// `tt…` items, so Stremio shows its normal page and Telemedia streams.

import { http } from './client';
import { makeCache } from '../utils/cache';

const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';
// Wikimedia requires a descriptive User-Agent with contact info.
const UA = 'Telemedia-Stremio-Addon/0.1 (https://github.com/avivdan/telemedia-stremio-claude)';

export interface HebrewSearchHit {
  imdbId: string;
  type: 'movie' | 'series';
  name: string;     // Hebrew label (English if missing)
  enName?: string;
  year?: number;
}

// Wikidata "instance of" (P31) classes.
const SERIES_CLASSES = new Set([
  'Q5398426',  // television series
  'Q1259759',  // miniseries
  'Q581714',   // animated television series
  'Q526877',   // web series
  'Q15416',    // television program
  'Q117467246', // animated television series (newer item)
]);
const FILM_CLASSES = new Set([
  'Q11424',    // film
  'Q24869',    // feature film
  'Q506240',   // television film
  'Q202866',   // animated film
  'Q229390',   // 3D film
  'Q93204',    // documentary film
]);
// Not something to watch as a whole: an episode/season, or a video game
// (games have IMDb ids too, e.g. "Dune 2000").
const SKIP_CLASSES = new Set(['Q21191270', 'Q3464665', 'Q7889']);

interface Snak { mainsnak?: { datavalue?: { value?: unknown } } }
export interface WikidataEntity {
  labels?: Record<string, { value: string }>;
  claims?: Record<string, Snak[]>;
}

const claimValues = (e: WikidataEntity, prop: string) =>
  (e.claims?.[prop] ?? []).map((c) => c.mainsnak?.datavalue?.value).filter((v) => v != null);

// Pure: Wikidata entities (in search-relevance order) → hits with IMDb ids.
export function toSearchHits(ids: string[], entities: Record<string, WikidataEntity>): HebrewSearchHit[] {
  const hits: HebrewSearchHit[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const e = entities[id];
    if (!e) continue;
    const imdbId = claimValues(e, 'P345').find((v): v is string => typeof v === 'string' && /^tt\d+$/.test(v));
    if (!imdbId || seen.has(imdbId)) continue;
    const classes = new Set(
      claimValues(e, 'P31').map((v) => (v as { id?: string }).id).filter((v): v is string => !!v),
    );
    if ([...classes].some((c) => SKIP_CLASSES.has(c))) continue;
    // Episode/season counts mark a series even when its class isn't listed.
    const series =
      [...classes].some((c) => SERIES_CLASSES.has(c)) ||
      (!([...classes].some((c) => FILM_CLASSES.has(c))) &&
        (claimValues(e, 'P1113').length > 0 || claimValues(e, 'P2437').length > 0));
    const years = claimValues(e, 'P577')
      .map((v) => Number(/^[+-]?(\d{4})/.exec((v as { time?: string }).time ?? '')?.[1]))
      .filter((y) => y > 0);
    const he = e.labels?.he?.value;
    const en = e.labels?.en?.value;
    if (!he && !en) continue;
    seen.add(imdbId);
    hits.push({
      imdbId,
      type: series ? 'series' : 'movie',
      name: he ?? en!,
      enName: en,
      year: years.length ? Math.min(...years) : undefined,
    });
  }
  return hits;
}

// Stremio asks the movie and series catalogs in parallel with the same query —
// cache the in-flight promise so Wikidata gets one lookup per query.
const cache = makeCache<Promise<HebrewSearchHit[]>>(500, 60 * 60 * 1000);

export function hebrewSearch(query: string): Promise<HebrewSearchHit[]> {
  const key = query.trim().toLowerCase();
  const hit = cache.get(key);
  if (hit) return hit;
  const p = lookup(query.trim());
  p.catch(() => cache.delete(key));
  cache.set(key, p);
  return p;
}

async function lookup(query: string): Promise<HebrewSearchHit[]> {
  const headers = { 'User-Agent': UA, Accept: 'application/json' };
  const search = await http.getJson<{ search?: { id: string }[] }>(
    `${WIKIDATA_API}?action=wbsearchentities&search=${encodeURIComponent(query)}` +
      '&language=he&uselang=he&type=item&limit=20&format=json',
    { headers },
  );
  const ids = (search.search ?? []).map((r) => r.id);
  if (ids.length === 0) return [];
  const data = await http.getJson<{ entities?: Record<string, WikidataEntity> }>(
    `${WIKIDATA_API}?action=wbgetentities&ids=${ids.join('|')}` +
      '&props=claims|labels&languages=he|en&format=json',
    { headers },
  );
  return toSearchHits(ids, data.entities ?? {});
}
