// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errors } from 'telegram';
import { withTimeout, TimeoutError, isFileReferenceError } from '../src/api/telegram';

test('isFileReferenceError: spots expired references in gramjs 400s', () => {
  const expired = new errors.BadRequestError('FILE_REFERENCE_EXPIRED', undefined as never, 400);
  assert.equal(expired.errorMessage, 'BAD_REQUEST'); // why we match the text
  assert.ok(isFileReferenceError(expired));
  assert.ok(isFileReferenceError(new Error('400: FILE_REFERENCE_INVALID (caused by upload.GetFile)')));
  assert.ok(!isFileReferenceError(new Error('Not connected')));
  assert.ok(!isFileReferenceError('FILE_REFERENCE_EXPIRED'));
});

test('withTimeout: a hung promise fails with TimeoutError', async () => {
  const hung = new Promise<never>(() => {});
  await assert.rejects(withTimeout(hung, 20, 'block'), (err) =>
    err instanceof TimeoutError && /block: no answer/.test(err.message));
});

test('withTimeout: an answer in time passes through, errors too', async () => {
  assert.equal(await withTimeout(Promise.resolve(7), 1000, 'x'), 7);
  await assert.rejects(withTimeout(Promise.reject(new Error('boom')), 1000, 'x'), /boom/);
});
