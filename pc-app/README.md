# Telemedia for Windows

Watch videos from your Telegram channels in Stremio on your PC.
Telemedia runs in the tray and starts with Windows.

## What you need

- Windows 10 or 11 (64-bit)
- [Stremio](https://www.stremio.com/downloads) on the PC
- Telegram on your phone

## Setup (about 2 minutes, once)

1. **Run `Telemedia-Setup-X.Y.Z.exe`.**
   Windows may say "Windows protected your PC", because the installer isn't
   signed. Click **More info**, then **Run anyway**.
   No admin rights are needed. Telemedia opens when the install finishes.
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

An Electron tray app around the TV app's Node bootstrap
([`../tv-app/node-bootstrap`](../tv-app/node-bootstrap)), unchanged:

```
src/main.js (Electron main)                 utility process: node-bootstrap/main.js
  window + tray, start with Windows   ──▶     control server 127.0.0.1:7001 (status, password, logout)
  polls /status, draws the QR codes           starter-key setup, QR login, Stremio pairing
src/ui/ (window, no Node access)              addon on 127.0.0.1:7000
src/preload.js (status in, actions out)
```

**Run from source** (in `pc-app/`):

```bash
npm install
npm start          # stages the Node part once (npm run bundle refreshes it), opens the app
```

**Build the installer:**

```bash
npm run dist       # → release/Telemedia-Setup-X.Y.Z.exe
```

`npm run bundle` (also run by `dist`) builds the addon, copies the bootstrap and
writes `defaults.json` with the scrambled starter key
([`../tv-app/scripts/defaults.mjs`](../tv-app/scripts/defaults.mjs)), the same
key as the TV app (`~/Documents/telemedia-signing/starter.properties`).
The installer carries that key: see the main README on sharing it.

The installer is not code-signed, so SmartScreen warns on first run.
