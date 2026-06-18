import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseVoiceTts,
  validateVoiceForm,
  voiceSettingsFromTts,
  DEFAULT_VOICE_FORM_TUNING,
  DEFAULT_VOICE_ID,
  DEFAULT_VOICE_MODEL,
} from './voice.ts';
import {
  DEFAULT_VOICE_ID as CANON_VOICE_ID,
  ELEVENLABS_DEFAULT_MODEL as CANON_MODEL,
} from '../voice/elevenlabs.ts';

test('drift guard: local defaults mirror the canonical elevenlabs constants', () => {
  assert.equal(DEFAULT_VOICE_ID, CANON_VOICE_ID);
  assert.equal(DEFAULT_VOICE_MODEL, CANON_MODEL);
});

test('parseVoiceTts: empty → default voice/model + default tuning', () => {
  const f = parseVoiceTts({});
  assert.equal(f.voiceId, DEFAULT_VOICE_ID);
  assert.equal(f.model, DEFAULT_VOICE_MODEL);
  assert.equal(f.stability, DEFAULT_VOICE_FORM_TUNING.stability);
  assert.equal(f.similarityBoost, DEFAULT_VOICE_FORM_TUNING.similarityBoost);
  assert.equal(f.style, DEFAULT_VOICE_FORM_TUNING.style);
  assert.equal(f.useSpeakerBoost, DEFAULT_VOICE_FORM_TUNING.useSpeakerBoost);
});

test('parseVoiceTts: garbage input → defaults', () => {
  assert.equal(parseVoiceTts(null).voiceId, DEFAULT_VOICE_ID);
  assert.equal(parseVoiceTts('nope').model, DEFAULT_VOICE_MODEL);
});

test('parseVoiceTts: placeholder voice_id → default voice id', () => {
  const f = parseVoiceTts({ voice_id: 'placeholder', model: 'eleven_turbo_v2' });
  assert.equal(f.voiceId, DEFAULT_VOICE_ID);
  assert.equal(f.model, 'eleven_turbo_v2');
});

test('parseVoiceTts: full object round-trips its values', () => {
  const f = parseVoiceTts({
    voice_id: 'abc123',
    model: 'eleven_turbo_v2',
    stability: 0.3,
    similarity_boost: 0.9,
    style: 0.2,
    use_speaker_boost: false,
  });
  assert.deepEqual(f, {
    voiceId: 'abc123',
    model: 'eleven_turbo_v2',
    stability: 0.3,
    similarityBoost: 0.9,
    style: 0.2,
    useSpeakerBoost: false,
  });
});

test('parseVoiceTts: partial tuning backfills missing keys', () => {
  const f = parseVoiceTts({ voice_id: 'abc', model: 'm', stability: 0.1 });
  assert.equal(f.stability, 0.1);
  assert.equal(f.similarityBoost, DEFAULT_VOICE_FORM_TUNING.similarityBoost);
  assert.equal(f.useSpeakerBoost, DEFAULT_VOICE_FORM_TUNING.useSpeakerBoost);
});

test('validateVoiceForm: valid form → snake_case stored object', () => {
  const r = validateVoiceForm({
    voiceId: 'abc',
    model: 'eleven_multilingual_v2',
    stability: 0.5,
    similarityBoost: 0.75,
    style: 0,
    useSpeakerBoost: true,
  });
  assert.equal(r.ok, true);
  assert.ok(r.ok && r.value.voice_id === 'abc');
  assert.ok(r.ok && r.value.similarity_boost === 0.75);
  assert.ok(r.ok && r.value.use_speaker_boost === true);
  assert.ok(r.ok && r.value.model === 'eleven_multilingual_v2');
});

test('validateVoiceForm: rejects empty voiceId / model', () => {
  assert.equal(validateVoiceForm({ voiceId: '', model: 'm', stability: 0.5, similarityBoost: 0.5, style: 0, useSpeakerBoost: true }).ok, false);
  assert.equal(validateVoiceForm({ voiceId: 'a', model: '', stability: 0.5, similarityBoost: 0.5, style: 0, useSpeakerBoost: true }).ok, false);
});

test('validateVoiceForm: rejects out-of-range / non-number sliders', () => {
  const base = { voiceId: 'a', model: 'm', stability: 0.5, similarityBoost: 0.5, style: 0, useSpeakerBoost: true };
  assert.equal(validateVoiceForm({ ...base, stability: -0.1 }).ok, false);
  assert.equal(validateVoiceForm({ ...base, similarityBoost: 1.1 }).ok, false);
  assert.equal(validateVoiceForm({ ...base, style: Number.NaN }).ok, false);
  assert.equal(validateVoiceForm({ ...base, stability: 'x' as unknown as number }).ok, false);
});

test('validateVoiceForm: rejects non-boolean useSpeakerBoost', () => {
  const base = { voiceId: 'a', model: 'm', stability: 0.5, similarityBoost: 0.5, style: 0 };
  assert.equal(validateVoiceForm({ ...base, useSpeakerBoost: 'yes' as unknown as boolean }).ok, false);
});

test('voiceSettingsFromTts: none present → undefined', () => {
  assert.equal(voiceSettingsFromTts({ voice_id: 'a', model: 'm' }), undefined);
  assert.equal(voiceSettingsFromTts(null), undefined);
});

test('voiceSettingsFromTts: subset present → only those keys, typed', () => {
  const s = voiceSettingsFromTts({ stability: 0.2, use_speaker_boost: false, similarity_boost: 'bad' });
  assert.deepEqual(s, { stability: 0.2, use_speaker_boost: false });
});
