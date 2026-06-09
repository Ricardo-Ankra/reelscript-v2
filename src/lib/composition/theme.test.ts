import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bakeTheme, DEFAULT_THEME } from './theme.ts';

test('bakeTheme: null brand_kit yields the full defaults', () => {
  assert.deepEqual(bakeTheme(null), DEFAULT_THEME);
  assert.deepEqual(bakeTheme(undefined), DEFAULT_THEME);
});

test('bakeTheme: minimal seed (primary + font) backfills the rest', () => {
  const t = bakeTheme({ colors: { primary: '#E2725B' }, typography: { font: 'Poppins' } });
  assert.equal(t.colors.primary, '#E2725B'); // brand wins
  assert.equal(t.colors.background, DEFAULT_THEME.colors.background); // default backfills
  assert.equal(t.fonts.display, 'Poppins');
  assert.equal(t.fonts.body, 'Poppins');
  assert.equal(t.fonts.mono, 'monospace');
});

test('bakeTheme: every supplied colour token overrides its default', () => {
  const t = bakeTheme({ colors: { background: '#111', foreground: '#eee', accent: '#0f0' } });
  assert.equal(t.colors.background, '#111');
  assert.equal(t.colors.foreground, '#eee');
  assert.equal(t.colors.accent, '#0f0');
  assert.equal(t.colors.secondary, DEFAULT_THEME.colors.secondary);
});

test('bakeTheme: motion_preset validated, bad value falls back', () => {
  assert.equal(bakeTheme({ motion_preset: 'punchy' }).motion, 'punchy');
  assert.equal(bakeTheme({ motion_preset: 'wild' }).motion, 'standard');
});

test('bakeTheme: never returns logos (signed separately, unused in Phase 4)', () => {
  assert.deepEqual(bakeTheme({ colors: { primary: '#fff' } }).logos, {});
});

test('bakeTheme: result is a complete Theme (all tokens present)', () => {
  const t = bakeTheme({});
  for (const k of ['background', 'foreground', 'primary', 'secondary', 'accent', 'bodyText'] as const) {
    assert.equal(typeof t.colors[k], 'string');
  }
  assert.ok(t.fonts.display && t.fonts.body && t.fonts.mono);
});
