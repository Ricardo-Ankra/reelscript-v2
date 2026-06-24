import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MOTION_ID, resolveMotion } from './motion-presets.ts';
import { CAMERA_MOVES, parseCameraSpec } from '../videos/cinematography.ts';

test('every CameraMove has a non-empty motion id', () => {
  for (const move of CAMERA_MOVES) {
    assert.ok(MOTION_ID[move] && MOTION_ID[move].length > 0, `missing id for ${move}`);
  }
});

test('resolveMotion returns the move id + the spec motion_strength', () => {
  const camera = parseCameraSpec({ move: 'orbit_360', motion_strength: 0.4 })!;
  const { motionId, motionStrength } = resolveMotion(camera);
  assert.equal(motionId, MOTION_ID['orbit_360']);
  assert.equal(motionStrength, 0.4);
});
