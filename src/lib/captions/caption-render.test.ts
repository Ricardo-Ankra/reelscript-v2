import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findActiveChunk, entranceProgress, resolveFocusPlacement } from './caption-render.ts';
import type { CaptionChunk } from './types.ts';

const chunk = (fromFrame: number, toFrame: number): CaptionChunk => ({ fromFrame, toFrame, words: [] });

test('findActiveChunk: fromFrame inclusive, toFrame exclusive', () => {
  const chunks = [chunk(0, 30), chunk(30, 60)];
  assert.equal(findActiveChunk(chunks, 0), chunks[0]);
  assert.equal(findActiveChunk(chunks, 29), chunks[0]);
  assert.equal(findActiveChunk(chunks, 30), chunks[1]); // boundary belongs to next
  assert.equal(findActiveChunk(chunks, 59), chunks[1]);
});

test('findActiveChunk: outside every chunk → undefined', () => {
  const chunks = [chunk(10, 20)];
  assert.equal(findActiveChunk(chunks, 5), undefined);
  assert.equal(findActiveChunk(chunks, 20), undefined);
});

test('entranceProgress: 0 at/before start, ramps to 1 at start+entrance, clamps after', () => {
  assert.equal(entranceProgress(100, 90, 10), 0); // before reveal
  assert.equal(entranceProgress(100, 100, 10), 0); // at reveal
  assert.equal(entranceProgress(100, 105, 10), 0.5);
  assert.equal(entranceProgress(100, 110, 10), 1);
  assert.equal(entranceProgress(100, 200, 10), 1); // clamps
});

test('entranceProgress: a zero/negative entrance window settles immediately', () => {
  assert.equal(entranceProgress(100, 100, 0), 1);
});

test('resolveFocusPlacement: balanced is the default (incl. undefined)', () => {
  const balanced = { sizeScale: 1, justify: 'flex-end', paddingBottomPct: 20 };
  assert.deepEqual(resolveFocusPlacement(undefined), balanced);
  assert.deepEqual(resolveFocusPlacement('balanced'), balanced);
});

test('resolveFocusPlacement: visual drops to the lower third and shrinks', () => {
  const p = resolveFocusPlacement('visual');
  assert.equal(p.justify, 'flex-end');
  assert.ok(p.paddingBottomPct < 20, 'lower than balanced');
  assert.ok(p.sizeScale < 1, 'slightly smaller');
});

test('resolveFocusPlacement: text centers and is slightly larger', () => {
  const p = resolveFocusPlacement('text');
  assert.equal(p.justify, 'center');
  assert.ok(p.sizeScale >= 1);
});
