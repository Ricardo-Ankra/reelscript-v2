// Pure channel voice-params parse + validation (Phase 8 — voice editor). No
// react/server/network: imports only the pure VoiceSettings type. The two
// default strings mirror the server-only elevenlabs.ts (a unit test guards the
// drift) so this module stays importable by tests without pulling in 'server-only'.
import type { VoiceSettings } from '../voice/alignment.ts';

// Mirror of elevenlabs.ts DEFAULT_VOICE_ID / ELEVENLABS_DEFAULT_MODEL. Kept local
// so this pure module never imports the server-only client. voice.test.ts asserts
// these equal the canonical values.
export const DEFAULT_VOICE_ID = '21m00Tcm4TlvDq8ikWAM';
export const DEFAULT_VOICE_MODEL = 'eleven_multilingual_v2';

export const VOICE_PARAM_MIN = 0;
export const VOICE_PARAM_MAX = 1;

// ElevenLabs' own defaults for eleven_multilingual_v2; shown when voice_tts has
// no tuning keys.
export const DEFAULT_VOICE_FORM_TUNING = {
  stability: 0.5,
  similarityBoost: 0.75,
  style: 0,
  useSpeakerBoost: true,
} as const;

export interface VoiceForm {
  voiceId: string;
  model: string;
  stability: number;
  similarityBoost: number;
  style: number;
  useSpeakerBoost: boolean;
}

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

// Build the form model from a stored voice_tts. Backfills voiceId/model to the
// defaults when unset or the Phase-2 'placeholder' (voiceId only), and tuning to
// DEFAULT_VOICE_FORM_TUNING when absent / wrong-typed.
export function parseVoiceTts(voiceTts: unknown): VoiceForm {
  const o = asRecord(voiceTts);
  const rawVoice = typeof o.voice_id === 'string' ? o.voice_id : '';
  const voiceId = rawVoice && rawVoice !== 'placeholder' ? rawVoice : DEFAULT_VOICE_ID;
  const model = typeof o.model === 'string' && o.model ? o.model : DEFAULT_VOICE_MODEL;
  return {
    voiceId,
    model,
    stability: num(o.stability, DEFAULT_VOICE_FORM_TUNING.stability),
    similarityBoost: num(o.similarity_boost, DEFAULT_VOICE_FORM_TUNING.similarityBoost),
    style: num(o.style, DEFAULT_VOICE_FORM_TUNING.style),
    useSpeakerBoost:
      typeof o.use_speaker_boost === 'boolean'
        ? o.use_speaker_boost
        : DEFAULT_VOICE_FORM_TUNING.useSpeakerBoost,
  };
}

function inRange(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= VOICE_PARAM_MIN && v <= VOICE_PARAM_MAX;
}

// Validate a form submission → the snake_case voice_tts object to store. The keys
// match what synthesis reads and ElevenLabs' voice_settings naming.
export function validateVoiceForm(
  input: unknown,
): { ok: true; value: Record<string, unknown> } | { ok: false; reason: string } {
  const o = asRecord(input);
  const voiceId = o.voiceId;
  const model = o.model;
  if (typeof voiceId !== 'string' || !voiceId.trim()) return { ok: false, reason: 'Pick a voice.' };
  if (typeof model !== 'string' || !model.trim()) return { ok: false, reason: 'Pick a model.' };
  if (!inRange(o.stability)) return { ok: false, reason: 'Stability must be between 0 and 1.' };
  if (!inRange(o.similarityBoost)) return { ok: false, reason: 'Similarity boost must be between 0 and 1.' };
  if (!inRange(o.style)) return { ok: false, reason: 'Style must be between 0 and 1.' };
  if (typeof o.useSpeakerBoost !== 'boolean') return { ok: false, reason: 'Speaker boost must be on or off.' };
  return {
    ok: true,
    value: {
      voice_id: voiceId,
      model,
      stability: o.stability,
      similarity_boost: o.similarityBoost,
      style: o.style,
      use_speaker_boost: o.useSpeakerBoost,
    },
  };
}

// Extract the 4 tuning keys from a stored voice_tts as VoiceSettings, omitting any
// key that is absent / wrong-typed. Returns undefined when none are present so the
// synthesis event omits voice_settings entirely (byte-identical to pre-wiring).
export function voiceSettingsFromTts(voiceTts: unknown): VoiceSettings | undefined {
  const o = asRecord(voiceTts);
  const out: VoiceSettings = {};
  if (typeof o.stability === 'number' && Number.isFinite(o.stability)) out.stability = o.stability;
  if (typeof o.similarity_boost === 'number' && Number.isFinite(o.similarity_boost))
    out.similarity_boost = o.similarity_boost;
  if (typeof o.style === 'number' && Number.isFinite(o.style)) out.style = o.style;
  if (typeof o.use_speaker_boost === 'boolean') out.use_speaker_boost = o.use_speaker_boost;
  return Object.keys(out).length > 0 ? out : undefined;
}
