import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalizeMusicParams,
  canonicalMusicJson,
  remuxIdempotencyKey,
  DEFAULT_MUSIC_PARAMS,
} from './params.ts';

test('canonicalizeMusicParams: fills defaults from empty input', () => {
  assert.deepEqual(canonicalizeMusicParams(undefined), DEFAULT_MUSIC_PARAMS);
  assert.deepEqual(canonicalizeMusicParams({}), DEFAULT_MUSIC_PARAMS);
});

test('canonicalizeMusicParams: clamps out-of-range and rounds to 3dp', () => {
  const c = canonicalizeMusicParams({ masterVolume: 2, duckingDepth: -1, fadeInSec: 0.123456 });
  assert.equal(c.masterVolume, 1);
  assert.equal(c.duckingDepth, 0);
  assert.equal(c.fadeInSec, 0.123);
});

test('canonicalMusicJson: cosmetically-different params produce identical JSON', () => {
  const a = canonicalMusicJson({ masterVolume: 0.2 });
  const b = canonicalMusicJson({ masterVolume: 0.20000001 });
  assert.equal(a, b);
});

test('canonicalMusicJson: key order is stable regardless of input order', () => {
  const a = canonicalMusicJson({ masterVolume: 0.3, loop: false });
  const b = canonicalMusicJson({ loop: false, masterVolume: 0.3 });
  assert.equal(a, b);
});

test('remuxIdempotencyKey: identical inputs hash equal, different track differs', () => {
  const k1 = remuxIdempotencyKey('base.mp4', 'track-1', { masterVolume: 0.2 });
  const k2 = remuxIdempotencyKey('base.mp4', 'track-1', { masterVolume: 0.20000001 });
  const k3 = remuxIdempotencyKey('base.mp4', 'track-2', { masterVolume: 0.2 });
  assert.equal(k1, k2);
  assert.notEqual(k1, k3);
});
