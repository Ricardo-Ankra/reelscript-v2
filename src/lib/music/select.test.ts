import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectMusicTrack, rerollMusicTrack, rankTracksByMood, type MusicTrack } from './select.ts';

const LIB: MusicTrack[] = [
  { id: 'neu', moodTags: ['neutral'] },
  { id: 'up', moodTags: ['upbeat'] },
  { id: 'up2', moodTags: ['upbeat', 'energetic'] },
  { id: 'cal', moodTags: ['calm'] },
];

test('selectMusicTrack: a direct mood hit wins', () => {
  assert.equal(selectMusicTrack('upbeat', LIB)?.id, 'up');
});

test('selectMusicTrack: no match falls back to a neutral-tagged track', () => {
  assert.equal(selectMusicTrack('dramatic', LIB)?.id, 'neu');
});

test('selectMusicTrack: empty library is null', () => {
  assert.equal(selectMusicTrack('upbeat', []), null);
});

test('rankTracksByMood: mood hits, then neutral, then the rest (stable)', () => {
  const ranked = rankTracksByMood('upbeat', LIB).map((t) => t.id);
  assert.deepEqual(ranked, ['up', 'up2', 'neu', 'cal']);
});

test('rerollMusicTrack: steps to the next ranked track, wrapping', () => {
  // ranked for 'upbeat' = [up, up2, neu, cal]
  assert.equal(rerollMusicTrack('upbeat', LIB, 'up')?.id, 'up2');
  assert.equal(rerollMusicTrack('upbeat', LIB, 'cal')?.id, 'up'); // wraps
});

test('rerollMusicTrack: null current returns the first ranked', () => {
  assert.equal(rerollMusicTrack('upbeat', LIB, null)?.id, 'up');
});

test('rerollMusicTrack: single-track library returns that track', () => {
  const one: MusicTrack[] = [{ id: 'solo', moodTags: ['calm'] }];
  assert.equal(rerollMusicTrack('upbeat', one, 'solo')?.id, 'solo');
});
