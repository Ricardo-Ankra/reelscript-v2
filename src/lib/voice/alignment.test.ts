import { test } from 'node:test';
import assert from 'node:assert/strict';
import { durationFromAlignment, decodeTtsResponse } from './alignment.ts';

const alignment = {
  characters: ['H', 'i'],
  character_start_times_seconds: [0, 0.1],
  character_end_times_seconds: [0.1, 0.42],
};

test('durationFromAlignment: last end time', () => {
  assert.equal(durationFromAlignment(alignment), 0.42);
});

test('durationFromAlignment: empty alignment is zero', () => {
  assert.equal(
    durationFromAlignment({
      characters: [],
      character_start_times_seconds: [],
      character_end_times_seconds: [],
    }),
    0,
  );
});

test('decodeTtsResponse: decodes base64 audio and measures duration', () => {
  const audio_base64 = Buffer.from('FAKE_MP3_BYTES').toString('base64');
  const { audio, durationSeconds, alignment: a } = decodeTtsResponse({ audio_base64, alignment });
  assert.equal(audio.toString(), 'FAKE_MP3_BYTES');
  assert.equal(durationSeconds, 0.42);
  assert.equal(a.characters.length, 2);
});

test('decodeTtsResponse: throws on missing audio', () => {
  assert.throws(() => decodeTtsResponse({ alignment }), /missing audio_base64/);
});

test('decodeTtsResponse: throws on missing alignment', () => {
  const audio_base64 = Buffer.from('x').toString('base64');
  assert.throws(() => decodeTtsResponse({ audio_base64 }), /missing alignment/);
});
