import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEmphasisSystemPrompt,
  buildEmphasisUserPrompt,
  parseEmphasisAnnotations,
} from './emphasis-pass.ts';
import type { SpokenWord } from './tokenize.ts';

const w = (text: string): SpokenWord => ({ text, startSec: 0, endSec: 0 });
const WORDS = [w('they'), w('are'), w('lying'), w('about'), w('creatine')];

test('user prompt lists indexed words, the scene script, and the density', () => {
  const p = buildEmphasisUserPrompt(WORDS, 'They are lying about creatine.', 'sparing');
  assert.ok(p.includes('2:lying'), 'words are indexed for stable referencing');
  assert.ok(p.includes('They are lying about creatine.'), 'carries scene context');
  assert.ok(/sparing/i.test(p), 'carries the density');
});

test('system prompt documents the three axes, vocab, ceiling, and forbidden pairings', () => {
  const p = buildEmphasisSystemPrompt();
  // axes + enums
  for (const role of ['key', 'shout', 'contrast', 'number']) assert.ok(p.includes(role), `mentions role ${role}`);
  for (const effect of ['topple', 'shatter', 'glitch', 'rise', 'zoom', 'shake', 'pop']) assert.ok(p.includes(effect), `mentions effect ${effect}`);
  assert.ok(/positive/.test(p) && /negative/.test(p), 'tone sentiment');
  // ceiling shared with the validator (≈ one third → 33%)
  assert.ok(p.includes('33'), 'states the effect ceiling percentage');
  // forbidden pairing derived from the shared incoherent-pair map
  assert.ok(/positive[\s\S]*shatter|shatter[\s\S]*positive/.test(p), 'warns against positive+shatter');
  assert.ok(/only a json array/i.test(p), 'fixes the output shape');
});

test('parses a clean annotation array and runs it through coherence', () => {
  const out = parseEmphasisAnnotations('[{"index":2,"role":"shout","tone":"negative","effect":"glitch"}]', 5);
  assert.deepEqual(out, [{ index: 2, role: 'shout', tone: 'negative', effect: 'glitch' }]);
});

test('tolerates ```json fences', () => {
  const out = parseEmphasisAnnotations('```json\n[{"index":0,"role":"key"}]\n```', 5);
  assert.deepEqual(out, [{ index: 0, role: 'key' }]);
});

test('accepts an {"emphasis":[...]} object wrapper', () => {
  const out = parseEmphasisAnnotations('{"emphasis":[{"index":1,"role":"contrast"}]}', 5);
  assert.deepEqual(out, [{ index: 1, role: 'contrast' }]);
});

test('malformed JSON yields no emphasis (never blocks a render)', () => {
  assert.deepEqual(parseEmphasisAnnotations('not json at all', 5), []);
  assert.deepEqual(parseEmphasisAnnotations('', 5), []);
});

test('applies the coherence validator: strips incoherent pairing + drops out-of-range', () => {
  const out = parseEmphasisAnnotations(
    '[{"index":0,"role":"key","tone":"positive","effect":"shatter"},{"index":99,"role":"shout"}]',
    5,
  );
  // index 99 dropped; positive+shatter loses the effect, keeps role+tone
  assert.deepEqual(out, [{ index: 0, role: 'key', tone: 'positive' }]);
});
