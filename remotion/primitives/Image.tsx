import type { FC } from 'react';
import { Img, interpolate, useCurrentFrame } from 'remotion';
import { useAsset } from '../../src/lib/primitives/theme-context';

// A still image (stock or resource), optionally with a slow Ken-Burns zoom. The
// `asset` prop is a manifest asset id; the signed URL is resolved at render via
// AssetContext (spec 10.3). At layer 0 with fit='cover' this is a full-bleed
// background; over other layers it is an inline image.
export const Image: FC<{
  asset: string;
  fit?: 'cover' | 'contain';
  pan?: boolean;
}> = ({ asset, fit = 'cover', pan = true }) => {
  const resolved = useAsset(asset);
  const frame = useCurrentFrame();
  if (!resolved) return null;
  // Gentle zoom from 1.0 → ~1.08 over ~5s; clamped so longer scenes hold the end.
  const scale = pan ? interpolate(frame, [0, 150], [1, 1.08], { extrapolateRight: 'clamp' }) : 1;
  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
      <Img
        src={resolved.url}
        style={{ width: '100%', height: '100%', objectFit: fit, transform: `scale(${scale})` }}
      />
    </div>
  );
};
