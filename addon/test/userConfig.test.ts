// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSetting } from '../src/userConfig';

const file = {
  apiId: 123,
  apiHash: 'filehash',
  session: 'filesession',
  settings: { CATALOG_COUNTRY: 'US', STREAM_PARALLEL: 3 },
};

test('resolveSetting: environment wins, then config file, else undefined', () => {
  assert.equal(resolveSetting('TELEGRAM_API_ID', { TELEGRAM_API_ID: '999' }, file), '999');
  assert.equal(resolveSetting('TELEGRAM_API_ID', {}, file), '123');
  assert.equal(resolveSetting('TELEGRAM_SESSION', {}, file), 'filesession');
  assert.equal(resolveSetting('CATALOG_COUNTRY', {}, file), 'US');
  assert.equal(resolveSetting('STREAM_PARALLEL', {}, file), '3');
  assert.equal(resolveSetting('LOG_LEVEL', {}, file), undefined);
  assert.equal(resolveSetting('LOG_LEVEL', {}, {}), undefined);
});

test('resolveSetting: empty values fall through instead of overriding', () => {
  assert.equal(resolveSetting('TELEGRAM_API_HASH', { TELEGRAM_API_HASH: '' }, file), 'filehash');
  assert.equal(resolveSetting('TELEGRAM_API_HASH', {}, { apiHash: '' }), undefined);
});
