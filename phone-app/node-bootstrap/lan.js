// Serving Stremio on other devices (TV, PC on the same Wi-Fi) from this phone.
//
// The addon itself is unchanged and listens on 127.0.0.1 only (internal
// port). In front of it, a small gateway listens on 0.0.0.0:7000:
//   http://127.0.0.1:7000/manifest.json         this phone, no key needed
//   http://<phone-ip>:7000/<key>/manifest.json  other devices: the personal
//                                               key is required; any other
//                                               request from the network → 404
// For keyed requests the gateway rewrites the stream URLs in the addon's
// answers to the same keyed address, and serves the manifest under its own
// id ("…lan"), so the account can hold it next to the phone's own
// 127.0.0.1 entry without replacing it.
//
// The same gateway also answers on HTTPS (port 7443) as
//   https://192-168-0-104.local-ip.sh:7443/<key>/manifest.json
// because Stremio's web-based apps (web.stremio.com, smart-TV apps such as
// VIDAA, webOS, Tizen) only load https addons from other devices.
// local-ip.sh is a public DNS service: "192-168-0-104.local-ip.sh" resolves to
// 192.168.0.104, and it publishes a Let's Encrypt certificate for
// *.local-ip.sh together with its private key, for exactly this use. That key
// is public, so this TLS hides nothing on the LAN (no worse than plain http);
// it only makes browsers accept the address. The personal key in the path
// still decides who gets in.

'use strict';

const crypto = require('crypto');
const dgram = require('dgram');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const { pipeline } = require('stream');

const LAN_SUFFIX = '.lan';
const STREMIO_RESOURCE = /^\/(catalog|meta|stream|subtitles)\/[^/]+\/[^/]+\.json/;
const DEDUPE_RESOURCE = /^\/(catalog|stream)\/[^/]+\/[^/]+\.json/;

const newKey = () => crypto.randomBytes(16).toString('base64url');

function sameKey(given, key) {
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(key));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const plainAddress = (a) => String(a || '').replace(/^::ffff:/, '');

// "/stream/movie/tt1375666.json" for the log (decoded, shortened).
function shortPath(path) {
  let p = path;
  try { p = decodeURIComponent(path); } catch { /* keep as is */ }
  return p.length > 100 ? p.slice(0, 100) + '…' : p;
}
const isLoopback = (a) => /^127\./.test(plainAddress(a)) || a === '::1';

// RFC 1918 home/office networks (also a phone's own hotspot).
function isPrivate(ip) {
  return /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
}

// "/<key>/rest" with the right key → "/rest"; anything else → null.
function stripKey(url, key) {
  const m = /^\/([A-Za-z0-9_-]{16,64})(\/.*)?$/.exec(url);
  return m && sameKey(m[1], key) ? m[2] || '/' : null;
}

// The manifest other devices get: its own id and name, so it sits next to
// the 127.0.0.1 entry in a Stremio account instead of replacing it (and, with
// an id per phone, next to other people's phones too).
function lanManifest(manifest, { id, name } = {}) {
  return {
    ...manifest,
    id: id || String(manifest.id) + LAN_SUFFIX,
    name: name || `${manifest.name} (phone)`,
    description: `${manifest.description || ''} Served by a phone over Wi-Fi.`.trim(),
  };
}

// An addon answer for another device: stream URLs on the keyed LAN address.
function rewriteBody(path, body, { localBase, keyedBase, manifest = lanManifest }) {
  if (path === '/manifest.json') return JSON.stringify(manifest(JSON.parse(body)));
  return body.split(localBase + '/').join(keyedBase + '/');
}

// The phone's Wi-Fi (or hotspot) IPv4 address, or null when not on Wi-Fi.
// Interface names first (wlan0, …); some Android versions refuse to list
// interfaces, then use the address the system would send from.
function lanFromInterfaces() {
  let ifs;
  try {
    ifs = os.networkInterfaces();
  } catch {
    return undefined; // not allowed here: try the other way
  }
  const found = [];
  for (const [name, addrs] of Object.entries(ifs || {})) {
    for (const a of addrs || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal && isPrivate(a.address)) {
        if (/^(rmnet|ccmni|tun|ppp|dummy|p2p|v4-rmnet)/.test(name)) continue; // mobile data, VPN
        found.push({ name, address: a.address, rank: /^(wlan|swlan|ap|eth|en)/.test(name) ? 0 : 1 });
      }
    }
  }
  found.sort((x, y) => x.rank - y.rank);
  return found.length ? found[0].address : null;
}

function lanFromRoute() {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const done = (ip) => {
      try { sock.close(); } catch { /* closed */ }
      resolve(ip && isPrivate(ip) ? ip : null);
    };
    sock.on('error', () => done(null));
    // UDP connect sends nothing; it only picks the route and local address.
    sock.connect(53, '1.1.1.1', () => {
      try { done(sock.address().address); } catch { done(null); }
    });
  });
}

// → { ip, source }. source 'route' is a guess (it may be a VPN or mobile-data
// address): fine to show, never written into Stremio accounts by itself.
async function lanAddress() {
  const ip = lanFromInterfaces();
  if (ip !== undefined) return { ip, source: 'interfaces' };
  return { ip: await lanFromRoute(), source: 'route' };
}

// Stremio's own web apps (web.stremio.com, app.strem.io, the smart-TV shells
// such as https://relvhgchz5.strem.io): the only browser pages allowed to use
// the keyless 127.0.0.1 address.
const STREMIO_ORIGIN = /^https:\/\/([a-z0-9-]+\.)*(strem\.io|stremio\.com)$/i;

// The address a connected Stremio account should have now: the current one
// when it may be written automatically (a real Wi-Fi address, and never https
// → http), else the account's own address with just the current key, so a
// new key always reaches every account. null: nothing to write.
function accountTargetUrl(linkUrl, currentUrl, key, ipSource) {
  const allowed = currentUrl && ipSource === 'interfaces'
    && !(linkUrl && linkUrl.startsWith('https:') && currentUrl.startsWith('http:'));
  if (allowed) return currentUrl;
  if (!linkUrl) return null;
  return linkUrl.replace(/\/[A-Za-z0-9_-]{16,64}\/manifest\.json$/, `/${key}/manifest.json`);
}

// ---------------------------------------------------------------------------
// The local-ip.sh certificate (see the top of this file).
// ---------------------------------------------------------------------------
const CERT_SOURCE = 'https://local-ip.sh';
const CERT_DOMAIN = 'local-ip.sh';
const DAY = 86_400_000;

// 192.168.0.104 → "192-168-0-104.local-ip.sh"
const tlsHostname = (ip) => `${String(ip).replace(/\./g, '-')}.${CERT_DOMAIN}`;

function leafOf(pem) {
  const first = (String(pem).match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/) || [])[0];
  return new crypto.X509Certificate(first);
}

// null when { cert, key } is usable for *.local-ip.sh, else why not.
function checkCert(pair, now = Date.now()) {
  try {
    const leaf = leafOf(pair.cert);
    const names = String(leaf.subjectAltName || '').split(/,\s*/);
    if (!names.includes(`DNS:*.${CERT_DOMAIN}`)) return 'not a *.' + CERT_DOMAIN + ' certificate';
    if (Date.parse(leaf.validTo) - now < 2 * DAY) return 'expired or about to';
    if (Date.parse(leaf.validFrom) > now + DAY) return 'not valid yet (is the clock right?)';
    if (!leaf.checkPrivateKey(crypto.createPrivateKey(pair.key))) return 'key does not match';
    return null;
  } catch (err) {
    return 'unreadable (' + err.message + ')';
  }
}

// Kept in the app's files, so a restart works without the internet; fetched
// again when it gets within 20 days of expiry (local-ip.sh renews earlier).
function createCertStore(dir, source = CERT_SOURCE) {
  const files = { cert: path.join(dir, 'local-ip.pem'), key: path.join(dir, 'local-ip.key') };
  let current = null;
  try {
    const saved = { cert: fs.readFileSync(files.cert, 'utf8'), key: fs.readFileSync(files.key, 'utf8') };
    if (!checkCert(saved)) current = saved;
  } catch {
    // none saved yet
  }
  async function download(name) {
    const res = await fetch(`${source}/${name}`);
    if (!res.ok) throw new Error(`${source}/${name}: HTTP ${res.status}`);
    return res.text();
  }
  // → true when a new certificate was installed.
  async function refresh() {
    if (current && Date.parse(leafOf(current.cert).validTo) - Date.now() > 20 * DAY) return false;
    const next = { cert: await download('server.pem'), key: await download('server.key') };
    const problem = checkCert(next);
    if (problem) throw new Error('local-ip.sh certificate: ' + problem);
    if (current && current.cert === next.cert) return false;
    fs.writeFileSync(files.cert, next.cert);
    fs.writeFileSync(files.key, next.key);
    current = next;
    return true;
  }
  return { get: () => current, refresh };
}

// ---------------------------------------------------------------------------
// Which Telegram messages may be played or opened through the gateway: only
// the ones the addon itself handed out (stream links, catalog and meta
// items). Without this, anyone who can reach the addon (another app on the
// phone, a connected TV) could ask for any message number, and the addon's
// lookup falls back to all of the account's chats, private ones included.
// Kept in the app's files, so a resumed video still plays after a restart.
// ---------------------------------------------------------------------------
const MAX_ALLOWED_MSGS = 20_000;
const MAX_ALLOWED_CHATS = 2_000;

function createMediaAllowlist(file = null) {
  const msgs = new Set(); // "chatId:messageId"
  const chats = new Set(); // "chatId"
  let dirty = false;
  let timer = null;
  if (file) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const m of saved.msgs || []) msgs.add(String(m));
      for (const c of saved.chats || []) chats.add(String(c));
    } catch {
      // nothing saved yet
    }
  }
  const save = () => {
    timer = null;
    if (!dirty || !file) return;
    dirty = false;
    try {
      fs.writeFileSync(file, JSON.stringify({ msgs: [...msgs], chats: [...chats] }));
    } catch (err) {
      console.log('[lan] could not save the media list: ' + err.message);
    }
  };
  // Newest last; the oldest go first when the list is full.
  const add = (set, value, max) => {
    if (set.has(value)) {
      set.delete(value);
    } else {
      dirty = true;
    }
    set.add(value);
    while (set.size > max) set.delete(set.values().next().value);
    if (dirty && file && !timer) timer = setTimeout(save, 10_000);
  };
  // Learn from one addon answer (its JSON text).
  function harvest(body) {
    for (const m of String(body).matchAll(/\/stream\/(-?\d+)\/(\d+)\//g)) add(msgs, `${m[1]}:${m[2]}`, MAX_ALLOWED_MSGS);
    for (const m of String(body).matchAll(/"tg:(-?\d+):(\d+)"/g)) add(msgs, `${m[1]}:${m[2]}`, MAX_ALLOWED_MSGS);
    for (const m of String(body).matchAll(/"tgchat:(-?\d+)"/g)) add(chats, m[1], MAX_ALLOWED_CHATS);
  }
  // null when the request may go to the addon, else why not. Expects a path
  // whose percent-encoding is valid (checked before).
  function check(path) {
    const p = path.split('?')[0];
    // The video itself: /stream/<chatId>/<messageId>/<file>
    let m = /^\/stream\/([^/]+)\/(\d+)(?:\/[^/]*)?$/.exec(p);
    if (m && !p.endsWith('.json')) {
      const chat = decodeURIComponent(m[1]);
      return /^-?\d+$/.test(chat) && msgs.has(`${chat}:${m[2]}`) ? null : 'not offered';
    }
    // Stremio resources about one Telegram message or chat.
    m = /^\/(meta|stream|subtitles)\/[^/]+\/([^/]+)\.json$/.exec(p);
    if (m) {
      const id = decodeURIComponent(m[2]);
      let t = /^tg:(-?\d+):(\d+)$/.exec(id);
      if (t) return msgs.has(`${t[1]}:${t[2]}`) ? null : 'not offered';
      t = /^tgchat:(-?\d+)(?::ep(\d+))?$/.exec(id);
      if (t) return chats.has(t[1]) || (t[2] && msgs.has(`${t[1]}:${t[2]}`)) ? null : 'not offered';
      if (/^tg/i.test(id)) return 'not offered';
    }
    return null;
  }
  function clear() {
    msgs.clear();
    chats.clear();
    dirty = true;
    save();
  }
  return {
    harvest,
    check,
    clear,
    flush: save,
    allow: (chat, msg) => add(msgs, `${chat}:${msg}`, MAX_ALLOWED_MSGS),
    size: () => msgs.size,
  };
}

// Valid percent-encoding? (A malformed one used to crash the whole addon.)
function decodablePath(url) {
  try {
    decodeURIComponent(String(url).split('?')[0]);
    return true;
  } catch {
    return false;
  }
}

// On every answer: never treated as a page that could run code.
const SAFE_HEADERS = {
  'x-content-type-options': 'nosniff',
  'content-security-policy': "sandbox; default-src 'none'",
};

// The gateway. getKey() → the personal key; isSelf(address) → true for this
// phone's own LAN address; dedupeSelf() → true while this phone's Stremio
// uses the 127.0.0.1 entry (then the keyed entry answers the phone itself with
// nothing, so the phone doesn't list every stream twice).
// onLocalStremio(): Stremio on this phone asked for a resource on 127.0.0.1;
// onSelfStremio(): the same on the keyed (LAN) address.
// activeStreams() → video transfers in progress (for wake/Wi-Fi locks).
// setTls({ cert, key }) starts (or renews) the HTTPS side on tlsPort.
// lanManifest(manifest) → the manifest other devices see (default: lanManifest).
// allowlistFile: where the list of offered videos is kept (createMediaAllowlist).
function createGateway({
  port, tlsPort, addonPort, getKey, isSelf, dedupeSelf, onLocalStremio,
  onSelfStremio = () => {}, lanManifest: manifestFor = lanManifest, allowlistFile = null,
}) {
  const localBase = `http://127.0.0.1:${port}`;
  let streams = 0;
  const keyedOpen = new Set(); // answers in progress on the keyed address
  const allowlist = createMediaAllowlist(allowlistFile);

  // cors: answers for other devices' browsers (web-based Stremio apps) carry
  // CORS headers on every response, video included (the addon's own video
  // route sets none). onVideo(status): log hook for the first response.
  function proxy(req, res, path, rewrite, { cors = false, onVideo = null } = {}) {
    const corsHeaders = cors
      ? {
        'access-control-allow-origin': '*',
        'access-control-expose-headers': 'Content-Length, Content-Range, Accept-Ranges, Content-Type',
      }
      : {};
    const headers = { ...req.headers, host: `127.0.0.1:${addonPort}` };
    delete headers['accept-encoding']; // plain JSON bodies: rewritten and/or read for the media list
    const isVideo = /^\/stream\/[^/]+\/\d+/.test(path) && !/\.json$/.test(path.split('?')[0]);
    if (isVideo) streams++;
    let counted = isVideo;
    const release = () => {
      if (counted) {
        counted = false;
        streams--;
      }
    };
    const up = http.request(
      { host: '127.0.0.1', port: addonPort, method: req.method, path, headers },
      (ur) => {
        if (isVideo && onVideo) onVideo(ur.statusCode);
        const type = String(ur.headers['content-type'] || '');
        if (ur.statusCode === 200 && /json/.test(type)) {
          const chunks = [];
          ur.on('data', (c) => chunks.push(c));
          ur.on('end', () => {
            let body = Buffer.concat(chunks).toString('utf8');
            allowlist.harvest(body);
            try {
              if (rewrite) body = rewrite(path.split('?')[0], body);
            } catch (err) {
              console.log('[lan] rewrite failed: ' + err.message);
            }
            const out = { ...corsHeaders, ...ur.headers, ...SAFE_HEADERS, 'content-length': Buffer.byteLength(body) };
            delete out['content-encoding'];
            delete out['transfer-encoding'];
            res.writeHead(ur.statusCode, out);
            res.end(body);
          });
          // The addon gave up mid-answer: don't leave the caller waiting.
          ur.on('close', () => {
            if (ur.complete) return;
            if (!res.headersSent) {
              res.writeHead(502, corsHeaders);
              res.end();
            } else {
              res.destroy();
            }
          });
          return;
        }
        const out = { ...corsHeaders, ...ur.headers, ...SAFE_HEADERS };
        // Videos stay videos; anything else is only ever a download (a
        // document from a chat must not open as a page).
        if (isVideo && !/^(video|audio)\//i.test(type)) {
          out['content-type'] = 'application/octet-stream';
          out['content-disposition'] = 'attachment';
        }
        res.writeHead(ur.statusCode, out);
        // pipeline, not pipe: when the addon's video download stops early
        // (a Telegram error mid-file), the player's connection is reset, so it
        // retries instead of waiting on a half-sent response.
        pipeline(ur, res, (err) => {
          if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') console.log('[lan] transfer ended: ' + err.message);
          else if (err && !ur.complete && !res.writableFinished) console.log('[lan] transfer cut off');
        });
      },
    );
    up.on('error', () => {
      release();
      if (!res.headersSent) res.writeHead(502, corsHeaders);
      res.end();
    });
    res.on('close', () => {
      release();
      up.destroy();
    });
    req.pipe(up);
  }

  const handle = (req, res) => {
    const url = req.url || '/';
    const from = plainAddress(req.socket.remoteAddress);
    const notFound = () => {
      res.writeHead(404, { 'Content-Type': 'text/plain', ...SAFE_HEADERS });
      res.end('Not found');
    };
    if (!decodablePath(url)) {
      res.writeHead(400, { 'Content-Type': 'text/plain', ...SAFE_HEADERS });
      return res.end('Bad request');
    }
    // Only messages the addon handed out (see createMediaAllowlist).
    const offered = (path) => {
      const why = allowlist.check(path);
      if (why) console.log(`[lan] refused ${shortPath(path.split('/').slice(0, 3).join('/'))}…: ${why}`);
      return !why;
    };

    const keyed = stripKey(url, getKey());
    const isVideoPath = keyed !== null && /^\/stream\/[^/]+\/\d+/.test(keyed) && !/\.json$/.test(keyed.split('?')[0]);
    // Every request from the network, for troubleshooting other devices
    // (never the key; video requests are logged with their answer, below).
    if (!isLoopback(from) && !isSelf(from) && !isVideoPath) {
      const origin = req.headers.origin ? ` origin=${req.headers.origin}` : '';
      const pna = req.headers['access-control-request-private-network'] ? ' private-network-preflight' : '';
      console.log(`[lan] from ${from}: ${req.method} ${keyed === null ? '(no key) ' + shortPath(url.split('/').slice(0, 3).join('/')) : shortPath(keyed)}${origin}${pna}`);
    }

    // Browser preflight (web-based Stremio apps, e.g. on smart TVs): allow it,
    // including Chrome's Private Network Access check, for keyed URLs only.
    if (req.method === 'OPTIONS' && keyed !== null) {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || '*',
        'Access-Control-Allow-Private-Network': 'true',
        'Access-Control-Max-Age': '600',
      });
      return res.end();
    }

    if (keyed === null) {
      // No (or a wrong) key: only this phone itself, and not web pages open
      // on it: a browser request has an Origin (only Stremio's own web apps
      // pass), and a page using DNS rebinding sends its own host name.
      if (!isLoopback(from)) return notFound();
      const hostName = String(req.headers.host || '').replace(/:\d+$/, '');
      if (hostName !== '127.0.0.1' && hostName !== 'localhost') return notFound();
      if (req.headers.origin && !STREMIO_ORIGIN.test(req.headers.origin)) {
        console.log(`[lan] refused a browser page on this phone: ${req.headers.origin}`);
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        return res.end('Forbidden');
      }
      if (!offered(url)) return notFound();
      if (STREMIO_RESOURCE.test(url)) {
        console.log(`[lan] local ${shortPath(url)}`);
        onLocalStremio(url);
      }
      return proxy(req, res, url, null);
    }

    if (!offered(keyed)) return notFound();
    const self = isSelf(from);
    if (DEDUPE_RESOURCE.test(keyed) && self && dedupeSelf()) {
      console.log(`[lan] self (duplicate of local, empty) ${shortPath(keyed)}`);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify(keyed.startsWith('/stream/') ? { streams: [] } : { metas: [] }));
    }
    if (STREMIO_RESOURCE.test(keyed)) {
      console.log(`[lan] ${self ? 'self' : 'network'} ${shortPath(keyed)}`);
      if (self) onSelfStremio(keyed);
    }
    // The address the other device used to reach us (it changes with the IP).
    const host = /^[A-Za-z0-9.\-:[\]]{1,80}$/.test(req.headers.host || '') ? req.headers.host : null;
    if (!host) return notFound();
    const scheme = req.socket.encrypted ? 'https' : 'http';
    const keyedBase = `${scheme}://${host}/${getKey()}`;
    keyedOpen.add(res);
    res.on('close', () => keyedOpen.delete(res));
    const onVideo = self ? null : (status) => {
      const range = req.headers.range ? ` ${req.headers.range}` : '';
      const origin = req.headers.origin ? ` origin=${req.headers.origin}` : '';
      console.log(`[lan] from ${from}: ${req.method} video${range} → ${status}${origin}`);
    };
    proxy(req, res, keyed, (p, body) => rewriteBody(p, body, { localBase, keyedBase, manifest: manifestFor }), {
      cors: true,
      onVideo,
    });
  };

  const server = http.createServer(handle);
  server.on('error', (err) => console.error('[lan] gateway error: ' + err.message));
  server.listen(port, '0.0.0.0');

  let tlsServer = null;
  function setTls(pair) {
    if (!pair || !tlsPort) return;
    if (tlsServer) {
      tlsServer.setSecureContext({ cert: pair.cert, key: pair.key });
      return;
    }
    tlsServer = https.createServer({ cert: pair.cert, key: pair.key }, handle);
    tlsServer.on('error', (err) => console.error('[lan] https gateway error: ' + err.message));
    tlsServer.listen(tlsPort, '0.0.0.0', () => console.log('[lan] https on port ' + tlsPort));
  }
  // After a new key: end every transfer that came in with the old one (a
  // removed TV must not keep playing what it already started).
  function dropKeyed() {
    for (const res of keyedOpen) res.destroy();
    keyedOpen.clear();
  }
  return {
    server,
    setTls,
    dropKeyed,
    allowlist,
    tlsActive: () => !!(tlsServer && tlsServer.listening),
    tlsServer: () => tlsServer,
    activeStreams: () => streams,
  };
}

module.exports = {
  createMediaAllowlist,
  decodablePath,
  accountTargetUrl,
  checkCert,
  createCertStore,
  tlsHostname,
  newKey,
  stripKey,
  isLoopback,
  isPrivate,
  lanManifest,
  rewriteBody,
  lanAddress,
  createGateway,
  LAN_SUFFIX,
};
