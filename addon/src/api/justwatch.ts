// "Popular on Netflix / Prime / …" catalogs from JustWatch — no API key.
//
// JustWatch's public GraphQL endpoint (the one its website uses) returns
// popular titles per streaming service and country, with IMDb ids, so the
// rows are tt… items: Stremio shows its normal pages and Telemedia streams.
// Unlike TMDB's watch-provider data this follows the user's country (default
// IL) and returns localized names (Hebrew by default).

import { http } from './client';
import { config } from '../config';
import { makeCache, cached } from '../utils/cache';
import type { StremioMetaPreview } from '../types';

const API = 'https://apis.justwatch.com/graphql';
const PAGE = 50;
const MAX_ITEMS = 300;
const TTL_MS = 60 * 60 * 1000; // popularity changes slowly

const QUERY = `
query PopularTitles($country: Country!, $language: Language!, $first: Int!, $after: String, $filter: TitleFilter) {
  popularTitles(country: $country, first: $first, after: $after, filter: $filter) {
    pageInfo { endCursor hasNextPage }
    edges {
      node {
        content(country: $country, language: $language) {
          title
          originalReleaseYear
          externalIds { imdbId }
        }
      }
    }
  }
}`;

export interface JustWatchEdge {
  node: {
    content?: {
      title?: string;
      originalReleaseYear?: number;
      externalIds?: { imdbId?: string | null };
    };
  };
}

// Pure: JustWatch edges → Stremio previews (IMDb-linked titles only, deduped).
export function toPreviews(edges: JustWatchEdge[], type: 'movie' | 'series'): StremioMetaPreview[] {
  const seen = new Set<string>();
  const out: StremioMetaPreview[] = [];
  for (const e of edges) {
    const c = e.node.content;
    const imdbId = c?.externalIds?.imdbId;
    if (!c?.title || !imdbId || !/^tt\d+$/.test(imdbId) || seen.has(imdbId)) continue;
    seen.add(imdbId);
    out.push({
      id: imdbId,
      type,
      name: c.title,
      poster: `https://images.metahub.space/poster/medium/${imdbId}/img`,
      releaseInfo: c.originalReleaseYear ? String(c.originalReleaseYear) : undefined,
    });
  }
  return out;
}

interface PopularTitlesResponse {
  data?: {
    popularTitles?: {
      pageInfo?: { endCursor?: string | null; hasNextPage?: boolean };
      edges?: JustWatchEdge[];
    };
  };
  errors?: unknown;
}

const listCache = makeCache<StremioMetaPreview[]>(100, TTL_MS);

// Stremio pages via `skip`; JustWatch via cursors with at most ~100 per
// request. Fetch 50-item pages until the requested depth, cache per depth.
export async function popularOnProvider(
  pkg: string,
  type: 'movie' | 'series',
  skip = 0,
): Promise<StremioMetaPreview[]> {
  const want = Math.min(MAX_ITEMS, Math.ceil((skip + PAGE) / PAGE) * PAGE);
  const key = `${config.catalog.country}|${config.catalog.language}|${pkg}|${type}|${want}`;
  const all = await cached(listCache, key, async () => {
    const edges: JustWatchEdge[] = [];
    let after: string | null = null;
    // Some items lack an IMDb id; keep fetching until enough usable ones.
    while (toPreviews(edges, type).length < want) {
      const res: PopularTitlesResponse = await http.postJson<PopularTitlesResponse>(
        API,
        {
          query: QUERY,
          variables: {
            country: config.catalog.country,
            language: config.catalog.language,
            first: PAGE,
            after,
            filter: { packages: [pkg], objectTypes: [type === 'movie' ? 'MOVIE' : 'SHOW'] },
          },
        },
        { headers: { Accept: 'application/json' } },
      );
      if (res.errors) throw new Error(`JustWatch: ${JSON.stringify(res.errors).slice(0, 200)}`);
      const page = res.data?.popularTitles;
      edges.push(...(page?.edges ?? []));
      if (!page?.pageInfo?.hasNextPage || !page.pageInfo.endCursor) break;
      after = page.pageInfo.endCursor;
    }
    return toPreviews(edges, type);
  });
  return all.slice(skip, skip + PAGE);
}
