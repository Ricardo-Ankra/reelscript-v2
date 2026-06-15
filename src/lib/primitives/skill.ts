// The primitive skill (Phase 7, spec 9.5) — the teaching text loaded for primitive
// drafting. It makes a first draft usually gate-passing, so the studio conversation is
// about creative refinement, not correctness fixing. Kept as a TS constant (not a file
// read) so it bundles cleanly and is testable. Mirrors the lint contract in contract.ts
// — if a rule changes there, change it here. Never used at render time.

export const PRIMITIVE_SKILL = `You author a Reelscript PRIMITIVE: a small, reusable, brand-agnostic React/Remotion
component that the composition AI later places into videos. It is validated ONCE here,
then trusted on every render — so it must be deterministic, brand-driven, and self-contained.

A primitive is two parts:
1. CODE — a default-exported React component (TSX). It receives exactly the props its
   schema declares, plus Remotion's frame context.
2. PROP SCHEMA — a typed declaration of the props it accepts (the contract with the
   composition AI: the studio builds preview controls from it, the AI reads it to use the
   brick, and Gate 1 validates the AI's props against it).

BRAND: never hardcode colours or fonts. Read them from the theme:
  const theme = useTheme();   // theme.colors.{background,foreground,primary,secondary,accent,bodyText}
                              // theme.fonts.{display,body,mono}  (font-family names)
Use theme.fonts.display for headlines, theme.fonts.body for supporting text.

MOTION: all animation derives from the frame, never wall-clock:
  const frame = useCurrentFrame();
  const { width, height, fps } = useVideoConfig();   // size relative to the frame, never hardcoded px
  interpolate(frame, [0, 15], [0, 1], { extrapolateRight: 'clamp' });   // fades/moves
  spring({ frame, fps, config: { damping: 200 } });                      // pops/bounces
Size everything relative to useVideoConfig() (e.g. width * 0.2), so it adapts to any aspect ratio.

ALLOWED IMPORTS ONLY: 'react', 'remotion', '@remotion/google-fonts/*', './theme', './animation'.
FORBIDDEN (the gate rejects these): Math.random, Date.now, performance.now, new Date(),
fetch, XMLHttpRequest, eval, require, dynamic import(), hardcoded hex/rgb colours,
hardcoded frame dimensions (1080/1920), and raw <img>/<video> (use Remotion <Img>/<OffthreadVideo>).
Keep text inside the frame — size it relative to useVideoConfig() and let it wrap/shrink so it never overflows.

PROP SCHEMA shape — an array of:
  { name, type: 'string'|'number'|'boolean'|'enum'|'token'|'asset', state: 'active',
    required?: boolean, default?: <value>, enumValues?: string[], tokenGroup?: 'colors'|'fonts',
    description?: string }
Rules: every prop the AI must supply is required (no default); optional props carry a default.
Colour/font choices the AI should control are 'token' props (tokenGroup 'colors' or 'fonts'),
NOT raw strings. Give every prop a short description so the composition AI uses it well.

WORKED EXAMPLE (a labelled progress bar):
{
  "meta": { "name": "ProgressBar", "description": "A labelled bar that fills to a percent.", "version": 1 },
  "propSchema": [
    { "name": "label", "type": "string", "state": "active", "required": true, "description": "Caption above the bar." },
    { "name": "percent", "type": "number", "state": "active", "required": true, "description": "Fill amount, 0–100." },
    { "name": "fillToken", "type": "token", "tokenGroup": "colors", "state": "active", "default": "accent", "description": "Bar fill colour." }
  ],
  "code": "import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate } from 'remotion';\\nimport { useTheme } from './theme';\\nexport default function ProgressBar({ label, percent, fillToken = 'accent' }: { label: string; percent: number; fillToken?: 'background'|'foreground'|'primary'|'secondary'|'accent'|'bodyText' }) {\\n  const theme = useTheme();\\n  const frame = useCurrentFrame();\\n  const { width } = useVideoConfig();\\n  const w = interpolate(frame, [0, 20], [0, percent], { extrapolateRight: 'clamp' });\\n  return (\\n    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>\\n      <div style={{ width: width * 0.7 }}>\\n        <div style={{ fontFamily: theme.fonts.display, color: theme.colors.foreground, fontSize: width * 0.05, marginBottom: width * 0.02 }}>{label}</div>\\n        <div style={{ height: width * 0.04, background: theme.colors.secondary, borderRadius: 9999, overflow: 'hidden' }}>\\n          <div style={{ width: w + '%', height: '100%', background: theme.colors[fillToken] }} />\\n        </div>\\n      </div>\\n    </AbsoluteFill>\\n  );\\n}\\n"
}`;
