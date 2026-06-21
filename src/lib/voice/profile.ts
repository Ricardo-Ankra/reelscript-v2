// Built-in, model-aware emotion profile (Phase 8 slice 1). Pure: interprets the
// fixed EMOTION_TAGS vocabulary into ElevenLabs input. v3-class models get inline
// audio tags (per-span delivery); v2 strips tags to plain text (keeping <pause>
// as an SSML break) and derives one scene-level voice_settings nudge from the
// emotion tags present. The editable per-model voice_profiles override is slice 2.
import { EMOTION_TAGS, type EmotionTag } from './emotion';
import type { VoiceSettings } from './alignment';

export type TagMode = 'audio_tag' | 'ssml_break' | 'strip';
export interface TagMapping {
  mode: TagMode;
  value?: string; // audio_tag text
  nudge?: { stability?: number; style?: number }; // strip deltas
}
export type TagMappings = Partial<Record<EmotionTag, TagMapping>>;

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

// Apply a tag_mappings to narration → the exact text to synthesize + the per-scene
// voice_settings. Per tag (absent from the mapping ⇒ treated as strip): audio_tag →
// insert value (missing/empty ⇒ ''); ssml_break → insert the SSML break; strip →
// remove. settings = base ⊕ AVERAGE of present strip-tags-that-carry-a-nudge deltas
// (stability/style), clamped [0,1]; none ⇒ settings = base (undefined stays
// undefined → voice_settings omitted). Same averaging/clamp rule as slice 1.
export function applyStoredProfile(
  narration: string,
  mapping: TagMappings,
  base: VoiceSettings | undefined,
): { text: string; settings: VoiceSettings | undefined } {
  let out = narration;
  for (const tag of EMOTION_TAGS) {
    const m = mapping[tag] ?? { mode: 'strip' as const };
    const replacement =
      m.mode === 'audio_tag' ? m.value ?? '' : m.mode === 'ssml_break' ? PAUSE_BREAK : '';
    out = out.split(tag).join(replacement);
  }
  const text = tidy(out);

  const contributing = EMOTION_TAGS.filter((tag) => {
    const m = mapping[tag];
    return m != null && m.mode === 'strip' && m.nudge != null && narration.includes(tag);
  });
  if (contributing.length === 0) return { text, settings: base };

  const seed: Required<VoiceSettings> = { ...DEFAULT_VOICE_SETTINGS, ...(base ?? {}) };
  let dStability = 0;
  let dStyle = 0;
  for (const tag of contributing) {
    const n = mapping[tag]!.nudge!;
    dStability += n.stability ?? 0;
    dStyle += n.style ?? 0;
  }
  dStability /= contributing.length;
  dStyle /= contributing.length;

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

// The built-in behavior expressed as data — seeds a new profile and is the fallback
// when no stored row exists. v2 (non-audio): emotion tags { mode:'strip',
// nudge: EMOTION_NUDGES[tag] }, <pause> { mode:'ssml_break' }. v3 (audio): emotion
// tags { mode:'audio_tag', value: AUDIO_TAGS[tag] }, <pause> { mode:'ssml_break' }.
export function defaultTagMappings(modelId: string): TagMappings {
  const audio = modelSupportsAudioTags(modelId);
  const out: TagMappings = {};
  for (const tag of EMOTION_TAGS) {
    if (tag === '<pause>') {
      out[tag] = { mode: 'ssml_break' };
      continue;
    }
    if (audio) {
      out[tag] = { mode: 'audio_tag', value: AUDIO_TAGS[tag] };
    } else {
      const n = EMOTION_NUDGES[tag];
      const nudge: { stability?: number; style?: number } = {};
      if (n.stability !== undefined) nudge.stability = n.stability;
      if (n.style !== undefined) nudge.style = n.style;
      out[tag] = { mode: 'strip', nudge };
    }
  }
  return out;
}

const TAG_MODES: readonly TagMode[] = ['audio_tag', 'ssml_break', 'strip'];
const EMOTION_TAG_SET = new Set<string>(EMOTION_TAGS);

// Validate an editor submission → storable tag_mappings. Rejects: an unknown key; a
// non-object entry; a mode not in the 3; an audio_tag with an empty/missing value; a
// nudge that is not an object or whose stability/style is non-numeric / outside [-1,1].
export function validateTagMappings(
  input: unknown,
): { ok: true; value: TagMappings } | { ok: false; reason: string } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, reason: 'Profile must be an object.' };
  }
  const out: TagMappings = {};
  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    if (!EMOTION_TAG_SET.has(key)) return { ok: false, reason: `Unknown tag: ${key}` };
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return { ok: false, reason: `Mapping for ${key} must be an object.` };
    }
    const m = raw as Record<string, unknown>;
    if (!TAG_MODES.includes(m.mode as TagMode)) {
      return { ok: false, reason: `Invalid mode for ${key}.` };
    }
    const mode = m.mode as TagMode;
    const entry: TagMapping = { mode };
    if (mode === 'audio_tag') {
      if (typeof m.value !== 'string' || m.value.trim() === '') {
        return { ok: false, reason: `${key}: audio tag text is required.` };
      }
      entry.value = m.value;
    }
    if (m.nudge !== undefined) {
      if (typeof m.nudge !== 'object' || m.nudge === null || Array.isArray(m.nudge)) {
        return { ok: false, reason: `${key}: nudge must be an object.` };
      }
      const n = m.nudge as Record<string, unknown>;
      const nudge: { stability?: number; style?: number } = {};
      for (const axis of ['stability', 'style'] as const) {
        if (n[axis] !== undefined) {
          const v = n[axis];
          if (typeof v !== 'number' || Number.isNaN(v) || v < -1 || v > 1) {
            return { ok: false, reason: `${key}: ${axis} must be between -1 and 1.` };
          }
          nudge[axis] = v;
        }
      }
      entry.nudge = nudge;
    }
    out[key as EmotionTag] = entry;
  }
  return { ok: true, value: out };
}

// The built-in profile, expressed via the general engine: apply the model's default
// tag mapping. Signature/behavior unchanged from slice 1 (the slice-1 tests guard it).
export function applyVoiceProfile(
  narration: string,
  modelId: string,
  base: VoiceSettings | undefined,
): { text: string; settings: VoiceSettings | undefined } {
  return applyStoredProfile(narration, defaultTagMappings(modelId), base);
}
