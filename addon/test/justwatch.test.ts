// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toPreviews, type JustWatchEdge } from '../src/api/justwatch';

const edge = (title: string, imdbId: string | null, year?: number): JustWatchEdge => ({
  node: { content: { title, originalReleaseYear: year, externalIds: { imdbId } } },
});

test('toPreviews: IMDb-linked titles only, deduped, with posters', () => {
  const out = toPreviews(
    [
      edge('שתיקת הכבשים', 'tt0102926', 1991),
      edge('No IMDb id', null),
      edge('Bad id', 'abc'),
      edge('שתיקת הכבשים (repeat)', 'tt0102926', 1991),
      edge('משחקי הכס', 'tt0944947'),
    ],
    'movie',
  );
  assert.deepEqual(out, [
    {
      id: 'tt0102926',
      type: 'movie',
      name: 'שתיקת הכבשים',
      poster: 'https://images.metahub.space/poster/medium/tt0102926/img',
      releaseInfo: '1991',
    },
    {
      id: 'tt0944947',
      type: 'movie',
      name: 'משחקי הכס',
      poster: 'https://images.metahub.space/poster/medium/tt0944947/img',
      releaseInfo: undefined,
    },
  ]);
});
