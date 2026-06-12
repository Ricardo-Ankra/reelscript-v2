import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  reconstructWords,
  buildCaptions,
  suppressDuringSpans,
  toSrt,
  toVtt,
  DEFAULT_MAX_CHARS_PER_LINE,
  type CaptionSegment,
} from './segments.ts';
import type { TtsAlignment } from '../voice/alignment.ts';

// Build a character-level alignment from words + per-word [start,end] seconds, with
// single spaces between words (the spaces carry the previous word's end time).
function align(words: { t: string; s: number; e: number }[]): TtsAlignment {
  const characters: string[] = [];
  const character_start_times_seconds: number[] = [];
  const character_end_times_seconds: number[] = [];
  words.forEach((w, wi) => {
    const n = w.t.length;
    for (let i = 0; i < n; i++) {
      characters.push(w.t[i]);
      // linearly spread the word's window across its characters
      character_start_times_seconds.push(w.s + ((w.e - w.s) * i) / n);
      character_start_times_seconds[character_start_times_seconds.length - 1];
      character_end_times_seconds.push(w.s + ((w.e - w.s) * (i + 1)) / n);
    }
    if (wi < words.length - 1) {
      characters.push(' ');
      character_start_times_seconds.push(w.e);
      character_end_times_seconds.push(w.e);
    }
  });
  return { characters, character_start_times_seconds, character_end_times_seconds };
}

test('reconstructWords: groups characters into words with first-start/last-end', () => {
  const a = align([
    { t: 'hello', s: 0, e: 1 },
    { t: 'world', s: 1, e: 2 },
  ]);
  const words = reconstructWords(a);
  assert.equal(words.length, 2);
  assert.equal(words[0].text, 'hello');
  assert.equal(words[0].startSec, 0);
  assert.equal(words[0].endSec, 1);
  assert.equal(words[1].text, 'world');
  assert.equal(words[1].endSec, 2);
});

test('buildCaptions: one line, frames = round(sec*fps) + scene offset', () => {
  const a = align([
    { t: 'hi', s: 0, e: 0.5 },
    { t: 'there', s: 0.5, e: 1 },
  ]);
  const segs = buildCaptions([{ alignment: a, startFrame: 30 }], { fps: 30 });
  assert.equal(segs.length, 1);
  assert.deepEqual(segs[0], { fromFrame: 30, toFrame: 60, text: 'hi there' });
});

test('buildCaptions: wraps at maxCharsPerLine', () => {
  const a = align([
    { t: 'aaaa', s: 0, e: 1 },
    { t: 'bbbb', s: 1, e: 2 },
    { t: 'cccc', s: 2, e: 3 },
  ]);
  // maxChars 9 fits "aaaa bbbb" (9) but not a third word.
  const segs = buildCaptions([{ alignment: a, startFrame: 0 }], { fps: 10, maxCharsPerLine: 9 });
  assert.equal(segs.length, 2);
  assert.equal(segs[0].text, 'aaaa bbbb');
  assert.equal(segs[1].text, 'cccc');
});

test('buildCaptions: silent scene (no alignment) contributes nothing', () => {
  const segs = buildCaptions(
    [
      { alignment: null, startFrame: 0 },
      { alignment: align([{ t: 'go', s: 0, e: 1 }]), startFrame: 100 },
    ],
    { fps: 30 },
  );
  assert.equal(segs.length, 1);
  assert.equal(segs[0].fromFrame, 100);
});

test('buildCaptions: a caption always lasts at least one frame', () => {
  const a = align([{ t: 'x', s: 0, e: 0 }]);
  const segs = buildCaptions([{ alignment: a, startFrame: 0 }], { fps: 30 });
  assert.equal(segs[0].toFrame, segs[0].fromFrame + 1);
});

test('default max chars per line is the documented constant', () => {
  assert.equal(DEFAULT_MAX_CHARS_PER_LINE, 32);
});

test('suppressDuringSpans: drops segments overlapping a kinetic span, keeps the rest', () => {
  const segs: CaptionSegment[] = [
    { fromFrame: 0, toFrame: 30, text: 'a' },
    { fromFrame: 30, toFrame: 60, text: 'b' }, // overlaps span [45,90)
    { fromFrame: 90, toFrame: 120, text: 'c' },
  ];
  const out = suppressDuringSpans(segs, [{ fromFrame: 45, toFrame: 90 }]);
  assert.deepEqual(out.map((s) => s.text), ['a', 'c']);
});

test('suppressDuringSpans: no spans is a passthrough', () => {
  const segs: CaptionSegment[] = [{ fromFrame: 0, toFrame: 30, text: 'a' }];
  assert.equal(suppressDuringSpans(segs, []), segs);
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
