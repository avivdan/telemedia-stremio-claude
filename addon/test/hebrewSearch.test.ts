// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toSearchHits, type WikidataEntity } from '../src/api/hebrewSearch';

const P = (id: string) => ({ mainsnak: { datavalue: { value: { id } } } });
const S = (value: string) => ({ mainsnak: { datavalue: { value } } });
const T = (time: string) => ({ mainsnak: { datavalue: { value: { time } } } });

const entities: Record<string, WikidataEntity> = {
  // The Last of Us (TV series)
  Q87131973: {
    labels: { he: { value: 'האחרונים מבינינו' }, en: { value: 'The Last of Us' } },
    claims: { P345: [S('tt3581920')], P31: [P('Q5398426')], P577: [T('+2023-01-15T00:00:00Z')] },
  },
  // The Last of Us (video game) — no IMDb id
  Q11281069: {
    labels: { he: { value: 'The Last of Us' }, en: { value: 'The Last of Us' } },
    claims: { P31: [P('Q7889')] },
  },
  // Dune (2021 film)
  Q60834962: {
    labels: { he: { value: 'חולית' }, en: { value: 'Dune' } },
    claims: { P345: [S('tt1160419')], P31: [P('Q11424')], P577: [T('+2021-10-21T00:00:00Z'), T('+2021-09-03T00:00:00Z')] },
  },
  // An episode — skipped even with an IMDb id
  Q999: {
    labels: { en: { value: 'Pilot' } },
    claims: { P345: [S('tt0000001')], P31: [P('Q21191270')] },
  },
  // Video game with an IMDb id — skipped
  Q1176352: {
    labels: { en: { value: 'Dune 2000' } },
    claims: { P345: [S('tt0165275')], P31: [P('Q7889')] },
  },
  // Unknown class but has a number of seasons → series; no Hebrew label → English
  Q1000: {
    labels: { en: { value: 'Some Show' } },
    claims: { P345: [S('tt0000002')], P31: [P('Q123')], P2437: [S('3')] },
  },
};

test('toSearchHits: keeps IMDb-linked titles in relevance order, typed', () => {
  const hits = toSearchHits(
    ['Q87131973', 'Q11281069', 'Q60834962', 'Q999', 'Q1176352', 'Q1000', 'Qmissing'],
    entities,
  );
  assert.deepEqual(hits, [
    { imdbId: 'tt3581920', type: 'series', name: 'האחרונים מבינינו', enName: 'The Last of Us', year: 2023 },
    { imdbId: 'tt1160419', type: 'movie', name: 'חולית', enName: 'Dune', year: 2021 },
    { imdbId: 'tt0000002', type: 'series', name: 'Some Show', enName: 'Some Show', year: undefined },
  ]);
});
