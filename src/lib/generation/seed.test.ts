import { test } from 'node:test';
import assert from 'node:assert/strict';
import { videoSeed } from './seed.ts';

test('videoSeed is deterministic for the same id', () => {
  assert.equal(videoSeed('abc-123'), videoSeed('abc-123'));
});

test('videoSeed differs across ids', () => {
  assert.notEqual(videoSeed('abc-123'), videoSeed('abc-124'));
});

test('videoSeed is a non-negative safe integer', () => {
  const s = videoSeed('00000000-0000-0000-0000-000000000000');
  assert.ok(Number.isSafeInteger(s), 'safe integer');
  assert.ok(s >= 0, 'non-negative');
});
