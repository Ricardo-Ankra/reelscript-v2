// Composition spec — v2 (spec 8.3). The renderer consumes a self-contained spec: a
// baked theme snapshot (spec 8.2), an asset manifest, and scenes of layered
// primitive instances with per-scene voiceover.
//
// DURABILITY (Phase 4 review): the spec exists in two forms with the SAME shape.
//   * Durable record — manifest entries carry `r2Key` only (no `url`). This is the
//     permanent artifact at renders.composition_spec_r2_key; it never expires
//     (spec 7.2: renders preserved indefinitely).
//   * Render-time copy — resolveAssets fills `url` with a signed R2 URL (lifetime >
//     max render, spec 10.3). This ephemeral copy is what Lambda fetches; it is
//     regenerable by re-signing the durable record, so a later re-render never hits
//     a dead URL.
//
// Relative import (not the @/ alias) so the Remotion bundler, which compiles the
// remotion/ entry, can resolve this module without extra webpack alias config.
import type { Theme, PrimitiveInstance } from '../primitives/contract';

export interface CompositionMetadata {
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
}

/** An asset the renderer must fetch: voiceover (Phase 3), or image/video (Phase 5). */
export interface AssetManifestEntry {
  id: string; // referenced by scenes (voiceover) or instance `asset` props (media)
  kind: 'audio' | 'image' | 'video';
  r2Key: string; // durable pointer — the permanent record
  url?: string; // signed R2 URL — present ONLY in the render-time ephemeral copy
  attribution?: string; // stock licensing credit (spec 8.6), for the overlay
}

export interface CompositionScene {
  id: string;
  durationInFrames: number;
  /** Voiceover for this scene; references a manifest asset. Omitted = silent scene. */
  voiceover?: { assetId: string };
  instances: PrimitiveInstance[];
}

export interface CompositionSpec {
  version: 2;
  metadata: CompositionMetadata;
  /** Baked brand snapshot — the renderer reads this, never live channel config. */
  theme: Theme;
  /** Every fetchable asset; the renderer resolves scene refs through this. */
  assets: AssetManifestEntry[];
  scenes: CompositionScene[];
}
