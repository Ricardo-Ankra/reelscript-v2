import { test } from 'node:test';
import assert from 'node:assert/strict';
import { route } from './router.ts';
import { parseCameraSpec } from '../videos/cinematography.ts';

const base = { camera: null, hero: false, needs_speech: false, broadcast_4k: false };

test('non-generative kinds route to remotion / ingest', () => {
  assert.equal(route({ ...base, kind: 'motion_graphic' }), 'remotion');
  assert.equal(route({ ...base, kind: 'live_action' }), 'ingest');
});

test('generative routing: hero-move → dop-preview', () => {
  assert.equal(route({ ...base, kind: 'generative', camera: parseCameraSpec({ move: 'bullet_time' }) }), 'higgsfield.dop-preview');
});

test('generative routing: flags in priority order needs_speech > broadcast_4k > hero > default', () => {
  assert.equal(route({ ...base, kind: 'generative', needs_speech: true }), 'higgsfield.veo-3.1');
  assert.equal(route({ ...base, kind: 'generative', broadcast_4k: true }), 'higgsfield.kling-3.0');
  assert.equal(route({ ...base, kind: 'generative', hero: true }), 'higgsfield.seedance-2.0');
  assert.equal(route({ ...base, kind: 'generative' }), 'higgsfield.dop-preview');
  // a hero move beats the speech flag (move checked first)
  assert.equal(route({ ...base, kind: 'generative', camera: parseCameraSpec({ move: 'orbit_360' }), needs_speech: true }), 'higgsfield.dop-preview');
});
