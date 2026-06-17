import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildEffectProbe } from './effect-probe.ts';
import { lintPrimitive } from '../primitives/lint.ts';
import { EMPHASIS_EFFECTS } from './types.ts';

const effectSource = (name: string) =>
  readFileSync(new URL(`./effects/${name}.ts`, import.meta.url), 'utf8');

test('buildEffectProbe inlines the effect source and exposes a default export', () => {
  const src = effectSource('pop');
  const { code, propSchema } = buildEffectProbe('pop', src);
  assert.ok(code.includes('export const pop'), 'inlines the real effect source');
  assert.match(code, /export default function/);
  assert.ok(code.includes('pop(t)'), 'invokes the effect by name');
  // No stressable text prop: an effect animates a short word the system controls,
  // so it is stressed against the extreme THEMES (the aspect-robust dimension),
  // not an 80-char overflow paragraph it can never receive.
  assert.deepEqual(propSchema, []);
  assert.match(code, /rehabilitation/, 'bakes a realistic worst-case emphasis word');
});

test('buildEffectProbe bounds + wraps text so overflowing content stays in frame', () => {
  // The brand stress kit feeds pathologically long text; like a real caption band,
  // the probe must wrap and stay within the frame, not run off both edges.
  const { code } = buildEffectProbe('pop', effectSource('pop'));
  assert.match(code, /break-word/, 'wraps long words');
  assert.match(code, /maxWidth/, 'bounds the text width');
  assert.ok(!code.includes("whiteSpace: 'pre'"), 'does not force single-line text');
});

test('buildEffectProbe imports only lint-whitelisted modules', () => {
  const { code } = buildEffectProbe('shatter', effectSource('shatter'));
  const imports = [...code.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(imports.sort(), ["./theme", 'remotion']);
});

// The lint gate of "one trust class": every starter effect's probe passes the
// SAME lintPrimitive the studio runs — no hand-written exemption. Fully runnable
// in `npm test` (lint is pure AST); compile/smoke/brand run via `npm run seed:effects`.
for (const name of EMPHASIS_EFFECTS) {
  test(`effect probe '${name}' passes the lint gate`, () => {
    const { code } = buildEffectProbe(name, effectSource(name));
    const res = lintPrimitive(code);
    assert.ok(res.ok, `lint violations: ${JSON.stringify(res.violations)}`);
  });
}
