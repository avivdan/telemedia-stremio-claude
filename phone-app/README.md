# Telemedia for Android phones

Watch movies and series from your Telegram channels and groups in
[Stremio](https://www.stremio.com): on your Android phone, and on any TV or
computer on the same Wi-Fi. The phone is the server: everyone uses their own
phone with their own Telegram, and can connect it to a TV and disconnect it
again. No computer and no cloud.

## What you need

- An Android phone (Android 7 or newer)
- [Telegram](https://play.google.com/store/apps/details?id=org.telegram.messenger) on the same phone, logged in
- [Stremio](https://play.google.com/store/apps/details?id=com.stremio.one) on the same phone, and a Stremio account

## Setup (about 2 minutes, once)

1. **Install the app.** The APK (`Telemedia-Phone-vX.Y.Z.apk`) is shared
   privately: ask whoever gave you Telemedia. Open it on the phone; Android
   asks once to allow installing apps from that app (Files, Chrome, …): allow,
   then **Install**.
2. **Open Telemedia** and allow notifications (it shows that it is running).
3. **Log in to Telegram:** type your Telegram phone number (with the country
   code, e.g. +972 …) and tap **Send code**. Telegram sends a code to your
   Telegram app (chat *Telegram*): type it in Telemedia and tap **Log in**. If
   your account has a two-step verification password, type it too.
   Telemedia then gets your own Telegram API key by itself (about a minute).
   You'll see a "login code" message in the *Telegram* chat: nothing to do,
   Telemedia reads it.
4. **Suggested groups:** tick the groups and channels you want to join, tap
   **Join selected** (or **Skip**). You can leave them anytime in Telegram.
5. **Add to Stremio:** tap **Add to Stremio**. A Stremio page opens in the
   browser: log in with **the same Stremio account as the Stremio app** on
   this phone (and on your TV), confirm, then come back to Telemedia.
6. **Allow running in the background** when Android asks, so videos don't stop
   while you watch.

Done. Open Stremio, pick any movie or episode, choose a **Telemedia** stream.

If Telemedia doesn't show up in Stremio yet, close Stremio and open it again.
Still not there? Stremio on the phone is logged in to another account: tap
**Add to Stremio again** in Telemedia and log in with that account.

## Watch on a TV or computer

The phone can serve Stremio on any TV or computer on the same Wi-Fi, like a
small home server: your own TV, or a friend's.

1. In Telemedia, under **Watch on a TV or computer**, tap **Connect a user**.
   A user is a Stremio account: the one on your own TV or computer, or a
   friend's. Then either:
   - log in to **that user's Stremio account** on the page that opens and
     confirm, or
   - let that user scan the code shown in Telemedia with **their own
     phone** and confirm there (no password typed on your phone).
   Stremio on every device logged in to that account now lists
   **Telemedia (*your name*'s phone)**.
2. Keep the phone on the same Wi-Fi, ideally charging. It keeps serving with
   the screen off.
3. **Done with that user?** Find their account under **Connected Stremio
   accounts** (the bottom of that card) and tap **Remove from Stremio
   account**, right below it. That deletes Telemedia from that Stremio account,
   ends the phone's session in it and gives your phone a new personal key, so
   that user can't use your phone anymore. Your other connected accounts (your
   own TV) get the new key by themselves. **Connect another user** (the main
   button once one is connected) adds one more account.

The list in Telemedia shows every connected Stremio account. If the phone's
Wi-Fi address changes (another network, a new IP), Telemedia updates all of
them by itself. If you remove Telemedia inside Stremio instead, it stays
removed.

It works in every Stremio app: Android TV, the PC app, web.stremio.com and
the smart-TV apps (tested on Hisense VIDAA; LG and Samsung use the same kind
of app). The address looks like
`https://192-168-0-104.local-ip.sh:7443/<key>/manifest.json`: your phone's
Wi-Fi IP with dashes, and a personal key. Without the key, the phone answers
nothing to the network. Don't share it.

Why `local-ip.sh`: Stremio's web-based apps (smart TVs, web.stremio.com)
only load `https://` add-ons. [local-ip.sh](https://local-ip.sh) is a free
public service: the name `192-168-0-104.local-ip.sh` simply points to
192.168.0.104, and it hands out a valid certificate for such names. Two cases
where smart-TV apps can't use it (Telemedia says so on its screen, and
Android TV and computers still work over plain `http`):
- local-ip.sh can't be reached the first time the app starts: Telemedia keeps
  trying (after 30 s, then less and less often) and switches by itself.
- The router blocks such names ("DNS rebinding protection", common on some
  routers and ad blockers): allow `local-ip.sh` in its settings. To check,
  open the address in the TV's web browser: it should show some text, not
  "can't find the server".

**Give the phone a fixed address at home.** The address contains the phone's
Wi-Fi IP. It's simplest to set a *DHCP reservation* for the phone in your
router (often under LAN / DHCP settings: pick the phone, "reserve IP" or
"static lease"). On Android also set *Wi-Fi → your network → Privacy → Use
device MAC*, or the phone may show up with a new MAC (and IP) after a while.

On a device that runs its own Telemedia (the TV app), you see both: its own
**Telemedia** and your phone's. To use only the phone there, uninstall the
Telemedia TV app. Don't remove **Telemedia** (without "phone") in Stremio's
Add-ons: that removes it from the whole account, including your phone.

**Outside home?** Not built in. One option: install
[Tailscale](https://tailscale.com) on the phone and the other device, and use
the phone's Tailscale IP in the address instead.

## Everyday use

- Nothing to do: Telemedia runs in the background (see its notification) and
  starts by itself when the phone turns on.
- **Stop Telemedia** (in the app, or **Stop** in its notification) stops it
  completely: nothing runs, TVs can't use the phone. It stays stopped, also
  after a restart of the phone, until you tap **Start Telemedia**.
- **Restart** in the app fixes most hiccups.
- **Log out:** at the top of Telemedia, next to "Logged in to Telegram as
  *name*". It also takes your TVs out, and the phone forgets that account's
  API key. The next login is like the first one, with any Telegram account:
  that account gets its own key. (Telemedia only finds videos in chats that
  account is in.) You can also sign the phone out from Telegram:
  *Settings → Devices*. That keeps the key, so use **Log out** here to switch
  to another account.
- Updates: install the new APK over the old one. It keeps your login.

## Good to know

- Your Telegram login stays on the phone. It's only sent to Telegram. It is
  not backed up or copied to a new phone: on a new phone, log in again.
- Only Telemedia itself can control it: other apps and web pages on the phone
  can't (each start makes a new secret only the app knows).
- Other devices on your Wi-Fi can only use Telemedia with the address that
  has your personal key in it. The `https` in it does not make it private:
  local-ip.sh's certificate key is public by design, so treat it like plain
  http. Use it at home, not on public Wi-Fi.
- If Telegram says "too many tries", wait a few hours before trying again.
- Telemedia and Telemedia TV can share one Stremio account: each device plays
  from its own Telemedia.

## Testing checklist

Before sharing a new APK. First the automated tests (no network, a few
seconds):

```bash
npm test
```

Then by hand, on a real phone and TV. Each line: what to do → what should
happen.

**Must pass**

1. **Login** (only with a number that hasn't tried today: Telegram blocks
   repeated my.telegram.org codes for hours) → phone number, code, two-step
   password if any → "Logged in", the own API key arrives by itself (about a
   minute), then the groups step.
2. **Suggested groups** → tick two, **Join selected** → they show up in
   Telegram.
3. **Stremio on the phone** → **Add to Stremio** with the same account as the
   phone's Stremio app → search a Hebrew title (e.g. החברים של נאור): results
   in the **חיפוש בעברית** row → an episode plays.
4. **Connect a user** → the TV's Stremio lists **Telemedia (*name*'s phone)** →
   plays on an Android TV and on a smart-TV app (VIDAA / LG / Samsung) → skip
   forward and back → pause a few minutes and resume.
5. **Screen off** → phone screen off while the TV plays, 10+ minutes → keeps
   playing.
6. **Battery** → *Settings → Apps → Telemedia → Battery*: **Unrestricted**
   (the app asks once).
7. **Phone reboot** without opening Telemedia → its notification appears by
   itself → the TV plays.
8. **Stop** in the notification → stops → open the app: "Telemedia is
   stopped" → **Start Telemedia** → back. Stop again, reboot → still stopped.
9. **Remove** → with a second Stremio account connected (**Connect another
   user**, that user scans the code with their own phone and confirms) →
   **Remove from Stremio account** under that account → that TV can't play anymore, even
   a video it was playing → your own TV still plays (it got the new key).

**Worth checking**

10. **No internet** → airplane mode, open the app → "Waiting for an internet
    connection…" → airplane mode off → continues by itself.
11. **New Wi-Fi address** (reconnect, or another router) → TVs keep working
    within about a minute.
12. **Remove inside Stremio** → remove "Telemedia (*name*'s phone)" in a TV's
    Stremio Add-ons → it stays removed (Telemedia forgets that account).
13. **Log out** (top of the screen, next to "Logged in to Telegram as …") →
    the TVs lose Telemedia too (it leaves their Stremio accounts) → log in
    again, also with another account: it runs like a first login and fetches
    that account's own API key (mind item 1).

Something wrong with a TV? `adb logcat -s TelemediaNode | grep "\[lan\]"`
shows each request from other devices (key removed).

---

## For developers

The app embeds Node.js ([nodejs-mobile](https://github.com/nodejs-mobile/nodejs-mobile),
Node 18) and runs the Telemedia addon on the phone, like the TV app does. The
addon is not copied here: the build compiles it from the TV project, so there
is one addon codebase.

```
proj/
  telemedia-stremio-claude/   addon/ (the Stremio addon) and tv-app/ (TV app)
  telemedia-phone/            this repo
```

```
MainActivity (UI process)                NodeService (":node" process, foreground service)
  one card per setup step       ──▶       node-bootstrap/main.js
  polls 127.0.0.1:7001                      ├─ control server 127.0.0.1:7001 (status + actions)
                                            ├─ login.js   Telegram login on the phone
                                            ├─ setup.js   own API key (starter key → own key)
                                            ├─ groups.js  head-start groups (join on request)
                                            ├─ lan.js     gateway 0.0.0.0:7000 (+ https :7443) → addon
                                            ├─ stremio-account.js  LAN entry in the Stremio account
                                            ├─ tv/stremio-link.js, tv/my-telegram.js (from the TV app)
                                            └─ require(addon dist) → addon on 127.0.0.1:7010
BootReceiver → starts NodeService on boot, once set up
```

**Serving other devices** (`lan.js`). The addon is unchanged and listens on
127.0.0.1:7010 only. A gateway on 0.0.0.0:7000 forwards to it:
- from the phone itself (127.0.0.1), no key: `http://127.0.0.1:7000/manifest.json`;
- from the network, only with the personal key (random, made once, in the
  app's `config.json`): `http://<phone-ip>:7000/<key>/manifest.json`. Anything
  else from the network gets 404. For keyed requests the gateway rewrites the
  stream URLs to the keyed address (from the request's `Host`) and serves the
  manifest as `community.telemedia.lan` / "Telemedia (phone)", so the account
  holds it next to the 127.0.0.1 entry instead of replacing it. When the
  phone's own Stremio uses the 127.0.0.1 entry, keyed catalog/stream requests
  from the phone itself get empty answers (no duplicates).
- The same gateway answers HTTPS on 0.0.0.0:7443 with local-ip.sh's public
  `*.local-ip.sh` certificate (Let's Encrypt; `server.pem`/`server.key`
  downloaded from local-ip.sh, checked for name, dates and key match, kept in
  the app's files, refreshed every 6 h when within 20 days of expiry). Once it
  listens, the advertised address becomes
  `https://<ip-with-dashes>.local-ip.sh:7443/<key>/manifest.json` and keyed
  answers carry `https://` stream URLs (scheme and host from the request).
  Needed because Stremio's web apps only load https add-ons from other
  devices (mixed content). `OPTIONS` preflights on keyed URLs get CORS and
  `Access-Control-Allow-Private-Network: true`. The certificate key is public,
  so this is reachability, not secrecy; the path key is the access control.
  Routers with DNS-rebinding protection may refuse such names; then use the
  http address.
- **Connected accounts** (`stremio-account.js`, `config.stremioLinks`):
  "Connect a user" is the link login (link.stremio.com; the page opens on the
  phone, and its QR code is shown for that user's own phone). The phone's
  entry is added to that account and the session key kept (app-private), one
  per account (`getUser` tells accounts apart). Every account is updated when
  the address, http/https or the key changes; automatic updates only replace
  this phone's existing entry (never re-add one the user removed in Stremio,
  never swap https for http, never write a guessed address). "Remove" deletes
  the entry, logs that session out and makes a new LAN key; the remaining
  accounts get the new address.
- **One entry per phone:** id `community.telemedia.lan.<phoneId>` (random,
  stable per phone) and name "Telemedia (<Telegram first name>'s phone)", so
  several people's phones can sit in one TV account. Updates match only this
  phone's id (or, for entries from older versions with the shared id
  `community.telemedia.lan`, this phone's key or address).
- The first "Add to Stremio" (the 127.0.0.1 entry, `stremio-link.js`) goes to
  whatever account is logged in on the Stremio web page, which may not be the
  phone's Stremio app's account (seen in testing). The app only says "All
  set" once Stremio on the phone actually calls Telemedia (127.0.0.1 or its
  LAN address).
- Every request from the network is logged (`[lan] from <ip>: METHOD path`,
  video requests with their answer; key removed):
  `adb logcat -s TelemediaNode | grep "\[lan\]"`.
- While a video streams, `NodeService` holds a partial wake lock (renewed,
  30-minute safety timeout) and a Wi-Fi lock (it polls `activeStreams` in
  `/status`; a failed poll changes nothing).

**Who may talk to the phone.**
- The control server (127.0.0.1:7001) needs a secret that `NodeService` makes
  at every start, writes to the app's files (`control.token`) and passes to
  Node; `ControlClient` sends it as `X-Telemedia-Token`. Requests with an
  `Origin` (browser pages) or another host name (DNS rebinding) are refused.
  `npm run my-groups` gets in with a short-lived developer token instead:
  it pushes a random one over adb into the app's own external folder
  (`Android/data/com.telemedia.phone/files/dev-token`, Android 11+ only, where
  other apps can't reach it), Node accepts it for 15 minutes, and the script
  deletes it at the end. No token is ever inside the APK.
- **Log out of Telegram** also takes this phone out of every connected
  Stremio account, ends those sessions and changes the key, so whoever logs
  in next doesn't inherit the TVs. It also forgets the api_id/api_hash: they
  are the my.telegram.org app of the account that logged out, so the next
  account never runs on them and gets its own through the first-run setup.
- The keyless addon address (127.0.0.1:7000) is for Stremio on the phone:
  browser pages on the phone are refused (only Stremio's own web origins may
  call it), and so are other host names. Other *apps* on the phone can still
  use it, as with the TV app (Stremio needs it keyless).
- **Only offered videos.** The gateway lets a video (or a message's details)
  through only if the addon itself handed it out: a stream link, a catalog
  or a group's video list (`createMediaAllowlist` in `lan.js`, kept in the
  app's files so a resumed video still plays). Guessed message numbers get
  404: the addon's own lookup would otherwise fall back to all of the
  account's chats, private ones included. Every answer carries
  `X-Content-Type-Options: nosniff` and a `sandbox` CSP, non-video files are
  sent as downloads, addresses with broken percent-encoding get 400, and an
  unexpected error is logged instead of ending the process.
- **Stop Telemedia** stops the service; the `:node` process ends in
  `onDestroy`, and a `stopped` flag file keeps it stopped (boot receiver,
  opening the app) until Start/Restart.
- Nothing is backed up or moved to a new phone (`allowBackup="false"`,
  `data_extraction_rules.xml`).

**Build and install** (Android SDK with NDK and CMake 3.22.1, JDK 17; both
found under `%LOCALAPPDATA%\Android` if `JAVA_HOME`/`ANDROID_HOME` aren't set):

```bash
npm run libnode                          # once: Node runtime → app/libnode/
npm test                                 # unit tests (no network)
npm run deploy -- 192.168.0.50:41234     # bundle, build, adb install, start (keeps the installed version number)
npm run my-groups [-- --invites]         # your chats, to choose head-start groups (developer builds)
npm run release -- 0.2.0                 # signed APK in release/
```

Wireless debugging: on the phone, *Developer options → Wireless debugging →
Pair device with pairing code*, then `adb pair <ip>:<pair-port>` and
`adb connect <ip>:<port>` (the port shown on the Wireless debugging screen).
If the phone shows "offline": `adb kill-server`, then `adb connect` again.

**Telegram login on one phone.** The TV app shows a QR code that another
phone scans. A phone can't scan its own screen, and Telegram refuses
`tg://login?token=…` links opened on the phone itself (it answers "go to
Settings > Devices > Scan QR"; tested on a Galaxy S24 FE). So the phone app
logs in with the phone number: `auth.sendCode` sends a code to the Telegram
app, the user types it (`login.js`). The first-run setup is the TV app's automatic one
(`setup.js`): the bundled starter key logs in, the my.telegram.org login code
is read from the *Telegram* chat (777000), the user's own api_id/api_hash is
read or created (`my-telegram.js`), then the own key logs in by approving its
login token from the starter session (`auth.acceptLoginToken`) and the
starter session logs out. If that fails, the app shows the same
my.telegram.org steps by hand, or takes a pasted api_id/api_hash.

**Adding the addon to Stremio** (`stremio-link.js`, shared with the TV app):
"Add to Stremio" opens Stremio's link login (link.stremio.com) in the browser.
Once the user confirms, the app reads the account's addon collection, adds or
refreshes Telemedia, writes it back, verifies it and logs that session out.
The Stremio app syncs the account's addons.

**Build-time settings, outside the repo** (in `~/Documents/telemedia-signing`,
or `TELEMEDIA_SIGNING_DIR`), all optional except for releases:

| File | What |
|---|---|
| `signing.properties` + keystore | Release signing (same key as the TV app). `deploy` uses it too, so deploys and releases can replace each other. |
| `starter.properties` | `apiId=…`, `apiHash=…`: the starter key, stored scrambled in `defaults.json`. Share an APK with it privately. |
| `groups.txt` | Head-start groups: one `t.me/name`, `@name` or invite link (`t.me/+…`) per line, optional ` \| note`. Or `TELEMEDIA_GROUPS`. No groups are built in. |

Addon settings (`CATALOG_COUNTRY`, `TG_HEBREW_GROUP`, …) come from the
environment or the addon's user config file, as for the TV app.

Logs: `adb logcat -s TelemediaNode NodeService`

Notes:
- ABIs: `arm64-v8a`, `armeabi-v7a`.
- nodejs-mobile has no full ICU, so addon code must not use regex `\p{…}` or
  `String.prototype.normalize`. `lru-cache` is pinned to v10 (v11 needs Node 20+).
- The TV helpers (`my-telegram.js`, `stremio-link.js`, `starter-login.js`)
  are copied from `../telemedia-stremio-claude/tv-app/node-bootstrap` at
  build time; `bundle-node.mjs` checks they still export what the phone uses.
