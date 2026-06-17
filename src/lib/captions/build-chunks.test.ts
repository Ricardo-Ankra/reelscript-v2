import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCaptionChunks } from './build-chunks.ts';
import { chunkWords } from './chunks.ts';
import type { SpokenWord } from './tokenize.ts';
import type { WordEmphasis } from './types.ts';

const w = (text: string, s: number, e: number): SpokenWord => ({ text, startSec: s, endSec: e });

const WORDS: SpokenWord[] = [
  w('they', 0, 0.3),
  w('are', 0.3, 0.5),
  w('lying', 0.5, 1.0),
  w('today', 1.0, 1.4),
];

test('with no emphasis it equals chunkWords (no emphasis attached)', () => {
  const opts = { fps: 30 };
  assert.deepEqual(buildCaptionChunks(WORDS, [], opts), chunkWords(WORDS, opts));
});

test('attaches each emphasis to the word at its global token index', () => {
  const emphasis: WordEmphasis[] = [
    { index: 2, role: 'shout', tone: 'negative', effect: 'shatter' }, // "lying"
    { index: 3, role: 'key', tone: 'positive' }, // "today"
  ];
  const chunks = buildCaptionChunks(WORDS, emphasis, { fps: 30, maxWords: 10 });
  const flat = chunks.flatMap((c) => c.words);
  assert.equal(flat[2].text, 'lying');
  assert.deepEqual(flat[2].emphasis, { index: 2, role: 'shout', tone: 'negative', effect: 'shatter' });
  assert.equal(flat[3].text, 'today');
  assert.equal(flat[3].emphasis?.role, 'key');
  // unemphasized words carry no emphasis
  assert.equal(flat[0].emphasis, undefined);
  assert.equal(flat[1].emphasis, undefined);
});

test('emphasis whose index is out of range is ignored (defensive)', () => {
  const chunks = buildCaptionChunks(WORDS, [{ index: 99, role: 'key' }], { fps: 30 });
  assert.ok(chunks.flatMap((c) => c.words).every((x) => x.emphasis === undefined));
});

test('attachment survives word grouping across multiple chunks', () => {
  // Force a break after index 1 via maxWords: 2 → chunk A [they, are], chunk B [lying, today].
  const chunks = buildCaptionChunks(WORDS, [{ index: 2, role: 'shout' }], { fps: 30, maxWords: 2 });
  assert.equal(chunks.length, 2);
  assert.equal(chunks[1].words[0].text, 'lying');
  assert.equal(chunks[1].words[0].emphasis?.role, 'shout');
});
