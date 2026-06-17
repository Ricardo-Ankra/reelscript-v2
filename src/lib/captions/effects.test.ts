import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EFFECTS, DEFAULT_EFFECT, applyEffect } from './effects/index.ts';
import { EMPHASIS_EFFECTS, type EmphasisEffect } from './types.ts';

const SETTLED = [{ opacity: 1 }];

test('the registry covers exactly the EmphasisEffect enum', () => {
  assert.deepEqual(Object.keys(EFFECTS).sort(), [...EMPHASIS_EFFECTS].sort());
});

test('the default effect is pop', () => {
  assert.equal(DEFAULT_EFFECT, 'pop');
});

test('every effect settles to a plain word at t=1 (uniform settled contract)', () => {
  for (const name of EMPHASIS_EFFECTS) {
    assert.deepEqual(EFFECTS[name](1), SETTLED, `${name} should settle at t=1`);
  }
});

test('every effect is non-settled at t=0 (it actually animates in)', () => {
  for (const name of EMPHASIS_EFFECTS) {
    assert.notDeepEqual(EFFECTS[name](0), SETTLED, `${name} should differ from settled at t=0`);
  }
});

test('shatter splits into two layers mid-animation; the others are single-layer', () => {
  assert.equal(EFFECTS.shatter(0.5).length, 2);
  for (const name of EMPHASIS_EFFECTS.filter((n) => n !== 'shatter')) {
    assert.equal(EFFECTS[name](0.5).length, 1, `${name} should be single-layer`);
  }
});

test('shatter halves clip to top and bottom and converge by t=1', () => {
  const mid = EFFECTS.shatter(0.5);
  assert.match(mid[0].clipPath ?? '', /inset\(0/); // top half
  assert.match(mid[1].clipPath ?? '', /inset\(50%/); // bottom half
  assert.deepEqual(EFFECTS.shatter(1), SETTLED);
});

test('fade-in effects ramp opacity from 0 at t=0', () => {
  assert.equal(EFFECTS.pop(0)[0].opacity, 0);
});

test('applyEffect falls back to the default effect for an unknown/undefined name', () => {
  assert.deepEqual(applyEffect(undefined, 0.5), EFFECTS.pop(0.5));
  assert.deepEqual(applyEffect('nope' as EmphasisEffect, 0.5), EFFECTS.pop(0.5));
  assert.deepEqual(applyEffect('rise', 0.5), EFFECTS.rise(0.5));
});
