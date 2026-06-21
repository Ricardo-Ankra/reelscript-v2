import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  modelSupportsAudioTags,
  applyVoiceProfile,
  stripEmotionTags,
  EMOTION_NUDGES,
} from './profile.ts';

test('modelSupportsAudioTags: v2 false, v3 true', () => {
  assert.equal(modelSupportsAudioTags('eleven_multilingual_v2'), false);
  assert.equal(modelSupportsAudioTags('eleven_v3'), true);
  assert.equal(modelSupportsAudioTags('eleven_multilingual_v3'), true);
});

test('stripEmotionTags: removes all tags incl. pause, no SSML', () => {
  const out = stripEmotionTags('Hello <excited> world <pause> now <whisper>.');
  assert.equal(out, 'Hello world now .');
  assert.ok(!out.includes('<break'));
  assert.ok(!out.includes('<excited>'));
});

test('applyVoiceProfile v2: strips tags, pause→break, nudges settings', () => {
  const r = applyVoiceProfile('A <excited> b <pause> c', 'eleven_multilingual_v2', {
    stability: 0.5,
    similarity_boost: 0.75,
    style: 0,
    use_speaker_boost: true,
  });
  assert.ok(r.text.includes('<break time="0.4s"/>'));
  assert.ok(!r.text.includes('<excited>'));
  // single tag <excited>: style 0 + 0.2 = 0.2, stability 0.5 - 0.1 = 0.4
  assert.equal(r.settings?.style, 0.2);
  assert.equal(r.settings?.stability, 0.4);
  assert.equal(r.settings?.similarity_boost, 0.75);
  assert.equal(r.settings?.use_speaker_boost, true);
});

test('applyVoiceProfile v2: multiple emotion tags AVERAGE (not sum)', () => {
  // <excited> style +0.2, <calm> style -0.15 → avg = +0.025; base style 0 → 0.025
  // <excited> stability -0.1, <calm> stability +0.1 → avg 0 → base 0.5
  const r = applyVoiceProfile('<excited> x <calm> y', 'eleven_multilingual_v2', {
    stability: 0.5,
    similarity_boost: 0.75,
    style: 0,
    use_speaker_boost: true,
  });
  assert.equal(Math.round(r.settings!.style * 1000) / 1000, 0.025);
  assert.equal(r.settings?.stability, 0.5);
});

test('applyVoiceProfile v2: clamps to [0,1]', () => {
  // base style 0.95 + <excited> +0.2 = 1.15 → clamp 1
  const r = applyVoiceProfile('<excited> x', 'eleven_multilingual_v2', {
    stability: 0.5,
    similarity_boost: 0.75,
    style: 0.95,
    use_speaker_boost: true,
  });
  assert.equal(r.settings?.style, 1);
});

test('applyVoiceProfile v2: no tags + undefined base → settings undefined (back-compat)', () => {
  const r = applyVoiceProfile('plain narration', 'eleven_multilingual_v2', undefined);
  assert.equal(r.settings, undefined);
  assert.equal(r.text, 'plain narration');
});

test('applyVoiceProfile v2: no emotion tags + a base → base unchanged', () => {
  const base = { stability: 0.3, similarity_boost: 0.6, style: 0.1, use_speaker_boost: false };
  const r = applyVoiceProfile('plain <pause> text', 'eleven_multilingual_v2', base);
  assert.deepEqual(r.settings, base);
  assert.ok(r.text.includes('<break time="0.4s"/>'));
});

test('applyVoiceProfile v2: emotion tag + undefined base → seeds defaults then nudges', () => {
  // base undefined → seed {stability:0.5, similarity_boost:0.75, style:0, use_speaker_boost:true}
  const r = applyVoiceProfile('<excited> x', 'eleven_multilingual_v2', undefined);
  assert.equal(r.settings?.style, 0.2);
  assert.equal(r.settings?.stability, 0.4);
});

test('applyVoiceProfile v3: inserts audio tags, settings = base unchanged', () => {
  const base = { stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: true };
  const r = applyVoiceProfile('A <excited> b <pause> c', 'eleven_v3', base);
  assert.ok(r.text.includes('[excited]'));
  assert.ok(r.text.includes('<break time="0.4s"/>'));
  assert.ok(!r.text.includes('<excited>'));
  assert.deepEqual(r.settings, base);
});

test('EMOTION_NUDGES: pause has no nudge', () => {
  assert.deepEqual(EMOTION_NUDGES['<pause>'], {});
});
