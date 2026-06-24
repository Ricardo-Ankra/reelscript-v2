import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildConformArgs, buildKeyframeArgs } from './ffmpeg.ts';
import type { ProbeResult } from './probe.ts';

const probe = (over: Partial<ProbeResult> = {}): ProbeResult => ({
  width: 1920, height: 1080, durationSec: 10, fps: 30, hasAudio: true, rotation: 0, ...over,
});
const target = { width: 1080, height: 1920, fps: 30 };

test('buildConformArgs reframes to cover the target with fps, faststart, h264', () => {
  const a = buildConformArgs({ inPath: '/tmp/in.mp4', outPath: '/tmp/out.mp4', target, probe: probe() });
  const vf = a[a.indexOf('-vf') + 1];
  assert.match(vf, /scale=1080:1920:force_original_aspect_ratio=increase/);
  assert.match(vf, /crop=1080:1920/);
  assert.match(vf, /fps=30/);
  assert.ok(a.includes('libx264'));
  assert.ok(a.includes('+faststart'));
  assert.ok(!a.includes('-noautorotate')); // rely on default autorotate
  assert.equal(a[a.length - 1], '/tmp/out.mp4');
});

test('buildConformArgs uses aac when audio present, -an when not', () => {
  const withAudio = buildConformArgs({ inPath: 'i', outPath: 'o', target, probe: probe({ hasAudio: true }) });
  assert.ok(withAudio.includes('-c:a') && withAudio.includes('aac'));
  assert.ok(!withAudio.includes('-an'));
  const noAudio = buildConformArgs({ inPath: 'i', outPath: 'o', target, probe: probe({ hasAudio: false }) });
  assert.ok(noAudio.includes('-an'));
  assert.ok(!noAudio.includes('aac'));
});

test('buildConformArgs adds -t only when durationSec given (and > 0)', () => {
  const trimmed = buildConformArgs({ inPath: 'i', outPath: 'o', target, probe: probe(), durationSec: 4.5 });
  assert.equal(trimmed[trimmed.indexOf('-t') + 1], '4.5');
  const untrimmed = buildConformArgs({ inPath: 'i', outPath: 'o', target, probe: probe() });
  assert.ok(!untrimmed.includes('-t'));
});

test('buildConformArgs never emits source-dimension arithmetic (target dims only)', () => {
  const a = buildConformArgs({ inPath: 'i', outPath: 'o', target, probe: probe({ width: 0, height: 0 }) });
  const vf = a[a.indexOf('-vf') + 1];
  // geometry references the target (1080x1920) only — never the probe's 0x0
  assert.match(vf, /1080:1920/);
  assert.doesNotMatch(vf, /\b0:0\b/);
});

test('buildKeyframeArgs grabs a single still at the timestamp', () => {
  const a = buildKeyframeArgs({ inPath: '/tmp/in.mp4', outPath: '/tmp/k.png', atSec: 1.25 });
  assert.equal(a[a.indexOf('-ss') + 1], '1.25');
  assert.ok(a.includes('-frames:v') && a[a.indexOf('-frames:v') + 1] === '1');
  assert.equal(a[a.length - 1], '/tmp/k.png');
});
