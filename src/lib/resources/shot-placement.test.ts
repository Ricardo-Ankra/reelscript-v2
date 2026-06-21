import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateShotResource } from './shot-placement.ts';

test('validateShotResource: a non-empty id pins to resource', () => {
  assert.deepEqual(validateShotResource({ resourceId: 'abc-123' }), {
    source: 'resource',
    resourceId: 'abc-123',
  });
});

test('validateShotResource: null or empty clears to stock', () => {
  assert.deepEqual(validateShotResource({ resourceId: null }), { source: 'stock', resourceId: null });
  assert.deepEqual(validateShotResource({ resourceId: '' }), { source: 'stock', resourceId: null });
  assert.deepEqual(validateShotResource({ resourceId: '   ' }), { source: 'stock', resourceId: null });
});
