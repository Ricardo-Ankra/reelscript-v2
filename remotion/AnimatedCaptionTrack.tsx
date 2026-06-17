import type { FC } from 'react';
import { useCurrentFrame, useVideoConfig } from 'remotion';
import { useTheme } from '../src/lib/primitives/theme-context';
import type { Theme } from '../src/lib/primitives/contract';
import type { CaptionChunk, CaptionWord } from '../src/lib/captions/types';
import type { CaptionStyle } from '../src/lib/captions/segments';
import { findActiveChunk, entranceProgress, resolveFocusPlacement } from '../src/lib/captions/caption-render';
import { applyEffect, type EffectLayer } from '../src/lib/captions/effects';
import {
  resolveWordStyle,
  type CaptionEmphasisConfig,
} from '../src/lib/captions/emphasis-style';
import { withAlpha } from './layout';

// DOAC-style animated caption track (caption emphasis revision, 2026-06-16) — the
// single text layer that replaces the old caption track + KineticText. For the
// active chunk it builds the words up one at a time as they are spoken; each word
// animates in (a soft fade-up, or its emphasis EFFECT) and carries its resolved
// role typography + tone colour.
//
// Layout is relative (% band, em-relative sizing, no hardcoded dimensions) so it
// holds at the tightest 9:16 width and adapts to other aspect ratios. The
// legibility bake (a dark stroke + shadow on every glyph, optional brand-tinted
// scrim) is what keeps the brand tone colour readable over arbitrary footage —
// applied to every word regardless of colour, so low-contrast tones never go bare.

const ENTRANCE_SECONDS = 0.35;

export const AnimatedCaptionTrack: FC<{
  chunks: CaptionChunk[];
  style?: CaptionStyle;
  emphasisConfig?: CaptionEmphasisConfig;
}> = ({ chunks, style, emphasisConfig }) => {
  const theme = useTheme();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const active = findActiveChunk(chunks, frame);
  if (!active) return null;

  const atTop = style?.position === 'top';
  // Per-scene focus → vertical band + size scale (caption emphasis revision addendum).
  const placement = resolveFocusPlacement(active.focus);
  const baseFont = (style?.fontSizePx ?? 64) * placement.sizeScale;
  const showScrim = style?.background === true; // opt-in; stroke+shadow is the default bake
  const entranceFrames = Math.round(ENTRANCE_SECONDS * fps);

  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        top: 0,
        bottom: 0,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: atTop ? 'flex-start' : placement.justify,
        alignItems: 'center',
        padding: '0 7%',
        paddingTop: atTop ? '9%' : undefined,
        paddingBottom: atTop ? undefined : `${placement.paddingBottomPct}%`,
      }}
    >
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'center',
          alignItems: 'flex-end',
          gap: '0.12em 0.32em',
          maxWidth: '100%',
        }}
      >
        {active.words.map((word, i) =>
          frame < word.fromFrame ? null : (
            <Word
              key={i}
              word={word}
              t={entranceProgress(word.fromFrame, frame, entranceFrames)}
              baseFont={baseFont}
              showScrim={showScrim}
              scrim={withAlpha(theme.colors.background, 0.5)}
              theme={theme}
              config={emphasisConfig}
            />
          ),
        )}
      </div>
    </div>
  );
};

// Non-emphasis (and emphasis-without-effect) words use a soft fade-up; only an
// explicit effect drives the registry animation. Settles to identity at t=1.
const softFadeUp = (t: number): EffectLayer[] =>
  t >= 1 ? [{ opacity: 1 }] : [{ transform: `translateY(${10 * (1 - t)}px)`, opacity: Math.min(1, t * 2) }];

const Word: FC<{
  word: CaptionWord;
  t: number;
  baseFont: number;
  showScrim: boolean;
  scrim: string;
  theme: Theme;
  config?: CaptionEmphasisConfig;
}> = ({ word, t, baseFont, showScrim, scrim, theme, config }) => {
  const ws = resolveWordStyle(word.emphasis, theme, config);
  const layers = word.emphasis?.effect ? applyEffect(word.emphasis.effect, t) : softFadeUp(t);
  const fontSize = Math.round(baseFont * ws.sizeMultiplier);
  const stroke = Math.max(1, Math.round(fontSize * 0.02));

  return (
    <span style={{ position: 'relative', display: 'inline-block' }}>
      {layers.map((layer, li) => (
        <span
          key={li}
          style={{
            // First layer establishes the box; extra layers (e.g. shatter halves)
            // stack over it so the word keeps a single layout footprint.
            position: li === 0 ? 'relative' : 'absolute',
            left: li === 0 ? undefined : 0,
            top: li === 0 ? undefined : 0,
            right: li === 0 ? undefined : 0,
            display: 'inline-block',
            fontFamily: ws.fontFamily,
            color: ws.color,
            fontSize,
            fontWeight: ws.fontWeight,
            fontStyle: ws.italic ? 'italic' : 'normal',
            lineHeight: 1.1,
            whiteSpace: 'pre',
            transform: layer.transform,
            transformOrigin: 'center',
            opacity: layer.opacity,
            clipPath: layer.clipPath,
            // Legibility bake — every glyph, regardless of tone colour.
            WebkitTextStroke: `${stroke}px ${withAlpha('#000000', 0.9)}`,
            textShadow: '0 2px 12px rgba(0,0,0,0.6)',
            ...(showScrim
              ? { background: scrim, borderRadius: '0.12em', padding: '0 0.08em' }
              : {}),
          }}
        >
          {word.text}
        </span>
      ))}
    </span>
  );
};
