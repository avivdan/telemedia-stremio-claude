# Telemedia — Stremio addon

A Stremio addon that finds movies and episodes in your Telegram chats and
streams them. It's a Node.js + TypeScript port of the Kodi add-on
`plugin.video.telemedia` 2.5.8: TDLib is replaced by [gramjs](https://github.com/gram-js/gramjs)
(MTProto in TypeScript), and the Kodi `RangeHTTPRequestHandler` by a Range
proxy on Node's `http` module.

It runs standalone (this folder) or embedded in the Android TV app
([`../tv-app`](../tv-app)), which loads the compiled `dist/src/index.js`
unchanged.

## Run it

```bash
npm install
npm run login             # Telegram QR code in the terminal (or: npm run login -- --phone)
npm run build && npm start
```

`npm run login` asks once for your Telegram API ID/hash (my.telegram.org) if
none is set, then saves them and the session to the user config file. There
is no `.env` file to edit.

Install in Stremio: `http://127.0.0.1:7000/manifest.json`.

### Reaching it from other devices

Stremio clients refuse plain-HTTP addons unless the address is loopback
(`127.0.0.1`). Options:

| Setup | Settings |
|---|---|
| Same machine | defaults |
| Android TV | Use the TV app. It serves on the TV's own loopback. For testing a PC build on the TV: `adb reverse tcp:7000 tcp:7000` |
| Other devices | HTTPS tunnel (e.g. `cloudflared tunnel --url http://localhost:7000`): `PUBLIC_BASE_URL=https://…`, `ADDON_HOST=0.0.0.0`, and `STREAM_BASE_URL=http://<lan-ip>:7000` to keep video off the tunnel (free tunnels drop long streams) |

## Configuration

There's no `.env`. Each setting is read, in order, from:
1. **an environment variable** with the name below (CI, Docker, the TV app, one-off overrides);
2. **the user config file**, written by `npm run login`:
   `%APPDATA%\telemedia\config.json` on Windows, `~/.config/telemedia/config.json`
   elsewhere (override the path with `TELEMEDIA_CONFIG`). Credentials sit at the top
   level (`apiId`, `apiHash`, `session`), other settings under `"settings"`, e.g.
   `{"settings": {"CATALOG_COUNTRY": "US"}}`;
3. **the built-in default.**

| Setting | Default | Notes |
|---|---|---|
| `TELEGRAM_API_ID`, `TELEGRAM_API_HASH` | — (required) | my.telegram.org; `npm run login` asks once and saves them |
| `TELEGRAM_SESSION` | — | written by `npm run login`. Full account access; the config file is created owner-only |
| `ADDON_HOST` / `ADDON_PORT` | `127.0.0.1` / `7000` | bind address |
| `PUBLIC_BASE_URL` | `http://127.0.0.1:7000` | base URL Stremio is given |
| `STREAM_BASE_URL` | `PUBLIC_BASE_URL` | base URL written into stream links |
| `CATALOG_COUNTRY` | `IL` | streaming-service rows: which country's availability |
| `CATALOG_LANGUAGE` | `he` | streaming-service rows: title language |
| `TG_KIDS_CHAT_ID`, `TG_HEBREW_GROUP`, `TG_WORLD_GROUP` | Kodi channels | `0` hides the catalog |
| `STREAM_CHUNK_KB` | `1024` | `upload.getFile` request size (power of two, max 1024) |
| `STREAM_PARALLEL` | `2` | requests in flight per stream |
| `CACHE_TTL_SECONDS` | `900` | catalog cache |
| `LOG_LEVEL` | `info` | |

Empty values fall through to the next source.

**No third-party API keys.** The only credential is the Telegram API ID/hash,
which identifies the app itself. All metadata comes from keyless public services:
Cinemeta, Wikidata and JustWatch.

## How a stream request is resolved

`/stream/<type>/<id>.json` with `tt…` (Cinemeta) ids:

1. **Titles** (`api/titles.ts → titleInfoForImdb`), cached for 24h. Two
   sources, queried in parallel; either can fail:
   - **Cinemeta** (`v3-cinemeta.strem.io/meta/<type>/<tt>.json`): English title, year
   - **Wikidata** (one SPARQL query on IMDb id `P345`): Hebrew + English labels
     (main titles) and aliases ("La casa de papel", "TLoU"), year

   Merged in that order (`mergeTitleSources`). Up to 3 aliases are searched.
   Only Hebrew/Latin-script titles are kept.
2. **Queries** (`search/matching.ts → buildQueries`): round-robin by tier,
   main titles before alternative ones, Hebrew first.
   - Series, Hebrew title: `<t> ע<S> פ<E>`, `<t> עונה <S> פרק <E>`, `<t> S<SS>E<EE>`
   - Series, Latin title: `<t> S<SS>E<EE>`, `<t> <S>x<EE>`
   - Movies: `<t> <year>`, `<t>`
3. **Telegram search** (`api/telegram.ts → globalSearchVideos`):
   `messages.searchGlobal` with both the Video and Document filters, keeping
   `video/*` documents, because many uploads are sent as files. Cached for 5 min. At most
   12 queries per request, stopping at 5 good hits.
4. **Media resolution** (`handlers/stream.ts → resolveMedia`): results without
   media (copyright-stripped or inaccessible) get one direct `GetMessages`
   retry. Failures are remembered for 6h, and after 3 failures a channel is
   skipped entirely.
5. **Classification** (`classify`) on `filename + caption`:
   - title must appear as a whole-word run. Normalization lowercases, folds
     accents, drops apostrophes and geresh, maps `&` to `and`, and strips niqqud
     and maqaf.
   - series: the episode tag must match (`S01E02`, `S01.E02`, `1x02`,
     `Season 1 Episode 2`, `ע1 פ2`, `ע1פ2`, `ע'1 פ'2`, `עונה 1 פרק 2`).
   - movies: episode-tagged files are dropped. The release year ranks *best*;
     ±1 also counts for multi-word titles. A different year is dropped
     (remakes). No year is kept as *ok*, but only for multi-word titles,
     because one word like "Up" is in too many filenames. Years that are part of a
     title ("Blade Runner 2049") are ignored, unless that year is the release
     year (alias "Dune (2021)").
6. **Ranking** (`rankStreams`, `dedupeStreams`): container (MKV/WebM >
   TS > MP4 > …), then resolution parsed from the filename, then size. The same
   upload in several channels (same size + name) appears once.

`search/matching.ts` is pure and covered by `test/matching.test.ts`, which uses
real filenames.

## Streaming

`GET /stream/<chatId>/<messageId>/video.<ext>` is the Range proxy (`handlers/proxy.ts`):
it parses `Range`, answers `206` with `Content-Range`, and streams bytes from
`iterDownload` (`api/telegram.ts`).

`iterDownload` calls `upload.getFile` directly instead of gramjs's iterator.
Requests are block-aligned and 1 MiB, with `STREAM_PARALLEL` in flight, and
blocks are yielded in order and trimmed to the range. gramjs's own iterator
caps requests at 512 KiB, runs sequentially, and re-downloads up to half of
every chunk after an unaligned seek. Measured on an Android TV box: ~0.9 MB/s
before, 2–2.5 MB/s after. More than ~2 parallel requests on one connection
triggers Telegram throttling.

## Catalogs

| Catalog | Source |
|---|---|
| חיפוש בעברית (movie + series, search-only) | Hebrew text in Stremio's search box → Wikidata label search (`api/hebrewSearch.ts`) → items with IMDb ids, typed by Wikidata class. Non-Hebrew queries are ignored (Cinemeta covers them). Cached 1h. No key. |
| My Groups | your Telegram dialogs |
| Kids / Hebrew / World | fixed channels from the Kodi addon |
| Netflix / Prime / HBO Max / Disney+ / Apple TV+ | JustWatch popular titles per service (`api/justwatch.ts`), keyless GraphQL used by its website. Follows `CATALOG_COUNTRY` (default Israel), titles in `CATALOG_LANGUAGE`. IMDb-linked items only, cursor-paged 50 at a time, cached 1h. |

There are no generic Movies/TV catalogs. Stremio's built-in Cinemeta already
shows popular titles and handles English search, and Telemedia provides
streams for those `tt…` ids.

The manifest scopes resources per id prefix: `meta` only for `tg:`/`tgchat:`,
so Cinemeta always owns `tt…` details (names, episode lists), while `stream`
also covers `tt`. Bump `version` when catalogs change; Stremio then offers
"Upgrade" on the addon page.

## Layout

```
src/
  index.ts              HTTP server: Range proxy + Stremio SDK router; exports addonEvents
  manifest.ts           Stremio manifest
  config.ts             env vars → user config file → defaults
  userConfig.ts         user config file (path, read/write, precedence)
  api/telegram.ts       gramjs client, search, fetchMessage, parallel iterDownload
  api/titles.ts         keyless titles: Cinemeta + Wikidata
  api/hebrewSearch.ts   Hebrew search box → Wikidata → IMDb ids
  api/justwatch.ts      streaming-service rows (JustWatch, keyless)
  api/auth.ts           CLI login (npm run login)
  handlers/stream.ts    stream resolution (titles → queries → search → classify → rank)
  handlers/proxy.ts     Range proxy
  handlers/catalog.ts   catalogs
  handlers/meta.ts      meta for tg: ids
  search/matching.ts    pure matching/ranking (unit-tested)
  mappers/              Telegram → Stremio objects
  utils/                cache, logger, ids, errors
scripts/                login, search, list-chat + ad-hoc debug scripts
test/                   node:test unit tests (npm test)
examples/               sample manifest/catalog/meta/stream JSON
```

## Debug tools

```bash
npm run search -- "האחרונים מבינינו עונה 1 פרק 2"   # raw global search + why results are dropped
npm run list-chat -- -1001251653717 "" 50           # video files in one chat (video + document filters)
npm test                                            # unit tests
```

## Known limitations

- **Telegram search tokenization:** queries like `<title> ע1 פ2` often return
  nothing even when filenames contain exactly that. Files are usually found
  through the `עונה 1 פרק 2` query, which matches the captions.
- **Copyright-stripped channels:** Telegram returns placeholders without media
  in some regions. Nothing to do client-side.
- **Single user:** one config file means one Telegram account.
- **Unofficial endpoints:** JustWatch's GraphQL and Stremio's link and
  addon-collection APIs (used by the TV app) are undocumented, so they can change.
  The rows and the auto-install fail soft: an empty row, or the manual
  install fallback.
- **Not ported from Kodi:** Trakt, Real-Debrid/Drive resolvers, Kodi
  installers, resume positions (Stremio tracks progress), and the
  forward-to-bot fallback (`TG_BOT_USERNAME` is not wired).
