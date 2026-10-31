// Stremio manifest. Catalogs mirror default.py's main_menu():
//   My Groups / Kids / Hebrew / World
// Plus per-provider discovery (Netflix/Prime/HBO/Disney+/Apple TV+) from
// JustWatch — no API key needed.

// `id` is part of the catalog id (kept stable from the earlier TMDB provider
// ids so manifests cached by Stremio keep working); `jw` is the JustWatch
// package code. Availability follows CATALOG_COUNTRY (see api/justwatch.ts).
export const PROVIDERS = [
  { id: 8, name: 'Netflix', jw: 'nfx' },
  { id: 9, name: 'Prime Video', jw: 'prv' },
  { id: 1899, name: 'HBO Max', jw: 'mxx' },
  { id: 337, name: 'Disney+', jw: 'dnp' },
  { id: 350, name: 'Apple TV+', jw: 'atp' },
] as const;

function providerCatalogs() {
  const out: {
    type: 'movie' | 'series';
    id: string;
    name: string;
    extra: { name: string; isRequired: boolean }[];
  }[] = [];
  for (const p of PROVIDERS) {
    for (const kind of ['movie', 'series'] as const) {
      out.push({
        type: kind,
        id: `telemedia-prov-${p.id}-${kind}`,
        name: `${p.name} ${kind === 'movie' ? 'Movies' : 'Series'} - Telemedia`,
        extra: [{ name: 'skip', isRequired: false }],
      });
    }
  }
  return out;
}

export const HEBREW_SEARCH_CATALOG = 'telemedia-he-search';

const ownIdPrefixes = ['tg:', 'tgchat:'];

export const manifest = {
  id: 'community.telemedia',
  version: '0.3.0',
  name: 'Telemedia',
  description:
    'Stream videos from your Telegram chats (port of Kodi plugin.video.telemedia).',
  // Meta only for our own ids — Cinemeta owns tt… details (names, episodes).
  // Streams for both, including Cinemeta's tt… movies and episodes.
  resources: [
    'catalog',
    { name: 'meta', types: ['movie', 'series'], idPrefixes: ownIdPrefixes },
    { name: 'stream', types: ['movie', 'series'], idPrefixes: [...ownIdPrefixes, 'tt'] },
  ],
  types: ['movie', 'series'],
  idPrefixes: [...ownIdPrefixes, 'tt'],
  // No generic Movies/TV catalogs: Stremio already shows Cinemeta's popular
  // rows and its search, and we serve streams for those (tt…) ids.
  catalogs: [
    // Hebrew titles in Stremio's search box (Cinemeta only knows English
    // names). isRequired → shows in search results only, not on the board.
    ...(['movie', 'series'] as const).map((type) => ({
      type,
      id: HEBREW_SEARCH_CATALOG,
      name: 'חיפוש בעברית',
      extra: [{ name: 'search', isRequired: true }],
    })),
    {
      type: 'series',
      id: 'telemedia-my-groups',
      name: 'My Groups - Telemedia',
      extra: [],
    },
    {
      type: 'movie',
      id: 'telemedia-kids',
      name: 'Kids - Telemedia',
      extra: [{ name: 'search', isRequired: false }],
    },
    {
      type: 'movie',
      id: 'telemedia-hebrew',
      name: 'Hebrew - Telemedia',
      extra: [{ name: 'search', isRequired: false }],
    },
    {
      type: 'movie',
      id: 'telemedia-world',
      name: 'World - Telemedia',
      extra: [{ name: 'search', isRequired: false }],
    },
    // Streaming provider catalogs (JustWatch popular titles per service).
    // Streams still come from Telegram (title-based search at stream time).
    ...providerCatalogs(),
  ],
  behaviorHints: {
    configurable: false,
    configurationRequired: false,
  },
};

export type Manifest = typeof manifest;
