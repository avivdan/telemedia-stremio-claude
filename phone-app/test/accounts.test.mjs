// Stremio account entries (node-bootstrap/stremio-account.js): connecting a
// phone to a TV's account, updating it, removing it — never touching the
// user's other addons or another person's phone.
// Run: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
// stremio-account.js loads the TV app's stremio-link.js from ./tv/ (copied
// there by the bundle); point that at the TV project for the tests.
const tvBootstrap = join(here, '..', '..', 'telemedia-stremio-claude', 'tv-app', 'node-bootstrap');
const Module = require('node:module');
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === './tv/stremio-link') return join(tvBootstrap, 'stremio-link.js');
  return resolve.call(this, request, ...rest);
};
const { mergeEntries } = require('../node-bootstrap/stremio-account.js');
const lan = require('../node-bootstrap/lan.js');

const MY_ID = 'community.telemedia.lan.ab12cd34';
const KEY = 'MyKey_0123456789abcdef';
const other = (id, url) => ({ transportUrl: url, manifest: { id, name: id, version: '1.0.0' } });
const cinemeta = other('com.linvo.cinemeta', 'https://v3-cinemeta.strem.io/manifest.json');
const local = other('community.telemedia', 'http://127.0.0.1:7000/manifest.json');
const friendsPhone = other('community.telemedia.lan.ffff0000', 'https://192-168-1-9.local-ip.sh:7443/FriendKey_0123456789ab/manifest.json');
const mine = (url) => ({ transportUrl: url, manifest: { id: MY_ID, name: "Telemedia (Blue's phone)", version: '0.3.0' } });
const ours = (url) => (a) => !!a.manifest && (a.manifest.id === MY_ID
  || (a.manifest.id === 'community.telemedia.lan' && (a.transportUrl === url || a.transportUrl.includes(`/${KEY}/`))));

test('connect: appended after the existing addons, others untouched', () => {
  const url = `https://192-168-1-20.local-ip.sh:7443/${KEY}/manifest.json`;
  const e = mine(url);
  const next = mergeEntries([cinemeta, local, friendsPhone], [e], ours(null));
  assert.deepEqual(next.map((a) => a.manifest.id), ['com.linvo.cinemeta', 'community.telemedia', 'community.telemedia.lan.ffff0000', MY_ID]);
});

test('new address or key: our entry replaced in place, the friend\'s phone kept', () => {
  const old = mine(`https://192-168-1-20.local-ip.sh:7443/${KEY}/manifest.json`);
  const newUrl = 'https://192-168-0-7.local-ip.sh:7443/NewKey_0123456789abcde/manifest.json';
  const next = mergeEntries([cinemeta, old, friendsPhone], [mine(newUrl)], ours(old.transportUrl));
  assert.deepEqual(next.map((a) => a.transportUrl), [cinemeta.transportUrl, newUrl, friendsPhone.transportUrl]);
});

test('older versions\' shared id: ours (by key) replaced, a stranger\'s kept', () => {
  const legacyMine = other('community.telemedia.lan', `http://192.168.0.104:7000/${KEY}/manifest.json`);
  const legacyStranger = other('community.telemedia.lan', 'http://192.168.0.50:7000/StrangerKey_0123456789/manifest.json');
  const url = `https://192-168-0-104.local-ip.sh:7443/${KEY}/manifest.json`;
  const next = mergeEntries([legacyMine, legacyStranger], [mine(url)], ours(null));
  assert.deepEqual(next.map((a) => [a.manifest.id, a.transportUrl]), [
    [MY_ID, url],
    ['community.telemedia.lan', legacyStranger.transportUrl],
  ]);
});

test('same address, new id or name (an update of an older entry): rewritten', () => {
  const url = `https://192-168-0-104.local-ip.sh:7443/${KEY}/manifest.json`;
  const legacy = { ...other('community.telemedia.lan', url), flags: { official: false, protected: false } };
  const next = mergeEntries([cinemeta, legacy, local], [mine(url)], ours(url));
  assert.deepEqual(next.map((a) => [a.manifest.id, a.manifest.name]), [
    ['com.linvo.cinemeta', 'com.linvo.cinemeta'],
    [MY_ID, "Telemedia (Blue's phone)"],
    ['community.telemedia', 'community.telemedia'],
  ]);
  assert.deepEqual(next[1].flags, { official: false, protected: false });
});

test('our entry twice (older bug): one kept, the copy dropped', () => {
  const url = `https://192-168-0-104.local-ip.sh:7443/${KEY}/manifest.json`;
  const next = mergeEntries([mine(url), cinemeta, mine(url)], [mine(url)], ours(url));
  assert.deepEqual(next.map((a) => a.manifest.id), [MY_ID, 'com.linvo.cinemeta']);
});

test('automatic update with our entry gone (removed in Stremio): nothing re-added', () => {
  const url = `https://192-168-0-7.local-ip.sh:7443/${KEY}/manifest.json`;
  const list = [cinemeta, local, friendsPhone];
  assert.equal(mergeEntries(list, [mine(url)], ours(null), true), list);
});

test('same address again: nothing to write', () => {
  const url = `https://192-168-1-20.local-ip.sh:7443/${KEY}/manifest.json`;
  const list = [cinemeta, mine(url)];
  assert.equal(mergeEntries(list, [mine(url)], ours(url)), list);
});

test('remove picks only this phone\'s entries', () => {
  const url = `https://192-168-1-20.local-ip.sh:7443/${KEY}/manifest.json`;
  const shouldRemove = (a) => (a.manifest && a.manifest.id === MY_ID) || a.transportUrl === url || a.transportUrl.includes(`/${KEY}/`);
  const list = [cinemeta, local, friendsPhone, mine(url), other('community.telemedia.lan', `http://192.168.1.20:7000/${KEY}/manifest.json`)];
  assert.deepEqual(list.filter((a) => !shouldRemove(a)).map((a) => a.manifest.id), ['com.linvo.cinemeta', 'community.telemedia', 'community.telemedia.lan.ffff0000']);
});

test('manifest for other devices: id and name per phone', () => {
  const m = lan.lanManifest({ id: 'community.telemedia', name: 'Telemedia', description: 'x' }, { id: MY_ID, name: "Telemedia (Blue's phone)" });
  assert.equal(m.id, MY_ID);
  assert.equal(m.name, "Telemedia (Blue's phone)");
  assert.equal(lan.lanManifest({ id: 'community.telemedia', name: 'Telemedia' }).id, 'community.telemedia.lan');
});
