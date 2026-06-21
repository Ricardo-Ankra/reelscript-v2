import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenizeSpokenWords, type SpokenWord } from './tokenize.ts';
import type { TtsAlignment } from '../voice/alignment.ts';

// Build a character-level alignment from words + per-word [start,end] seconds, with
// single spaces between words (the spaces carry the previous word's end time).
// Whitespace between array elements is the ONLY whitespace; a word string with no
// internal whitespace therefore produces exactly one token.
function align(words: { t: string; s: number; e: number }[]): TtsAlignment {
  const characters: string[] = [];
  const character_start_times_seconds: number[] = [];
  const character_end_times_seconds: number[] = [];
  words.forEach((w, wi) => {
    const n = w.t.length;
    for (let i = 0; i < n; i++) {
      characters.push(w.t[i]);
      character_start_times_seconds.push(w.s + ((w.e - w.s) * i) / n);
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

const texts = (ws: SpokenWord[]) => ws.map((w) => w.text);

test('tokenizeSpokenWords: splits on whitespace, first-start/last-end timing', () => {
  const a = align([
    { t: 'hello', s: 0, e: 1 },
    { t: 'world', s: 1, e: 2 },
  ]);
  const ws = tokenizeSpokenWords(a);
  assert.deepEqual(texts(ws), ['hello', 'world']);
  assert.equal(ws[0].startSec, 0);
  assert.equal(ws[0].endSec, 1);
  assert.equal(ws[1].endSec, 2);
});

// The four load-bearing tricky cases: each must be ONE token (no internal
// whitespace), so emphasis indices and chunk boundaries agree on word count.
test('tokenizeSpokenWords: hyphenate is one token', () => {
  const a = align([{ t: 'well-being', s: 0, e: 1 }]);
  assert.deepEqual(texts(tokenizeSpokenWords(a)), ['well-being']);
});

test('tokenizeSpokenWords: decimal is one token', () => {
  const a = align([{ t: '2.5', s: 0, e: 1 }]);
  assert.deepEqual(texts(tokenizeSpokenWords(a)), ['2.5']);
});

test('tokenizeSpokenWords: contraction is one token', () => {
  const a = align([{ t: "doesn't", s: 0, e: 1 }]);
  assert.deepEqual(texts(tokenizeSpokenWords(a)), ["doesn't"]);
});

test('tokenizeSpokenWords: em-dash join (no spaces) is one token', () => {
  const a = align([{ t: 'creatine—really', s: 0, e: 1 }]);
  assert.deepEqual(texts(tokenizeSpokenWords(a)), ['creatine—really']);
});

test('tokenizeSpokenWords: mixed tricky words keep their count and order', () => {
  const a = align([
    { t: 'it', s: 0, e: 0.3 },
    { t: "doesn't", s: 0.3, e: 0.8 },
    { t: 'cost', s: 0.8, e: 1.1 },
    { t: '2.5', s: 1.1, e: 1.5 },
    { t: 'well-being', s: 1.5, e: 2.2 },
  ]);
  assert.deepEqual(texts(tokenizeSpokenWords(a)), ['it', "doesn't", 'cost', '2.5', 'well-being']);
});

test('tokenizeSpokenWords: empty alignment yields no tokens', () => {
  assert.deepEqual(tokenizeSpokenWords({ characters: [], character_start_times_seconds: [], character_end_times_seconds: [] }), []);
});

test('tokenizeSpokenWords: drops a bracketed audio-tag token, keeps real words + timings', () => {
  const a = align([
    { t: 'hello', s: 0, e: 1 },
    { t: '[excited]', s: 1, e: 1.4 },
    { t: 'world', s: 1.4, e: 2 },
  ]);
  const ws = tokenizeSpokenWords(a);
  assert.deepEqual(texts(ws), ['hello', 'world']);
  assert.equal(ws[0].startSec, 0);
  assert.equal(ws[1].startSec, 1.4);
  assert.equal(ws[1].endSec, 2);
});

test('tokenizeSpokenWords: a word with internal brackets is NOT dropped', () => {
  const a = align([{ t: 'a[b]c', s: 0, e: 1 }]);
  assert.deepEqual(texts(tokenizeSpokenWords(a)), ['a[b]c']);
});
