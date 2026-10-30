// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildQueries,
  classify,
  dedupeStreams,
  matchesEpisode,
  matchesTitle,
  parseQuality,
  rankStreams,
  yearMatch,
} from '../src/search/matching';
import type { StremioStream } from '../src/types';

const LOU = 'האחרונים מבינינו';

test('episode tags: real filenames from Telegram', () => {
  const hits = [
    '1080p WEB ז.מ האחרונים מבינינו ע1 פ2.mp4',
    'האחרונים_מבינינו_ע1_פ2_1080P_ע"י_יהודה_בן_גביר.mp4',
    'לולו_סרטים_האחרונים_מבינינו_ע1פ2_ת_מ_1080P.mkv', // no separator
    "האחרונים מבינינו ע'1 פ'2.mkv", // ASCII apostrophe as geresh
    'האחרונים מבינינו ע׳1 פ׳2.mkv', // real geresh U+05F3
    '4 האחרונים מבינינו - עונה 1 פרק 2',
    'האחרונים מבינינו עונה 1 - פרק 2.mkv',
    'The.Last.of.Us.S01E02.1080p.mkv',
    'The.Last.of.Us.S01.E02.1080p.mkv',
    'The Last of Us 1x02.mkv',
    'The Last of Us Season 1 Episode 2.mkv',
  ];
  for (const f of hits) assert.ok(matchesEpisode(f, 1, 2), f);
});

test('episode tags: near misses are rejected', () => {
  const misses = [
    '1080p WEB ז.מ האחרונים מבינינו ע2 פ1.mp4', // swapped
    'האחרונים מבינינו ע1 פ20.mkv',
    'האחרונים מבינינו ע10 פ2.mkv',
    'Show.S01E20.mkv',
    'Show.S11E02.mkv',
    'Show.1920x1080.mkv',
    'שבוע1 פ2.mkv', // ע ends another word
  ];
  for (const f of misses) assert.ok(!matchesEpisode(f, 1, 2), f);
});

test('title matching: punctuation, accents, Hebrew marks', () => {
  assert.ok(matchesTitle('Greys.Anatomy.S20E01.mkv', "Grey's Anatomy"));
  assert.ok(matchesTitle("Grey's Anatomy S20E01.mkv", "Grey's Anatomy"));
  assert.ok(matchesTitle('L.Amour.2020.mkv', "L'Amour"));
  assert.ok(matchesTitle('Law.and.Order.S01E01.mkv', 'Law & Order'));
  assert.ok(matchesTitle('Pokemon.S01E01.mkv', 'Pokémon'));
  assert.ok(matchesTitle('ג׳וני.mkv', "ג'וני"));
  assert.ok(matchesTitle('בית_הנייר_ע1_פ1.mkv', 'בית־הנייר')); // maqaf
  assert.ok(matchesTitle(`לולו_סרטים_${LOU.replace(' ', '_')}_ע1פ2.mkv`, LOU));
});

test('title matching: no partial-word matches', () => {
  assert.ok(!matchesTitle('Dirty_Pop_The_Boy_Band_S01E01.mp4', 'The Boys'));
  assert.ok(!matchesTitle('Upgrade.2018.mkv', 'Up'));
});

test('year matching ignores years inside the title', () => {
  assert.equal(yearMatch('Blade Runner 2049.mkv', 2017, ['Blade Runner 2049']), 'none');
  assert.equal(yearMatch('Blade.Runner.2049.2017.1080p.mkv', 2017, ['Blade Runner 2049']), 'match');
  assert.equal(yearMatch('Dune.1984.mkv', 2021, ['Dune']), 'conflict');
  assert.equal(yearMatch('Dune.2022.mkv', 2021, ['Dune']), 'match'); // ±1 for regional dates
});

test('classify: series', () => {
  const titles = ['The Last of Us', LOU];
  assert.equal(classify('לולו_סרטים_האחרונים_מבינינו_ע1פ2_ת_מ_1080P.mkv', titles, 1, 2), 'best');
  assert.equal(classify('The.Last.of.Us.S01E03.mkv', titles, 1, 2), null);
  assert.equal(classify('Random.Show.S01E02.mkv', titles, 1, 2), null);
});

test('classify: movies', () => {
  const dune = ['Dune', 'חולית'];
  assert.equal(classify('Dune.2021.2160p.mkv', dune, undefined, undefined, 2021), 'best');
  assert.equal(classify('Dune.1984.mkv', dune, undefined, undefined, 2021), null); // other film
  assert.equal(classify('Dune.mkv', dune, undefined, undefined, 2021), null); // single word, no year
  assert.equal(classify('Dune.S01E01.mkv', dune, undefined, undefined, 2021), null); // episode
  const elCamino = ['El Camino: A Breaking Bad Movie', 'אל קמינו: שובר שורות - הסרט'];
  assert.equal(
    classify('לולו_סרטים_אל_קמינו:_שובר_שורות_הסרט_2019_ת_מ_1080P.mkv', elCamino, undefined, undefined, 2019),
    'best',
  );
  const lotr = ['The Lord of the Rings'];
  assert.equal(classify('The.Lord.of.the.Rings.1080p.mkv', lotr, undefined, undefined, 2001), 'ok');
});

test('quality parsing', () => {
  assert.equal(parseQuality('לולו_סרטים_האחרונים_מבינינו_ע1פ2_ת_מ_1080P.mkv'), 1080);
  assert.equal(parseQuality('Show.S01E01.720p.WEB.mkv'), 720);
  assert.equal(parseQuality('Movie.4K.HDR.mkv'), 2160);
  assert.equal(parseQuality('חולית (2021) איכות 1080 ציקו מדיה.mkv'), 1080);
  assert.equal(parseQuality('לולו_סרטים_חולית_2021_ת.מ_WEBRip.mkv'), undefined);
  assert.equal(parseQuality('Movie.1920x1080.mkv'), undefined);
});

const stream = (filename: string, size: number): StremioStream => ({
  url: `http://x/${filename}`,
  behaviorHints: { filename, videoSize: size },
});

test('ranking: container, then resolution, then size', () => {
  const ranked = rankStreams([
    stream('a.1080p.mp4', 5),
    stream('b.720p.mkv', 1),
    stream('c.1080p.mkv', 2),
    stream('d.1080p.mkv', 3),
  ]).map((s) => s.behaviorHints!.filename);
  assert.deepEqual(ranked, ['d.1080p.mkv', 'c.1080p.mkv', 'b.720p.mkv', 'a.1080p.mp4']);
});

test('dedupe: same upload reposted across channels', () => {
  const out = dedupeStreams([
    stream('לולו סרטים האחרונים מבינינו ע1פ2 ת מ 1080P.mkv', 3500000000),
    stream('לולו סרטים האחרונים מבינינו ע1פ2 ת מ 1080P.mkv', 3500000000),
    stream('לולו סרטים האחרונים מבינינו ע1פ2 ת מ 720P.mkv', 1500000000),
  ]);
  assert.equal(out.length, 2);
});

test('queries: Hebrew first, main titles before alternatives, no dash variant', () => {
  const q = buildQueries(['The Last of Us', LOU], ['TLOU'], 1, 2);
  assert.deepEqual(q, [
    `${LOU} ע1 פ2`,
    'The Last of Us S01E02',
    `${LOU} עונה 1 פרק 2`,
    'The Last of Us 1x02',
    `${LOU} S01E02`,
    'TLOU S01E02',
    'TLOU 1x02',
  ]);
  assert.deepEqual(buildQueries(['Dune'], [], undefined, undefined, 2021), ['Dune 2021', 'Dune']);
});
