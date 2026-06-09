import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  USD_PER_1K_CHARS,
  countCharacters,
  estimateUsd,
  estimateSynthesisCost,
} from './estimate.ts';

test('countCharacters: raw narration length', () => {
  assert.equal(countCharacters('hello'), 5);
  assert.equal(countCharacters(''), 0);
});

test('estimateUsd: 1000 chars == the per-1k rate', () => {
  assert.equal(estimateUsd(1000), USD_PER_1K_CHARS);
  assert.equal(estimateUsd(0), 0);
  assert.equal(estimateUsd(500), USD_PER_1K_CHARS / 2);
});

test('estimateSynthesisCost: sums narrations and prices them', () => {
  const { characters, estimatedUsd } = estimateSynthesisCost(['ab', 'cde']); // 5 chars
  assert.equal(characters, 5);
  assert.equal(estimatedUsd, estimateUsd(5));
});

test('estimateSynthesisCost: empty list is zero', () => {
  assert.deepEqual(estimateSynthesisCost([]), { characters: 0, estimatedUsd: 0 });
});
