import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  frameLooksBlank,
  buildGate2QaPrompt,
  parseGate2Verdict,
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
