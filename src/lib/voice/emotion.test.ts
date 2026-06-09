import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EMOTION_TAGS, applyFallbackProfile } from './emotion.ts';

test('vocabulary: the fixed seven tags, exactly', () => {
  assert.deepEqual(
    [...EMOTION_TAGS],
    ['<excited>', '<pause>', '<whisper>', '<emphatic>', '<calm>', '<curious>', '<serious>'],
  );
});

test('fallback: <pause> becomes an SSML break', () => {
  assert.equal(
    applyFallbackProfile('Wait for it <pause> now.'),
    'Wait for it <break time="0.4s"/> now.',
  );
});

test('fallback: every non-pause tag is stripped to plain text', () => {
  for (const tag of EMOTION_TAGS) {
    if (tag === '<pause>') continue;
    assert.equal(applyFallbackProfile(`Hello ${tag} world`), 'Hello world', `tag ${tag}`);
  }
});

test('fallback: multiple tags in one string', () => {
  assert.equal(
    applyFallbackProfile('<excited>Big news<emphatic> today <pause> friends'),
    'Big news today <break time="0.4s"/> friends',
  );
});

test('fallback: collapses whitespace a stripped tag leaves and trims', () => {
  assert.equal(applyFallbackProfile('  <calm>   Stay   calm  '), 'Stay calm');
});

test('fallback: preserves newlines but trims spaces around them', () => {
  assert.equal(applyFallbackProfile('line one  \n  <curious> line two'), 'line one\nline two');
});

test('fallback: plain narration passes through unchanged (Phase 3 common case)', () => {
  assert.equal(applyFallbackProfile('Just a normal sentence.'), 'Just a normal sentence.');
});
