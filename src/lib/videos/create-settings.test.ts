import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseChannelCreateOptions, mergeCreateSettings } from './create-settings.ts';
import { SETTINGS_DEFAULTS } from './settings.ts';

test('parseChannelCreateOptions: empty/invalid → SETTINGS_DEFAULTS', () => {
  assert.deepEqual(parseChannelCreateOptions(null), SETTINGS_DEFAULTS);
  assert.deepEqual(parseChannelCreateOptions({}), SETTINGS_DEFAULTS);
});

test('parseChannelCreateOptions: reads the channel-stored full option set', () => {
  const out = parseChannelCreateOptions({
    aspect_ratio: '16:9',
    fps: 24,
    target_length: 45,
    captions_on: false,
    caption_emphasis_density: 'liberal',
    music_on: true,
  });
  assert.deepEqual(out, {
    aspect_ratio: '16:9',
    fps: 24,
    target_length: 45,
    captions_on: false,
    caption_emphasis_density: 'liberal',
    music_on: true,
    color_look: 'neutral',
    preview_gate: false,
  });
});

test('parseChannelCreateOptions: invalid single key falls back to its default', () => {
  const out = parseChannelCreateOptions({ aspect_ratio: '4:3', fps: 60, target_length: 0 });
  assert.equal(out.aspect_ratio, SETTINGS_DEFAULTS.aspect_ratio);
  assert.equal(out.fps, SETTINGS_DEFAULTS.fps);
  assert.equal(out.target_length, SETTINGS_DEFAULTS.target_length);
});

test('parseChannelCreateOptions: out-of-bounds / non-integer target_length → fallback', () => {
  assert.equal(parseChannelCreateOptions({ target_length: 3 }).target_length, SETTINGS_DEFAULTS.target_length);
  assert.equal(parseChannelCreateOptions({ target_length: 12.5 }).target_length, SETTINGS_DEFAULTS.target_length);
  assert.equal(parseChannelCreateOptions({ target_length: 500 }).target_length, SETTINGS_DEFAULTS.target_length);
  assert.equal(parseChannelCreateOptions({ target_length: 45 }).target_length, 45);
});

test('mergeCreateSettings: valid override wins per key', () => {
  const base = { ...SETTINGS_DEFAULTS };
  const out = mergeCreateSettings(base, {
    aspect_ratio: '1:1',
    fps: 24,
    target_length: 60,
    captions_on: false,
    caption_emphasis_density: 'off',
    music_on: true,
  });
  assert.deepEqual(out, {
    aspect_ratio: '1:1',
    fps: 24,
    target_length: 60,
    captions_on: false,
    caption_emphasis_density: 'off',
    music_on: true,
    color_look: 'neutral',
    preview_gate: false,
  });
});

test('mergeCreateSettings: empty/invalid override → base unchanged', () => {
  const base = { ...SETTINGS_DEFAULTS, aspect_ratio: '16:9' as const, music_on: true };
  assert.deepEqual(mergeCreateSettings(base, {}), base);
  assert.deepEqual(mergeCreateSettings(base, null), base);
  assert.deepEqual(mergeCreateSettings(base, { aspect_ratio: '4:3', fps: 99 }), base);
});

test('mergeCreateSettings: out-of-bounds / non-integer target_length → base', () => {
  const base = { ...SETTINGS_DEFAULTS, target_length: 30 };
  assert.equal(mergeCreateSettings(base, { target_length: 4 }).target_length, 30);
  assert.equal(mergeCreateSettings(base, { target_length: 181 }).target_length, 30);
  assert.equal(mergeCreateSettings(base, { target_length: 12.5 }).target_length, 30);
  assert.equal(mergeCreateSettings(base, { target_length: 90 }).target_length, 90);
});
