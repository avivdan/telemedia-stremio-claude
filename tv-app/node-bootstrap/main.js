// Entry point run by nodejs-mobile inside the Android TV app.
//
// argv[2] = absolute path to config.json in the app's private files dir.
// config.json: { apiId, apiHash, session?, port? }
//
// Flow:
//   1. Start a control server on 127.0.0.1:7001 that the Kotlin UI polls
//      (GET /status, POST /password, POST /exit).
//   2. No apiId/apiHash      → state "need_config", wait for UI + restart.
//   3. No session            → QR login (scan with Telegram on phone),
//                              save session to config.json.
//   4. Session present       → verify it (revoked → back to QR login), set
//                              env vars, load the addon (dist/src/index.js),
//                              state "running" once /manifest.json answers.
//   5. In parallel: Stremio pairing QR (stremio-link.js) adds the addon to the
//      user's Stremio account. stremioConnected=true in config.json once that
//      succeeds or Stremio is seen requesting a catalog/meta/stream.

'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const stremioLink = require('./stremio-link');

const CONTROL_PORT = 7001;
const cfgPath = process.argv[2];

let status = { state: 'starting' };
let passwordResolver = null;
// Pairing with the user's Stremio account (see stremio-link.js), reported
// alongside the main state so the UI can show both QR codes at once.
let stremioStatus = { state: 'idle' };
let resolveAddonReady;
const addonReady = new Promise((r) => { resolveAddonReady = r; });

// Build-time defaults (bundle-node.mjs copies API ID/hash from the repo .env).
// Values saved from the TV UI in config.json take precedence.
function readDefaults() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'defaults.json'), 'utf8'));
  } catch {
    return {};
  }
}

function readConfig() {
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch {}
  const defaults = readDefaults();
  if (!cfg.apiId || !cfg.apiHash) {
    cfg.apiId = defaults.apiId;
    cfg.apiHash = defaults.apiHash;
  }
  return cfg;
}

function writeConfig(cfg) {
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
}

function setStatus(next) {
  status = next;
  console.log('[bootstrap] state=' + next.state);
}

// ---------------------------------------------------------------------------
// Control server — local only, the UI process talks to us through it.
// ---------------------------------------------------------------------------
function startControlServer() {
  const server = http.createServer((req, res) => {
    const send = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (req.method === 'GET' && req.url === '/status') {
      return send(200, { ...status, stremio: stremioStatus });
    }

    if (req.method === 'POST' && req.url === '/password') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        if (!passwordResolver) return send(409, { error: 'no password requested' });
        const resolve = passwordResolver;
        passwordResolver = null;
        setStatus({ state: 'logging_in' });
        resolve(body);
        send(200, { ok: true });
      });
      return;
    }

    // UI asks us to die; the foreground service gets restarted by the UI.
    if (req.method === 'POST' && req.url === '/exit') {
      send(200, { ok: true });
      setTimeout(() => process.exit(0), 200);
      return;
    }

    send(404, { error: 'not found' });
  });
  server.listen(CONTROL_PORT, '127.0.0.1');
}

// ---------------------------------------------------------------------------
// QR login — TV shows tg://login?token=..., user scans it in Telegram on
// their phone (Settings → Devices → Link Desktop Device).
// ---------------------------------------------------------------------------
async function qrLogin(cfg) {
  const { TelegramClient } = require('telegram');
  const { StringSession } = require('telegram/sessions');

  const apiId = Number(cfg.apiId);
  const client = new TelegramClient(new StringSession(''), apiId, cfg.apiHash, {
    connectionRetries: 5,
  });
  await client.connect();

  await client.signInUserWithQrCode(
    { apiId, apiHash: cfg.apiHash },
    {
      qrCode: async ({ token, expires }) => {
        setStatus({
          state: 'qr',
          qrUrl: 'tg://login?token=' + token.toString('base64url'),
          expires,
        });
      },
      password: async (hint) => {
        setStatus({ state: 'need_password', hint: hint || '' });
        return new Promise((resolve) => { passwordResolver = resolve; });
      },
      onError: async (err) => {
        setStatus({ state: 'error', error: err.message });
        return true; // stop; UI offers a restart
      },
    },
  );

  const session = client.session.save();
  await client.disconnect();
  return session;
}

// A saved session can be revoked (logged out from phone, expired). Detect
// that up front so we fall back to QR login instead of crash-looping.
const DEAD_SESSION = /AUTH_KEY_UNREGISTERED|AUTH_KEY_INVALID|SESSION_REVOKED|SESSION_EXPIRED|USER_DEACTIVATED/;

async function sessionIsValid(cfg) {
  const { TelegramClient } = require('telegram');
  const { StringSession } = require('telegram/sessions');
  const client = new TelegramClient(new StringSession(cfg.session), Number(cfg.apiId), cfg.apiHash, {
    connectionRetries: 5,
  });
  try {
    await client.connect();
    await client.getMe();
    return true;
  } catch (err) {
    if (DEAD_SESSION.test(String(err && (err.errorMessage || err.message)))) return false;
    throw err;
  } finally {
    await client.disconnect().catch(() => {});
  }
}

function waitForAddon(port) {
  const deadline = Date.now() + 60_000;
  const probe = () => {
    http
      .get({ host: '127.0.0.1', port, path: '/manifest.json', timeout: 2000 }, (res) => {
        res.resume();
        if (res.statusCode === 200) {
          const manifestUrl = `http://127.0.0.1:${port}/manifest.json`;
          setStatus({
            state: 'running',
            manifestUrl,
            stremioConnected: !!readConfig().stremioConnected,
          });
          resolveAddonReady({ manifestUrl });
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

// ---------------------------------------------------------------------------
// Start the actual addon with config mapped to the env vars src/config.ts reads.
// ---------------------------------------------------------------------------
function startAddon(cfg) {
  const port = String(cfg.port || 7000);
  const base = 'http://127.0.0.1:' + port;
  // Addon settings bundled from the repo .env (TMDB keys, chat ids, ...).
  for (const [k, v] of Object.entries(readDefaults().env || {})) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
  process.env.TELEGRAM_API_ID = String(cfg.apiId);
  process.env.TELEGRAM_API_HASH = cfg.apiHash;
  process.env.TELEGRAM_SESSION = cfg.session;
  process.env.ADDON_HOST = '127.0.0.1';
  process.env.ADDON_PORT = port;
  process.env.PUBLIC_BASE_URL = base;
  process.env.STREAM_BASE_URL = base;
  // Low-RAM TV boxes: keep the read-ahead small.
  process.env.STREAM_PREFETCH_KB = process.env.STREAM_PREFETCH_KB || '1024';

  // src/index.ts calls process.exit(1) on fatal errors. Keep the process
  // (and the control server) alive so the UI can show the error instead of
  // the service crash-looping. Clean exits (POST /exit) still go through.
  const realExit = process.exit.bind(process);
  process.exit = (code) => {
    if (code) {
      setStatus({ state: 'error', error: `addon failed to start (exit ${code}), see logs` });
      return undefined;
    }
    return realExit(code);
  };

  setStatus({ state: 'starting_addon' });
  const addon = require(path.join(__dirname, 'dist', 'src', 'index.js'));
  watchStremio(addon);
  waitForAddon(Number(port));
}

// Remember (once) that Stremio on this device actually uses the addon, so the
// UI stops asking the user to add it. Stremio syncs installed addons per
// account, so this usually flips without any action on a second TV.
function watchStremio(addon) {
  if (!addon.addonEvents || readConfig().stremioConnected) return;
  addon.addonEvents.once('stremio-request', () => {
    markStremioConnected();
    console.log('[bootstrap] Stremio is using the addon');
  });
}

function markStremioConnected() {
  if (!readConfig().stremioConnected) writeConfig({ ...readConfig(), stremioConnected: true });
  if (status.state === 'running') setStatus({ ...status, stremioConnected: true });
}

// Runs in parallel with Telegram login, so both QR codes can be scanned in one go.
function startStremioPairing() {
  stremioLink
    .run({
      isConnected: () => !!readConfig().stremioConnected,
      whenAddonReady: () => addonReady,
      markConnected: markStremioConnected,
      onStatus: (s) => {
        stremioStatus = s;
        console.log('[bootstrap] stremio=' + s.state);
      },
    })
    .catch((err) => {
      stremioStatus = { state: 'error', error: String(err && err.message ? err.message : err) };
    });
}

async function main() {
  startControlServer();
  startStremioPairing();
  const cfg = readConfig();

  if (!cfg.apiId || !cfg.apiHash) {
    setStatus({ state: 'need_config' });
    return; // stay alive for the control server
  }

  if (cfg.session) {
    setStatus({ state: 'logging_in' });
    if (!(await sessionIsValid(cfg))) {
      console.log('[bootstrap] saved session is no longer valid, switching to QR login');
      delete cfg.session;
      const stored = readConfig();
      delete stored.session;
      writeConfig(stored);
    }
  }

  if (!cfg.session) {
    setStatus({ state: 'logging_in' });
    cfg.session = await qrLogin(cfg);
    writeConfig({ ...readConfig(), session: cfg.session });
  }

  startAddon(cfg);
}

main().catch((err) => {
  console.error('[bootstrap] fatal', err);
  setStatus({ state: 'error', error: String(err && err.message ? err.message : err) });
});
