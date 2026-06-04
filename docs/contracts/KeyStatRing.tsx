// =============================================================================
// KeyStatRing — reference primitive
// =============================================================================
// A worked example of the primitive contract: a statistic inside a circular
// progress ring, the number scaling (and optionally counting) in, the ring
// sweeping to a value. Demonstrates every rule a primitive must follow, and
// doubles as a teaching example for the primitive-skill.
//
// Note how it obeys the contract:
//   * colours and fonts come from useTheme(), never literals;
//   * all motion derives from useCurrentFrame() — no wall-clock time;
//   * frame dimensions come from useVideoConfig() — nothing hardcoded;
//   * imports stay within the whitelist;
//   * it declares its prop schema, including one deprecated prop with a
//     code-level fallback, exactly as the lifecycle requires.
// =============================================================================

import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring } from 'remotion';
import { useTheme } from './theme';
import type { PropSchema, PrimitiveMeta } from './theme';

interface KeyStatRingProps {
  value: string; // the headline figure, e.g. "73%"
  label: string; // the caption beneath it, e.g. "STILL UNFOUND"
  progress: number; // 0..1, how far the ring sweeps
  animation: 'scale-pop' | 'fade' | 'count-up';
  thickProgressRing?: boolean; // deprecated; superseded by ringWeight on the theme motion preset
}

export function KeyStatRing({
  value,
  label,
  progress,
  animation,
  thickProgressRing = false, // deprecated-prop fallback: old specs may still pass it
}: KeyStatRingProps) {
  const theme = useTheme();
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();

  // Size relative to the frame, never hardcoded pixels.
  const ringSize = width * 0.18;
  const stroke = (thickProgressRing ? 0.09 : 0.06) * ringSize;

  // Entry animation, driven entirely by the frame.
  const pop = spring({ frame, fps, from: 0.6, to: 1, config: { damping: 200 } });
  const fade = interpolate(frame, [0, 12], [0, 1], { extrapolateRight: 'clamp' });
  const sweep = interpolate(frame, [0, 30], [0, progress], { extrapolateRight: 'clamp' });

  const numberScale = animation === 'scale-pop' ? pop : 1;
  const opacity = animation === 'fade' ? fade : 1;
  const shown =
    animation === 'count-up' ? formatCountUp(value, frame) : value;

  const radius = ringSize / 2 - stroke / 2;
  const circumference = 2 * Math.PI * radius;

  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', opacity }}>
      <svg width={ringSize} height={ringSize} style={{ overflow: 'visible' }}>
        <circle
          cx={ringSize / 2}
          cy={ringSize / 2}
          r={radius}
          fill="none"
          stroke={theme.colors.secondary}
          strokeWidth={stroke}
          opacity={0.25}
        />
        <circle
          cx={ringSize / 2}
          cy={ringSize / 2}
          r={radius}
          fill="none"
          stroke={theme.colors.accent}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - sweep)}
          transform={`rotate(-90 ${ringSize / 2} ${ringSize / 2})`}
        />
      </svg>
      <div
        style={{
          position: 'absolute',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: ringSize * 0.04,
          transform: `scale(${numberScale})`,
        }}
      >
        <span style={{ fontFamily: theme.fonts.display, color: theme.colors.foreground, fontSize: ringSize * 0.28 }}>
          {shown}
        </span>
        <span style={{ fontFamily: theme.fonts.body, color: theme.colors.accent, fontSize: ringSize * 0.1, letterSpacing: 1 }}>
          {label}
        </span>
      </div>
    </AbsoluteFill>
  );
}

// Counts a numeric value up over the first second; passes non-numeric values
// through unchanged. Pure function of the frame, so the render stays
// deterministic.
function formatCountUp(value: string, frame: number): string {
  const match = value.match(/^(\d[\d,]*)(\D*)$/);
  if (!match) return value;
  const target = Number(match[1].replace(/,/g, ''));
  const suffix = match[2];
  const t = Math.min(frame / 30, 1);
  const current = Math.round(target * t);
  return current.toLocaleString() + suffix;
}

// -- Schema + metadata the build step reads to register this primitive. -------

export const propSchema: PropSchema = [
  { name: 'value', type: 'string', state: 'active', required: true, description: 'The headline figure, e.g. "73%".' },
  { name: 'label', type: 'string', state: 'active', required: true, description: 'Short caption beneath the figure.' },
  { name: 'progress', type: 'number', state: 'active', required: true, description: 'Ring fill from 0 to 1.' },
  {
    name: 'animation',
    type: 'enum',
    state: 'active',
    required: true,
    enumValues: ['scale-pop', 'fade', 'count-up'],
    description: 'How the figure enters.',
  },
  // Deprecated: still accepted on old specs, hidden from the AI, with a
  // code-level fallback above. Demonstrates the prop lifecycle (contract 2/3).
  { name: 'thickProgressRing', type: 'boolean', state: 'deprecated', default: false },
];

export const meta: PrimitiveMeta = {
  name: 'KeyStatRing',
  description: 'A statistic inside a circular progress ring, with an animated number and a sweeping ring.',
  version: 2,
};

export default KeyStatRing;
