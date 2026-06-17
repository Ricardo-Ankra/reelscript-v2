// Caption emphasis data model (caption emphasis revision, 2026-06-16).
//
// One animated caption track replaces the old two-track caption/kinetic split.
// Emphasis is a three-axis annotation the AI emits per word; the renderer
// resolves each axis deterministically (role → typography, tone → color from
// baked brand tables; effect → a gate-validated animation registry).
//
// Pure type declarations — shared by chunkWords, the coherence validator, the
// emphasis pass, and the AnimatedCaptionTrack renderer, so they cannot drift.

export type EmphasisRole = 'key' | 'shout' | 'contrast' | 'number'; // → typography
export type EmphasisTone = 'positive' | 'negative' | 'neutral'; // → color
export type EmphasisEffect =
  | 'pop'
  | 'topple'
  | 'shatter'
  | 'shake'
  | 'rise'
  | 'zoom'
  | 'glitch'; // → animation

export const EMPHASIS_ROLES: readonly EmphasisRole[] = ['key', 'shout', 'contrast', 'number'];
export const EMPHASIS_TONES: readonly EmphasisTone[] = ['positive', 'negative', 'neutral'];
export const EMPHASIS_EFFECTS: readonly EmphasisEffect[] = [
  'pop',
  'topple',
  'shatter',
  'shake',
  'rise',
  'zoom',
  'glitch',
];

export interface WordEmphasis {
  index: number; // index into the scene's canonical spoken-word list (see tokenize.ts)
  role: EmphasisRole; // required on every emphasized word
  tone?: EmphasisTone; // optional; omitted → neutral
  effect?: EmphasisEffect; // optional; the RARE axis (see coherence validator)
}

export interface CaptionWord {
  text: string;
  fromFrame: number; // word pops in here (absolute frame)
  toFrame: number; // spoken-word end (for active-state / travel effects)
  emphasis?: WordEmphasis; // undefined → normal word
}

// Per-scene caption focus — does this scene lead with the words or the imagery?
// Drives the caption band + size (resolved deterministically by the renderer).
export type CaptionFocus = 'visual' | 'text' | 'balanced';

export interface CaptionChunk {
  fromFrame: number; // chunk first visible
  toFrame: number; // chunk replaced (next chunk's start, or last word's end)
  words: CaptionWord[];
  focus?: CaptionFocus; // the scene's focus; omitted → balanced
}
