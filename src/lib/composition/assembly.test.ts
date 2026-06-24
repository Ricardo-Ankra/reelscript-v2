import { test } from 'node:test';
import assert from 'node:assert/strict';
import { partitionSceneFrames, fitForSegment, segmentAssetId, buildSegmentAssets } from './assembly.ts';

test('partitionSceneFrames splits proportionally and tiles exactly', () => {
  const t = partitionSceneFrames(10, [
    { shotId: 'a', durationSeconds: 1 },
    { shotId: 'b', durationSeconds: 1 },
  ]);
  assert.deepEqual(t, [
    { shotId: 'a', from: 0, durationInFrames: 5 },
    { shotId: 'b', from: 5, durationInFrames: 5 },
  ]);
});

test('partitionSceneFrames hands the rounding remainder to the last shot', () => {
  const t = partitionSceneFrames(10, [
    { shotId: 'a', durationSeconds: 1 },
    { shotId: 'b', durationSeconds: 1 },
    { shotId: 'c', durationSeconds: 1 },
  ]);
  assert.deepEqual(t.map((x) => x.durationInFrames), [3, 3, 4]);
  assert.deepEqual(t.map((x) => x.from), [0, 3, 6]);
  assert.equal(t.reduce((s, x) => s + x.durationInFrames, 0), 10);
});

test('partitionSceneFrames falls back to an equal split when all weights are 0', () => {
  const t = partitionSceneFrames(9, [
    { shotId: 'a', durationSeconds: 0 },
    { shotId: 'b', durationSeconds: 0 },
    { shotId: 'c', durationSeconds: 0 },
  ]);
  assert.deepEqual(t.map((x) => x.durationInFrames), [3, 3, 3]);
  assert.deepEqual(t.map((x) => x.from), [0, 3, 6]);
});

test('partitionSceneFrames handles a single shot and uneven weights', () => {
  assert.deepEqual(partitionSceneFrames(7, [{ shotId: 'a', durationSeconds: 5 }]), [
    { shotId: 'a', from: 0, durationInFrames: 7 },
  ]);
  const t = partitionSceneFrames(10, [
    { shotId: 'a', durationSeconds: 3 },
    { shotId: 'b', durationSeconds: 1 },
  ]);
  assert.equal(t.reduce((s, x) => s + x.durationInFrames, 0), 10);
  assert.equal(t[0].durationInFrames, 7); // floor(10*3/4)=7
  assert.equal(t[1].durationInFrames, 3);
  assert.deepEqual(t.map((x) => x.from), [0, 7]);
});

test('partitionSceneFrames returns [] for no shots', () => {
  assert.deepEqual(partitionSceneFrames(10, []), []);
});

test('fitForSegment: native >= allotted is trim, native < allotted is freeze', () => {
  assert.equal(fitForSegment(30, 30), 'trim');
  assert.equal(fitForSegment(31, 30), 'trim');
  assert.equal(fitForSegment(29, 30), 'freeze');
});

test('segmentAssetId is stable and shot-scoped', () => {
  assert.equal(segmentAssetId('abc'), 'seg-abc');
});

test('buildSegmentAssets maps each key to a kind:video manifest entry', () => {
  const entries = buildSegmentAssets([
    { shotId: 's1', key: 'generation/s1/clip.mp4' },
    { shotId: 's2', key: 'ingest/s2/footage.mp4' },
  ]);
  assert.deepEqual(entries, [
    { id: 'seg-s1', kind: 'video', r2Key: 'generation/s1/clip.mp4' },
    { id: 'seg-s2', kind: 'video', r2Key: 'ingest/s2/footage.mp4' },
  ]);
});
