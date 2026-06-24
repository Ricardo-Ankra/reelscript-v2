import type { FC } from 'react';
import { AbsoluteFill, Audio, OffthreadVideo, Freeze, Sequence, type CalculateMetadataFunction } from 'remotion';
import './brand-fonts'; // loads every brand-allowlisted font (spec 10.4); gates rendering internally
import { ThemeContext, AssetContext, type ResolvedAsset } from '../src/lib/primitives/theme-context';
import type { CompositionSpec } from '../src/lib/composition/spec';
import { PRIMITIVES } from './primitives/registry';
import { AnimatedCaptionTrack } from './AnimatedCaptionTrack';

// Segments are full-frame and occlude primitives within their sub-range (Slice 3a A-lite).
// Composition-level overlays (captions, attribution) render after the scenes, so they stay
// on top regardless of this z-index.
const SEGMENT_LAYER = 10000;

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
  // Manifest lookup: scenes reference voiceover by asset id; the render-time copy
  // carries the signed url (spec 10.3). A durable (key-only) spec has no url, so a
  // scene's audio simply doesn't play if it was never resolved.
  const assetUrl = (assetId: string): string | undefined =>
    spec.assets.find((a) => a.id === assetId)?.url;

  // Map media asset id → { signed url, kind } for the media primitives (Phase 5).
  const assetMap: Record<string, ResolvedAsset> = {};
  for (const a of spec.assets) {
    if (a.url && (a.kind === 'image' || a.kind === 'video')) {
      assetMap[a.id] = { url: a.url, kind: a.kind };
    }
  }
  // Unique attribution credits for the licensing overlay (spec 8.6).
  const attributions = [...new Set(spec.assets.map((a) => a.attribution).filter(Boolean) as string[])];
  const attrFrom = Math.max(0, spec.metadata.durationInFrames - 90);

  return (
    <ThemeContext.Provider value={spec.theme}>
      <AssetContext.Provider value={assetMap}>
        <AbsoluteFill style={{ backgroundColor: spec.theme.colors.background }}>
        {spec.scenes.map((scene, sceneIndex) => {
          const from = sceneOffsets[sceneIndex];
          const voiceUrl = scene.voiceover ? assetUrl(scene.voiceover.assetId) : undefined;
          return (
            <Sequence key={scene.id} from={from} durationInFrames={scene.durationInFrames}>
              {/* Per-scene voiceover; plays from the scene's first frame (spec 8.3). */}
              {voiceUrl && <Audio src={voiceUrl} />}
              {scene.segments?.map((seg) => {
                const url = assetUrl(seg.assetId);
                if (!url) return null; // durable (unsigned) spec ⇒ no playback, like voiceover
                return (
                  <Sequence
                    key={seg.shotId}
                    from={seg.from}
                    durationInFrames={seg.durationInFrames}
                    layout="none"
                  >
                    <div style={{ position: 'absolute', inset: 0, zIndex: SEGMENT_LAYER }}>
                      {/* Muted: VO-first; the per-scene <Audio> owns sound. */}
                      {seg.fit === 'trim' ? (
                        <OffthreadVideo src={url} trimAfter={seg.durationInFrames} muted />
                      ) : (
                        <>
                          <Sequence durationInFrames={seg.sourceDurationInFrames} layout="none">
                            <OffthreadVideo src={url} muted />
                          </Sequence>
                          <Sequence from={seg.sourceDurationInFrames} layout="none">
                            <Freeze frame={seg.sourceDurationInFrames - 1}>
                              <OffthreadVideo src={url} muted />
                            </Freeze>
                          </Sequence>
                        </>
                      )}
                    </div>
                  </Sequence>
                );
              })}
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

        {/* Animated caption track (caption emphasis revision): the single system text
            layer over all scenes — word-by-word reveal with per-word emphasis. */}
        {spec.captions && spec.captions.length > 0 && (
          <AnimatedCaptionTrack
            chunks={spec.captions}
            style={spec.captionStyle}
            emphasisConfig={spec.captionEmphasis}
          />
        )}

        {/* Attribution overlay over the final ~90 frames (spec 8.6). */}
        {attributions.length > 0 && (
          <Sequence from={attrFrom} layout="none">
            <div
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                bottom: '3%',
                textAlign: 'center',
                fontFamily: spec.theme.fonts.body,
                fontSize: 22,
                color: spec.theme.colors.bodyText,
                opacity: 0.85,
                padding: '0 6%',
              }}
            >
              {attributions.join(' · ')}
            </div>
          </Sequence>
        )}
        </AbsoluteFill>
      </AssetContext.Provider>
    </ThemeContext.Provider>
  );
};
