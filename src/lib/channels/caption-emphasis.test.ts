import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCaptionEmphasis,
  validateCaptionEmphasisForm,
  defaultToneColors,
} from './caption-emphasis.ts';
import { DEFAULT_THEME } from '../composition/theme.ts';
import { DEFAULT_ROLE_TABLE } from '../captions/emphasis-style.ts';

const T = DEFAULT_THEME; // positive #22C55E, negative #EF4444, accent #F59E0B

test('parseCaptionEmphasis: empty brand_kit → default role table + tones follow theme', () => {
  const f = parseCaptionEmphasis({}, T);
  assert.deepEqual(f.roles.shout, DEFAULT_ROLE_TABLE.shout);
  assert.equal(f.roles.key.weight, DEFAULT_ROLE_TABLE.key.weight);
  assert.deepEqual(f.tones.positive, { mode: 'theme', color: T.colors.positive });
  assert.deepEqual(f.tones.negative, { mode: 'theme', color: T.colors.negative });
  assert.deepEqual(f.tones.neutral, { mode: 'theme', color: T.colors.accent });
});

test('parseCaptionEmphasis: stored role override merges over default', () => {
  const f = parseCaptionEmphasis({ caption_emphasis: { roles: { key: { weight: 900 } } } }, T);
  assert.equal(f.roles.key.weight, 900);
  assert.equal(f.roles.key.font, DEFAULT_ROLE_TABLE.key.font); // untouched field keeps default
});

test('parseCaptionEmphasis: stored custom tone hex → mode custom', () => {
  const f = parseCaptionEmphasis({ caption_emphasis: { tones: { positive: { color: '#abcdef' } } } }, T);
  assert.deepEqual(f.tones.positive, { mode: 'custom', color: '#abcdef' });
});

test('parseCaptionEmphasis: stored tone as a theme-token name → resolved to hex, custom', () => {
  const f = parseCaptionEmphasis({ caption_emphasis: { tones: { neutral: { color: 'primary' } } } }, T);
  assert.deepEqual(f.tones.neutral, { mode: 'custom', color: T.colors.primary });
});

test('defaultToneColors: maps tones to the theme tokens they follow', () => {
  assert.deepEqual(defaultToneColors(T), {
    positive: T.colors.positive,
    negative: T.colors.negative,
    neutral: T.colors.accent,
  });
});

const VALID_FORM = {
  roles: {
    key: { font: 'body', weight: 700, sizeMultiplier: 1.15, italic: false },
    shout: { font: 'display', weight: 800, sizeMultiplier: 1.4, italic: false },
    contrast: { font: 'body', weight: 600, sizeMultiplier: 0.9, italic: true },
    number: { font: 'display', weight: 800, sizeMultiplier: 1.5, italic: false },
  },
  tones: {
    positive: { mode: 'custom', color: '#00ff00' },
    negative: { mode: 'theme', color: '#EF4444' },
    neutral: { mode: 'theme', color: '#F59E0B' },
  },
};

test('validateCaptionEmphasisForm: valid → full roles + only custom tones', () => {
  const r = validateCaptionEmphasisForm(VALID_FORM);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.value.roles?.shout, { font: 'display', weight: 800, sizeMultiplier: 1.4, italic: false });
  assert.equal(Object.keys(r.value.roles ?? {}).length, 4);
  assert.deepEqual(r.value.tones, { positive: { color: '#00ff00' } }); // only the custom one
});

test('validateCaptionEmphasisForm: all tones following theme → tones key omitted', () => {
  const allTheme = {
    ...VALID_FORM,
    tones: {
      positive: { mode: 'theme', color: '#1' },
      negative: { mode: 'theme', color: '#2' },
      neutral: { mode: 'theme', color: '#3' },
    },
  };
  const r = validateCaptionEmphasisForm(allTheme);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal('tones' in r.value, false);
});

test('validateCaptionEmphasisForm: rejects bad font / weight / size / italic / custom hex', () => {
  assert.equal(validateCaptionEmphasisForm({ ...VALID_FORM, roles: { ...VALID_FORM.roles, key: { ...VALID_FORM.roles.key, font: 'serif' } } }).ok, false);
  assert.equal(validateCaptionEmphasisForm({ ...VALID_FORM, roles: { ...VALID_FORM.roles, key: { ...VALID_FORM.roles.key, weight: 99 } } }).ok, false);
  assert.equal(validateCaptionEmphasisForm({ ...VALID_FORM, roles: { ...VALID_FORM.roles, key: { ...VALID_FORM.roles.key, weight: 901 } } }).ok, false);
  assert.equal(validateCaptionEmphasisForm({ ...VALID_FORM, roles: { ...VALID_FORM.roles, key: { ...VALID_FORM.roles.key, weight: 700.5 } } }).ok, false);
  assert.equal(validateCaptionEmphasisForm({ ...VALID_FORM, roles: { ...VALID_FORM.roles, key: { ...VALID_FORM.roles.key, sizeMultiplier: 0.4 } } }).ok, false);
  assert.equal(validateCaptionEmphasisForm({ ...VALID_FORM, roles: { ...VALID_FORM.roles, key: { ...VALID_FORM.roles.key, sizeMultiplier: 3.1 } } }).ok, false);
  assert.equal(validateCaptionEmphasisForm({ ...VALID_FORM, tones: { ...VALID_FORM.tones, positive: { mode: 'custom', color: 'green' } } }).ok, false);
});
