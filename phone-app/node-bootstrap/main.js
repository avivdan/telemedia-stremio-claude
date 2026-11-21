// Entry point run by nodejs-mobile inside the Telemedia phone app.
//
// argv[2] = absolute path to config.json in the app's private files dir.
// config.json: { apiId, apiHash, session?, stremioAdded?, stremioConnected?,
//                groupsDone?, lanKey?, phoneId?, ownerName?, stremioLinks? }
//
// Flow (everything on this one phone):
//   1. Control server on 127.0.0.1:7001 for the app screen (GET /status and
//      the POST actions below).
//   2. No own api_id/api_hash yet, starter key bundled → state "need_login":
//      the user logs in with the starter key (login.js: phone number + the
//      code Telegram sends to the Telegram app), then setup.js fetches the user's own key from my.telegram.org
//      and switches to it. Without a starter key, or if that fails →
//      "need_config": the same my.telegram.org steps by hand in the app, or
//      paste an api_id/api_hash.
//   3. Own key but no session → "need_login" with the own key.
//   4. Session → load the addon (dist/src/index.js) on 127.0.0.1:7000, state
//      "running".
//   5. Then, once: offer the head-start groups (groups.js); join only what the
//      user confirms.
//   6. "Add to Stremio" (stremio-link.js, shared with the TV app): Stremio's
//      link login, opened in the browser; then the addon is added to the
//      user's Stremio account, which the Stremio app syncs.

'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const stremioLink = require('./tv/stremio-link');
const myTelegram = require('./tv/my-telegram');
const { unscramble } = require('./tv/starter-login');
const { createLogin, connectOrThrow, KeyRejectedError, KEY_REJECTED } = require('./login');
const { fetchOwnKeys } = require('./setup');
const groups = require('./groups');
const lan = require('./lan');
const stremioAccount = require('./stremio-account');

const CONTROL_PORT = 7001;
const PUBLIC_PORT = 7000; // the gateway (lan.js): this phone and the LAN
const TLS_PORT = 7443; // the gateway on HTTPS, for web-based Stremio apps (lan.js)
const ADDON_INTERNAL_PORT = 7010; // the addon itself, 127.0.0.1 only
const MAX_BODY = 8192;
const STREMIO_PAIRING_MS = 20 * 60 * 1000; // stop polling Stremio after this
const cfgPath = process.argv[2];
// The app's secret for the control server, new for every start (NodeService
// passes it; only the app, which can read its own files, knows it).
const CONTROL_TOKEN = process.argv[3] || '';
// Developer tools only (npm run my-groups): a short-lived token that adb
// pushes into the app's own external folder (Android 11+, where other apps
// can't read or write it; NodeService passes the folder only there).
const DEV_DIR = process.argv[4] || '';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const messageOf = (err) => String(err && err.message ? err.message : err);

// One bad request or a stray promise must not take the whole app down (the
// addon, the gateway and the login all live in this one process).
process.on('uncaughtException', (err) => {
  console.error('[bootstrap] unexpected error (kept running): ' + (err && err.stack ? err.stack : err));
});
process.on('unhandledRejection', (err) => {
  console.error('[bootstrap] unhandled rejection (kept running): ' + messageOf(err));
});

let status = { state: 'starting' };
let login = null; // createLogin() while state is need_login
let configSetup = null; // need_config actions
let passwordResolver = null;
let lastPassword;
let stremioStatus = { state: 'idle' };
let stremioRun = null;
let stremioUntil = 0;
let groupsStatus = { state: 'none' };
let resolveAddonReady;
const addonReady = new Promise((r) => { resolveAddonReady = r; });

// Build-time settings (scripts/bundle-node.mjs): addon env defaults, the
// head-start groups and, optionally, the scrambled starter key.
let defaultsCache;
function readDefaults() {
  if (!defaultsCache) {
    try {
      defaultsCache = JSON.parse(fs.readFileSync(path.join(__dirname, 'defaults.json'), 'utf8'));
    } catch {
      defaultsCache = {};
    }
  }
  return defaultsCache;
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch {
    return {};
  }
}

function writeConfig(cfg) {
  const tmp = cfgPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, cfgPath);
}

function patchConfig(patch) {
  const cfg = { ...readConfig(), ...patch };
  for (const [k, v] of Object.entries(patch)) if (v === undefined) delete cfg[k];
  writeConfig(cfg);
  return cfg;
}

// stremioAdded: "Add to Stremio" put Telemedia into the account confirmed on
// the Stremio web page. stremioConnected: Stremio on this phone really asks
// Telemedia (the two differ when the web page used another account).
let stremioAdded = !!readConfig().stremioAdded;
let stremioConnected = !!readConfig().stremioConnected;

function setStatus(next) {
  status = next;
  console.log('[bootstrap] state=' + next.state + (next.setupStep ? ' step=' + next.setupStep : ''));
}

// The addon's own Telegram module: same file → same client as the addon uses.
const addonTelegram = () => require(path.join(__dirname, 'dist', 'src', 'api', 'telegram.js'));

// ---------------------------------------------------------------------------
// Control server — 127.0.0.1 only; the app screen talks to us through it.
// ---------------------------------------------------------------------------
const actions = {
  // Two-step verification password.
  '/password': async ({ password }) => {
    if (!passwordResolver) throw new Error('No password was asked for.');
    if (!password) throw new Error('Type your password.');
    const resolve = passwordResolver;
    passwordResolver = null;
    lastPassword = password;
    setStatus({ state: 'logging_in' });
    resolve(password);
  },

  // Telegram login (state need_login), see login.js.
  '/login/phone': async ({ phone }) => {
    if (!login) throw new Error('Not logging in right now.');
    const number = myTelegram.normalizePhone(phone);
    if (!number) throw new Error('Type the full number with the country code.\nLike +972 50 123 4567.');
    await login.submitPhone(number);
  },
  '/login/code': async ({ code }) => {
    if (!login) throw new Error('Not logging in right now.');
    await login.submitCode(code);
  },
  '/login/reset': async () => {
    if (login) await login.reset();
  },

  // Own API key by hand (state need_config).
  '/config/phone': async (input) => {
    if (!configSetup) throw new Error('Not needed right now.');
    return configSetup.phone(input);
  },
  '/config/code': async (input) => {
    if (!configSetup) throw new Error('Not needed right now.');
    return configSetup.code(input);
  },
  '/config/keys': async (input) => {
    if (!configSetup) throw new Error('Not needed right now.');
    return configSetup.keys(input);
  },

  // Head-start groups.
  '/groups/show': async () => {
    offerGroups(true);
  },
  '/groups/join': async ({ links }) => joinGroups(Array.isArray(links) ? links : []),
  // The account's own groups/channels, to choose head-start groups from
  // (developer tool: npm run my-groups, over adb).
  '/chats': async () => {
    if (status.state !== 'running') throw new Error('Telemedia is not running yet.');
    return { chats: await groups.listMyChats(await addonTelegram().getClient()) };
  },
  '/chats/invites': async () => {
    if (status.state !== 'running') throw new Error('Telemedia is not running yet.');
    return { chats: await groups.findInvites(await addonTelegram().getClient()) };
  },
  '/groups/skip': async () => {
    patchConfig({ groupsDone: true });
    groupsStatus = { state: 'skipped' };
  },

  // Stremio: a fresh link.stremio.com link for the "Add to Stremio" button.
  '/stremio/link': async () => ({ link: await stremioPairingLink() }),
  // Developer tools (over adb): a connected account's addons (names and
  // hosts only), and putting the 127.0.0.1 entry back into it.
  '/stremio/addons': async ({ id }) => ({ addons: await stremioAccount.listAddons(linkFor(id).authKey) }),
  // Only for the phone owner's own account (named explicitly), and in line
  // with the other account writes.
  '/stremio/repair': async ({ id }) => {
    if (!id) throw new Error('Name the account (id from /status).');
    return serialized(async () => {
      const manifest = await addonManifest();
      await stremioAccount.putAddons(linkFor(id).authKey, [
        { transportUrl: `http://127.0.0.1:${PUBLIC_PORT}/manifest.json`, manifest },
      ]);
      return { addons: await stremioAccount.listAddons(linkFor(id).authKey) };
    });
  },
  // "Connect a user": a link.stremio.com link for that user's Stremio account.
  '/lan/link': async () => {
    if (status.state !== 'running') throw new Error('Telemedia is not running yet.');
    return { link: await lanPairingLink() };
  },
  // "Remove": out of that account, and a new key (see removeLink).
  '/lan/remove': async ({ id }) => {
    if (status.state !== 'running') throw new Error('Telemedia is not running yet.');
    return removeLink(String(id || ''));
  },

  // Sign this phone out of Telegram (the app restarts us afterwards). The
  // next person to log in must not inherit the TVs: this phone's entries
  // leave every connected account, those sessions end, and the key changes.
  // Nor the Telegram key: api_id/api_hash are the my.telegram.org app of the
  // account that logs out, so they go too. The next login starts like a
  // first one and gets that account's own key (main(), step 1).
  '/logout': async () => {
    try {
      const { Api } = require('telegram');
      if (status.state === 'running') {
        const client = await addonTelegram().getClient();
        await Promise.race([client.invoke(new Api.auth.LogOut()), sleep(5000)]);
      } else if (readConfig().session) {
        await Promise.race([revokeSavedSession(), sleep(8000)]);
      }
    } catch (err) {
      console.log('[bootstrap] logout: ' + messageOf(err));
    }
    await Promise.race([disconnectAllTvs(), sleep(25_000)]).catch(() => {});
    patchConfig({
      session: undefined, apiId: undefined, apiHash: undefined,
      groupsDone: undefined, stremioLinks: undefined, ownerName: undefined, lanKey: lan.newKey(),
    });
    if (gateway) {
      gateway.dropKeyed();
      gateway.allowlist.clear(); // the next account's chats are different
    }
  },

  // The app asks us to stop; it starts a fresh process right after.
  '/exit': async () => {
    setTimeout(() => process.exit(0), 200);
  },
};

// The developer token, if adb put a fresh one there (at most 15 minutes old).
function devToken() {
  if (!DEV_DIR) return '';
  try {
    const file = path.join(DEV_DIR, 'dev-token');
    if (Date.now() - fs.statSync(file).mtimeMs > 15 * 60_000) return '';
    const token = fs.readFileSync(file, 'utf8').trim();
    return token.length >= 32 ? token : '';
  } catch {
    return '';
  }
}

// Who may use the control server: the app (CONTROL_TOKEN), or developer
// tools over adb (devToken). Never browser pages (they send an Origin) or
// other host names (DNS rebinding).
function controlAllowed(req) {
  try {
    if (req.headers.origin) return false;
    const hostName = String(req.headers.host || '').replace(/:\d+$/, '');
    if (hostName !== '127.0.0.1' && hostName !== 'localhost') return false;
    // Bytes, not characters: a header with non-ASCII characters must not make
    // timingSafeEqual throw (that would end the whole process).
    const given = Buffer.from(String(req.headers['x-telemedia-token'] || ''));
    const ok = (secret) => {
      if (!secret) return false;
      const want = Buffer.from(secret);
      return given.length === want.length && require('crypto').timingSafeEqual(given, want);
    };
    return ok(CONTROL_TOKEN) || ok(devToken());
  } catch {
    return false;
  }
}

function startControlServer() {
  const server = http.createServer((req, res) => {
    const send = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (!controlAllowed(req)) return send(403, { error: 'forbidden' });
    if (req.method === 'GET' && req.url === '/status') {
      return send(200, {
        ...status,
        stremio: stremioStatus,
        stremioConnected,
        stremioAdded,
        groups: groupsStatus,
        groupsCount: groupList().length,
        ownerName: readConfig().ownerName || null,
        lan: status.state === 'running' ? lanStatus : null,
        activeStreams: gateway ? gateway.activeStreams() : 0,
      });
    }
    const action = req.method === 'POST' && actions[req.url];
    if (!action) return send(404, { error: 'not found' });

    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > MAX_BODY) req.destroy();
    });
    req.on('end', async () => {
      let input;
      try {
        input = JSON.parse(body || '{}');
      } catch {
        return send(400, { error: 'Bad request' });
      }
      try {
        send(200, { ok: true, ...((await action(input)) || {}) });
      } catch (err) {
        send(400, { error: messageOf(err) });
      }
    });
  });
  server.listen(CONTROL_PORT, '127.0.0.1');
}

// Two-step verification password, typed in the app (POST /password).
function askPassword(hint, wrong) {
  setStatus({ state: 'need_password', hint: hint || '', wrong: !!wrong });
  return new Promise((resolve) => { passwordResolver = resolve; });
}

// ---------------------------------------------------------------------------
// Telegram login on this phone (login.js) → a logged-in TelegramClient.
// ---------------------------------------------------------------------------
async function interactiveLogin(apiId, apiHash) {
  let done = false;
  login = createLogin({
    apiId,
    apiHash,
    askPassword,
    onStatus: (view) => {
      if (done) return;
      passwordResolver = null; // a failed password step goes back to the login screen
      setStatus({ state: 'need_login', login: view });
    },
  });
  try {
    const client = await login.done;
    setStatus({ state: 'logging_in' });
    return client;
  } finally {
    done = true;
    login = null;
  }
}

// First-run setup by hand (no starter key, or the automatic way failed):
// phone number → my.telegram.org code (in the Telegram app) → own keys; or
// paste an api_id/api_hash.
function configForm(failure) {
  return new Promise((resolve) => {
    let pending = null;
    const step = (setupStep, setupError) => setStatus({ state: 'need_config', setupStep, setupError });
    const finish = (keys) => {
      configSetup = null;
      resolve({ apiId: String(keys.apiId), apiHash: String(keys.apiHash).toLowerCase() });
    };
    configSetup = {
      phone: async ({ phone }) => {
        const number = myTelegram.normalizePhone(phone);
        if (!number) throw new Error('Type the full number with the country code.\nLike +972 50 123 4567.');
        pending = await myTelegram.sendCode(number);
        step('code_sent');
      },
      code: async ({ code }) => {
        if (!pending) throw new Error('Send the phone number first.');
        try {
          const keys = await myTelegram.fetchKeys(pending, code, (s) => step(s));
          finish(keys);
          return { created: keys.created };
        } catch (err) {
          step('error', messageOf(err));
          throw err;
        }
      },
      keys: async ({ apiId, apiHash }) => {
        const id = String(apiId || '').trim();
        const hash = String(apiHash || '').trim().toLowerCase();
        if (!/^\d{3,12}$/.test(id)) throw new Error('The api_id is a number.');
        if (!/^[0-9a-f]{32}$/.test(hash)) throw new Error('The api_hash is 32 letters and numbers.');
        finish({ apiId: id, apiHash: hash });
      },
    };
    if (failure) step('error', failure);
    else step(undefined);
  });
}

// A saved session can be revoked (logged out from another device, expired).
// Detect that up front so we ask to log in again instead of crash-looping.
const DEAD_SESSION = /AUTH_KEY_UNREGISTERED|AUTH_KEY_INVALID|AUTH_KEY_DUPLICATED|SESSION_REVOKED|SESSION_EXPIRED|USER_DEACTIVATED/;

// Logs out the saved Telegram session when the addon (and its client) isn't
// running, e.g. from the error screen.
async function revokeSavedSession() {
  const { TelegramClient, Api } = require('telegram');
  const { StringSession } = require('telegram/sessions');
  const cfg = readConfig();
  const client = new TelegramClient(new StringSession(cfg.session), Number(cfg.apiId), cfg.apiHash, { connectionRetries: 1 });
  try {
    await connectOrThrow(client);
    await client.invoke(new Api.auth.LogOut());
  } finally {
    await client.destroy().catch(() => {});
  }
}

async function sessionIsValid(cfg) {
  const { TelegramClient } = require('telegram');
  const { StringSession } = require('telegram/sessions');
  const client = new TelegramClient(new StringSession(cfg.session), Number(cfg.apiId), cfg.apiHash, {
    connectionRetries: 5,
  });
  try {
    await connectOrThrow(client);
    await client.getMe();
    return true;
  } catch (err) {
    const text = String(err && (err.errorMessage || err.message));
    if (DEAD_SESSION.test(text)) return false;
    if (KEY_REJECTED.test(text)) throw new KeyRejectedError(text);
    throw err;
  } finally {
    await client.destroy().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// The addon, with config mapped to the env vars its src/config.ts reads. It
// listens on 127.0.0.1:ADDON_INTERNAL_PORT only; the gateway (lan.js) on
// PUBLIC_PORT is what Stremio talks to, here and on other devices.
// ---------------------------------------------------------------------------
function waitForAddon() {
  const deadline = Date.now() + 60_000;
  const probe = () => {
    http
      .get({ host: '127.0.0.1', port: ADDON_INTERNAL_PORT, path: '/manifest.json', timeout: 2000 }, (res) => {
        res.resume();
        if (res.statusCode === 200) {
          const manifestUrl = `http://127.0.0.1:${PUBLIC_PORT}/manifest.json`;
          setStatus({ state: 'running', manifestUrl });
          resolveAddonReady({ manifestUrl });
          offerGroups(false);
        } else retry();
      })
      .on('error', retry);
  };
  const retry = () => {
    if (status.state !== 'starting_addon') return; // addon already failed
    if (Date.now() > deadline) return setStatus({ state: 'error', error: 'addon did not start (see logs)' });
    setTimeout(probe, 500);
  };
  probe();
}

function startAddon(cfg) {
  const base = 'http://127.0.0.1:' + PUBLIC_PORT; // the gateway
  for (const [k, v] of Object.entries(readDefaults().env || {})) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
  process.env.TELEGRAM_API_ID = String(cfg.apiId);
  process.env.TELEGRAM_API_HASH = cfg.apiHash;
  process.env.TELEGRAM_SESSION = cfg.session;
  process.env.ADDON_HOST = '127.0.0.1';
  process.env.ADDON_PORT = String(ADDON_INTERNAL_PORT);
  process.env.PUBLIC_BASE_URL = base;
  process.env.STREAM_BASE_URL = base;

  // src/index.ts calls process.exit(1) on fatal errors. Keep the process (and
  // the control server) alive so the app can show the error instead of the
  // service crash-looping. Clean exits (POST /exit) still go through.
  const realExit = process.exit.bind(process);
  process.exit = (code) => {
    if (code) {
      setStatus({ state: 'error', error: `addon failed to start (exit ${code}), see logs` });
      return undefined;
    }
    return realExit(code);
  };

  setStatus({ state: 'starting_addon' });
  require(path.join(__dirname, 'dist', 'src', 'index.js'));
  startLan();
  waitForAddon();
}

// ---------------------------------------------------------------------------
// Other devices (lan.js): the gateway, the phone's Wi-Fi address, and the
// Stremio accounts this phone is connected to (stremio-account.js).
//
// A phone is a portable server: its owner connects it to any TV's Stremio
// account ("Connect a user"), the TV plays through the phone's personal key,
// and "Remove" takes it out of that account again and scrambles the key, so
// that TV can't use the old address anymore. The phone's other connected
// accounts get the new address automatically, as on every Wi-Fi address
// change (one kept Stremio session per account, app-private).
// ---------------------------------------------------------------------------
const LAN_CHECK_MS = 15_000;
const LAN_RETRY_MS = 2 * 60_000;
const CERT_CHECK_MS = 6 * 60 * 60_000;
let gateway = null;
let certStore = null;
let lanStatus = { ip: null, url: null, secure: false, pairing: { state: 'idle' }, accounts: [], tls: { state: 'waiting' } };
let certRetryMs = 30_000; // while there is no certificate: 30 s, doubling up to 1 h
let certRetryTimer = null;
// The https name (192-168-0-104.local-ip.sh) must resolve to the phone; some
// routers refuse such answers (DNS-rebinding protection). Checked per address.
const tlsNameCheck = { ip: null, ok: true, at: 0 };
let ipSource = 'interfaces';
let lanPairing = null; // the newest link login; older ones stop
const retryAt = new Map(); // link id → next try after a failed update
let lastLocalStremio = 0; // last Stremio request on 127.0.0.1
const LOCAL_IN_USE_MS = 10 * 60_000;
let linksBusy = Promise.resolve(); // account writes one at a time

function lanKey() {
  let key = readConfig().lanKey;
  if (!key) {
    key = lan.newKey();
    patchConfig({ lanKey: key });
  }
  return key;
}

// Stable per phone (not per key), so a new key replaces this phone's entry
// in place, and two people's phones never replace each other's entries.
function phoneId() {
  let id = readConfig().phoneId;
  if (!id) {
    id = require('crypto').randomBytes(4).toString('hex');
    patchConfig({ phoneId: id });
  }
  return id;
}

const lanAddonId = () => 'community.telemedia.lan.' + phoneId();

// "Telemedia (Blue's phone)": tells phones apart on a shared TV.
function lanAddonName() {
  const owner = readConfig().ownerName;
  return owner ? `Telemedia (${owner}'s phone)` : 'Telemedia (phone)';
}

function myLanManifest(manifest) {
  return lan.lanManifest(manifest, { id: lanAddonId(), name: lanAddonName() });
}

// What an account entry was last written with; a different one (new app
// version, new name) means the entry needs rewriting even at the same address.
let addonVersionCache;
function addonVersion() {
  if (addonVersionCache === undefined) {
    try {
      addonVersionCache = String(require(path.join(__dirname, 'dist', 'src', 'manifest.js')).manifest.version || '');
    } catch {
      addonVersionCache = '';
    }
  }
  return addonVersionCache;
}
const lanEntryTag = () => `${lanAddonId()}|${lanAddonName()}|${addonVersion()}`;

// The address other devices use. HTTPS (local-ip.sh name) once the
// certificate is there: it works in every Stremio app, including the
// web-based ones on smart TVs; plain http only in the native apps.
function lanUrl(ip) {
  if (!ip) return null;
  const nameOk = tlsNameCheck.ip !== ip || tlsNameCheck.ok;
  return gateway && gateway.tlsActive() && nameOk
    ? `https://${lan.tlsHostname(ip)}:${TLS_PORT}/${lanKey()}/manifest.json`
    : `http://${ip}:${PUBLIC_PORT}/${lanKey()}/manifest.json`;
}

// Does 192-168-x-y.local-ip.sh resolve to this phone on this network?
// (Only what the phone sees: a TV with other DNS may still differ.)
async function checkTlsName(ip) {
  if (!ip || (tlsNameCheck.ip === ip && Date.now() - tlsNameCheck.at < 10 * 60_000)) return;
  let ok = false;
  try {
    const { address } = await require('dns').promises.lookup(lan.tlsHostname(ip), { family: 4 });
    ok = address === ip;
  } catch {
    ok = false;
  }
  if (tlsNameCheck.ip === ip && tlsNameCheck.ok !== ok) console.log('[lan] https name ' + (ok ? 'resolves again' : 'no longer resolves'));
  else if (!ok) console.log('[lan] the https name does not resolve on this network (router DNS protection?): using http');
  Object.assign(tlsNameCheck, { ip, ok, at: Date.now() });
}

async function addonManifest() {
  const res = await fetch(`http://127.0.0.1:${ADDON_INTERNAL_PORT}/manifest.json`);
  return res.json();
}

// --- connected accounts: config.stremioLinks = [{ id, authKey, userId, user, url, broken? }]
function readLinks() {
  return readConfig().stremioLinks || [];
}

function linkFor(id) {
  const links = readLinks();
  const link = id ? links.find((l) => l.id === id) : links[0];
  if (!link) throw new Error('No connected Stremio account.\nTap Connect a user first.');
  return link;
}

function saveLinks(links) {
  patchConfig({ stremioLinks: links });
  publishAccounts();
}

// For the app screen: never the session keys.
function publishAccounts() {
  const url = lanStatus.url;
  lanStatus = {
    ...lanStatus,
    accounts: readLinks().map((l) => ({
      id: l.id,
      user: l.user || 'Stremio account',
      ok: !l.broken && !!url && l.url === url && l.tag === lanEntryTag(),
      broken: !!l.broken,
    })),
  };
}

// One account write at a time (they read-modify-write the same lists).
function serialized(fn) {
  const run = linksBusy.then(fn, fn);
  linksBusy = run.catch(() => {});
  return run;
}

// Earlier versions kept a single session as stremioAuthKey/lanAccountUrl.
function migrateLinks() {
  const cfg = readConfig();
  if (!cfg.stremioAuthKey) return;
  const links = cfg.stremioLinks || [];
  if (!links.some((l) => l.authKey === cfg.stremioAuthKey)) {
    links.push({ id: newLinkId(), authKey: cfg.stremioAuthKey, url: cfg.lanAccountUrl || null });
  }
  patchConfig({ stremioLinks: links, stremioAuthKey: undefined, lanAccountUrl: undefined });
}

const newLinkId = () => require('crypto').randomBytes(4).toString('hex');

// The account's email, shown in full in the app's list (only the app can read
// the status), so the user knows exactly which account it is.
function accountName(email) {
  const e = String(email || '').trim();
  return e.includes('@') ? e : null;
}
// Versions up to 0.2.4 saved it shortened, like "av…@gmail.com".
const SHORTENED_NAME = /…@/;

// Names for accounts that have none yet, or only the shortened one an older
// version saved. In line with the other account writes, so it can't undo a
// Connect or a Remove. Stremio not answering: tried again in 2 minutes, then
// less often (at most hourly) while it keeps failing.
const NAMES_RETRY_FIRST_MS = 2 * 60_000;
const NAMES_RETRY_MAX_MS = 60 * 60_000;
let namesRetry = null;
let namesRetryMs = NAMES_RETRY_FIRST_MS;
function fillUserNames() {
  clearTimeout(namesRetry);
  namesRetry = null;
  return serialized(async () => {
    const found = new Map(); // link id → fields to set
    let again = false;
    for (const l of readLinks()) {
      if ((l.user && !SHORTENED_NAME.test(l.user)) || l.broken) continue;
      try {
        const u = await stremioAccount.getUser(l.authKey);
        found.set(l.id, { userId: u.id, user: accountName(u.email) || l.user });
      } catch (err) {
        console.log(`[lan] account ${l.id}: name: ${messageOf(err)}`); // the id, never the email
        if (stremioAccount.isAuthError(err)) found.set(l.id, { broken: true });
        else again = true;
      }
    }
    // Into the list as it is now: a logout may have cleared it meanwhile (it
    // doesn't wait in this line), and its accounts must not come back.
    const links = readLinks();
    const hits = links.filter((l) => found.has(l.id));
    for (const l of hits) Object.assign(l, found.get(l.id));
    if (hits.length) saveLinks(links);
    if (again) {
      namesRetry = setTimeout(() => fillUserNames().catch(() => {}), namesRetryMs);
      namesRetryMs = Math.min(namesRetryMs * 2, NAMES_RETRY_MAX_MS);
    } else {
      namesRetryMs = NAMES_RETRY_FIRST_MS;
    }
  });
}

// Writes the current address into one account. → true when it's up to date.
// → 'ok' | 'missing' (automatic update, but the user removed the entry in
// Stremio: leave it removed) | 'failed'.
async function updateLink(link, url, manifest, { automatic = false } = {}) {
  if (!url) return 'failed';
  try {
    const key = lanKey();
    const result = await stremioAccount.putAddons(link.authKey, [{ transportUrl: url, manifest }], {
      // Only ever our own entries: this phone's id, or (earlier versions used
      // one id for every phone) the old id with our address or key in it.
      replaces: (a) => !!a.manifest && (a.manifest.id === lanAddonId()
        || (a.manifest.id === 'community.telemedia.lan'
          && (a.transportUrl === link.url || String(a.transportUrl).includes(`/${key}/`)))),
      onlyReplace: automatic,
    });
    console.log(`[lan] Stremio account ${link.id}: ${result}`);
    if (result === 'missing') return 'missing';
    link.url = url;
    link.tag = lanEntryTag();
    link.broken = false;
    retryAt.delete(link.id);
    return 'ok';
  } catch (err) {
    console.log(`[lan] could not update Stremio account ${link.id}: ${messageOf(err)}`);
    if (stremioAccount.isAuthError(err)) link.broken = true;
    retryAt.set(link.id, Date.now() + LAN_RETRY_MS);
    return 'failed';
  }
}

// Brings every connected account to the current address (after a Wi-Fi
// change, http → https, or a new key).
// Automatic: never adds an entry the user removed in Stremio (that account is
// then forgotten), never swaps an https address for http (smart-TV apps
// would lose it; a "Connect a user" tap still writes whatever is current), and
// never writes a guessed address.
const targetUrl = (link, url, key) => lan.accountTargetUrl(link.url, url, key, ipSource);

function refreshLinks() {
  return serialized(async () => {
    const url = lanStatus.url;
    const key = lanKey();
    let links = readLinks();
    const tag = lanEntryTag();
    const stale = links
      .map((l) => ({ l, to: targetUrl(l, url, key) }))
      .filter(({ l, to }) => !l.broken && to && (l.url !== to || l.tag !== tag) && (retryAt.get(l.id) || 0) < Date.now());
    if (!stale.length) return;
    const manifest = myLanManifest(await addonManifest());
    const gone = [];
    for (const { l, to } of stale) {
      if ((await updateLink(l, to, manifest, { automatic: true })) === 'missing') gone.push(l);
    }
    for (const l of gone) {
      console.log(`[lan] account ${l.id}: removed in Stremio, forgetting it`);
      stremioAccount.logout(l.authKey).catch(() => {});
    }
    links = links.filter((l) => !gone.includes(l));
    saveLinks(links);
  });
}

async function checkLan() {
  await updateAddress();
  await refreshLinks();
  publishAccounts();
}

// The phone's address and the https state, without touching any account.
async function updateAddress() {
  const found = await lan.lanAddress().catch(() => ({ ip: null, source: 'interfaces' }));
  const ip = found.ip;
  if (ip !== lanStatus.ip) console.log('[lan] Wi-Fi address ' + (ip ? `is now ${ip} (${found.source})` : 'gone'));
  ipSource = found.source;
  if (gateway && gateway.tlsActive()) await checkTlsName(ip);
  const url = lanUrl(ip);
  const tls = gateway && gateway.tlsActive()
    ? (tlsNameCheck.ip === ip && !tlsNameCheck.ok ? { state: 'blocked' } : { state: 'ready' })
    : { state: 'waiting', error: lanStatus.tls && lanStatus.tls.error };
  lanStatus = { ...lanStatus, ip, url, secure: !!url && url.startsWith('https:'), tls };
  publishAccounts();
  expirePairingNote();
}

// "Connected to …" and connect errors are shown for a while, not forever.
function expirePairingNote() {
  const p = lanStatus.pairing || {};
  if ((p.state === 'done' || p.state === 'error') && Date.now() - (p.at || 0) > 3 * 60_000) {
    lanStatus = { ...lanStatus, pairing: { state: 'idle' } };
  }
}

function startLan() {
  lanKey();
  migrateLinks();
  gateway = lan.createGateway({
    port: PUBLIC_PORT,
    tlsPort: TLS_PORT,
    addonPort: ADDON_INTERNAL_PORT,
    getKey: lanKey,
    lanManifest: myLanManifest,
    allowlistFile: path.join(path.dirname(cfgPath), 'media-allowlist.json'),
    isSelf: (address) => !!address && address === lanStatus.ip,
    // Only when this phone's Stremio really uses the 127.0.0.1 entry right
    // now: "connected" alone can come from the account, and Stremio on a
    // phone may not show that entry at all.
    dedupeSelf: () => Date.now() - lastLocalStremio < LOCAL_IN_USE_MS,
    onLocalStremio: () => {
      lastLocalStremio = Date.now();
      if (stremioConnected) return;
      console.log('[bootstrap] Stremio on this phone is using the addon');
      markStremioConnected();
    },
    // Stremio on this phone using the LAN entry counts too.
    onSelfStremio: () => {
      if (stremioConnected) return;
      console.log('[bootstrap] Stremio on this phone is using the addon (LAN entry)');
      markStremioConnected();
    },
  });
  certStore = lan.createCertStore(path.dirname(cfgPath));
  if (certStore.get()) gateway.setTls(certStore.get());
  refreshCert();
  setInterval(refreshCert, CERT_CHECK_MS);
  rememberOwnerName();
  fillUserNames().catch(() => {});
  checkLan().catch(() => {});
  setInterval(() => checkLan().catch(() => {}), LAN_CHECK_MS);
}

// The Telegram first name, for "Telemedia (Blue's phone)".
async function rememberOwnerName() {
  try {
    const me = await (await addonTelegram().getClient()).getMe();
    const name = String(me.firstName || '').trim().slice(0, 24);
    if (name && readConfig().ownerName !== name) {
      patchConfig({ ownerName: name });
      // The entries' tag no longer matches: rewritten with the new name.
      refreshLinks().catch(() => {});
    }
  } catch (err) {
    console.log('[lan] owner name: ' + messageOf(err));
  }
}

// The HTTPS certificate from local-ip.sh (lan.js); without it, other
// devices get the plain http address.
function refreshCert() {
  clearTimeout(certRetryTimer);
  certStore
    .refresh()
    .then((changed) => {
      certRetryMs = 30_000;
      if (!changed && gateway.tlsActive()) return;
      gateway.setTls(certStore.get());
      console.log('[lan] https certificate ' + (changed ? 'updated' : 'loaded'));
      // Advertise the https address (and update the accounts) once listening.
      setTimeout(() => checkLan().catch(() => {}), 1500);
    })
    .catch((err) => {
      console.log('[lan] no https certificate yet: ' + messageOf(err));
      if (gateway.tlsActive()) return; // the current one still works; the 6-hour check retries
      lanStatus = { ...lanStatus, tls: { state: 'waiting', error: messageOf(err) } };
      certRetryTimer = setTimeout(refreshCert, certRetryMs);
      certRetryMs = Math.min(certRetryMs * 2, 60 * 60_000);
    });
}

// "Connect a user": a link.stremio.com link. That user confirms it, on
// this phone (the page opens here) or on their own phone (QR code on screen).
// Then this phone's entry is added to that account and the session kept.
async function lanPairingLink() {
  await updateAddress();
  if (!lanStatus.url) throw new Error('Connect the phone to Wi-Fi first.');
  const { code, link } = await stremioAccount.createLink();
  const run = {};
  lanPairing = run;
  lanStatus = { ...lanStatus, pairing: { state: 'waiting', link } };
  (async () => {
    const authKey = await stremioAccount.waitForLink(code, () => lanPairing !== run);
    if (lanPairing !== run) return;
    if (!authKey) {
      lanStatus = { ...lanStatus, pairing: { state: 'idle' } };
      return;
    }
    lanStatus = { ...lanStatus, pairing: { state: 'installing' } };
    const fail = (error) => {
      lanStatus = { ...lanStatus, pairing: { state: 'error', error, at: Date.now() } };
    };
    await serialized(async () => {
      // Which account, before writing anything: without it the same account
      // could end up listed twice.
      let user;
      try {
        user = await stremioAccount.getUser(authKey);
      } catch (err) {
        console.log('[lan] getUser: ' + messageOf(err));
      }
      if (!user || !user.id) {
        stremioAccount.logout(authKey).catch(() => {});
        return fail('Couldn\'t tell which Stremio account that is.\nTry again.');
      }
      // The confirmation can come minutes later: still on Wi-Fi?
      await updateAddress();
      if (!lanStatus.url) {
        stremioAccount.logout(authKey).catch(() => {});
        return fail('Connect the phone to Wi-Fi first.\nThen try again.');
      }
      let links = readLinks();
      const same = links.find((l) => l.userId === user.id);
      const link = same || { id: newLinkId() };
      const oldKey = same && same.authKey;
      Object.assign(link, { authKey, userId: user.id, user: accountName(user.email), url: null, broken: false });
      const result = await updateLink(link, lanStatus.url, myLanManifest(await addonManifest()));
      if (result !== 'ok' && link.broken) {
        // Stremio refused this session: nothing was written.
        stremioAccount.logout(authKey).catch(() => {});
        return fail('Stremio didn\'t accept it.\nTry again.');
      }
      // Kept even if the write's check failed (it may have gone through): the
      // next update rewrites the entry, or forgets the account if it's not there.
      if (!same) links.push(link);
      // An old row for the same account whose session ended (from an older
      // version, so without an account id): this connection replaces it.
      const stale = links.filter((l) => l.broken && !l.userId);
      if (stale.length === 1) links = links.filter((l) => l !== stale[0]);
      saveLinks(links);
      if (oldKey && oldKey !== authKey) stremioAccount.logout(oldKey).catch(() => {});
      if (result !== 'ok') return fail('Stremio is slow right now.\nTelemedia will finish adding it by itself.');
      lanStatus = { ...lanStatus, pairing: { state: 'done', user: link.user, at: Date.now() } };
    });
  })().catch((err) => {
    console.log('[lan] connect failed: ' + messageOf(err));
    lanStatus = { ...lanStatus, pairing: { state: 'error', error: messageOf(err), at: Date.now() } };
  });
  return link;
}

// "Remove": takes this phone's entry out of one account, ends that session,
// and scrambles the key so that account's TVs can't use the old address. The
// other connected accounts get the new address.
function removeLink(id) {
  return serialized(async () => {
    const links = readLinks();
    const link = links.find((l) => l.id === id);
    if (!link) throw new Error('That account is not connected anymore.');
    const key = lanKey();
    let removed = null;
    let problem = null;
    try {
      removed = await stremioAccount.removeAddons(link.authKey, (a) =>
        (a.manifest && a.manifest.id === lanAddonId())
        || (a.transportUrl && (a.transportUrl === link.url || a.transportUrl.includes(`/${key}/`))));
    } catch (err) {
      problem = stremioAccount.isAuthError(err)
        ? 'Removed from the list.\nStremio had already signed this phone out of that account, so its entry stays there.\nIt doesn\'t work anymore (new key).\nYou can delete it in that user\'s Stremio, under Add-ons.'
        : 'Removed from the list.\nStremio couldn\'t be reached to delete its entry.\nIt doesn\'t work anymore (new key).';
      console.log('[lan] remove: ' + messageOf(err));
    }
    stremioAccount.logout(link.authKey).catch(() => {});
    saveLinks(links.filter((l) => l.id !== id));
    // Scramble: the old address (and any stream URL with it) stops working now,
    // including videos that TV is playing at this moment.
    patchConfig({ lanKey: lan.newKey() });
    if (gateway) gateway.dropKeyed();
    console.log(`[lan] account ${id} removed (${removed || 'not deleted'}), new key`);
    lanStatus = { ...lanStatus, url: lanUrl(lanStatus.ip), pairing: { state: 'idle' } };
    publishAccounts();
    return { removed: removed === 'removed', problem };
  }).then((result) => {
    // The other accounts get the new key in the background (the list shows it).
    refreshLinks().then(publishAccounts, (err) => console.log('[lan] update after remove: ' + messageOf(err)));
    return result;
  });
}

// Logout: this phone's entries out of every connected account, sessions ended.
function disconnectAllTvs() {
  return serialized(async () => {
    const key = lanKey();
    for (const l of readLinks()) {
      try {
        await stremioAccount.removeAddons(l.authKey, (a) =>
          (a.manifest && a.manifest.id === lanAddonId())
          || (a.transportUrl && (a.transportUrl === l.url || a.transportUrl.includes(`/${key}/`))));
      } catch (err) {
        console.log(`[lan] logout: account ${l.id}: ${messageOf(err)}`);
      }
      stremioAccount.logout(l.authKey).catch(() => {});
    }
  });
}

// ---------------------------------------------------------------------------
// Stremio pairing (stremio-link.js): started by the "Add to Stremio" button,
// stops polling after a while if the user never confirms.
// ---------------------------------------------------------------------------
function markStremioAdded() {
  stremioAdded = true;
  if (!readConfig().stremioAdded) patchConfig({ stremioAdded: true });
}

function markStremioConnected() {
  stremioConnected = true;
  if (!readConfig().stremioConnected) patchConfig({ stremioConnected: true });
}

async function stremioPairingLink() {
  stremioUntil = Date.now() + STREMIO_PAIRING_MS;
  if (!stremioRun) {
    stremioStatus = { state: 'starting' };
    stremioRun = stremioLink
      .run({
        isConnected: () => stremioConnected || Date.now() > stremioUntil,
        whenAddonReady: () => addonReady,
        markConnected: markStremioAdded,
        onStatus: (s) => {
          stremioStatus = s;
          console.log('[bootstrap] stremio=' + s.state);
        },
      })
      .catch((err) => {
        console.log('[bootstrap] stremio pairing: ' + messageOf(err));
      })
      .finally(() => {
        stremioRun = null;
        if (!stremioConnected) stremioStatus = { state: 'idle' };
      });
  }
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (stremioStatus.state === 'waiting' && stremioStatus.link) return stremioStatus.link;
    if (stremioStatus.state === 'error') throw new Error(stremioStatus.error || 'Stremio is unreachable');
    if (stremioConnected) throw new Error('Telemedia is already in your Stremio.');
    await sleep(300);
  }
  throw new Error('Can\'t reach Stremio right now.\nCheck the internet and try again.');
}

// ---------------------------------------------------------------------------
// Head-start groups (groups.js): offered once after login, joined on request.
// ---------------------------------------------------------------------------
const groupList = () => readDefaults().groups || [];

async function offerGroups(force) {
  if (!groupList().length || status.state !== 'running') return;
  if (!force && readConfig().groupsDone) return;
  if (groupsStatus.state === 'loading' || groupsStatus.state === 'joining') return;
  groupsStatus = { state: 'loading' };
  try {
    const client = await addonTelegram().getClient();
    const items = [];
    for (const entry of groupList()) items.push(await groups.describe(client, entry));
    // Already in all of them: nothing to offer.
    if (!force && items.every((i) => i.joined)) {
      patchConfig({ groupsDone: true });
      groupsStatus = { state: 'done', items, results: {} };
      return;
    }
    groupsStatus = { state: 'offer', items };
  } catch (err) {
    console.log('[groups] ' + messageOf(err));
    groupsStatus = { state: 'offer', items: groupList().map((e) => ({ link: e.link, note: e.note, error: 'could not load' })) };
  }
}

async function joinGroups(links) {
  if (groupsStatus.state !== 'offer') throw new Error('Nothing to join right now.');
  const chosen = groupList().filter((e) => links.includes(e.link));
  if (!chosen.length) throw new Error('Tick at least one group.\nOr tap Skip.');
  const items = groupsStatus.items;
  groupsStatus = { state: 'joining', items, results: {} };
  (async () => {
    const client = await addonTelegram().getClient();
    const results = await groups.joinAll(client, chosen, (r) => {
      groupsStatus = { state: 'joining', items, results: r };
    });
    patchConfig({ groupsDone: true });
    groupsStatus = { state: 'done', items, results };
    console.log('[groups] joined ' + Object.values(results).filter((r) => r.result).length + ' of ' + chosen.length);
  })().catch((err) => {
    console.log('[groups] ' + messageOf(err));
    groupsStatus = { state: 'offer', items, error: messageOf(err) };
  });
}

// ---------------------------------------------------------------------------
// No connection to Telegram (gramjs connect() gave up): wait and try again,
// with the reason on screen, instead of hanging on "Logging in…".
async function untilOnline(fn) {
  let delay = 5000;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (!/NO_CONNECTION|ETIMEDOUT|ECONNREFUSED|ENETUNREACH|EAI_AGAIN|ENOTFOUND/.test(messageOf(err))) throw err;
      setStatus({ state: 'waiting_network' });
      console.log(`[bootstrap] no connection to Telegram, trying again in ${delay / 1000} s`);
      await sleep(delay);
      delay = Math.min(delay * 2, 60_000);
    }
  }
}

const keyProblem = (err) => {
  console.log('[bootstrap] key rejected: ' + messageOf(err));
  return 'Telegram rejected this key.\nGet your own key below.';
};

async function main() {
  startControlServer();
  const cfg = readConfig();
  let setupFailure = null;
  const starter = unscramble(readDefaults().starter);

  for (;;) {
    // 1. Own key, the automatic way (once: it asks my.telegram.org for a code).
    if ((!cfg.apiId || !cfg.apiHash) && starter && !setupFailure) {
      try {
        const starterClient = await interactiveLogin(starter.apiId, starter.apiHash);
        setStatus({ state: 'auto_setup', setupStep: 'code' });
        const keys = await fetchOwnKeys({
          starterClient,
          starter,
          askPassword,
          password: () => lastPassword,
          onStep: (setupStep) => setStatus({ state: 'auto_setup', setupStep }),
        });
        // Read from the account's own my.telegram.org page: valid as they are.
        patchConfig({ apiId: keys.apiId, apiHash: keys.apiHash, session: keys.session });
        console.log('[bootstrap] own API keys saved' + (keys.session ? ' with session' : ''));
        Object.assign(cfg, keys);
      } catch (err) {
        console.log('[bootstrap] automatic setup failed: ' + messageOf(err));
        setupFailure = err instanceof KeyRejectedError
          ? 'The built-in key stopped working.\nGet your own key below.'
          : messageOf(err);
      }
    }

    // 2. By hand. Kept in memory: saved only once a login with them works.
    if (!cfg.apiId || !cfg.apiHash) {
      const keys = await configForm(setupFailure);
      Object.assign(cfg, keys);
      delete cfg.session;
    }

    try {
      // 3. A saved session: still valid?
      if (cfg.session) {
        setStatus({ state: 'logging_in' });
        if (!(await untilOnline(() => sessionIsValid(cfg)))) {
          console.log('[bootstrap] saved session is no longer valid, logging in again');
          delete cfg.session;
          patchConfig({ session: undefined });
        }
      }
      // 4. Log in with the own key.
      if (!cfg.session) {
        const client = await interactiveLogin(cfg.apiId, cfg.apiHash);
        cfg.session = client.session.save();
        await client.destroy().catch(() => {}); // the addon opens its own connection
      }
    } catch (err) {
      if (!(err instanceof KeyRejectedError)) throw err;
      console.log('[bootstrap] own API key rejected: ' + messageOf(err));
      setupFailure = keyProblem(err);
      for (const k of ['apiId', 'apiHash', 'session']) delete cfg[k];
      patchConfig({ apiId: undefined, apiHash: undefined, session: undefined });
      continue;
    }

    patchConfig({ apiId: cfg.apiId, apiHash: cfg.apiHash, session: cfg.session });
    break;
  }

  startAddon(cfg);
}

main().catch((err) => {
  console.error('[bootstrap] fatal', err);
  setStatus({ state: 'error', error: messageOf(err) });
});
