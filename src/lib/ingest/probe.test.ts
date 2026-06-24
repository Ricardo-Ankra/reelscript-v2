import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProbe } from './probe.ts';

test('parseProbe reads dims, fps, duration, audio from a full probe', () => {
  const r = parseProbe({
    streams: [
      { codec_type: 'video', width: 1920, height: 1080, avg_frame_rate: '30000/1001', duration: '12.5' },
      { codec_type: 'audio' },
    ],
    format: { duration: '12.34' },
  });
  assert.equal(r.width, 1920);
  assert.equal(r.height, 1080);
  assert.equal(r.fps, 30); // 30000/1001 ≈ 29.97 → rounds to 30
  assert.equal(r.durationSec, 12.34); // format.duration preferred
  assert.equal(r.hasAudio, true);
});

test('parseProbe falls back to stream duration when format.duration absent', () => {
  const r = parseProbe({ streams: [{ codec_type: 'video', width: 100, height: 100, duration: '5' }] });
  assert.equal(r.durationSec, 5);
  assert.equal(r.hasAudio, false);
});

test('parseProbe rotation from tags.rotate', () => {
  const r = parseProbe({ streams: [{ codec_type: 'video', width: 10, height: 10, tags: { rotate: '90' } }] });
  assert.equal(r.rotation, 90);
});

test('parseProbe rotation from side_data_list (negative → normalized)', () => {
  const r = parseProbe({
    streams: [{ codec_type: 'video', width: 10, height: 10, side_data_list: [{ rotation: -90 }] }],
  });
  assert.equal(r.rotation, 270);
});

test('parseProbe on empty/garbage never throws and returns zeros', () => {
  const r = parseProbe({});
  assert.deepEqual(r, { width: 0, height: 0, durationSec: 0, fps: 0, hasAudio: false, rotation: 0 });
});

test('parseProbe fps 0/0 → 0', () => {
  const r = parseProbe({ streams: [{ codec_type: 'video', width: 1, height: 1, avg_frame_rate: '0/0' }] });
  assert.equal(r.fps, 0);
});
