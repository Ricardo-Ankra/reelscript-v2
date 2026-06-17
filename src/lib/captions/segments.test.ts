import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunksToSegments, toSrt, toVtt, type CaptionSegment } from './segments.ts';
import type { CaptionChunk } from './types.ts';

const chunk = (fromFrame: number, toFrame: number, words: string[]): CaptionChunk => ({
  fromFrame,
  toFrame,
  words: words.map((text) => ({ text, fromFrame, toFrame })),
});

test('chunksToSegments: one cue per chunk, words joined with spaces', () => {
  const segs = chunksToSegments([chunk(0, 30, ['hello', 'world']), chunk(30, 60, ['again'])]);
  assert.deepEqual(segs, [
    { fromFrame: 0, toFrame: 30, text: 'hello world' },
    { fromFrame: 30, toFrame: 60, text: 'again' },
  ]);
});

test('chunksToSegments: a zero-length chunk is widened to at least one frame', () => {
  const segs = chunksToSegments([chunk(10, 10, ['x'])]);
  assert.equal(segs[0].toFrame, 11);
});

test('toSrt: numbered cues with comma-millisecond timestamps', () => {
  const segs: CaptionSegment[] = [{ fromFrame: 0, toFrame: 30, text: 'hello' }];
  assert.equal(toSrt(segs, 30), '1\n00:00:00,000 --> 00:00:01,000\nhello\n');
});

test('toVtt: WEBVTT header with dot-millisecond timestamps', () => {
  const segs: CaptionSegment[] = [{ fromFrame: 15, toFrame: 45, text: 'hi' }];
  assert.equal(toVtt(segs, 30), 'WEBVTT\n\n00:00:00.500 --> 00:00:01.500\nhi\n');
});

test('toSrt/toVtt: empty input yields no cues', () => {
  assert.equal(toSrt([], 30), '');
  assert.equal(toVtt([], 30), 'WEBVTT\n\n');
});
