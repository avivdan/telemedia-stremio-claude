// Unit tests for the pure parts of the phone bootstrap (no network).
// Run: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scramble } from '../scripts/toolchain.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const groups = require('../node-bootstrap/groups.js');
const login = require('../node-bootstrap/login.js');
const tvBootstrap = join(here, '..', '..', 'telemedia-stremio-claude', 'tv-app', 'node-bootstrap');

test('group links: usernames', () => {
  for (const s of ['@Some_Channel', 't.me/Some_Channel', 'https://t.me/Some_Channel/', 'tg://resolve?domain=Some_Channel']) {
    assert.deepEqual(groups.parseGroupLink(s), { kind: 'username', username: 'Some_Channel' }, s);
  }
});

test('group links: invites', () => {
  for (const s of ['https://t.me/+AbC-12_x', 't.me/joinchat/AbC-12_x', 'tg://join?invite=AbC-12_x']) {
    assert.deepEqual(groups.parseGroupLink(s), { kind: 'invite', hash: 'AbC-12_x' }, s);
  }
});

test('group links: rejects what it cannot join', () => {
  for (const s of ['', '-1001106800100', 'https://example.com/x', 't.me/ab', 'hello world']) {
    assert.equal(groups.parseGroupLink(s), null, s);
  }
});

test('group list: lines, notes, comments, duplicates', () => {
  const list = groups.parseGroupList(
    '# suggested\n@first_group | Movies, in Hebrew\n\nhttps://t.me/+Inv1te\nt.me/FIRST_GROUP\n',
  );
  assert.deepEqual(list, [
    { link: '@first_group', note: 'Movies, in Hebrew', kind: 'username', username: 'first_group' },
    { link: 'https://t.me/+Inv1te', note: '', kind: 'invite', hash: 'Inv1te' },
  ]);
  assert.equal(groups.parseGroupList('@aaaa1,@bbbb2').length, 2);
  assert.deepEqual(groups.parseGroupList(''), []);
  assert.throws(() => groups.parseGroupList('not a link'), /can't read/);
});

test('login: friendly errors', () => {
  assert.match(login.friendlyError({ errorMessage: 'PHONE_CODE_INVALID' }), /Wrong code/);
  assert.match(login.friendlyError({ errorMessage: 'FLOOD', seconds: 300 }), /Wait 5 minutes/);
  assert.match(login.friendlyError(new Error('FLOOD_WAIT_60')), /Wait 1 minute /);
  assert.equal(login.friendlyError(new Error('SOMETHING_ELSE')), 'SOMETHING_ELSE');
});

test('starter key: the TV app unscrambles what we scramble', () => {
  const { unscramble } = require(join(tvBootstrap, 'starter-login.js'));
  const key = { apiId: '123456', apiHash: '0123456789abcdef0123456789abcdef' };
  const text = scramble(key);
  assert.ok(!text.includes(key.apiHash) && !Buffer.from(text, 'base64').toString().includes(key.apiHash));
  assert.deepEqual(unscramble(text), key);
  assert.equal(scramble(undefined), undefined);
});
