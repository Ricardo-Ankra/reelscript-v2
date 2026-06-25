// Master color "look" presets (V2 Slice 3b). PURE — no react/server/network. A look
// is a named, subtle, broadcast-safe ffmpeg -vf chain (eq/colorbalance only, no curves
// or lut3d this slice → filter strings are space-free and robust across ffmpeg builds).
// The render step applies it as a post-pass on the dedicated ffmpeg Lambda. This module
// is the single source of the look vocabulary, shared by settings.ts and the channel
// brand validator.
//
// Subtle by design: a master look is a stylistic top-coat, not a consistency-fixer;
// aggressive grades on heterogeneous AI/stock footage amplify mismatch. lut3d/.cube is
// a clean future upgrade (same render step, different argv + a .cube input).

export type ColorLook = 'none' | 'neutral' | 'warm' | 'cool' | 'punch';

export const COLOR_LOOKS: readonly ColorLook[] = ['none', 'neutral', 'warm', 'cool', 'punch'];

export const DEFAULT_COLOR_LOOK: ColorLook = 'neutral';

export const LOOK_LABELS: Record<ColorLook, string> = {
  none: 'None (no grade)',
  neutral: 'Neutral (clean)',
  warm: 'Warm cinematic',
  cool: 'Cool teal',
  punch: 'Punch (high contrast)',
};

// Subtle, broadcast-safe filter chains. eq: contrast/saturation/gamma multipliers around
// 1.0. colorbalance: rm/rh = red mids/highlights, bm/bh = blue mids/highlights,
// bs/rs = blue/red shadows, range roughly -0.1..0.1. Space-free so the whole chain is a
// single argv token.
const FILTERS: Record<Exclude<ColorLook, 'none'>, string> = {
  neutral: 'eq=contrast=1.06:saturation=1.08:gamma=0.98',
  warm: 'eq=contrast=1.05:saturation=1.06,colorbalance=rm=0.04:rh=0.03:bm=-0.03:bh=-0.04',
  cool: 'eq=contrast=1.05:saturation=1.04,colorbalance=bs=0.04:bh=0.03:rs=-0.02:rh=-0.03',
  punch: 'eq=contrast=1.12:saturation=1.14:gamma=0.97',
};

// The ffmpeg -vf chain for a look, or null for 'none' / an unknown id (caller skips the
// grade entirely → byte-identical base).
export function buildGradeFilter(look: ColorLook): string | null {
  if (look === 'none') return null;
  return FILTERS[look as Exclude<ColorLook, 'none'>] ?? null;
}

export interface GradeInput {
  inPath: string;
  outPath: string;
  filter: string;
}

// Pure argv for the grade pass: re-encode video with the filter, COPY audio (the base is
// voiceover-only — keep it bit-exact), faststart. Mirrors buildRemuxArgs.
export function buildGradeArgs(input: GradeInput): string[] {
  return [
    '-y',
    '-i',
    input.inPath,
    '-vf',
    input.filter,
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-preset',
    'veryfast',
    '-crf',
    '20',
    '-c:a',
    'copy',
    '-movflags',
    '+faststart',
    input.outPath,
  ];
}
