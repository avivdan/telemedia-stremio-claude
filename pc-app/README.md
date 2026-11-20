# Telemedia for Windows

Watch videos from your Telegram channels in Stremio on your PC.
Telemedia runs in the tray and starts with Windows.

## What you need

- Windows 10 or 11 (64-bit). It uses Microsoft Edge WebView2, which Windows 11
  and up-to-date Windows 10 already have.
- [Stremio](https://www.stremio.com/downloads) on the PC
- Telegram on your phone

## Setup (about 2 minutes, once)

1. **Run `Telemedia-Setup-X.Y.Z.exe`.**
   Windows may say "Windows protected your PC", because the installer isn't
   signed. Click **More info**, then **Run anyway**.
   No admin rights are needed. Telemedia opens when the install finishes.
   Uninstall from Windows Settings → Apps → Telemedia.
2. **Scan the Telegram code** with your phone: in Telegram, open
   *Settings → Devices → Link Desktop Device*.
   If your account has a two-step verification password, type it in the window.
   Telemedia then gets your own Telegram API key by itself (about a minute).
3. **Connect Stremio:** click **Connect in browser** and confirm (log in to
   Stremio there if asked), or scan the Stremio code with your phone camera.

That's it. Open any movie or episode in Stremio and pick a **Telemedia** stream.

If the automatic step fails, Telemedia shows **Open setup page** instead:
enter your phone number and the code Telegram sends you, and it reads your
key from my.telegram.org.

## Everyday use

- Telemedia starts with Windows and sits in the tray. Closing the window
  keeps it running; right-click the tray icon to quit.
- **Restart addon** fixes most hiccups.
- **Log out of Telegram** signs the PC out and forgets that account's key.
  The next scan can be any account.
- Telemedia only finds videos in channels and groups the account has joined.
- The switch at the top turns *Start with Windows* off.

Settings and the Telegram login live in `%APPDATA%\telemedia\config.json`,
shared with the command-line addon (`npm run login` / `npm start` in `addon/`).
The log is in `%APPDATA%\telemedia\app\logs`.

---

## For developers

A small C# app (WinForms + WebView2, the Edge engine built into Windows) around
the TV app's Node bootstrap ([`../tv-app/node-bootstrap`](../tv-app/node-bootstrap)),
which runs unchanged on a bundled `node.exe`. About 35 MB to download and
95 MB installed (Electron would be 130 MB / 400 MB).

```
shell/ Telemedia.exe (C#, .NET Framework 4.8)        node\node.exe main.js
  window: WebView2 shows ui/ (https://telemedia.example)   control server 127.0.0.1:7001
  tray icon, start with Windows, log file          ──▶     starter-key setup, QR login,
  polls /status, passes it to the page                     Stremio pairing, addon on :7000
  node.exe sits in a job object: it ends with the app
ui/    the page: status in, actions out (WebView2 messages)
setup/ Telemedia-Setup.exe: per-user installer, the app embedded as a zip
```

**Build** (in `pc-app/`; needs Node 20+ and the .NET SDK):

```bash
npm install
npm run build      # → stage/ (the installed layout); run stage\Telemedia.exe
npm start          # build, then open it
npm run dist       # → release/Telemedia-Setup-X.Y.Z.exe
```

`scripts/build.mjs` bundles the bootstrap and the addon with esbuild (3 MB
instead of 40 MB of node_modules), downloads `node.exe` from nodejs.org once
(checked against its SHA-256), and writes `defaults.json` with the scrambled
starter key ([`../tv-app/scripts/defaults.mjs`](../tv-app/scripts/defaults.mjs)),
the same key as the TV app (`~/Documents/telemedia-signing/starter.properties`).
The installer carries that key: see the main README on sharing it.

A run from `stage/` keeps its own settings and log (`%APPDATA%\telemedia\app-dev`)
and never registers itself to start with Windows. `TELEMEDIA_DEBUG_PORT=9333`
opens WebView2's DevTools protocol on that port (screenshots, debugging).

The installer is not code-signed, so SmartScreen warns on first run.
