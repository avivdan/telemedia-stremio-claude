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
2. **Open Telemedia.** A QR code appears.
3. **Scan it** with Telegram on your phone:
   *Settings → Devices → Link Desktop Device*.
   If you use a two-step verification password, type it on the TV.
4. **Add it to Stremio.** The app opens Stremio's Add-ons page for you.
   Choose **Add addon**, enter

   ```
   http://127.0.0.1:7000/manifest.json
   ```

   and press **Install**.

   You only do this once per Stremio account. Stremio remembers its addons,
   so on another TV with the same Stremio account, installing the Telemedia
   app is enough.

That's it. Open any movie or episode in Stremio and pick a **Telemedia** stream.

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

With developer options and network debugging enabled on the TV:

```bash
adb connect <tv-ip>:5555
adb install -r app-release.apk
```

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

`tv:bundle` copies the API ID/hash and addon settings (TMDB keys, chat IDs, …)
from `addon/.env` into the APK as defaults. **Don't share APKs built this way.**
The Telegram session is never bundled; each TV logs in with its own QR code.

**Why "add to Stremio" can't be automatic:** Stremio offers no way for another
app to install an addon. Its `stremio://` install links are rewritten to
`https://`, which a local server can't serve, and its `http` link handler only
accepts magnet links. The app opens Stremio's Add-ons page instead, and learns
it's connected from the first catalog, meta or stream request Stremio makes.

Logs: `adb logcat -s TelemediaNode NodeService`

Notes:
- ABIs: `arm64-v8a`, `armeabi-v7a` (common on TV boxes), `x86_64` (emulator).
- nodejs-mobile has no full ICU, so addon code must not use regex `\p{…}` or
  `String.prototype.normalize`.
- `lru-cache` is pinned to v10 in the bundle, because v11 needs Node 20+.
