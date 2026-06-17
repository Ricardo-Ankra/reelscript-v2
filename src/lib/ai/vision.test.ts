import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  frameLooksBlank,
  buildGate2QaPrompt,
  buildEffectBrandQaPrompt,
  parseGate2Verdict,
  buildResourceTagPrompt,
  parseResourceTag,
  MIN_SMOKE_FRAME_BYTES,
} from './vision.ts';

test('frameLooksBlank: below the byte floor is blank, at/above is not', () => {
  assert.equal(frameLooksBlank(1_000), true);
  assert.equal(frameLooksBlank(MIN_SMOKE_FRAME_BYTES - 1), true);
  assert.equal(frameLooksBlank(MIN_SMOKE_FRAME_BYTES), false);
  assert.equal(frameLooksBlank(250_000), false);
  assert.equal(frameLooksBlank(5_000, 1_000), false); // custom floor
});

test('buildGate2QaPrompt: carries the intent and the JSON output shape', () => {
  const p = buildGate2QaPrompt('a sunrise over mountains');
  assert.ok(p.includes('a sunrise over mountains'));
  assert.ok(p.includes('"pass"'));
  assert.ok(/only a json object/i.test(p));
});

test('buildEffectBrandQaPrompt: frames it as mid-animation and treats split/offset as intentional', () => {
  const p = buildEffectBrandQaPrompt('very-light');
  assert.ok(p.includes('very-light'), 'names the stress kit');
  assert.ok(/animation/i.test(p), 'frames it as one frame of an animation');
  assert.ok(/split|offset|duplicat/i.test(p), 'says split/offset pieces are intentional, not defects');
  assert.ok(/clip|edge|frame/i.test(p), 'still fails on out-of-frame clipping');
  assert.ok(p.includes('"pass"') && /only a json object/i.test(p), 'same verdict shape');
});

test('parseGate2Verdict: a clean pass', () => {
  const v = parseGate2Verdict('{"pass": true, "issues": []}');
  assert.deepEqual(v, { pass: true, issues: [] });
});

test('parseGate2Verdict: a fail with issues', () => {
  const v = parseGate2Verdict('{"pass": false, "issues": ["text overflows", "low contrast"]}');
  assert.deepEqual(v, { pass: false, issues: ['text overflows', 'low contrast'] });
});

test('parseGate2Verdict: tolerates ```json fences', () => {
  const v = parseGate2Verdict('```json\n{"pass": true, "issues": []}\n```');
  assert.deepEqual(v, { pass: true, issues: [] });
});

test('parseGate2Verdict: missing/non-boolean pass → null', () => {
  assert.equal(parseGate2Verdict('{"issues": []}'), null);
  assert.equal(parseGate2Verdict('{"pass": "yes"}'), null);
});

test('parseGate2Verdict: malformed JSON → null', () => {
  assert.equal(parseGate2Verdict('not json'), null);
});

test('parseGate2Verdict: non-array / non-string issues are coerced to a clean list', () => {
  // issues not an array → empty list
  assert.deepEqual(parseGate2Verdict('{"pass": true, "issues": "nope"}'), { pass: true, issues: [] });
  // mixed array → only strings kept
  assert.deepEqual(parseGate2Verdict('{"pass": false, "issues": ["ok", 5, null]}'), { pass: false, issues: ['ok'] });
});

// --- channel-resource auto-tag --------------------------------------------

test('buildResourceTagPrompt: asks for a description + lowercase tags as JSON', () => {
  const p = buildResourceTagPrompt();
  assert.ok(/description/i.test(p) && /tags/i.test(p));
  assert.ok(p.includes('"description"') && p.includes('"tags"'));
  assert.ok(/only a json object/i.test(p));
});

test('parseResourceTag: a clean description + tags', () => {
  assert.deepEqual(parseResourceTag('{"description": "A red sports car", "tags": ["car", "red", "automotive"]}'), {
    description: 'A red sports car',
    tags: ['car', 'red', 'automotive'],
  });
});

test('parseResourceTag: tolerates fences and coerces bad tags', () => {
  assert.deepEqual(parseResourceTag('```json\n{"description": "x", "tags": ["a", 3, null, "b"]}\n```'), {
    description: 'x',
    tags: ['a', 'b'],
  });
  // tags missing or non-array → empty list, still valid if description present
  assert.deepEqual(parseResourceTag('{"description": "x"}'), { description: 'x', tags: [] });
});

test('parseResourceTag: missing description or malformed → null', () => {
  assert.equal(parseResourceTag('{"tags": ["a"]}'), null);
  assert.equal(parseResourceTag('not json'), null);
});
