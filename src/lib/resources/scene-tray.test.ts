import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sceneAttachedResources } from './scene-tray.ts';

const resources = [
  { id: 'r1', kind: 'image', description: 'Rivian R2 driving' },
  { id: 'r2', kind: 'video', description: 'charging at night' },
];

test('sceneAttachedResources: maps resource-pinned shots, sorted by position', () => {
  const shots = [
    { id: 's2', position: 2, source: 'resource', resource_id: 'r2' },
    { id: 's1', position: 1, source: 'resource', resource_id: 'r1' },
  ];
  const out = sceneAttachedResources(shots, resources);
  assert.equal(out.length, 2);
  assert.deepEqual(
    out.map((a) => [a.shotId, a.shotPosition, a.resource.id]),
    [['s1', 1, 'r1'], ['s2', 2, 'r2']],
  );
});

test('sceneAttachedResources: excludes stock shots and null resource_id', () => {
  const shots = [
    { id: 's1', position: 1, source: 'stock', resource_id: null },
    { id: 's2', position: 2, source: 'resource', resource_id: 'r1' },
  ];
  const out = sceneAttachedResources(shots, resources);
  assert.deepEqual(out.map((a) => a.shotId), ['s2']);
});

test('sceneAttachedResources: drops a pin whose resource is unknown', () => {
  const shots = [{ id: 's1', position: 1, source: 'resource', resource_id: 'gone' }];
  assert.deepEqual(sceneAttachedResources(shots, resources), []);
});

test('sceneAttachedResources: empty shots → empty', () => {
  assert.deepEqual(sceneAttachedResources([], resources), []);
});
