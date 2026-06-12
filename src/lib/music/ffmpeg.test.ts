import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRemuxArgs } from './ffmpeg.ts';

function argsFor(overrides = {}) {
  return buildRemuxArgs({
    videoPath: 'in.mp4',
    musicPath: 'bed.mp3',
    outPath: 'out.mp4',
    videoDurationSec: 30,
    params: overrides,
  });
}

test('buildRemuxArgs: both inputs present, video first then music', () => {
  const a = argsFor();
  const i0 = a.indexOf('in.mp4');
  const i1 = a.indexOf('bed.mp3');
  assert.ok(i0 !== -1 && i1 !== -1 && i0 < i1);
});

test('buildRemuxArgs: stream-copies video and re-encodes audio to aac', () => {
  const a = argsFor().join(' ');
  assert.ok(a.includes('-c:v copy'));
  assert.ok(a.includes('-c:a aac'));
});

test('buildRemuxArgs: filter graph ducks music by the voiceover sidechain then mixes', () => {
  const a = argsFor();
  const fi = a.indexOf('-filter_complex');
  const graph = a[fi + 1];
  assert.ok(graph.includes('sidechaincompress'));
  assert.ok(graph.includes('[m][0:a]sidechaincompress')); // music keyed by voiceover (0:a)
  assert.ok(graph.includes('amix=inputs=2'));
  assert.ok(graph.includes(`volume=0.18`)); // default master volume
});

test('buildRemuxArgs: bounds output to the video length', () => {
  const a = argsFor();
  const ti = a.lastIndexOf('-t');
  assert.equal(a[ti + 1], '30');
});

test('buildRemuxArgs: loop adds -stream_loop before the music input', () => {
  const a = argsFor({ loop: true });
  const sl = a.indexOf('-stream_loop');
  const music = a.indexOf('bed.mp3');
  assert.ok(sl !== -1 && sl < music);
  // value is -1 (infinite), trimmed by -t
  assert.equal(a[sl + 1], '-1');
});

test('buildRemuxArgs: loop off omits -stream_loop', () => {
  assert.ok(!argsFor({ loop: false }).includes('-stream_loop'));
});

test('buildRemuxArgs: cropStartSec adds -ss before the music input only', () => {
  const a = argsFor({ cropStartSec: 5 });
  const ss = a.indexOf('-ss');
  const music = a.indexOf('bed.mp3');
  const video = a.indexOf('in.mp4');
  assert.ok(ss > video && ss < music); // applies to the second input (music), not the video
  assert.equal(a[ss + 1], '5');
});

test('buildRemuxArgs: fade-out starts fadeOutSec before the end', () => {
  const a = argsFor({ fadeOutSec: 2 }).join(' ');
  assert.ok(a.includes('afade=t=out:st=28:d=2')); // 30 - 2
});
