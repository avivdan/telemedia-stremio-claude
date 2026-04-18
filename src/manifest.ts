// Stremio manifest. Catalogs mirror default.py's main_menu():
//   Movies / TV Shows / My Groups / Kids / Hebrew / World
// Plus per-provider discovery (Netflix/Prime/HBO/Disney+/Apple TV+).

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

export const manifest = {
  id: 'community.telemedia',
  version: '0.1.0',
  name: 'Telemedia',
  description:
    'Stream videos from your Telegram chats (port of Kodi plugin.video.telemedia).',
  resources: ['catalog', 'meta', 'stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tg:', 'tgchat:', 'tmdb:', 'tt'],
  catalogs: [
    {
      type: 'movie',
      id: 'telemedia-movies',
      name: 'Movies - Telemedia',
      extra: [
        { name: 'search', isRequired: false },
        { name: 'skip', isRequired: false },
      ],
    },
    {
      type: 'series',
      id: 'telemedia-series',
      name: 'TV Shows - Telemedia',
      extra: [
        { name: 'search', isRequired: false },
        { name: 'skip', isRequired: false },
      ],
    },
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
    // Streams still come from Telegram (title-based search at stream time).
    ...providerCatalogs(),
  ],
  behaviorHints: {
    configurable: false,
    configurationRequired: false,
  },
};

export type Manifest = typeof manifest;
