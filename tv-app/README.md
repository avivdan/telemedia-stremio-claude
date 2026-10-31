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
2. **Open Telemedia. Two QR codes appear.** Scan both with your phone, in any order:
   - **Telegram:** in the Telegram app, *Settings → Devices → Link Desktop Device*.
     If you use a two-step verification password, type it on the TV.
     The TV then gets your own Telegram API key from my.telegram.org by itself
     (about a minute; it creates an app named "Telemedia TV" if your account has
     none). You'll see a "Web login code" message in your *Telegram* chat: the
     TV reads it, nothing to do.
   - **Stremio:** with the phone camera. Confirm on the page that opens (log in
     to Stremio there if asked). This adds Telemedia to your Stremio account.

   If that automatic step fails, or if your build has no starter key (see *For
   developers*), the TV shows a setup code instead: scan it with the phone camera
   (same Wi-Fi as the TV), enter your phone number and the login code Telegram
   sends you, or paste an api_id/api_hash you already have. If Telegram says
   "too many tries", wait a few hours.

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

**Keys.** None are built into the APK. Titles, Hebrew search and the
streaming-service rows come from Cinemeta, Wikidata and JustWatch, all keyless.
For Telegram, the addon always runs on the user's **own** API ID/hash (stored in
the app's private `config.json`), so each user is on their own rate limits.

First-run setup has two paths:
- **Starter key (automatic)**, `node-bootstrap/starter-login.js`: the build
  bundles one shared api_id/api_hash, used only during setup. The user scans
  a QR login made with it; the TV reads the account's phone number, asks
  my.telegram.org for a code, reads that code from the *Telegram* chat (777000),
  reads or creates the user's own app (`my-telegram.js`), then logs in under the
  own key by approving its login token from the starter session and logs the
  starter session out. If the switch fails, the user scans a second QR code.
  Put the key in `~/Documents/telemedia-signing/starter.properties`
  (`apiId=…` and `apiHash=…`, outside the repo) or `TELEMEDIA_STARTER_API_ID` /
  `TELEMEDIA_STARTER_API_HASH`. Create it as its own app on my.telegram.org,
  ideally from a spare account: it is public inside the APK, and if Telegram
  bans it only new setups stop (they fall back to the phone page).
- **Phone page** (`setup-server.js` + `my-telegram.js`), without a starter key or
  when the automatic path fails: a page on `<tv-ip>:7002` takes the phone number
  and the my.telegram.org login code, then the TV reads the keys from `/apps`
  (creating the app if needed). Without a LAN address the screen falls back to
  typing the keys on the TV.

**Adding the addon to Stremio** (`node-bootstrap/stremio-link.js`): Stremio has
no API for another app to install an addon into the Stremio app. Its
`stremio://` links are rewritten to `https://`, and its `http` handler only
takes magnets. But addons live in the user's Stremio *account*, and the app
syncs them. So the TV shows a QR code from Stremio's own link login
(`link.stremio.com`). Once the user confirms it, the app reads the account's
addon collection, appends or refreshes Telemedia, writes it back and verifies,
then logs that session out. It never writes unless it read a non-empty list.
Fallback: the "Open Stremio Add-ons" button plus the URL.

**Releasing.** Either way the APK is signed with the release key, with
versionName from the version you give and versionCode = major·10000 +
minor·100 + patch.
- **Locally, no secrets:** `npm run tv:release -- 0.3.0` builds and verifies
  `tv-app/release/Telemedia-v0.3.0.apk`, using `signing.properties` + the
  keystore from `~/Documents/telemedia-signing` (or `TELEMEDIA_SIGNING_DIR`).
  Then attach the APK to a GitHub Release.
- **GitHub Actions** (`.github/workflows/release.yml`): push a tag `vX.Y.Z`.
  It needs the keystore as repository secrets (`TELEMEDIA_KEYSTORE_BASE64`,
  `TELEMEDIA_KEYSTORE_PASSWORD`, `TELEMEDIA_KEY_ALIAS`, `TELEMEDIA_KEY_PASSWORD`)
  and refuses to run without them.

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
