// Composition spec — Phase 1 subset of spec 8.3.
// The renderer consumes a self-contained spec: a baked theme snapshot (spec 8.2)
// plus scenes of layered primitive instances. Audio bindings and the asset
// manifest arrive in later phases (voice, stock).
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

export interface CompositionScene {
  id: string;
  durationInFrames: number;
  instances: PrimitiveInstance[];
}

export interface CompositionSpec {
  version: 1;
  metadata: CompositionMetadata;
  /** Baked brand snapshot — the renderer reads this, never live channel config. */
  theme: Theme;
  scenes: CompositionScene[];
}
