// Pure helpers for resolving Stremio stream requests against Telegram search
// results: query building, title/episode/year matching, quality parsing and
// ranking. No I/O here — covered by test/matching.test.ts.

import type { StremioStream } from '../types';

// Letters/digits we treat as "word" characters: ASCII, Latin-1/Extended,
// Greek, Cyrillic, Hebrew, Arabic. Explicit ranges instead of \p{L}\p{N}
// because nodejs-mobile (Android TV build) ships Node without full ICU and
// rejects Unicode property escapes at parse time — for the same reason accent
// folding below uses a table instead of String.prototype.normalize.
export const WORD_CHARS =
  '0-9A-Za-z\\u00C0-\\u024F\\u0370-\\u03FF\\u0400-\\u04FF\\u05D0-\\u05EA\\u0600-\\u06FF';
const NON_WORD_RUN = new RegExp(`[^${WORD_CHARS}]+`, 'g');
// Zero or more separators between tag parts: space . _ - ' ׳ etc.
const SEP = `[^${WORD_CHARS}]*`;

const HEBREW = /[א-ת]/;
const LATIN = /[a-zA-Z]/;
export const hasHebrew = (s: string) => HEBREW.test(s);
export const hasLatin = (s: string) => LATIN.test(s);

// Apostrophes, Hebrew geresh/gershayim, quotes — "Grey's" must equal "Greys",
// "ג׳וני" must equal "ג'וני".
const APOSTROPHES = /['’‘`´׳״"]/g;
const NIQQUD = /[֑-ׇֽֿׁׂׅׄ]/g;
const HEBREW_PUNCT = /[־׀׃׆]/g; // maqaf, paseq, sof pasuq, nun hafukha
const ACCENTS: [RegExp, string][] = [
  [/[àáâãäåāăą]/g, 'a'],
  [/[çćĉċč]/g, 'c'],
  [/[ďđ]/g, 'd'],
  [/[èéêëēĕėęě]/g, 'e'],
  [/[ĝğġģ]/g, 'g'],
  [/[ìíîïĩīĭįı]/g, 'i'],
  [/[ĺļľł]/g, 'l'],
  [/[ñńņň]/g, 'n'],
  [/[òóôõöøōŏő]/g, 'o'],
  [/[ŕŗř]/g, 'r'],
  [/[śŝşš]/g, 's'],
  [/[ţť]/g, 't'],
  [/[ùúûüũūŭůűų]/g, 'u'],
  [/[ýÿŷ]/g, 'y'],
  [/[źżž]/g, 'z'],
  [/ß/g, 'ss'],
  [/æ/g, 'ae'],
  [/œ/g, 'oe'],
];

function normWith(s: string, apostrophe: '' | ' '): string {
  let out = s
    .toLowerCase()
    .replace(NIQQUD, '')
    .replace(HEBREW_PUNCT, ' ')
    .replace(APOSTROPHES, apostrophe)
    .replace(/&/g, ' and ');
  for (const [re, rep] of ACCENTS) out = out.replace(re, rep);
  return out.replace(NON_WORD_RUN, ' ').trim();
}

// Normalize for substring matching: lowercase, fold accents, drop
// apostrophes, collapse non-letter/digit runs to one space.
// "Grey's Anatomy" → "greys anatomy"; "האחרונים_מבינינו" → "האחרונים מבינינו".
export function norm(s: string): string {
  return normWith(s, '');
}

// True when `text` (filename + caption) contains the title as a distinct run
// of words — blocks "The Boy Band" matching "The Boys". Apostrophes are tried
// both dropped and as a space so "Grey's"="Greys" and "L'Amour"="L.Amour".
export function matchesTitle(text: string, title: string): boolean {
  for (const ta of ['', ' '] as const) {
    const t = normWith(title, ta);
    if (!t) continue;
    for (const xa of ['', ' '] as const) {
      if (` ${normWith(text, xa)} `.includes(` ${t} `)) return true;
    }
  }
  return false;
}

// Season/episode tags: S01E02, S01.E02, 1x02, "Season 1 Episode 2", and Hebrew
// "ע1 פ2" / "ע1פ2" / "ע'1 פ'2" / "עונה 1 פרק 2" (ע = עונה = season, פ = פרק =
// episode). No \b: underscores are \w in JS ("Show_S01E05_..."), so we use
// explicit digit lookarounds; the Hebrew ע must not end another word.
function episodePatterns(season: number, episode: number): RegExp[] {
  return [
    new RegExp(`s0*${season}[._\\s-]?e0*${episode}(?![0-9])`, 'i'),
    new RegExp(`(?<![0-9])0*${season}x0*${episode}(?![0-9])`, 'i'),
    new RegExp(`season[^a-z0-9]*0*${season}[^a-z0-9]+episode[^a-z0-9]*0*${episode}(?![0-9])`, 'i'),
    new RegExp(`(?<![\\u05D0-\\u05EA])ע${SEP}0*${season}${SEP}פ${SEP}0*${episode}(?![0-9])`),
    new RegExp(`עונה${SEP}0*${season}${SEP}פרק${SEP}0*${episode}(?![0-9])`),
  ];
}

export function matchesEpisode(text: string, season: number, episode: number): boolean {
  const s = text.toLowerCase();
  return episodePatterns(season, episode).some((p) => p.test(s));
}

// Any season/episode tag at all — used to keep episodes out of movie results.
const ANY_EPISODE = [
  /s\d{1,2}[._\s-]?e\d{1,3}(?![0-9])/i,
  /(?<![0-9])\d{1,2}x\d{2,3}(?![0-9])/i,
  new RegExp(`(?<![\\u05D0-\\u05EA])ע${SEP}\\d{1,2}${SEP}פ${SEP}\\d{1,3}(?![0-9])`),
  new RegExp(`עונה${SEP}\\d{1,2}${SEP}פרק`),
];
export function looksLikeEpisode(text: string): boolean {
  return ANY_EPISODE.some((p) => p.test(text));
}

// Year check for movies. Years that are part of a title ("Blade Runner 2049")
// are ignored. 'match' = within ±1 (regional release dates differ),
// 'conflict' = a different year is present (likely a remake/other film),
// 'none' = no year in the text.
export function yearMatch(text: string, year: number, titles: string[]): 'match' | 'conflict' | 'none' {
  const titleYears = new Set(titles.flatMap((t) => t.match(/(?:19|20)\d{2}/g) ?? []));
  const years = (text.match(/(?<![0-9])(?:19|20)\d{2}(?![0-9])/g) ?? [])
    .filter((y) => !titleYears.has(y))
    .map(Number);
  if (years.length === 0) return 'none';
  return years.some((y) => Math.abs(y - year) <= 1) ? 'match' : 'conflict';
}

// Resolution from the filename ("1080p", "720P", "4K"). Video metadata height
// is unreliable on Telegram (often a thumbnail-ish 180), so names win.
export function parseQuality(name: string): number | undefined {
  if (/(?<![a-z0-9])(?:4k|uhd)(?![a-z0-9])/i.test(name)) return 2160;
  const m = /(?<![0-9])(2160|1440|1080|720|576|480|360)[pi](?![a-z0-9])/i.exec(name);
  if (m) return Number(m[1]);
  // Bare "1080" (Hebrew uploads: "איכות 1080"), but not "1920x1080".
  const bare = /(?<![0-9x])(2160|1080|720)(?![0-9])/i.exec(name);
  return bare ? Number(bare[1]) : undefined;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------
export function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

// Query forms per title, most productive first. Hebrew uploaders tag
// "ע4 פ2", Latin ones "S04E02".
function queryForms(t: string, season?: number, episode?: number, year?: number): string[] {
  if (season == null || episode == null) return year ? [`${t} ${year}`, t] : [t];
  const se = `S${pad(season)}E${pad(episode)}`;
  return hasHebrew(t)
    ? [`${t} ע${season} פ${episode}`, `${t} עונה ${season} פרק ${episode}`, `${t} ${se}`]
    : [`${t} ${se}`, `${t} ${season}x${pad(episode)}`];
}

// Round-robin by tier so every title's best form runs before any title's
// second form. Main titles (official he/en/original) go entirely before
// alternative titles. Hebrew first within each group (user's source language).
export function buildQueries(
  mainTitles: string[],
  altTitles: string[],
  season?: number,
  episode?: number,
  year?: number,
): string[] {
  const hebFirst = (a: string, b: string) => (hasHebrew(a) ? 0 : 1) - (hasHebrew(b) ? 0 : 1);
  const roundRobin = (titles: string[]) => {
    const per = [...titles].sort(hebFirst).map((t) => queryForms(t, season, episode, year));
    const out: string[] = [];
    const depth = per.reduce((m, a) => Math.max(m, a.length), 0);
    for (let d = 0; d < depth; d++) for (const list of per) if (d < list.length) out.push(list[d]);
    return out;
  };
  const seen = new Set<string>();
  return [...roundRobin(mainTitles), ...roundRobin(altTitles)].filter((q) => {
    const k = q.trim().toLowerCase();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Classification + ranking
// ---------------------------------------------------------------------------
export type Bucket = 'best' | 'ok' | null;

// best = title + episode (series) / title + matching year (movies)
// ok   = movie title match with no year in the text (multi-word titles only:
//        a single word like "Up" or "Heat" appears in too many filenames)
// null = drop (no title, wrong episode, an episode file for a movie, a
//        different year)
export function classify(
  text: string,
  titles: string[],
  season?: number,
  episode?: number,
  year?: number,
): Bucket {
  const matched = titles.filter((t) => matchesTitle(text, t));
  if (matched.length === 0) return null;
  if (season != null && episode != null) {
    return matchesEpisode(text, season, episode) ? 'best' : null;
  }
  if (looksLikeEpisode(text)) return null;
  if (!year) return 'ok';
  const y = yearMatch(text, year, titles);
  if (y === 'match') return 'best';
  if (y === 'conflict') return null;
  return matched.some((t) => norm(t).includes(' ')) ? 'ok' : null;
}

// Container first (MKV/WebM seek reliably; Telegram MP4s often have the moov
// atom at the end), then resolution, then size.
export function formatRank(name: string): number {
  const n = name.toLowerCase();
  if (/\.(mkv|webm)$/.test(n)) return 0;
  if (/\.(ts|m2ts)$/.test(n)) return 1;
  if (/\.(mp4|m4v|mov)$/.test(n)) return 2;
  if (/\.(flv|3gp)$/.test(n)) return 3;
  if (/\.avi$/.test(n)) return 4;
  return 5;
}

const streamName = (s: StremioStream) => s.behaviorHints?.filename ?? s.title ?? '';

export function rankStreams(streams: StremioStream[]): StremioStream[] {
  return [...streams].sort(
    (a, b) =>
      formatRank(streamName(a)) - formatRank(streamName(b)) ||
      (parseQuality(streamName(b)) ?? 0) - (parseQuality(streamName(a)) ?? 0) ||
      (b.behaviorHints?.videoSize ?? 0) - (a.behaviorHints?.videoSize ?? 0),
  );
}

// The same upload reposted across channels → keep the first copy.
export function dedupeStreams(streams: StremioStream[]): StremioStream[] {
  const seen = new Set<string>();
  return streams.filter((s) => {
    const key = `${s.behaviorHints?.videoSize ?? ''}|${norm(streamName(s))}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
