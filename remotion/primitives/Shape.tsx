import type { FC } from 'react';
import { useTheme } from '../../src/lib/primitives/theme-context';

// Rectangles, lines, accents, backgrounds — the basis of the no-stock graphic
// path (spec 8.9). Colour comes from a theme token.
export const Shape: FC<{
  shape?: 'rect' | 'line';
  colorToken?: 'primary' | 'secondary' | 'accent' | 'foreground';
  xPct?: number;
  yPct?: number;
  widthPct?: number;
  heightPct?: number;
}> = ({
  shape = 'rect',
  colorToken = 'accent',
  xPct = 0,
  yPct = 0,
  widthPct = 100,
  heightPct = 2,
}) => {
  const theme = useTheme();
  return (
    <div
      style={{
        position: 'absolute',
        left: `${xPct}%`,
        top: `${yPct}%`,
        width: `${widthPct}%`,
        height: shape === 'line' ? '4px' : `${heightPct}%`,
        background: theme.colors[colorToken],
      }}
    />
  );
};
