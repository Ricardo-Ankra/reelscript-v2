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
import type { CaptionStyle } from '../captions/segments';
import type { CaptionChunk, CaptionFocus } from '../captions/types';
import type { CaptionEmphasisConfig } from '../captions/emphasis-style';

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

/**
 * One clip/footage shot placed on the timeline (Slice 3a). The shot's allotted span
 * (`from`/`durationInFrames`) tiles its scene; `assetId` points at a kind:'video' manifest
 * entry (the resolved clip_key/footage_key). `fit` is precomputed in loadBrief so the
 * renderer stays declarative: 'trim' = clip ≥ allotted (trimAfter to fit); 'freeze' = clip
 * < allotted (play fully, then hold the last source frame). `sourceDurationInFrames` is the
 * clip's native length, used to split the freeze.
 */
export interface ShotSegment {
  shotId: string;
  from: number; // start frame within the scene (0 = scene start)
  durationInFrames: number; // allotted span
  assetId: string; // a kind:'video' manifest entry
  fit: 'trim' | 'freeze';
  sourceDurationInFrames: number;
}

export interface CompositionScene {
  id: string;
  durationInFrames: number;
  /** Voiceover for this scene; references a manifest asset. Omitted = silent scene. */
  voiceover?: { assetId: string };
  /** Per-scene caption focus (AI-emitted): drives the caption band + size for this
   *  scene's captions. Omitted ⇒ 'balanced'. */
  captionFocus?: CaptionFocus;
  instances: PrimitiveInstance[];
  /** Clip/footage shot segments tiling this scene (Slice 3a). Absent/empty ⇒ legacy
   *  primitive-only render. Rendered full-frame above primitives. */
  segments?: ShotSegment[];
}

export interface CompositionSpec {
  version: 2;
  metadata: CompositionMetadata;
  /** Baked brand snapshot — the renderer reads this, never live channel config. */
  theme: Theme;
  /** Every fetchable asset; the renderer resolves scene refs through this. */
  assets: AssetManifestEntry[];
  scenes: CompositionScene[];
  /**
   * Burnt-in animated caption track (caption emphasis revision, 2026-06-16).
   * SYSTEM-built from the word timings (one tokenizer → chunkWords) with per-word
   * emphasis from the Haiku pass; NOT authored by the composition AI. The single
   * text layer — there is no separate kinetic track. Absent/empty = captions off.
   * Music is deliberately NOT in the spec: the render is voiceover-only; the ffmpeg
   * re-mux owns music (10.1).
   */
  captions?: CaptionChunk[];
  /** Baked caption style (position/size/legibility) from brand_kit.caption_style. */
  captionStyle?: CaptionStyle;
  /** Baked emphasis brand tables (role typography + tone colour) from
   *  brand_kit.caption_emphasis. Absent ⇒ the renderer uses the defaults. */
  captionEmphasis?: CaptionEmphasisConfig;
}
