import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chunkWords,
  DEFAULT_MAX_WORDS_PER_CHUNK,
  DEFAULT_MAX_CHARS_PER_CHUNK,
  DEFAULT_PAUSE_GAP_SEC,
} from './chunks.ts';
import { tokenizeSpokenWords } from './tokenize.ts';
import type { SpokenWord } from './tokenize.ts';
import type { TtsAlignment } from '../voice/alignment.ts';

const w = (text: string, s: number, e: number): SpokenWord => ({ text, startSec: s, endSec: e });
const chunkTexts = (words: SpokenWord[], opts: Parameters<typeof chunkWords>[1]) =>
  chunkWords(words, opts).map((c) => c.words.map((x) => x.text).join(' '));

test('chunkWords: groups under limits into one chunk; frames = startFrame + round(sec*fps)', () => {
  const chunks = chunkWords([w('hi', 0, 0.5), w('there', 0.5, 1)], { fps: 30, startFrame: 30 });
  assert.equal(chunks.length, 1);
  assert.deepEqual(chunks[0].words.map((x) => x.text), ['hi', 'there']);
  assert.equal(chunks[0].words[0].fromFrame, 30);
  assert.equal(chunks[0].words[1].fromFrame, 45);
  assert.equal(chunks[0].words[1].toFrame, 60);
});

test('chunkWords: breaks after a word ending in clause punctuation', () => {
  const texts = chunkTexts([w('really,', 0, 0.4), w('though', 0.4, 0.8)], { fps: 10 });
  assert.deepEqual(texts, ['really,', 'though']);
});

test('chunkWords: breaks on a pause gap larger than the threshold', () => {
  const broke = chunkTexts([w('a', 0, 0.3), w('b', 0.7, 1.0)], { fps: 30 }); // gap 0.4 > 0.35
  assert.deepEqual(broke, ['a', 'b']);
  const joined = chunkTexts([w('a', 0, 0.3), w('b', 0.5, 0.8)], { fps: 30 }); // gap 0.2
  assert.deepEqual(joined, ['a b']);
});

test('chunkWords: breaks at the max-words ceiling', () => {
  const texts = chunkTexts([w('a', 0, 0.1), w('b', 0.1, 0.2), w('c', 0.2, 0.3)], {
    fps: 30,
    maxWords: 2,
  });
  assert.deepEqual(texts, ['a b', 'c']);
});

test('chunkWords: breaks at the max-chars ceiling', () => {
  const texts = chunkTexts([w('aaaa', 0, 0.1), w('bbbb', 0.1, 0.2), w('cccc', 0.2, 0.3)], {
    fps: 10,
    maxChars: 9, // "aaaa bbbb" is 9; a third word overflows
  });
  assert.deepEqual(texts, ['aaaa bbbb', 'cccc']);
});

test('chunkWords: chunk.toFrame chains to next chunk start; last holds to last word end', () => {
  const chunks = chunkWords([w('a', 0, 0.3), w('b', 0.7, 1.0)], { fps: 10 }); // pause break
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].fromFrame, 0);
  assert.equal(chunks[0].toFrame, chunks[1].fromFrame); // holds through the pause
  assert.equal(chunks[1].toFrame, 10); // round(1.0*10)
});

test('chunkWords: empty input yields no chunks', () => {
  assert.deepEqual(chunkWords([], { fps: 30 }), []);
});

test('documented chunking defaults', () => {
  assert.equal(DEFAULT_MAX_WORDS_PER_CHUNK, 5);
  assert.equal(DEFAULT_MAX_CHARS_PER_CHUNK, 24);
  assert.equal(DEFAULT_PAUSE_GAP_SEC, 0.35);
});

// --- the load-bearing agreement: chunkWords consumes the canonical tokenizer ---
// Flattening chunkWords' output reproduces tokenizeSpokenWords' tokens, in order,
// with no word split/merged/dropped — so WordEmphasis.index (an index into the
// tokenizer's list) aligns 1:1 with the flattened caption words.
function align(words: { t: string; s: number; e: number }[]): TtsAlignment {
  const characters: string[] = [];
  const character_start_times_seconds: number[] = [];
  const character_end_times_seconds: number[] = [];
  words.forEach((x, wi) => {
    const n = x.t.length;
    for (let i = 0; i < n; i++) {
      characters.push(x.t[i]);
      character_start_times_seconds.push(x.s + ((x.e - x.s) * i) / n);
      character_end_times_seconds.push(x.s + ((x.e - x.s) * (i + 1)) / n);
    }
    if (wi < words.length - 1) {
      characters.push(' ');
      character_start_times_seconds.push(x.e);
      character_end_times_seconds.push(x.e);
    }
  });
  return { characters, character_start_times_seconds, character_end_times_seconds };
}

test('AGREEMENT: flattened chunkWords words equal the canonical tokens (tricky cases)', () => {
  const a = align([
    { t: 'it', s: 0, e: 0.3 },
    { t: "doesn't", s: 0.3, e: 0.8 },
    { t: 'cost', s: 0.8, e: 1.1 },
    { t: '2.5', s: 1.1, e: 1.5 },
    { t: 'well-being', s: 1.5, e: 2.2 },
    { t: 'creatine—really', s: 2.2, e: 3.0 },
  ]);
  const tokens = tokenizeSpokenWords(a);
  const flattened = chunkWords(tokens, { fps: 30 }).flatMap((c) => c.words.map((x) => x.text));
  assert.deepEqual(flattened, tokens.map((t) => t.text));
});
