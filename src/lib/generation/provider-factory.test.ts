import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getGenerationProvider } from './provider-factory.ts';

test('defaults to a fake provider exposing the full seam', () => {
  delete process.env.GENERATION_PROVIDER;
  const p = getGenerationProvider();
  assert.equal(typeof p.generateStill, 'function');
  assert.equal(typeof p.submitClip, 'function');
  assert.equal(typeof p.checkClip, 'function');
});

test('higgsfield throws until an adapter exists', () => {
  process.env.GENERATION_PROVIDER = 'higgsfield';
  assert.throws(() => getGenerationProvider(), /not configured/);
  delete process.env.GENERATION_PROVIDER;
});

test('an unknown provider name throws', () => {
  process.env.GENERATION_PROVIDER = 'nope';
  assert.throws(() => getGenerationProvider(), /Unknown GENERATION_PROVIDER/);
  delete process.env.GENERATION_PROVIDER;
});
