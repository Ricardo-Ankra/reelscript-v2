// Built-in, model-aware emotion profile (Phase 8 slice 1). Pure: interprets the
// fixed EMOTION_TAGS vocabulary into ElevenLabs input. v3-class models get inline
// audio tags (per-span delivery); v2 strips tags to plain text (keeping <pause>
// as an SSML break) and derives one scene-level voice_settings nudge from the
// emotion tags present. The editable per-model voice_profiles override is slice 2.
import { EMOTION_TAGS, applyFallbackProfile, type EmotionTag } from './emotion';
import type { VoiceSettings } from './alignment';

const PAUSE_BREAK = '<break time="0.4s"/>';

// ElevenLabs defaults (mirrors DEFAULT_VOICE_FORM_TUNING in channels/voice.ts) —
// the numeric base for a nudge when the channel has no tuning set.
const DEFAULT_VOICE_SETTINGS: Required<VoiceSettings> = {
  stability: 0.5,
  similarity_boost: 0.75,
  style: 0,
  use_speaker_boost: true,
};

// v3-class models support inline audio tags ([excited], [whispers], ...); v2 does
// not. Heuristic on the model id; the default eleven_multilingual_v2 → false.
export function modelSupportsAudioTags(modelId: string): boolean {
  return /v3/i.test(modelId);
}

// Per-tag voice_settings deltas for the non-audio (v2) path; <pause> has none
// (handled as an SSML break, not a setting). Deltas are gentle and applied over
// the channel's base, averaged across the tags in a scene, then clamped.
export const EMOTION_NUDGES: Record<EmotionTag, Partial<VoiceSettings>> = {
  '<excited>': { style: 0.2, stability: -0.1 },
  '<pause>': {},
  '<whisper>': { stability: 0.15, style: -0.15 },
  '<emphatic>': { style: 0.15 },
  '<calm>': { style: -0.15, stability: 0.1 },
  '<curious>': { style: 0.1 },
  '<serious>': { style: -0.1, stability: 0.1 },
};

// v3 inline audio-tag forms; <pause> stays an SSML break in both paths.
export const AUDIO_TAGS: Record<EmotionTag, string> = {
  '<excited>': '[excited]',
  '<pause>': PAUSE_BREAK,
  '<whisper>': '[whispers]',
  '<emphatic>': '[emphatic]',
  '<calm>': '[calm]',
  '<curious>': '[curious]',
  '<serious>': '[serious]',
};

function tidy(s: string): string {
  return s.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim();
}

// Strip ALL tags (incl. <pause>) to clean prose, no SSML — the spoken-text form
// used as the emphasis pass's sceneScript.
export function stripEmotionTags(narration: string): string {
  let out = narration;
  for (const tag of EMOTION_TAGS) out = out.split(tag).join('');
  return tidy(out);
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

// The built-in profile: returns the exact text to synthesize + the per-scene
// voice_settings (undefined ⇒ omit voice_settings, exactly as today).
export function applyVoiceProfile(
  narration: string,
  modelId: string,
  base: VoiceSettings | undefined,
): { text: string; settings: VoiceSettings | undefined } {
  if (modelSupportsAudioTags(modelId)) {
    let out = narration;
    for (const tag of EMOTION_TAGS) out = out.split(tag).join(AUDIO_TAGS[tag]);
    return { text: tidy(out), settings: base };
  }

  // v2: strip + pause→break (reuse the fallback), then nudge scene-wide.
  const text = applyFallbackProfile(narration);
  const present = EMOTION_TAGS.filter((t) => t !== '<pause>' && narration.includes(t));
  if (present.length === 0) return { text, settings: base };

  const seed: Required<VoiceSettings> = { ...DEFAULT_VOICE_SETTINGS, ...(base ?? {}) };
  let dStability = 0;
  let dStyle = 0;
  for (const t of present) {
    const n = EMOTION_NUDGES[t];
    dStability += n.stability ?? 0;
    dStyle += n.style ?? 0;
  }
  dStability /= present.length;
  dStyle /= present.length;

  return {
    text,
    settings: {
      stability: clamp01(seed.stability + dStability),
      similarity_boost: seed.similarity_boost,
      style: clamp01(seed.style + dStyle),
      use_speaker_boost: seed.use_speaker_boost,
    },
  };
}
