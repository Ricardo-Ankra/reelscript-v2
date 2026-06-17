import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeSettingsPatch,
  parseVideoSettings,
  SETTINGS_DEFAULTS,
} from './settings.ts';

test('sanitizeSettingsPatch: keeps valid keys, normalises nothing extra', () => {
  const out = sanitizeSettingsPatch({
    captions_on: false,
    caption_emphasis_density: 'liberal',
    music_on: true,
    aspect_ratio: '16:9',
    fps: 24,
  });
  assert.deepEqual(out, {
    captions_on: false,
    caption_emphasis_density: 'liberal',
    music_on: true,
    aspect_ratio: '16:9',
    fps: 24,
  });
});

test('sanitizeSettingsPatch: drops invalid enum / fps / non-boolean / unknown keys', () => {
  const out = sanitizeSettingsPatch({
    caption_emphasis_density: 'huge', // invalid
    aspect_ratio: '4:3', // invalid
    fps: 60, // invalid
    captions_on: 'yes', // not a boolean
    bogus: 1, // unknown
  });
  assert.deepEqual(out, {});
});

test('sanitizeSettingsPatch: non-object input → empty patch', () => {
  assert.deepEqual(sanitizeSettingsPatch(null), {});
  assert.deepEqual(sanitizeSettingsPatch('x'), {});
});

test('sanitizeSettingsPatch: toggling captions off does NOT include density (item 4)', () => {
  const out = sanitizeSettingsPatch({ captions_on: false });
  assert.deepEqual(out, { captions_on: false });
  assert.ok(!('caption_emphasis_density' in out), 'density key absent → merge cannot clear a stored value');
});

test('parseVideoSettings: empty → defaults', () => {
  assert.deepEqual(parseVideoSettings({}), SETTINGS_DEFAULTS);
  assert.deepEqual(parseVideoSettings(null), SETTINGS_DEFAULTS);
});

test('parseVideoSettings: partial raw merges over defaults; invalid values fall back', () => {
  const s = parseVideoSettings({ captions_on: false, aspect_ratio: '1:1', fps: 99, target_length: 45 });
  assert.equal(s.captions_on, false);
  assert.equal(s.aspect_ratio, '1:1');
  assert.equal(s.fps, SETTINGS_DEFAULTS.fps); // 99 invalid → default
  assert.equal(s.target_length, 45);
  assert.equal(s.caption_emphasis_density, SETTINGS_DEFAULTS.caption_emphasis_density);
});
