import type { FC } from 'react';
import { AbsoluteFill } from 'remotion';
import { useTheme } from '../../src/lib/primitives/contract';

// Full-bleed background. In later phases it backs an image/video; in Phase 1
// (no stock) it is a solid brand colour from a theme token.
export const FullBleed: FC<{
  colorToken?: 'background' | 'primary' | 'secondary';
}> = ({ colorToken = 'background' }) => {
  const theme = useTheme();
  return <AbsoluteFill style={{ background: theme.colors[colorToken] }} />;
};
