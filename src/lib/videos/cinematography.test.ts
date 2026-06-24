import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCameraSpec,
  parseLightingSpec,
  parseProvenance,
  SHOT_KINDS,
} from './cinematography.ts';

test('SHOT_KINDS lists the three source classes', () => {
  assert.deepEqual([...SHOT_KINDS], ['generative', 'motion_graphic', 'live_action']);
});

test('parseCameraSpec: absent → null', () => {
  assert.equal(parseCameraSpec(null), null);
  assert.equal(parseCameraSpec(undefined), null);
  assert.equal(parseCameraSpec('x'), null);
});

test('parseCameraSpec: empty object → all defaults', () => {
  assert.deepEqual(parseCameraSpec({}), {
    shot_size: 'MS', angle: 'eye_level', move: 'static',
    lens_mm: 35, dof: 'shallow', motion_strength: 0.7,
  });
});

test('parseCameraSpec: valid values kept; bad enum → default', () => {
  const c = parseCameraSpec({ shot_size: 'WS', angle: 'low', move: 'orbit_360', lens_mm: 85, dof: 'deep', motion_strength: 0.4 });
  assert.deepEqual(c, { shot_size: 'WS', angle: 'low', move: 'orbit_360', lens_mm: 85, dof: 'deep', motion_strength: 0.4 });
  const bad = parseCameraSpec({ shot_size: 'nope', move: 'fly', dof: 'x' });
  assert.equal(bad?.shot_size, 'MS');
  assert.equal(bad?.move, 'static');
  assert.equal(bad?.dof, 'shallow');
});

test('parseCameraSpec: lens_mm coerced to int; motion_strength clamped [0,1]', () => {
  assert.equal(parseCameraSpec({ lens_mm: 50.7 })?.lens_mm, 51);
  assert.equal(parseCameraSpec({ motion_strength: 5 })?.motion_strength, 1);
  assert.equal(parseCameraSpec({ motion_strength: -2 })?.motion_strength, 0);
  assert.equal(parseCameraSpec({ lens_mm: 'big' })?.lens_mm, 35);
});

test('parseLightingSpec: absent → null; empty → defaults; provided kept', () => {
  assert.equal(parseLightingSpec(null), null);
  assert.deepEqual(parseLightingSpec({}), {
    key: 'soft key from frame left', ratio: '3:1', time_of_day: 'golden hour',
    palette: 'teal shadows, warm highlights', texture: 'subtle film grain',
  });
  assert.equal(parseLightingSpec({ palette: 'cool blue' })?.palette, 'cool blue');
  // empty string falls back to default
  assert.equal(parseLightingSpec({ palette: '' })?.palette, 'teal shadows, warm highlights');
});

test('parseProvenance: absent → null; synthetic coerced; fields nullable', () => {
  assert.equal(parseProvenance(null), null);
  assert.deepEqual(parseProvenance({}), {
    synthetic: false, source: null, model: null, seed: null,
    source_uri: null, created_at: null, operator: null,
  });
  const p = parseProvenance({ synthetic: true, source: 'higgsfield:dop-preview', seed: 42 });
  assert.equal(p?.synthetic, true);
  assert.equal(p?.source, 'higgsfield:dop-preview');
  assert.equal(p?.seed, 42);
  assert.equal(parseProvenance({ synthetic: 'yes' })?.synthetic, false); // only boolean true counts
});
