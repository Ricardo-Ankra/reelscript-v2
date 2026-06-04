import type { FC } from 'react';
import { interpolate, useCurrentFrame } from 'remotion';
import { useTheme } from '../../src/lib/primitives/contract';

// Titles and labels. Reads colour + font from the theme (never literals), and
// animates from useCurrentFrame() (never wall-clock), per the primitive contract.
export const Text: FC<{
  text: string;
  colorToken?: 'foreground' | 'primary' | 'secondary' | 'accent' | 'bodyText';
  fontSizePx?: number;
  align?: 'left' | 'center' | 'right';
}> = ({ text, colorToken = 'foreground', fontSizePx = 96, align = 'center' }) => {
  const theme = useTheme();
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 15], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent:
          align === 'center' ? 'center' : align === 'left' ? 'flex-start' : 'flex-end',
        padding: '8%',
        opacity,
      }}
    >
      <span
        style={{
          fontFamily: theme.fonts.display,
          color: theme.colors[colorToken],
          fontSize: fontSizePx,
          fontWeight: 700,
          lineHeight: 1.1,
          textAlign: align,
        }}
      >
        {text}
      </span>
    </div>
  );
};
