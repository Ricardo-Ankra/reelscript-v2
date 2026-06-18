import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseChannelBrand, validateBrandForm } from './brand.ts';

const FULL_COLORS = {
  background: '#000000',
  foreground: '#ffffff',
  primary: '#3B82F6',
  secondary: '#1E3A8A',
  accent: '#F59E0B',
  bodyText: '#E2E8F0',
  positive: '#22C55E',
  negative: '#EF4444',
};

const VALID_FORM = {
  name: 'The Signal',
  colors: FULL_COLORS,
  font: 'Montserrat',
  motion: 'punchy',
  tone: '  bold, direct ',
  captionsOn: false,
  density: 'liberal',
  musicOn: true,
};

test('parseChannelBrand: empty brand_kit → defaults (Poppins, standard motion, default colors)', () => {
  const f = parseChannelBrand({ name: 'X', brand_kit: {}, brand_voice: {}, defaults: {} });
  assert.equal(f.name, 'X');
  assert.equal(f.font, 'Poppins');
  assert.equal(f.motion, 'standard');
  assert.equal(f.colors.background, '#0B1F3A'); // DEFAULT_THEME backfill
  assert.equal(f.tone, '');
  assert.equal(f.captionsOn, true);
  assert.equal(f.density, 'sparing');
  assert.equal(f.musicOn, false);
});

test('parseChannelBrand: populated brand_kit → stored values', () => {
  const f = parseChannelBrand({
    name: 'Y',
    brand_kit: { colors: { primary: '#123456' }, typography: { font: 'Inter' }, motion_preset: 'subtle' },
    brand_voice: { tone: 'calm' },
    defaults: { captions_on: false, caption_emphasis_density: 'off', music_on: true },
  });
  assert.equal(f.colors.primary, '#123456');
  assert.equal(f.font, 'Inter');
  assert.equal(f.motion, 'subtle');
  assert.equal(f.tone, 'calm');
  assert.equal(f.captionsOn, false);
  assert.equal(f.density, 'off');
  assert.equal(f.musicOn, true);
});

test('parseChannelBrand: off-allowlist stored font → falls back to Poppins', () => {
  const f = parseChannelBrand({ name: 'Z', brand_kit: { typography: { font: 'Comic Sans' } }, brand_voice: {}, defaults: {} });
  assert.equal(f.font, 'Poppins');
});

test('validateBrandForm: valid form returns the RPC pieces, tone trimmed', () => {
  const r = validateBrandForm(VALID_FORM);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.name, 'The Signal');
  assert.deepEqual(r.value.brandKitPatch.colors, FULL_COLORS);
  assert.deepEqual(r.value.brandKitPatch.typography, { font: 'Montserrat' });
  assert.equal(r.value.brandKitPatch.motion_preset, 'punchy');
  assert.deepEqual(r.value.brandVoice, { tone: 'bold, direct' });
  assert.deepEqual(r.value.defaults, { captions_on: false, caption_emphasis_density: 'liberal', music_on: true });
});

test('validateBrandForm: blank tone is omitted from brandVoice', () => {
  const r = validateBrandForm({ ...VALID_FORM, tone: '   ' });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.value.brandVoice, {});
});

test('validateBrandForm: accepts #fff and #ffffff hex forms', () => {
  assert.equal(validateBrandForm({ ...VALID_FORM, colors: { ...FULL_COLORS, primary: '#fff' } }).ok, true);
  assert.equal(validateBrandForm({ ...VALID_FORM, colors: { ...FULL_COLORS, primary: '#ffffff' } }).ok, true);
});

test('validateBrandForm: rejects missing color key', () => {
  const sevenColors: Record<string, string> = { ...FULL_COLORS };
  delete sevenColors.background;
  assert.equal(validateBrandForm({ ...VALID_FORM, colors: sevenColors }).ok, false);
});

test('validateBrandForm: rejects bad hex, off-allowlist font, bad motion/density, empty name', () => {
  assert.equal(validateBrandForm({ ...VALID_FORM, colors: { ...FULL_COLORS, primary: 'red' } }).ok, false);
  assert.equal(validateBrandForm({ ...VALID_FORM, font: 'Comic Sans' }).ok, false);
  assert.equal(validateBrandForm({ ...VALID_FORM, motion: 'wild' }).ok, false);
  assert.equal(validateBrandForm({ ...VALID_FORM, density: 'lots' }).ok, false);
  assert.equal(validateBrandForm({ ...VALID_FORM, name: '   ' }).ok, false);
});
