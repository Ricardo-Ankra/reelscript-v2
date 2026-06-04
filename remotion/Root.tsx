import type { FC } from 'react';
import { Composition } from 'remotion';
import { ReelComposition, calculateReelMetadata } from './ReelComposition';

// One composition for Phase 1. Dimensions/duration are placeholders here;
// calculateReelMetadata overrides them from the fetched spec at render start.
export const RemotionRoot: FC = () => {
  return (
    <Composition
      id="Reel"
      component={ReelComposition}
      durationInFrames={150}
      fps={30}
      width={1080}
      height={1920}
      defaultProps={{ specUrl: '' }}
      calculateMetadata={calculateReelMetadata}
    />
  );
};
