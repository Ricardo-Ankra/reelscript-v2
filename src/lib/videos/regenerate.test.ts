import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGenerateConfig,
  buildBrandContext,
  validateRegenerateInput,
  MIN_TARGET_LENGTH,
  MAX_TARGET_LENGTH,
} from './regenerate.ts';

test('buildGenerateConfig: uses the new length (seconds) + fields from settings', () => {
  const cfg = buildGenerateConfig(
    { aspect_ratio: '1:1', fps: 24, captions_on: false, music_on: true, target_length: 45 },
    60,
  );
  assert.equal(cfg.targetLengthSeconds, 60); // new length wins, in seconds
  assert.equal(cfg.aspectRatio, '1:1');
  assert.equal(cfg.fps, 24);
  assert.equal(cfg.captions, false);
  assert.equal(cfg.music, true);
});

test('buildGenerateConfig: empty settings fall back to defaults, new length applied', () => {
  const cfg = buildGenerateConfig({}, 30);
  assert.equal(cfg.targetLengthSeconds, 30);
  assert.equal(cfg.aspectRatio, '9:16');
  assert.equal(cfg.fps, 30);
  assert.equal(cfg.captions, true);
  assert.equal(cfg.music, false);
});

test('buildGenerateConfig: unit agreement — reads the same seconds the panel shows', () => {
  // panel renders settings.target_length as "45s"; regenerate supplies the new value
  // in the SAME unit (seconds). No minutes/label drift.
  assert.equal(buildGenerateConfig({ target_length: 45 }, 60).targetLengthSeconds, 60);
});

test('buildBrandContext: name + tone present', () => {
  assert.deepEqual(buildBrandContext({ name: 'Studio', brand_voice: { tone: 'punchy' } }), {
    channelName: 'Studio',
    tone: 'punchy',
  });
});

test('buildBrandContext: missing/blank tone is omitted (name always used as given)', () => {
  assert.deepEqual(buildBrandContext({ name: 'Studio', brand_voice: null }), { channelName: 'Studio' });
  assert.deepEqual(buildBrandContext({ name: 'Studio' }), { channelName: 'Studio' });
});

test('validateRegenerateInput: empty/whitespace prompt rejected', () => {
  assert.equal(validateRegenerateInput({ prompt: '   ', targetLengthSeconds: 30 }).ok, false);
  assert.equal(validateRegenerateInput({ targetLengthSeconds: 30 }).ok, false);
});

test('validateRegenerateInput: length bounds + integer', () => {
  assert.equal(validateRegenerateInput({ prompt: 'x', targetLengthSeconds: MIN_TARGET_LENGTH - 1 }).ok, false);
  assert.equal(validateRegenerateInput({ prompt: 'x', targetLengthSeconds: MAX_TARGET_LENGTH + 1 }).ok, false);
  assert.equal(validateRegenerateInput({ prompt: 'x', targetLengthSeconds: 30.5 }).ok, false);
});

test('validateRegenerateInput: valid trims prompt and returns value', () => {
  const r = validateRegenerateInput({ prompt: '  make it about cats ', targetLengthSeconds: 30 });
  assert.deepEqual(r, { ok: true, value: { prompt: 'make it about cats', targetLengthSeconds: 30 } });
});
