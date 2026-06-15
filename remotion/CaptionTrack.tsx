import type { FC } from 'react';
import { useCurrentFrame } from 'remotion';
import { useTheme } from '../src/lib/primitives/theme-context';
import type { CaptionSegment, CaptionStyle } from '../src/lib/captions/segments';
import { CAPTION_BAND_TOP_PCT, withAlpha } from './layout';

// Burnt-in caption renderer (Phase 6, spec 4.2.1 / 8.5). Draws the single active
// caption segment for the current frame in the reserved lower-third band. System
// layer — the segments are built deterministically from word timings, not by the
// composition AI, and already suppressed during kinetic spans upstream.
//
// Legibility bake (system, not authored): caption text uses the brand FOREGROUND
// over a BACKGROUND-tinted scrim — a pair a brand kit defines to contrast — plus a
// stroke + shadow, so it stays readable over arbitrary stock footage.
export const CaptionTrack: FC<{ segments: CaptionSegment[]; style?: CaptionStyle }> = ({
  segments,
  style,
}) => {
  const theme = useTheme();
  const frame = useCurrentFrame();
  const active = segments.find((s) => frame >= s.fromFrame && frame < s.toFrame);
  if (!active) return null;

  const fontSize = style?.fontSizePx ?? 48;
  const atTop = style?.position === 'top';
  const showScrim = style?.background !== false;
  const showOutline = style?.outline !== false;
  const stroke = Math.max(1, Math.round(fontSize * 0.02));

  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        ...(atTop ? { top: '6%' } : { top: `${CAPTION_BAND_TOP_PCT}%`, bottom: '5%' }),
        display: 'flex',
        justifyContent: 'center',
        alignItems: atTop ? 'flex-start' : 'flex-end',
        padding: '0 6%',
      }}
    >
      <span
        style={{
          fontFamily: theme.fonts.body,
          color: theme.colors.foreground,
          fontSize,
          fontWeight: 700,
          lineHeight: 1.2,
          textAlign: 'center',
          padding: '0.18em 0.5em',
          background: showScrim ? withAlpha(theme.colors.background, 0.6) : 'transparent',
          borderRadius: '0.18em',
          ...(showOutline ? { WebkitTextStroke: `${stroke}px ${withAlpha('#000000', 0.9)}` } : {}),
          textShadow: '0 2px 10px rgba(0,0,0,0.6)',
        }}
      >
        {active.text}
      </span>
    </div>
  );
};
