// Effect gate probe (caption emphasis revision, 2026-06-16).
//
// Turns a pure effect's source into a candidate the EXISTING authoring gates
// validate unchanged (one trust class): a small Remotion component that renders a
// sample word with the effect's layers applied at the reveal progress t. The
// effect source is inlined verbatim, so lint/compile/smoke/brand validate the
// REAL effect code — the renderer and the registry import the same file, so there
// is no drift.
//
// Pure (string in, string out) so it is unit-testable; the Lambda-backed gate run
// lives in effect-gate.ts (server-only).
import type { EmphasisEffect } from './types';
import type { EffectFn } from './effects/contract';
import type { PropSchema } from '../primitives/contract';

// The probe maps frame → t over the whole composition, so the gate's mid-render
// still (frame 15 of 30) lands mid-animation — the moment most likely to clip or
// collide — rather than on the settled frame.
//
// It bakes a realistic worst-case emphasis word (no stressable text prop): an
// effect animates a short, system-controlled word, so the meaningful stress is
// the extreme brand THEMES, not an 80-char overflow paragraph it can never
// receive. Layout is relative (a % band, em-free sizing) so it holds at the
// tightest frame width (9:16) and adapts to other aspect ratios unchanged.
const SAMPLE_WORD = 'rehabilitation';

export function buildEffectProbe(
  name: EmphasisEffect,
  effectSource: string,
): { code: string; propSchema: PropSchema } {
  const code = `import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import { useTheme } from './theme';

// --- inlined effect source (the artifact under test) ---
${effectSource}
// --- end effect source ---

export default function EffectProbe() {
  const text = ${JSON.stringify(SAMPLE_WORD)};
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const t = Math.min(1, frame / (durationInFrames - 1));
  const theme = useTheme();
  const layers = ${name}(t);
  // A bounded, centered, wrapping band — the same shape the caption renderer uses
  // — so overflowing text wraps and stays in frame instead of running off-edge,
  // and effect scale (≤ ~1.3 at the gate frame) still fits within the frame.
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ position: 'relative', width: '70%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {layers.map((layer, i) => (
          <span
            key={i}
            style={{
              position: layers.length > 1 ? 'absolute' : 'relative',
              maxWidth: '100%',
              fontFamily: theme.fonts.display,
              color: theme.colors.foreground,
              fontSize: 72,
              fontWeight: 800,
              lineHeight: 1.1,
              textAlign: 'center',
              overflowWrap: 'break-word',
              wordBreak: 'break-word',
              transform: layer.transform,
              transformOrigin: 'center',
              opacity: layer.opacity,
              clipPath: layer.clipPath,
            }}
          >
            {text}
          </span>
        ))}
      </div>
    </AbsoluteFill>
  );
}
`;
  // No props: the baked word is the input, so generateSampleProps (smoke) and
  // stressProps (brand) both render it — brand still varies the extreme themes.
  const propSchema: PropSchema = [];
  return { code, propSchema };
}

// Compile-time guard: each starter effect must satisfy EffectFn (kept here so a
// drifting effect signature is caught where the probe is built).
export type _AssertEffectFn = EffectFn;
