import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintPrimitive } from './lint.ts';

const CLEAN = `import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate } from 'remotion';
import { useTheme } from './theme';
export default function P({ label }: { label: string }) {
  const theme = useTheme();
  const { width } = useVideoConfig();
  const f = useCurrentFrame();
  const o = interpolate(f, [0, 10], [0, 1]);
  return <AbsoluteFill style={{ opacity: o, color: theme.colors.foreground, fontFamily: theme.fonts.display, width: width * 0.5 }}>{label}</AbsoluteFill>;
}`;

const rules = (code: string) => new Set(lintPrimitive(code).violations.map((v) => v.rule));

test('a contract-compliant primitive passes clean', () => {
  const r = lintPrimitive(CLEAN);
  assert.equal(r.ok, true, JSON.stringify(r.violations));
});

test('non-whitelist import is rejected', () => {
  assert.ok(rules(`import axios from 'axios';\n${CLEAN}`).has('import'));
  assert.ok(rules(`import fs from 'node:fs';\n${CLEAN}`).has('import'));
});

test('network access (fetch) is rejected', () => {
  assert.ok(rules(`import { AbsoluteFill } from 'remotion';\nexport default function P(){ fetch('https://x'); return <AbsoluteFill/>; }`).has('forbidden-call'));
});

test('eval and require are rejected', () => {
  assert.ok(rules(`export default function P(){ eval('1'); return null; }`).has('forbidden-call'));
  assert.ok(rules(`export default function P(){ const x = require('x'); return null; }`).has('forbidden-call'));
});

test('nondeterminism is rejected (Math.random, Date.now, new Date)', () => {
  assert.ok(rules(`export default function P(){ const x = Math.random(); return null; }`).has('nondeterministic'));
  assert.ok(rules(`export default function P(){ const x = Date.now(); return null; }`).has('nondeterministic'));
  assert.ok(rules(`export default function P(){ const d = new Date(); return null; }`).has('nondeterministic'));
});

test('dynamic import() is rejected', () => {
  assert.ok(rules(`export default function P(){ import('x'); return null; }`).has('dynamic-import'));
});

test('hardcoded colour is rejected', () => {
  assert.ok(rules(`import { AbsoluteFill } from 'remotion';\nexport default function P(){ return <AbsoluteFill style={{ color: '#ff0000' }}/>; }`).has('hardcoded-color'));
  assert.ok(rules(`import { AbsoluteFill } from 'remotion';\nexport default function P(){ return <AbsoluteFill style={{ color: 'rgb(1,2,3)' }}/>; }`).has('hardcoded-color'));
});

test('raw <img>/<video> is rejected', () => {
  assert.ok(rules(`export default function P(){ return <img src="x"/>; }`).has('raw-media'));
  assert.ok(rules(`export default function P(){ return <video/>; }`).has('raw-media'));
});

test('hardcoded frame dimension is rejected', () => {
  assert.ok(rules(`export default function P(){ const w = 1080; return null; }`).has('hardcoded-dimension'));
});

test('theme token member access is not flagged as a banned member', () => {
  // theme.colors.accent / theme.fonts.display are PropertyAccessExpressions but not
  // banned — only Math.random/Date.now/performance.now are.
  const r = lintPrimitive(`import { AbsoluteFill } from 'remotion';\nimport { useTheme } from './theme';\nexport default function P(){ const t = useTheme(); return <AbsoluteFill style={{ color: t.colors.accent, fontFamily: t.fonts.display }}/>; }`);
  assert.equal(r.ok, true, JSON.stringify(r.violations));
});
