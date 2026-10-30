// Stremio manifest. Catalogs mirror default.py's main_menu():
//   My Groups / Kids / Hebrew / World
// Plus per-provider discovery (Netflix/Prime/HBO/Disney+/Apple TV+) when a
// TMDB key is configured.

import { config } from './config';

// TMDB watch-provider ids. Same across regions but availability differs;
// `watch_region` is set at query time (see src/api/tmdb.ts).
export const PROVIDERS = [
  { id: 8, name: 'Netflix' },
  { id: 9, name: 'Prime Video' },
  { id: 1899, name: 'HBO Max' },
  { id: 337, name: 'Disney+' },
  { id: 350, name: 'Apple TV+' },
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

const ownIdPrefixes = ['tg:', 'tgchat:', ...(config.tmdb.enabled ? ['tmdb:'] : [])];

export const manifest = {
  id: 'community.telemedia',
  version: '0.2.0',
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
    // Streaming provider catalogs — TMDB `/discover` filtered by watch provider.
    // Need a TMDB key (no keyless source for watch providers). Streams still
    // come from Telegram (title-based search at stream time).
    ...(config.tmdb.enabled ? providerCatalogs() : []),
  ],
  behaviorHints: {
    configurable: false,
    configurationRequired: false,
  },
};

export type Manifest = typeof manifest;
