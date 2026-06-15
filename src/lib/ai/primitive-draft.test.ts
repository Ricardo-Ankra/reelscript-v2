import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDraftSystemPrompt, buildDraftUserPrompt, parseDraft } from './primitive-draft.ts';
import { lintPrimitive } from '../primitives/lint.ts';

test('system prompt loads the skill + the JSON output contract', () => {
  const s = buildDraftSystemPrompt();
  assert.ok(/useTheme/.test(s));
  assert.ok(/FORBIDDEN/.test(s));
  assert.ok(/"propSchema"/.test(s) && /"code"/.test(s));
});

test('user prompt carries instruction; refine mode includes current code + feedback', () => {
  const u = buildDraftUserPrompt({ instruction: 'a glowing badge', currentCode: 'export default () => null;', feedback: '- [import] bad' });
  assert.ok(u.includes('a glowing badge'));
  assert.ok(u.includes('REFINING') && u.includes('export default () => null;'));
  assert.ok(u.includes('failed the gates') && u.includes('[import] bad'));
});

test('parseDraft: valid envelope → code + schema + meta', () => {
  const env = JSON.stringify({
    meta: { name: 'Badge', description: 'a badge', version: 1 },
    propSchema: [{ name: 'label', type: 'string', state: 'active', required: true }],
    code: 'export default function Badge(){ return null; }',
  });
  const r = parseDraft(env);
  assert.ok(r);
  assert.equal(r.meta.name, 'Badge');
  assert.equal(r.proposedSchema.length, 1);
  assert.ok(r.code.includes('Badge'));
});

test('parseDraft: tolerates ```json fences', () => {
  const r = parseDraft('```json\n{"meta":{"name":"X"},"propSchema":[],"code":"export default ()=>null;"}\n```');
  assert.ok(r);
  assert.equal(r.meta.name, 'X');
  assert.equal(r.meta.version, 1); // defaulted
});

test('parseDraft: rejects malformed / missing code or schema', () => {
  assert.equal(parseDraft('not json'), null);
  assert.equal(parseDraft('{"meta":{"name":"X"},"propSchema":[]}'), null); // no code
  assert.equal(parseDraft('{"meta":{"name":"X"},"code":"x"}'), null); // no schema
  assert.equal(parseDraft('{"propSchema":[],"code":"x"}'), null); // no meta.name
});

test('a well-formed drafted primitive passes lint (skill teaches gate-passing code)', () => {
  const code = `import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate } from 'remotion';
import { useTheme } from './theme';
export default function Badge({ label }: { label: string }) {
  const theme = useTheme();
  const { width } = useVideoConfig();
  const o = interpolate(useCurrentFrame(), [0, 12], [0, 1], { extrapolateRight: 'clamp' });
  return <AbsoluteFill style={{ opacity: o, color: theme.colors.accent, fontFamily: theme.fonts.display, fontSize: width * 0.06 }}>{label}</AbsoluteFill>;
}`;
  assert.equal(lintPrimitive(code).ok, true, JSON.stringify(lintPrimitive(code).violations));
});
