// Caption emphasis effect contract (caption emphasis revision, 2026-06-16).
//
// An effect describes a word's ENTRANCE animation as the reveal progress t runs
// 0 → 1 (t=0 = the extreme start, t=1 = settled at rest). It returns one or more
// stacked LAYERS — the renderer draws the word once per layer — so multi-part
// effects like `shatter` (two glyph halves flying together) are expressible.
//
// Uniform settled contract: every effect returns exactly [{ opacity: 1 }] at
// t >= 1, i.e. a single plain word at rest. The emphasis is in the entrance.
//
// Effects are pure (t → layers), deterministic (no wall-clock, no randomness),
// and IMPORT-FREE, so each one passes the authoring lint gate's import whitelist
// unchanged — the same gate that validates studio primitives (one trust class).

export interface EffectLayer {
  transform?: string;
  opacity?: number;
  clipPath?: string;
}

export type EffectFn = (t: number) => EffectLayer[];
