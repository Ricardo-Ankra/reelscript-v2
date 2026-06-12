import type { FC } from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { useTheme } from '../../src/lib/primitives/theme-context';
import { KINETIC_CENTER_TOP_PCT, KINETIC_UPPER_TOP_PCT, withAlpha } from '../layout';

// Kinetic text (spec 4.2.2 / 8.4): a large, animated, brand-styled emphasis word
// frame-aligned to the voiceover. Reads colour + Display font from the theme and
// animates from useCurrentFrame() (never wall-clock), per the primitive contract.
//
// CLOSED animation enum — bounce | pop, the only two in V1. Neither overshoots
// scale 1, so the settled frame IS the max-scale frame: the legibility plate (a
// brand-tinted scrim with stroke + shadow) wraps the text inside the SAME scaled
// container, so it always sizes to the word's largest frame and never clips.
//
// Position is upper | center only — the lower third is the captions' band, so
// kinetic text is structurally forbidden from colliding with captions.
export const KineticText: FC<{
  text: string;
  animation?: 'bounce' | 'pop';
  position?: 'upper' | 'center';
  accentToken?: 'background' | 'foreground' | 'primary' | 'secondary' | 'accent' | 'bodyText';
  fontSizePx?: number;
}> = ({ text, animation = 'pop', position = 'center', accentToken = 'accent', fontSizePx = 150 }) => {
  const theme = useTheme();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const s = spring({ frame, fps, config: { damping: 14, stiffness: 120, mass: 0.6 } }); // 0..1
  const opacity = interpolate(frame, [0, 6], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  // bounce drops in from above; pop scales up. Neither exceeds the settled size.
  const transform =
    animation === 'bounce'
      ? `translateY(${interpolate(s, [0, 1], [-0.35, 0])}em)`
      : `scale(${interpolate(s, [0, 1], [0.6, 1])})`;

  const topPct = position === 'upper' ? KINETIC_UPPER_TOP_PCT : KINETIC_CENTER_TOP_PCT;
  const stroke = Math.max(2, Math.round(fontSizePx * 0.012));

  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        top: `${topPct}%`,
        display: 'flex',
        justifyContent: 'center',
        opacity,
      }}
    >
      <div style={{ transform, transformOrigin: 'center', display: 'inline-flex' }}>
        <span
          style={{
            fontFamily: theme.fonts.display,
            color: theme.colors[accentToken],
            fontSize: fontSizePx,
            fontWeight: 800,
            lineHeight: 1.05,
            textAlign: 'center',
            whiteSpace: 'pre',
            padding: '0.1em 0.28em',
            // legibility bake (system, not authored): brand-tinted scrim + stroke + shadow.
            background: withAlpha(theme.colors.background, 0.42),
            borderRadius: '0.12em',
            WebkitTextStroke: `${stroke}px ${withAlpha('#000000', 0.85)}`,
            textShadow: '0 4px 18px rgba(0,0,0,0.55)',
          }}
        >
          {text}
        </span>
      </div>
    </div>
  );
};
