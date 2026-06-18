import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseVideoDefaults,
  validateVideoDefaultsForm,
  VIDEO_DEFAULTS_FALLBACK,
} from './video-defaults.ts';

test('VIDEO_DEFAULTS_FALLBACK is 9:16 / 30 / 30', () => {
  assert.deepEqual(VIDEO_DEFAULTS_FALLBACK, { aspectRatio: '9:16', fps: 30, targetLength: 30 });
});

test('parseVideoDefaults: empty → fallback', () => {
  assert.deepEqual(parseVideoDefaults({}), VIDEO_DEFAULTS_FALLBACK);
});

test('parseVideoDefaults: garbage / null → fallback', () => {
  assert.deepEqual(parseVideoDefaults(null), VIDEO_DEFAULTS_FALLBACK);
  assert.deepEqual(parseVideoDefaults('nope'), VIDEO_DEFAULTS_FALLBACK);
});

test('parseVideoDefaults: full stored object → those values', () => {
  const f = parseVideoDefaults({ aspect_ratio: '16:9', fps: 24, target_length: 60 });
  assert.deepEqual(f, { aspectRatio: '16:9', fps: 24, targetLength: 60 });
});

test('parseVideoDefaults: partial object backfills only missing keys', () => {
  const f = parseVideoDefaults({ aspect_ratio: '1:1' });
  assert.deepEqual(f, { aspectRatio: '1:1', fps: 30, targetLength: 30 });
});

test('parseVideoDefaults: wrong-typed values fall back per field', () => {
  const f = parseVideoDefaults({ aspect_ratio: 'banana', fps: 99, target_length: 4 });
  assert.deepEqual(f, VIDEO_DEFAULTS_FALLBACK);
});

test('parseVideoDefaults: ignores the brand editor sibling keys', () => {
  const f = parseVideoDefaults({ captions_on: false, music_on: true, caption_emphasis_density: 'liberal' });
  assert.deepEqual(f, VIDEO_DEFAULTS_FALLBACK);
});

test('validateVideoDefaultsForm: valid form → snake_case value', () => {
  const r = validateVideoDefaultsForm({ aspectRatio: '16:9', fps: 24, targetLength: 60 });
  assert.equal(r.ok, true);
  assert.ok(r.ok && r.value.aspect_ratio === '16:9');
  assert.ok(r.ok && r.value.fps === 24);
  assert.ok(r.ok && r.value.target_length === 60);
});

test('validateVideoDefaultsForm: rejects bad aspect ratio', () => {
  assert.equal(validateVideoDefaultsForm({ aspectRatio: '4:3', fps: 30, targetLength: 30 }).ok, false);
});

test('validateVideoDefaultsForm: rejects bad fps', () => {
  assert.equal(validateVideoDefaultsForm({ aspectRatio: '9:16', fps: 25, targetLength: 30 }).ok, false);
});

test('validateVideoDefaultsForm: rejects target_length out of range / non-integer', () => {
  const base = { aspectRatio: '9:16', fps: 30 };
  assert.equal(validateVideoDefaultsForm({ ...base, targetLength: 4 }).ok, false);
  assert.equal(validateVideoDefaultsForm({ ...base, targetLength: 181 }).ok, false);
  assert.equal(validateVideoDefaultsForm({ ...base, targetLength: 30.5 }).ok, false);
  assert.equal(validateVideoDefaultsForm({ ...base, targetLength: 'x' as unknown as number }).ok, false);
});
