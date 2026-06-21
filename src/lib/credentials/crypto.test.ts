import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encryptSecret, decryptSecret } from './crypto.ts';

// A fixed 32-byte key (64 hex chars) for deterministic tests.
const KEY = '0'.repeat(64);

test('encryptSecret/decryptSecret: round-trips', () => {
  const plain = 'sk-ant-secret-value-123';
  const enc = encryptSecret(plain, KEY);
  assert.equal(decryptSecret(enc, KEY), plain);
});

test('encryptSecret: two encryptions differ (random iv) but both decrypt', () => {
  const a = encryptSecret('same', KEY);
  const b = encryptSecret('same', KEY);
  assert.notEqual(a, b);
  assert.equal(decryptSecret(a, KEY), 'same');
  assert.equal(decryptSecret(b, KEY), 'same');
});

test('decryptSecret: throws on a tampered payload', () => {
  const enc = encryptSecret('secret', KEY);
  const [iv, ct, tag] = enc.split('.');
  // Flip the last char of the ciphertext.
  const flipped = ct.slice(0, -1) + (ct.slice(-1) === 'A' ? 'B' : 'A');
  assert.throws(() => decryptSecret([iv, flipped, tag].join('.'), KEY));
});

test('decryptSecret: throws on a malformed payload', () => {
  assert.throws(() => decryptSecret('not-a-valid-payload', KEY));
});

test('decryptSecret: wrong key throws', () => {
  const enc = encryptSecret('secret', KEY);
  assert.throws(() => decryptSecret(enc, 'f'.repeat(64)));
});

test('decryptSecret: throws on a wrong-length auth tag', () => {
  const enc = encryptSecret('secret', KEY);
  const [iv, ct] = enc.split('.');
  // A 4-byte (not 16-byte) tag, base64-encoded.
  const shortTag = Buffer.from([1, 2, 3, 4]).toString('base64');
  assert.throws(() => decryptSecret([iv, ct, shortTag].join('.'), KEY));
});
