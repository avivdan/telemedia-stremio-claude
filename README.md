# Telemedia — Stremio port

A Stremio add-on that streams videos from your Telegram chats. It is a
Node.js + TypeScript port of the Kodi add-on **plugin.video.telemedia 2.5.8**
(`login.py`, `service.py`, `default.py`, `mediaurl.py`, …).

The Kodi original used TDLib plus a `BaseHTTPServer`-based Range proxy. This
port swaps TDLib for [gramjs](https://github.com/gram-js/gramjs) (MTProto in
TypeScript) and implements the Range proxy directly on Node's `http` module.

## Install

```bash
git clone <this repo>
cd telemedia-stremio
npm install
cp .env.example .env
```

Fill in `TELEGRAM_API_ID` and `TELEGRAM_API_HASH`. Register your own pair at
<https://my.telegram.org>. The defaults shipped in `.env.example` are copied
from the Kodi add-on and are shared across every Telemedia user — using your
own is safer and won't be rate-limited by Telegram.

## Authenticate once

```bash
npm run login
```

You'll be prompted for phone number → SMS code → optional 2FA password
(the Telegram authorization state machine from `login.py`). The CLI prints a
`TELEGRAM_SESSION=…` line — paste it into `.env`.

## Run

```bash
npm run build
npm start
# or hot-reload:
npm run dev
```

Stremio install URL:

```
http://127.0.0.1:7000/manifest.json
```

## Catalogs

| Catalog            | Source                                               | Kodi analogue                        |
| ------------------ | ---------------------------------------------------- | ------------------------------------ |
| Movies             | TMDB popular + search                                | `movies_menu()` (mode 10/14/15)      |
| TV Shows           | TMDB popular + search                                | `tv_show_menu()` (mode 11/14/20)     |
| My Groups          | `messages.getDialogs` over your account              | `my_groups()` (mode 12)              |
| Kids / Hebrew / World | hard-coded channel IDs from `default.py`          | `main_menu()` mode 31                |

Clicking a TMDB movie/series asks the stream handler to do a
`messages.searchGlobal` over your account for matching video messages
(`search_movies()` in `default.py:1283`).

Clicking a Telegram chat lists the recent `InputMessagesFilterVideo` messages
as "episodes" — same shape as `file_list()` in `default.py:1480`.

## Streaming

Stream URLs point at the add-on's own proxy:

```
http://127.0.0.1:7000/stream/<chatId>/<messageId>
```

The proxy:

1. Looks the message up via `channels.getMessages` / `messages.getMessages`.
2. Parses `Range: bytes=s-e` and responds with `206 Partial Content`,
   `Accept-Ranges: bytes`, `Content-Range: bytes s-e/total`.
3. Pulls the exact slice from Telegram with `client.iterDownload({ offset,
   limit, requestSize })` and pipes chunks through `res.write`.
4. Aborts the download if the client disconnects mid-stream.

This is the one-to-one analogue of `service.py`'s `RangeHTTPRequestHandler`
— see the comments in `src/handlers/proxy.ts` for the line-level mapping.

## What was intentionally *not* ported

| Kodi feature                            | Reason                                               |
| --------------------------------------- | ---------------------------------------------------- |
| Trakt progress/watchlist (modes 114–118) | Stremio has its own progress/library — no analogue.  |
| Real-Debrid resolver                    | External hoster logic, orthogonal to Telegram.       |
| Google Drive / upfile.co.il resolvers   | Niche, not used for the primary content.             |
| Addon/build installers (modes 24/25/32/47) | Kodi package manager; meaningless for Stremio.    |
| Kodi trailer player, overlay UI         | UI-specific.                                         |
| Pre-fetch / resume positions (SQLite)   | Stremio tracks progress itself.                      |
| Forward-to-bot fallback                 | Optional — can be added later by enabling `TG_BOT_USERNAME`. |

## Architecture

```
src/
  index.ts                 Boot + HTTP server (Stremio SDK + Range proxy on one port)
  manifest.ts              Stremio manifest (catalogs / types / id prefixes)
  config.ts                .env → typed config
  types.ts                 Shared domain types
  api/
    client.ts              axios + base headers (mirrors client.py)
    auth.ts                CLI sign-in → StringSession (mirrors login.py)
    telegram.ts            gramjs wrapper: getDialogs / search / iterDownload
    tmdb.ts                TMDB popular / search / detail
  handlers/
    catalog.ts             /catalog → metas[]
    meta.ts                /meta    → meta{}
    stream.ts              /stream  → streams[]
    proxy.ts               /stream/<chat>/<msg> Range proxy (the service.py port)
  mappers/
    catalogMapper.ts       Api.Message → preview
    metaMapper.ts          Api.Message → meta
    streamMapper.ts        TgMediaRef  → Stremio stream
  utils/
    logger.ts              leveled console logger
    errors.ts              typed error hierarchy
    cache.ts               lru-cache with TTL (mirrors cache.py)
    ids.ts                 pack/unpack tg:<chat>:<msg>
scripts/
  login.ts                 npm run login
examples/
  *.json                   sample manifest/catalog/meta/stream responses
```

## Known limitations / assumptions

* **DC affinity.** We trust `Document.dcId` for `iterDownload`. gramjs handles
  DC migration but very cold-start requests to a non-primary DC can be slow
  on the first chunk. This matches the Kodi addon's `wait_download_file`
  latency.
* **Single-user.** One `.env` = one Telegram account. Multi-tenancy would
  require a session-per-user + a config page.
* **No Cloudflare/scraping is involved.** The Kodi addon's brief mentions
  "cloudflare_request" — it is imported but applies only to Trakt/TMDB
  fallback paths we did not port.
* **Forward-to-bot fallback** (default.py:1975 `get_direct_bot_link`) is off
  by default. Set `TG_BOT_USERNAME=@your_bot` to enable it (hook not wired
  yet — skeleton left intentionally so it can be bolted onto `stream.ts`).
* **Kids/Hebrew/World chat IDs** are copied verbatim from default.py. If
  those channels are renamed or deleted upstream, the catalogs go empty.
```
