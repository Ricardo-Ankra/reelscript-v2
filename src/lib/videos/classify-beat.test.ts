import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyBeat } from './classify-beat.ts';

test('entity always → live_action (authenticity test wins)', () => {
  assert.equal(classifyBeat('entity', 'stock'), 'live_action');
  assert.equal(classifyBeat('entity', 'upload'), 'live_action');
  assert.equal(classifyBeat('entity', 'generate'), 'live_action');
  assert.equal(classifyBeat('entity', 'primitive'), 'live_action');
});

test('non-entity maps by recommendedSource', () => {
  assert.equal(classifyBeat('generic', 'primitive'), 'motion_graphic');
  assert.equal(classifyBeat('abstract', 'primitive'), 'motion_graphic');
  assert.equal(classifyBeat('generic', 'generate'), 'generative');
  assert.equal(classifyBeat('spokesperson', 'generate'), 'generative');
  assert.equal(classifyBeat('generic', 'stock'), 'live_action');
  assert.equal(classifyBeat('abstract', 'upload'), 'live_action');
});
