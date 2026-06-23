import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRenderError, phaseLabel } from './render-error.ts';

const FALLBACK = 'Something went wrong during composition or rendering.';

test('parseRenderError: full structured object', () => {
  const r = parseRenderError({
    phase: 'gate2',
    issues: ['Vehicle shown is a white Jeep Wrangler, not a Rivian R2'],
    message: 'Smoke frame failed QA',
    frameUrl: 'https://example.com/out.png',
  });
  assert.deepEqual(r, {
    phase: 'gate2',
    message: 'Smoke frame failed QA',
    issues: ['Vehicle shown is a white Jeep Wrangler, not a Rivian R2'],
    frameUrl: 'https://example.com/out.png',
  });
});

test('parseRenderError: structured with missing phase/frameUrl', () => {
  const r = parseRenderError({ message: 'Boom', issues: ['a', 'b'] });
  assert.equal(r.phase, null);
  assert.equal(r.frameUrl, null);
  assert.equal(r.message, 'Boom');
  assert.deepEqual(r.issues, ['a', 'b']);
});

test('parseRenderError: issues filters non-strings and blanks', () => {
  const r = parseRenderError({ message: 'x', issues: ['ok', '', '   ', 5, null] });
  assert.deepEqual(r.issues, ['ok']);
});

test('parseRenderError: plain string is the message', () => {
  const r = parseRenderError('Render failed.');
  assert.deepEqual(r, { phase: null, message: 'Render failed.', issues: [], frameUrl: null });
});

test('parseRenderError: empty string falls back', () => {
  assert.equal(parseRenderError('   ').message, FALLBACK);
});

test('parseRenderError: null / number / object-without-message fall back', () => {
  assert.equal(parseRenderError(null).message, FALLBACK);
  assert.equal(parseRenderError(42).message, FALLBACK);
  assert.equal(parseRenderError({ phase: 'gate1' }).message, FALLBACK);
});

test('phaseLabel: known phases mapped, unknown passthrough, null → null', () => {
  assert.equal(phaseLabel('gate2'), 'Smoke-frame QA');
  assert.equal(phaseLabel('gate1'), 'Spec validation');
  assert.equal(phaseLabel('mystery'), 'mystery');
  assert.equal(phaseLabel(null), null);
});
