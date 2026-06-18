import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateChannelName, MAX_CHANNEL_NAME } from './validate.ts';

test('validateChannelName: rejects empty / whitespace / non-string', () => {
  assert.equal(validateChannelName('').ok, false);
  assert.equal(validateChannelName('   ').ok, false);
  assert.equal(validateChannelName(undefined).ok, false);
  assert.equal(validateChannelName(42).ok, false);
});

test('validateChannelName: rejects over-long', () => {
  const long = 'a'.repeat(MAX_CHANNEL_NAME + 1);
  assert.equal(validateChannelName(long).ok, false);
});

test('validateChannelName: accepts a name at the length limit', () => {
  const atLimit = 'a'.repeat(MAX_CHANNEL_NAME);
  assert.deepEqual(validateChannelName(atLimit), { ok: true, value: atLimit });
});

test('validateChannelName: trims and returns the trimmed value', () => {
  assert.deepEqual(validateChannelName('  My Channel  '), {
    ok: true,
    value: 'My Channel',
  });
});
