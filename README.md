# Telemedia

Watch movies and series from your Telegram channels and groups in
[Stremio](https://www.stremio.com), on an Android TV. No computer needed.

## In short

- **What it is:** an Android TV app. It adds a "Telemedia" source to Stremio:
  open any movie or episode in Stremio and Telemedia finds it in your Telegram
  chats and plays it.
- **Where it runs:** only on the TV box. It starts with the TV and keeps
  running in the background. Nothing runs on a PC or in the cloud.
- **Setup:** install the app, scan two QR codes with your phone. About two
  minutes, once.
- **Your account stays yours:** the TV logs in to *your* Telegram, with *your*
  own Telegram API key (it gets that by itself). Nothing goes anywhere except
  Telegram and Stremio.

## Setup

1. Install `Telemedia-vX.Y.Z.apk` from
   [Releases](https://github.com/avivdan/telemedia-stremio-claude/releases) on
   the TV (details in [`tv-app/README.md`](tv-app/README.md#installing-the-apk)).
2. Open **Telemedia**. Two QR codes appear:
   - **Telegram:** in the Telegram app on your phone, *Settings → Devices →
     Link Desktop Device*, scan the code.
   - **Stremio:** scan with the phone camera and confirm.
3. Open Stremio, pick a movie, choose a **Telemedia** stream.

Works with an Android phone or an iPhone for scanning.

## How it works

```
 TV box
 ┌──────────────────────────────────────────────────────────┐
 │  Stremio  ──asks for streams──▶  Telemedia app            │
 │     ▲                             (the addon, on the TV)  │
 │     └──────── video ◀─────────────────┐                   │
 └───────────────────────────────────────┼───────────────────┘
                                         │ searches + streams
                                         ▼
                                 Telegram (your chats)
```

1. Stremio asks Telemedia: "streams for *Inception (2010)*?"
2. Telemedia searches your Telegram chats for matching video files.
3. You pick one; Telemedia streams it from Telegram to Stremio, on the TV.

**The first-time Telegram setup, step by step.** Telegram requires every
app to have an "API key" (api_id + api_hash), made on my.telegram.org. Nobody
wants to do that by hand on a TV, so the app does it:

1. The app has one shared *starter key* built in, used only for setup.
2. You scan the Telegram QR code: the TV is logged in with the starter key.
3. The TV asks my.telegram.org for a login code for your number. Telegram
   sends it to your *Telegram* chat ("Web login code"), and the TV reads it.
4. The TV opens your my.telegram.org page and reads your own API key
   (creating an app named "Telemedia TV" if you have none).
5. The TV switches to your own key and signs the starter login out.

From then on everything uses your own key, so your usage never mixes with
anyone else's. If the automatic way fails (for example Telegram says "too many
tries"), the TV shows a phone setup page instead.

## Questions

- **Does my PC have to stay on?** No. The PC is only for building the app.
- **iPhone / iPad?** Only for scanning the codes. The app needs an Android TV
  (or Android phone/tablet): iOS can't keep a streaming server running in the
  background.
- **Can others on my Wi-Fi use my Telegram through it?** No. The addon only
  answers on the TV itself (`127.0.0.1`).
- **How do I sign the TV out?** *Log out of Telegram* in the app, or on your
  phone: Telegram → *Settings → Devices*.

## Repository

| Folder | What it is |
|---|---|
| [`tv-app/`](tv-app/) | The Android TV app: user guide, build and release. |
| [`addon/`](addon/) | The Stremio addon (Node.js + TypeScript): Telegram search, matching files to movies and episodes, streaming. Runs inside the TV app, or standalone on a PC for development. |

```bash
npm run addon:install       # install addon dependencies
npm run addon:test          # unit tests
npm run addon:login         # one-time Telegram login for the PC addon
npm run addon:start         # run the addon on this machine
npm run tv:libnode          # one-time: download the Android Node.js runtime
npm run tv:deploy -- <tv-ip>:5555   # build the TV app and install it over adb
npm run tv:release -- X.Y.Z         # signed release APK in tv-app/release/
```

**Keys and secrets.** No keys are in the code. The release build reads the
signing key and the starter key from a folder outside the repo
(`~/Documents/telemedia-signing`), see [`tv-app/README.md`](tv-app/README.md).
Movie and series info comes from keyless services (Cinemeta, Wikidata,
JustWatch).

Origin: a port of the Kodi add-on `plugin.video.telemedia` 2.5.8.
