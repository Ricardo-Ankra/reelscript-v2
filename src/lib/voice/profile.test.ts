import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  modelSupportsAudioTags,
  applyVoiceProfile,
  stripEmotionTags,
  EMOTION_NUDGES,
  applyStoredProfile,
  defaultTagMappings,
  validateTagMappings,
  type TagMappings,
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

test('defaultTagMappings v2: emotion tags strip+nudge, pause ssml_break', () => {
  const m = defaultTagMappings('eleven_multilingual_v2');
  assert.deepEqual(m['<pause>'], { mode: 'ssml_break' });
  assert.deepEqual(m['<excited>'], { mode: 'strip', nudge: { style: 0.2, stability: -0.1 } });
  assert.deepEqual(m['<emphatic>'], { mode: 'strip', nudge: { style: 0.15 } });
});

test('defaultTagMappings v3: emotion tags audio_tag, pause ssml_break', () => {
  const m = defaultTagMappings('eleven_v3');
  assert.deepEqual(m['<pause>'], { mode: 'ssml_break' });
  assert.deepEqual(m['<excited>'], { mode: 'audio_tag', value: '[excited]' });
  assert.deepEqual(m['<whisper>'], { mode: 'audio_tag', value: '[whispers]' });
});

test('applyStoredProfile: audio_tag inserts value, ssml_break inserts break, strip removes', () => {
  const mapping: TagMappings = {
    '<excited>': { mode: 'audio_tag', value: '[excited]' },
    '<pause>': { mode: 'ssml_break' },
    '<whisper>': { mode: 'strip' },
  };
  const r = applyStoredProfile('A <excited> b <pause> c <whisper> d', mapping, undefined);
  assert.ok(r.text.includes('[excited]'));
  assert.ok(r.text.includes('<break time="0.4s"/>'));
  assert.ok(!r.text.includes('<whisper>'));
  assert.ok(!r.text.includes('[whispers]'));
});

test('applyStoredProfile: a tag absent from the mapping is stripped', () => {
  const r = applyStoredProfile('keep <serious> this', {}, undefined);
  assert.equal(r.text, 'keep this');
  assert.equal(r.settings, undefined);
});

test('applyStoredProfile: strip nudges average + clamp; no nudges → settings undefined', () => {
  // <excited> style +0.2, <calm> style -0.15 → avg +0.025; base undefined → seed style 0
  const mapping: TagMappings = {
    '<excited>': { mode: 'strip', nudge: { style: 0.2, stability: -0.1 } },
    '<calm>': { mode: 'strip', nudge: { style: -0.15, stability: 0.1 } },
  };
  const r = applyStoredProfile('<excited> x <calm> y', mapping, undefined);
  assert.equal(Math.round(r.settings!.style * 1000) / 1000, 0.025);
  assert.equal(r.settings?.stability, 0.5); // -0.1 +0.1 avg 0, seed 0.5
  // ssml_break / audio_tag tags carry no nudge → settings stays the base (undefined).
  const none = applyStoredProfile('a <pause> b', { '<pause>': { mode: 'ssml_break' } }, undefined);
  assert.equal(none.settings, undefined);
});

test('validateTagMappings: accepts a valid mapping', () => {
  const res = validateTagMappings({
    '<excited>': { mode: 'audio_tag', value: '[excited]' },
    '<calm>': { mode: 'strip', nudge: { style: -0.15, stability: 0.1 } },
    '<pause>': { mode: 'ssml_break' },
  });
  assert.equal(res.ok, true);
});

test('validateTagMappings: rejects bad mode, empty audio value, out-of-range nudge, unknown key', () => {
  assert.equal(validateTagMappings({ '<calm>': { mode: 'nope' } }).ok, false);
  assert.equal(validateTagMappings({ '<excited>': { mode: 'audio_tag', value: '' } }).ok, false);
  assert.equal(validateTagMappings({ '<calm>': { mode: 'strip', nudge: { style: 1.1 } } }).ok, false);
  assert.equal(validateTagMappings({ '<calm>': { mode: 'strip', nudge: { stability: -1.1 } } }).ok, false);
  assert.equal(validateTagMappings({ '<bogus>': { mode: 'strip' } }).ok, false);
});

test('equivalence: applyVoiceProfile == applyStoredProfile(defaultTagMappings) for v2 and v3', () => {
  const base = { stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: true };
  const n = 'A <excited> b <pause> c <calm> d';
  for (const model of ['eleven_multilingual_v2', 'eleven_v3']) {
    assert.deepEqual(
      applyVoiceProfile(n, model, base),
      applyStoredProfile(n, defaultTagMappings(model), base),
    );
  }
  // also the undefined-base path
  assert.deepEqual(
    applyVoiceProfile(n, 'eleven_multilingual_v2', undefined),
    applyStoredProfile(n, defaultTagMappings('eleven_multilingual_v2'), undefined),
  );
});

test('validateTagMappings: rejects nudge on non-strip mode; defaults still valid', () => {
  // A nudge on a non-strip entry (audio_tag) must be rejected — it would be dead data.
  const res = validateTagMappings({ '<calm>': { mode: 'audio_tag', value: '[calm]', nudge: { style: 0.1 } } });
  assert.equal(res.ok, false);

  // The built-in defaults for both v2 and v3 must still validate cleanly.
  assert.equal(validateTagMappings(defaultTagMappings('eleven_multilingual_v2')).ok, true);
  assert.equal(validateTagMappings(defaultTagMappings('eleven_v3')).ok, true);
});
