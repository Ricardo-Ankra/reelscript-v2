import type { FC } from 'react';
import { AbsoluteFill, Sequence, type CalculateMetadataFunction } from 'remotion';
import { loadFont } from '@remotion/google-fonts/Poppins';
import { ThemeContext } from '../src/lib/primitives/contract';
import type { CompositionSpec } from '../src/lib/composition/spec';
import { PRIMITIVES } from './primitives/registry';

// Register the brand font before the first frame is drawn (spec 10.4). Remotion's
// google-fonts integration gates rendering on this internally.
loadFont();

export type ReelProps = {
  /** Signed R2 URL to the composition spec JSON (spec-by-pointer, spec 10.2). */
  specUrl: string;
  /** Hydrated by calculateMetadata at render start; not passed by the caller. */
  spec?: CompositionSpec;
};

// Fetch the spec by pointer and derive dimensions/duration from it. This proves
// the empty-render-environment model: Lambda is handed only a URL and fetches
// the rest (spec 10.3).
export const calculateReelMetadata: CalculateMetadataFunction<ReelProps> = async ({
  props,
}) => {
  if (!props.specUrl) {
    // Allows the Remotion Studio to open without a spec.
    return { durationInFrames: 150, fps: 30, width: 1080, height: 1920 };
  }
  const res = await fetch(props.specUrl);
  if (!res.ok) {
    throw new Error(`Failed to fetch composition spec: ${res.status}`);
  }
  const spec = (await res.json()) as CompositionSpec;
  return {
    props: { ...props, spec },
    durationInFrames: spec.metadata.durationInFrames,
    fps: spec.metadata.fps,
    width: spec.metadata.width,
    height: spec.metadata.height,
  };
};

export const ReelComposition: FC<ReelProps> = ({ spec }) => {
  if (!spec) return null;

  // Cumulative start frame of each scene, computed purely (no running mutation).
  const sceneOffsets = spec.scenes.map((_, i) =>
    spec.scenes.slice(0, i).reduce((sum, s) => sum + s.durationInFrames, 0),
  );
  return (
    <ThemeContext.Provider value={spec.theme}>
      <AbsoluteFill style={{ backgroundColor: spec.theme.colors.background }}>
        {spec.scenes.map((scene, sceneIndex) => {
          const from = sceneOffsets[sceneIndex];
          return (
            <Sequence key={scene.id} from={from} durationInFrames={scene.durationInFrames}>
              {scene.instances.map((inst, i) => {
                const Comp = PRIMITIVES[inst.primitive];
                if (!Comp) return null;
                return (
                  <Sequence
                    key={`${scene.id}-${i}`}
                    from={inst.startFrame}
                    durationInFrames={inst.durationInFrames}
                    layout="none"
                  >
                    <div style={{ position: 'absolute', inset: 0, zIndex: inst.layer }}>
                      <Comp {...inst.props} />
                    </div>
                  </Sequence>
                );
              })}
            </Sequence>
          );
        })}
      </AbsoluteFill>
    </ThemeContext.Provider>
  );
};
