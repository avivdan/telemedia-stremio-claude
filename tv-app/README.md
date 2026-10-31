# Telemedia for Android TV

Watch videos from your Telegram channels in Stremio, right on your TV.
Nothing to run on a computer: the app runs in the background on the TV and
starts by itself when the TV turns on.

## What you need

- An Android TV (Android 7 or newer)
- [Stremio](https://play.google.com/store/apps/details?id=com.stremio.one) on the TV
- Telegram on your phone

## Setup (about 2 minutes, once)

1. **Install the app** on the TV (see *Installing the APK* below).
2. **Open Telemedia.** Two QR codes appear. Scan both with your phone, in any order:
   - **Telegram:** in the Telegram app, *Settings → Devices → Link Desktop Device*.
     If you use a two-step verification password, type it on the TV.
   - **Stremio:** with the phone camera. Confirm on the page that opens (log in
     to Stremio there if asked). This adds Telemedia to your Stremio account.

That's it. Open any movie or episode in Stremio and pick a **Telemedia** stream.

If the Stremio code doesn't work, use **Open Stremio Add-ons** in the app:
choose **Add addon**, enter `http://127.0.0.1:7000/manifest.json`, then **Install**.
Either way it's once per Stremio account: another TV on the same account only
needs the Telemedia app.

**Search in Hebrew:** type a Hebrew name in Stremio's search (פאודה, האחרונים מבינינו, …).
Results appear in the **חיפוש בעברית** rows. With a connected keyboard, type
from the phone's remote app instead (the TV keyboard layout may stay English).

**Streaming-service rows:** popular titles on Netflix, Prime Video, HBO Max,
Disney+ and Apple TV+ in Israel, with Telemedia streams.

## Everyday use

- Nothing to do: Telemedia starts with the TV.
- The app screen shows the status: *Connected to Stremio* means all good.
- **Restart addon** fixes most hiccups.
- **Log out of Telegram** signs the TV out. You'll get a new QR code.

## Good to know

- Your Telegram login stays on the TV. It's never sent anywhere except Telegram.
  You can sign the TV out anytime from your phone: *Settings → Devices*.
- The addon only listens on the TV itself (`127.0.0.1`), so other devices on
  your network can't use your Telegram account through it.
- Some channels' videos are blocked by Telegram for copyright in some regions.
  Those simply don't show up.
- On TVs with little memory, very high-quality (4K) files may stutter. Choose a
  1080p or 720p stream instead.

## Installing the APK

Download `Telemedia-vX.Y.Z.apk` from the project's
[GitHub Releases](https://github.com/avivdan/telemedia-stremio-claude/releases).

**On the TV, with the Downloader app** (free on Google Play):
1. Open Downloader and enter the release APK link.
2. Allow Downloader to install apps when Android asks (once).
3. Install, then open **Telemedia**.

Or from a computer, with network debugging enabled on the TV:

```bash
adb connect <tv-ip>:5555
adb install -r Telemedia-vX.Y.Z.apk
```

Updates install over the previous version and keep your login.

---

## For developers

The app embeds Node.js ([nodejs-mobile](https://github.com/nodejs-mobile/nodejs-mobile), Node 18)
and runs the addon from [`../addon`](../addon) unchanged.

```
MainActivity (UI process)              NodeService (":node" process, foreground service)
  status / QR / "add to Stremio"  ──▶   node-bootstrap/main.js
  polls 127.0.0.1:7001                    ├─ control server :7001 (status, 2FA password, restart)
                                          ├─ QR login → session saved in app-private config.json
                                          └─ require(addon dist) → addon on 127.0.0.1:7000
BootReceiver → starts NodeService on boot
```

**Build and install** (Android Studio's SDK, NDK and CMake 3.22.1, plus JDK 17), from the repo root:

```bash
npm run tv:libnode                          # once: Node runtime → tv-app/app/libnode/
npm run tv:deploy -- 192.168.0.114:5555     # bundle addon, build APK, adb install, restart, wait for "running"
```

`tv:deploy` uses `JAVA_HOME`/`ANDROID_HOME`, falling back to
`%LOCALAPPDATA%\Android\{jdk-17,Sdk}`.

**Keys.** No third-party API keys at all. Titles, Hebrew search and the
streaming-service rows come from Cinemeta, Wikidata and JustWatch, all keyless.
The only credential is the Telegram API ID/hash, which identifies the *app*.
Telegram expects each app to embed its own, so don't reuse another app's
published ID. `tv:bundle` takes `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` from
the environment (use a CI secret for releases), falling back to the desktop
addon's user config file (written by `npm run login`) for local builds.
Without them, the app shows a form asking for them.

The Telegram *session* is never bundled; each TV logs in with its own QR code.
An APK built with these values contains them, so publish only builds made
with the project's own Telegram ID.

**Adding the addon to Stremio** (`node-bootstrap/stremio-link.js`): Stremio has
no API for another app to install an addon into the Stremio app. Its
`stremio://` links are rewritten to `https://`, and its `http` handler only
takes magnets. But addons live in the user's Stremio *account*, and the app
syncs them. So the TV shows a QR code from Stremio's own link login
(`link.stremio.com`). Once the user confirms it, the app reads the account's
addon collection, appends or refreshes Telemedia, writes it back and verifies,
then logs that session out. It never writes unless it read a non-empty list.
Fallback: the "Open Stremio Add-ons" button plus the URL.

**Releasing** (`.github/workflows/release.yml`): push a tag `vX.Y.Z`. CI runs the
addon tests, stages the bundle with the Telegram ID from secrets, builds the APK
signed with the release key (versionName from the tag, versionCode =
major·10000 + minor·100 + patch), and attaches `Telemedia-vX.Y.Z.apk` to a GitHub
Release. It refuses to run if any secret is missing. Required repository
secrets: `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEMEDIA_KEYSTORE_BASE64`,
`TELEMEDIA_KEYSTORE_PASSWORD`, `TELEMEDIA_KEY_ALIAS`, `TELEMEDIA_KEY_PASSWORD`.

The release keystore is not in the repo. Keep it and its password backed up:
Android only installs updates signed with the same key. Local builds
(`tv:deploy`) use the debug key unless `TELEMEDIA_KEYSTORE*` is set, and a
device can't switch between debug- and release-signed builds without an
uninstall.

Logs: `adb logcat -s TelemediaNode NodeService`

Notes:
- ABIs: `arm64-v8a`, `armeabi-v7a` (common on TV boxes), `x86_64` (emulator).
- nodejs-mobile has no full ICU, so addon code must not use regex `\p{…}` or
  `String.prototype.normalize`.
- `lru-cache` is pinned to v10 in the bundle, because v11 needs Node 20+.
