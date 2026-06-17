import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveWordStyle, DEFAULT_ROLE_TABLE } from './emphasis-style.ts';
import type { CaptionEmphasisConfig } from './emphasis-style.ts';
import type { Theme } from '../primitives/contract.ts';

const THEME: Theme = {
  colors: {
    background: '#0B1F3A',
    foreground: '#FFFFFF',
    primary: '#3B82F6',
    secondary: '#1E3A8A',
    accent: '#F59E0B',
    bodyText: '#E2E8F0',
    positive: '#22C55E',
    negative: '#EF4444',
  },
  fonts: { display: 'Anton', body: 'Inter', mono: 'monospace' },
  logos: {},
  motion: 'standard',
};

test('a normal (unemphasized) word uses body font, weight 400, foreground colour', () => {
  const s = resolveWordStyle(undefined, THEME);
  assert.equal(s.fontFamily, 'Inter');
  assert.equal(s.fontWeight, 400);
  assert.equal(s.sizeMultiplier, 1);
  assert.equal(s.italic, false);
  assert.equal(s.color, '#FFFFFF');
});

test('role → typography from the default table', () => {
  const key = resolveWordStyle({ index: 0, role: 'key' }, THEME);
  assert.equal(key.fontFamily, 'Inter'); // body
  assert.equal(key.fontWeight, 700);
  assert.equal(key.sizeMultiplier, 1.15);

  const shout = resolveWordStyle({ index: 0, role: 'shout' }, THEME);
  assert.equal(shout.fontFamily, 'Anton'); // display
  assert.equal(shout.sizeMultiplier, 1.4);

  const contrast = resolveWordStyle({ index: 0, role: 'contrast' }, THEME);
  assert.equal(contrast.italic, true);
  assert.equal(contrast.sizeMultiplier, 0.9);
});

test('tone → colour: resolves through the baked theme tokens', () => {
  assert.equal(resolveWordStyle({ index: 0, role: 'key' }, THEME).color, THEME.colors.accent); // tone omitted → neutral
  assert.equal(resolveWordStyle({ index: 0, role: 'key', tone: 'neutral' }, THEME).color, THEME.colors.accent);
  assert.equal(resolveWordStyle({ index: 0, role: 'key', tone: 'positive' }, THEME).color, THEME.colors.positive);
  assert.equal(resolveWordStyle({ index: 0, role: 'key', tone: 'negative' }, THEME).color, THEME.colors.negative);
});

test('brand config overrides a role field, falling back to defaults for the rest', () => {
  const config: CaptionEmphasisConfig = { roles: { key: { weight: 900, sizeMultiplier: 2 } } };
  const s = resolveWordStyle({ index: 0, role: 'key' }, THEME, config);
  assert.equal(s.fontWeight, 900); // overridden
  assert.equal(s.sizeMultiplier, 2); // overridden
  assert.equal(s.fontFamily, 'Inter'); // default body retained
  assert.equal(s.italic, DEFAULT_ROLE_TABLE.key.italic);
});

test('brand config overrides a tone colour with a hex or a theme-token name', () => {
  const hex: CaptionEmphasisConfig = { tones: { positive: { color: '#00FF00' } } };
  assert.equal(resolveWordStyle({ index: 0, role: 'key', tone: 'positive' }, THEME, hex).color, '#00FF00');

  const token: CaptionEmphasisConfig = { tones: { positive: { color: 'primary' } } };
  assert.equal(resolveWordStyle({ index: 0, role: 'key', tone: 'positive' }, THEME, token).color, THEME.colors.primary);
});
