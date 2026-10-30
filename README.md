# Telemedia

Watch videos from your Telegram channels and groups in [Stremio](https://www.stremio.com).

The repo has two parts:

| Folder | What it is | Who it's for |
|---|---|---|
| [`tv-app/`](tv-app/) | **Telemedia for Android TV.** An app that runs everything on the TV itself: install, scan a QR code, watch. | Users. Start here. |
| [`addon/`](addon/) | **The Stremio addon** (Node.js + TypeScript). It searches Telegram, matches files to movies and episodes, and streams them. It runs inside the TV app, or standalone on a PC/server. | Developers |

```
Stremio ──HTTP──▶ addon (catalog / meta / stream + Range proxy) ──MTProto──▶ Telegram
                    ▲
                    └── runs inside tv-app on the TV, or with `npm start` on a PC
```

## Quick commands (from the repo root)

```bash
npm run addon:install       # install addon dependencies
npm run addon:login         # one-time Telegram login for the PC addon
npm run addon:start         # run the addon on this machine
npm run addon:test          # unit tests
npm run tv:libnode          # one-time: download the Android Node.js runtime
npm run tv:deploy -- <tv-ip>:5555   # build the TV app and install it over adb
```

Origin: a port of the Kodi add-on `plugin.video.telemedia` 2.5.8.
