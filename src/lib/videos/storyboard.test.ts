import { test } from 'node:test';
import assert from 'node:assert/strict';
import { storyboardLabel } from './storyboard.ts';

test('storyboardLabel: entity_name wins when present', () => {
  assert.equal(storyboardLabel({ entity_name: 'Rivian R2' }, 'a white SUV'), 'Rivian R2');
});

test('storyboardLabel: falls back to description when no entity', () => {
  assert.equal(storyboardLabel({ entity_name: null }, 'a city skyline'), 'a city skyline');
  assert.equal(storyboardLabel(null, 'a city skyline'), 'a city skyline');
  assert.equal(storyboardLabel({ entity_name: '   ' }, 'a city skyline'), 'a city skyline');
});

test('storyboardLabel: final fallback is "Shot"', () => {
  assert.equal(storyboardLabel(null, ''), 'Shot');
  assert.equal(storyboardLabel({ entity_name: '' }, '   '), 'Shot');
});
