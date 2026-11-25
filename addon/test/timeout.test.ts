// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withTimeout, TimeoutError } from '../src/api/telegram';

test('withTimeout: a hung promise fails with TimeoutError', async () => {
  const hung = new Promise<never>(() => {});
  await assert.rejects(withTimeout(hung, 20, 'block'), (err) =>
    err instanceof TimeoutError && /block: no answer/.test(err.message));
});

test('withTimeout: an answer in time passes through, errors too', async () => {
  assert.equal(await withTimeout(Promise.resolve(7), 1000, 'x'), 7);
  await assert.rejects(withTimeout(Promise.reject(new Error('boom')), 1000, 'x'), /boom/);
});
