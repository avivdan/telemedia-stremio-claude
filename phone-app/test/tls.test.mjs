// The HTTPS side of the LAN gateway (node-bootstrap/lan.js), with a
// self-signed *.local-ip.sh certificate made by openssl (skipped without it).
// Run: npm test

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const lan = require('../node-bootstrap/lan.js');

const KEY = 'TlsTestKey_0123456789';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telemedia-tls-'));
let pair = null;
try {
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '30',
    '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'),
    '-subj', '/CN=*.local-ip.sh', '-addext', 'subjectAltName=DNS:*.local-ip.sh',
  ], { stdio: 'ignore' });
  pair = { cert: fs.readFileSync(path.join(dir, 'c.pem'), 'utf8'), key: fs.readFileSync(path.join(dir, 'k.pem'), 'utf8') };
} catch {
  // no openssl: the tests below skip
}

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });

let addon;
let gateway;
let port;
let tlsPort;

before(async () => {
  if (!pair) return;
  port = await freePort();
  tlsPort = await freePort();
  const addonPort = await freePort();
  addon = http
    .createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ streams: [{ url: `http://127.0.0.1:${port}/stream/-100123/45/a.mkv` }] }));
    })
    .listen(addonPort, '127.0.0.1');
  gateway = lan.createGateway({
    port, tlsPort, addonPort,
    getKey: () => KEY, isSelf: () => false, dedupeSelf: () => false, onLocalStremio: () => {},
  });
  gateway.setTls(pair);
  await new Promise((r) => (gateway.tlsActive() ? r() : gateway.tlsServer().on('listening', r)));
});

after(() => {
  if (!pair) return;
  gateway.server.close();
  gateway.tlsServer().close();
  addon.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('certificate check', { skip: !pair && 'openssl not available' }, () => {
  assert.equal(lan.checkCert(pair), null);
  assert.match(lan.checkCert(pair, Date.now() + 40 * 86_400_000), /expired/);
  assert.match(lan.checkCert({ cert: pair.cert, key: 'nope' }), /unreadable/);
  assert.match(lan.checkCert({ cert: 'nope', key: pair.key }), /unreadable/);
  assert.equal(lan.tlsHostname('192.168.0.104'), '192-168-0-104.local-ip.sh');
});

test('https with the key: stream URLs on the https address', { skip: !pair && 'openssl not available' }, async () => {
  const host = `192-168-1-20.local-ip.sh:${tlsPort}`;
  const body = await new Promise((resolve, reject) => {
    https
      .get({
        host: '127.0.0.1', port: tlsPort, path: `/${KEY}/stream/movie/tt1.json`,
        headers: { Host: host }, servername: '192-168-1-20.local-ip.sh', rejectUnauthorized: false,
      }, (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => resolve(b));
      })
      .on('error', reject);
  });
  assert.equal(JSON.parse(body).streams[0].url, `https://${host}/${KEY}/stream/-100123/45/a.mkv`);
});

test('https preflight from a web app: CORS and private network allowed', { skip: !pair && 'openssl not available' }, async () => {
  const res = await new Promise((resolve, reject) => {
    const req = https.request({
      host: '127.0.0.1', port: tlsPort, method: 'OPTIONS', path: `/${KEY}/manifest.json`,
      headers: {
        Origin: 'https://web.stremio.com',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Private-Network': 'true',
      },
      rejectUnauthorized: false,
    }, resolve);
    req.on('error', reject);
    req.end();
  });
  assert.equal(res.statusCode, 204);
  assert.equal(res.headers['access-control-allow-origin'], '*');
  assert.equal(res.headers['access-control-allow-private-network'], 'true');
});
