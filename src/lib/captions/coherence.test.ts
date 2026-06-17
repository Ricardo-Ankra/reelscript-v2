import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateEmphasisCoherence,
  EMPHASIS_EFFECT_CEILING,
  INCOHERENT_TONE_EFFECT,
} from './coherence.ts';
import type { WordEmphasis } from './types.ts';

test('EMPHASIS_EFFECT_CEILING is one third (shared by validator and prompt)', () => {
  assert.equal(EMPHASIS_EFFECT_CEILING, 1 / 3);
});

test('the incoherent-pair map matches the spec table', () => {
  assert.deepEqual(INCOHERENT_TONE_EFFECT.rise, ['negative']);
  assert.deepEqual(INCOHERENT_TONE_EFFECT.topple, ['positive']);
  assert.deepEqual(INCOHERENT_TONE_EFFECT.shatter, ['positive']);
  assert.deepEqual(INCOHERENT_TONE_EFFECT.glitch, ['positive']);
  assert.deepEqual(INCOHERENT_TONE_EFFECT.shake, ['positive']);
  // pop and zoom are valence-free
  assert.deepEqual(INCOHERENT_TONE_EFFECT.pop ?? [], []);
  assert.deepEqual(INCOHERENT_TONE_EFFECT.zoom ?? [], []);
});

test('drops entries with an out-of-range index', () => {
  const raw: WordEmphasis[] = [
    { index: 0, role: 'key' },
    { index: 9, role: 'shout' },
    { index: -1, role: 'key' },
  ];
  const out = validateEmphasisCoherence(raw, 3);
  assert.deepEqual(out.map((e) => e.index), [0]);
});

test('drops an entry whose role is missing or invalid (no emphasis without a role)', () => {
  const raw = [
    { index: 0, role: 'bogus' },
    { index: 1 },
    { index: 2, role: 'key' },
  ] as unknown as WordEmphasis[];
  const out = validateEmphasisCoherence(raw, 3);
  assert.deepEqual(out.map((e) => e.index), [2]);
});

test('strips an invalid tone/effect field but keeps the valid role', () => {
  const raw = [{ index: 0, role: 'key', tone: 'bogus', effect: 'nope' }] as unknown as WordEmphasis[];
  const out = validateEmphasisCoherence(raw, 1);
  assert.deepEqual(out, [{ index: 0, role: 'key' }]);
});

test('dedupes by index, keeping the first valid annotation', () => {
  const raw: WordEmphasis[] = [
    { index: 1, role: 'key' },
    { index: 1, role: 'shout' },
  ];
  const out = validateEmphasisCoherence(raw, 3);
  assert.equal(out.length, 1);
  assert.equal(out[0].role, 'key');
});

test('strips an incoherent tone↔effect pairing, keeping role + tone', () => {
  const raw: WordEmphasis[] = [
    { index: 0, role: 'shout', tone: 'positive', effect: 'shatter' }, // incoherent
    { index: 1, role: 'key', tone: 'negative', effect: 'rise' }, // incoherent
  ];
  const out = validateEmphasisCoherence(raw, 2);
  assert.deepEqual(out[0], { index: 0, role: 'shout', tone: 'positive' });
  assert.deepEqual(out[1], { index: 1, role: 'key', tone: 'negative' });
});

test('keeps coherent effects: neutral tone and valence-free effects pass untouched', () => {
  // Isolated single-word calls so the effect ceiling (1) never interferes.
  const neutral = validateEmphasisCoherence(
    [{ index: 0, role: 'shout', tone: 'neutral', effect: 'topple' }], // neutral ok
    1,
  );
  assert.equal(neutral[0].effect, 'topple');
  const valenceFree = validateEmphasisCoherence(
    [{ index: 0, role: 'key', tone: 'positive', effect: 'pop' }], // valence-free ok
    1,
  );
  assert.equal(valenceFree[0].effect, 'pop');
});

test('a single emphasized word may keep its effect (max(1, ...) floor)', () => {
  const raw: WordEmphasis[] = [{ index: 0, role: 'key', tone: 'neutral', effect: 'shatter' }];
  const out = validateEmphasisCoherence(raw, 1);
  assert.equal(out[0].effect, 'shatter');
});

test('effect ceiling: keeps effects on highest-role words, strips the rest to role+tone', () => {
  // 6 emphasized words, all coherent → maxEffects = max(1, round(6/3)) = 2.
  const raw: WordEmphasis[] = [
    { index: 0, role: 'shout', effect: 'pop' },
    { index: 1, role: 'number', effect: 'zoom' },
    { index: 2, role: 'key', effect: 'pop' },
    { index: 3, role: 'key', effect: 'zoom' },
    { index: 4, role: 'contrast', effect: 'pop' },
    { index: 5, role: 'contrast', effect: 'zoom' },
  ];
  const out = validateEmphasisCoherence(raw, 6);
  const withEffect = out.filter((e) => e.effect).map((e) => e.index);
  assert.deepEqual(withEffect, [0, 1]); // shout + number win
  assert.equal(out.length, 6); // all stay emphasized (role kept)
});
