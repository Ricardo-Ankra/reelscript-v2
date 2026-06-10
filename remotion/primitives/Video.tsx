import type { FC } from 'react';
import { OffthreadVideo, useVideoConfig } from 'remotion';
import { useAsset } from '../../src/lib/primitives/theme-context';

// A trimmed video clip (stock or resource). `asset` is a manifest asset id resolved
// to a signed URL via AssetContext. Muted by default (the voiceover is the audio);
// fit cover at layer 0 makes a full-bleed moving background. trimStartSec trims from
// the source start so different scenes can sample different moments.
export const Video: FC<{
  asset: string;
  fit?: 'cover' | 'contain';
  mute?: boolean;
  trimStartSec?: number;
}> = ({ asset, fit = 'cover', mute = true, trimStartSec = 0 }) => {
  const resolved = useAsset(asset);
  const { fps } = useVideoConfig();
  if (!resolved) return null;
  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
      <OffthreadVideo
        src={resolved.url}
        muted={mute}
        startFrom={Math.max(0, Math.round(trimStartSec * fps))}
        style={{ width: '100%', height: '100%', objectFit: fit }}
      />
    </div>
  );
};
