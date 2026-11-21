// The LAN gateway (node-bootstrap/lan.js) against a fake addon.
// Run: npm test

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const lan = require('../node-bootstrap/lan.js');

const KEY = 'k'.repeat(10) + 'AbCdEfGhIj_-';
let addon;
let gateway;
let port;
let addonPort;
let self = false;
let localStremio = 0;

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });

// GET → { status, body, headers, complete }, optionally from a given local address.
const get = (host, path, headers = {}) =>
  new Promise((resolve, reject) => {
    http
      .get({ host, port, path, headers }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        const done = () => resolve({ status: res.statusCode, body, headers: res.headers, complete: res.complete });
        res.on('end', done);
        res.on('aborted', done);
        res.on('error', done);
      })
      .on('error', reject);
  });

before(async () => {
  port = await freePort();
  addonPort = await freePort();
  addon = http
    .createServer((req, res) => {
      if (req.url === '/manifest.json') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ id: 'community.telemedia', name: 'Telemedia', version: '1.0.0' }));
      }
      if (req.url === '/stream/movie/tt1.json') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ streams: [{ url: `http://127.0.0.1:${port}/stream/-100123/45/a.mkv` }] }));
      }
      // A chat document that is a web page: must never open as one.
      if (req.url.startsWith('/stream/-100123/66')) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end('<script>alert(1)</script>');
      }
      if (req.url.startsWith('/meta/movie/tg')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ meta: { id: 'tg:-100123:45', name: 'x' } }));
      }
      if (req.url.startsWith('/stream/-100123/45')) {
        res.writeHead(206, { 'Content-Type': 'video/x-matroska', 'Content-Range': 'bytes 0-3/10' });
        return res.end('abcd');
      }
      // A long video: keeps sending until the client goes away.
      if (req.url.startsWith('/stream/-100123/77')) {
        res.writeHead(206, { 'Content-Type': 'video/x-matroska', 'Content-Length': '100000000' });
        const timer = setInterval(() => res.write('x'.repeat(1024)), 20);
        return res.on('close', () => clearInterval(timer));
      }
      // A Telegram error mid-file: fewer bytes than promised, then the connection drops.
      if (req.url.startsWith('/stream/-100123/99')) {
        res.writeHead(206, { 'Content-Type': 'video/x-matroska', 'Content-Length': '100', 'Content-Range': 'bytes 0-99/100' });
        res.write('0123456789');
        return setTimeout(() => req.socket.destroy(), 50);
      }
      res.writeHead(404);
      res.end();
    })
    .listen(addonPort, '127.0.0.1');
  gateway = lan.createGateway({
    port,
    addonPort,
    getKey: () => KEY,
    isSelf: () => self,
    dedupeSelf: () => true,
    onLocalStremio: () => localStremio++,
  });
  for (const msg of [77, 99, 66]) gateway.allowlist.allow('-100123', msg);
  await new Promise((r) => gateway.server.on('listening', r));
});

after(() => {
  gateway.server.close();
  addon.close();
});

test('this phone: no key needed, answers unchanged', async () => {
  const m = await get('127.0.0.1', '/manifest.json');
  assert.equal(m.status, 200);
  assert.equal(JSON.parse(m.body).id, 'community.telemedia');
  const s = await get('127.0.0.1', '/stream/movie/tt1.json');
  assert.equal(JSON.parse(s.body).streams[0].url, `http://127.0.0.1:${port}/stream/-100123/45/a.mkv`);
  assert.equal(localStremio, 1);
  const v = await get('127.0.0.1', '/stream/-100123/45/a.mkv', { Range: 'bytes=0-3' });
  assert.equal(v.status, 206);
  assert.equal(v.body, 'abcd');
});

test('with the key: own manifest id, stream URLs on the keyed address', async () => {
  const host = `192.168.1.20:${port}`;
  const m = await get('127.0.0.1', `/${KEY}/manifest.json`, { Host: host });
  const manifest = JSON.parse(m.body);
  assert.equal(manifest.id, 'community.telemedia.lan');
  assert.equal(manifest.name, 'Telemedia (phone)');
  const s = await get('127.0.0.1', `/${KEY}/stream/movie/tt1.json`, { Host: host });
  assert.equal(JSON.parse(s.body).streams[0].url, `http://${host}/${KEY}/stream/-100123/45/a.mkv`);
  assert.equal(Number(s.headers['content-length']), Buffer.byteLength(s.body));
  const v = await get('127.0.0.1', `/${KEY}/stream/-100123/45/a.mkv`, { Host: host });
  assert.equal(v.body, 'abcd');
  assert.equal(gateway.activeStreams(), 0);
});

test('with the key: video answers carry CORS (web-based Stremio apps)', async () => {
  const v = await get('127.0.0.1', `/${KEY}/stream/-100123/45/a.mkv`, { Host: `192.168.1.20:${port}`, Origin: 'https://relvhgchz5.strem.io' });
  assert.equal(v.status, 206);
  assert.equal(v.headers['access-control-allow-origin'], '*');
  assert.match(v.headers['access-control-expose-headers'], /Content-Range/);
});

test('a video cut off upstream is cut off for the player too (no hanging)', async () => {
  const started = Date.now();
  const v = await get('127.0.0.1', `/${KEY}/stream/-100123/99/a.mkv`, { Host: `192.168.1.20:${port}` });
  assert.equal(v.complete, false);
  assert.ok(Date.now() - started < 10_000);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(gateway.activeStreams(), 0);
});

test('keyless 127.0.0.1: web pages and other host names refused, Stremio web allowed', async () => {
  assert.equal((await get('127.0.0.1', '/manifest.json', { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await get('127.0.0.1', '/manifest.json', { Host: `evil.example:${port}` })).status, 404);
  assert.equal((await get('127.0.0.1', '/manifest.json', { Origin: 'https://web.stremio.com' })).status, 200);
  assert.equal((await get('127.0.0.1', '/manifest.json', { Origin: 'https://relvhgchz5.strem.io' })).status, 200);
  assert.equal((await get('127.0.0.1', '/manifest.json', { Origin: 'https://strem.io.evil.example' })).status, 403);
});

test('the phone asking itself on the keyed address gets no duplicates', async () => {
  self = true;
  const s = await get('127.0.0.1', `/${KEY}/stream/movie/tt1.json`, { Host: `192.168.1.20:${port}` });
  self = false;
  assert.deepEqual(JSON.parse(s.body), { streams: [] });
});

test('from the network: 404 without the right key', async (t) => {
  const ip = Object.values(os.networkInterfaces()).flat()
    .find((a) => a && (a.family === 'IPv4' || a.family === 4) && !a.internal)?.address;
  if (!ip) return t.skip('no LAN address on this machine');
  assert.equal((await get(ip, '/manifest.json')).status, 404);
  assert.equal((await get(ip, '/stream/-100123/45/a.mkv')).status, 404);
  assert.equal((await get(ip, `/${'x'.repeat(22)}/manifest.json`)).status, 404);
  assert.equal((await get(ip, `/${KEY}/manifest.json`)).status, 200);
});

test('a new key reaches every account, without guessed addresses or https → http', () => {
  const t = lan.accountTargetUrl;
  const https = `https://192-168-0-4.local-ip.sh:7443/${KEY}/manifest.json`;
  const NEW = 'NewKey_0123456789abcdef';
  // normal: the current address
  assert.equal(t(https, `https://192-168-0-9.local-ip.sh:7443/${NEW}/manifest.json`, NEW, 'interfaces'), `https://192-168-0-9.local-ip.sh:7443/${NEW}/manifest.json`);
  // no https → http: same address, new key only
  assert.equal(t(https, `http://192.168.0.4:7000/${NEW}/manifest.json`, NEW, 'interfaces'), `https://192-168-0-4.local-ip.sh:7443/${NEW}/manifest.json`);
  // guessed address: same address, new key only
  assert.equal(t(https, `https://10-0-0-7.local-ip.sh:7443/${NEW}/manifest.json`, NEW, 'route'), `https://192-168-0-4.local-ip.sh:7443/${NEW}/manifest.json`);
  // off Wi-Fi: same address, new key only; nothing known: nothing to write
  assert.equal(t(https, null, NEW, 'interfaces'), `https://192-168-0-4.local-ip.sh:7443/${NEW}/manifest.json`);
  assert.equal(t(null, null, NEW, 'interfaces'), null);
});

test('after a new key, transfers that started with the old one are cut', async () => {
  const done = new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path: `/${KEY}/stream/-100123/77/slow.mkv`, headers: { Host: `192.168.1.20:${port}` } }, (res) => {
      res.on('data', () => {});
      res.on('close', () => resolve(res.complete));
    }).on('error', () => resolve(false));
  });
  await new Promise((r) => setTimeout(r, 150));
  gateway.dropKeyed();
  assert.equal(await done, false);
});

test('only videos and messages the addon offered can be opened', async () => {
  const host = { Host: `192.168.1.20:${port}` };
  // never offered: a guessed message number, a username, an id in a chat
  assert.equal((await get('127.0.0.1', `/${KEY}/stream/-100123/12345/a.mkv`, host)).status, 404);
  assert.equal((await get('127.0.0.1', `/${KEY}/stream/somechannel/45/a.mkv`, host)).status, 404);
  assert.equal((await get('127.0.0.1', `/${KEY}/meta/movie/tg%3A-100555%3A7.json`, host)).status, 404);
  assert.equal((await get('127.0.0.1', '/stream/-100123/12345/a.mkv')).status, 404);
  // offered by a stream list (45 is in /stream/movie/tt1.json): plays, and its
  // message can be looked at
  await get('127.0.0.1', '/stream/movie/tt1.json');
  assert.equal((await get('127.0.0.1', `/${KEY}/stream/-100123/45/a.mkv`, host)).status, 206);
  assert.equal((await get('127.0.0.1', `/${KEY}/meta/movie/tg%3A-100123%3A45.json`, host)).status, 200);
});

test('a broken address is refused, and the gateway keeps running', async () => {
  assert.equal((await get('127.0.0.1', '/stream/%E0%A4%A/1')).status, 400);
  assert.equal((await get('127.0.0.1', `/${KEY}/stream/%ZZ/45/a.mkv`, { Host: `192.168.1.20:${port}` })).status, 400);
  assert.equal((await get('127.0.0.1', '/manifest.json')).status, 200);
});

test('nothing it answers can run as a page', async () => {
  const m = await get('127.0.0.1', '/manifest.json');
  assert.equal(m.headers['x-content-type-options'], 'nosniff');
  assert.match(m.headers['content-security-policy'], /sandbox/);
  const doc = await get('127.0.0.1', '/stream/-100123/66/page.html');
  assert.equal(doc.headers['content-type'], 'application/octet-stream');
  assert.equal(doc.headers['content-disposition'], 'attachment');
  assert.match(doc.headers['content-security-policy'], /sandbox/);
  const video = await get('127.0.0.1', '/stream/-100123/45/a.mkv');
  assert.equal(video.headers['content-type'], 'video/x-matroska');
});

test('the list of offered videos: learned from answers, kept on disk, capped', async () => {
  const fs = await import('node:fs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telemedia-allow-'));
  const file = path.join(dir, 'media.json');
  const a = lan.createMediaAllowlist(file);
  a.harvest(JSON.stringify({ streams: [{ url: 'http://127.0.0.1:7000/stream/-1001/22/v.mp4' }], metas: [{ id: 'tg:-1001:23' }, { id: 'tgchat:-1009' }] }));
  assert.equal(a.check('/stream/-1001/22/v.mp4'), null);
  assert.equal(a.check('/stream/movie/tg%3A-1001%3A23.json'), null);
  assert.equal(a.check('/meta/series/tgchat%3A-1009.json'), null);
  assert.equal(a.check('/stream/-1001/24/v.mp4'), 'not offered');
  assert.equal(a.check('/stream/movie/tt0111161.json'), null);
  a.flush();
  const b = lan.createMediaAllowlist(file);
  assert.equal(b.check('/stream/-1001/22/v.mp4'), null);
  b.clear();
  assert.equal(lan.createMediaAllowlist(file).check('/stream/-1001/22/v.mp4'), 'not offered');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('key and address helpers', () => {
  assert.equal(lan.stripKey(`/${KEY}/stream/a`, KEY), '/stream/a');
  assert.equal(lan.stripKey(`/${KEY}`, KEY), '/');
  assert.equal(lan.stripKey('/manifest.json', KEY), null);
  assert.equal(lan.stripKey(`/${KEY.slice(1)}x/manifest.json`, KEY), null);
  assert.match(lan.newKey(), /^[A-Za-z0-9_-]{22}$/);
  assert.ok(lan.isPrivate('192.168.0.5') && lan.isPrivate('10.1.2.3') && lan.isPrivate('172.20.0.1'));
  assert.ok(!lan.isPrivate('100.64.0.1') && !lan.isPrivate('8.8.8.8') && !lan.isPrivate('172.32.0.1'));
  assert.ok(lan.isLoopback('::ffff:127.0.0.1') && !lan.isLoopback('192.168.0.5'));
});
