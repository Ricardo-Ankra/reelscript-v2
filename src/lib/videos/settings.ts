// Pure video-settings contract (Phase 8 — video settings panel). Validates a patch
// from the UI and parses the stored settings JSON into typed values with defaults.
// No react / server-only / network — unit-tested, shared by the panel + the action.

import { type ColorLook, COLOR_LOOKS, DEFAULT_COLOR_LOOK } from '../color/looks';

export type CaptionEmphasisDensity = 'off' | 'sparing' | 'liberal';
export type AspectRatio = '9:16' | '1:1' | '16:9';
export type Fps = 24 | 30; // literal union — 24 (cinematic) / 30 (standard social)

export interface VideoSettingsPatch {
  captions_on?: boolean;
  caption_emphasis_density?: CaptionEmphasisDensity;
  music_on?: boolean;
  aspect_ratio?: AspectRatio;
  fps?: Fps;
  color_look?: ColorLook;
  // target_length intentionally not patchable in this slice
}

export interface VideoSettings {
  captions_on: boolean;
  caption_emphasis_density: CaptionEmphasisDensity;
  music_on: boolean;
  aspect_ratio: AspectRatio;
  fps: Fps;
  color_look: ColorLook;
  target_length: number; // read-only in this slice
}

export const SETTINGS_DEFAULTS: VideoSettings = {
  captions_on: true,
  caption_emphasis_density: 'sparing',
  music_on: false,
  aspect_ratio: '9:16',
  fps: 30,
  color_look: DEFAULT_COLOR_LOOK,
  target_length: 30,
};

const DENSITIES: readonly CaptionEmphasisDensity[] = ['off', 'sparing', 'liberal'];
const ASPECTS: readonly AspectRatio[] = ['9:16', '1:1', '16:9'];
const FPSES: readonly Fps[] = [24, 30];

// Keep only known keys whose values are in the allowed set; drop everything else.
export function sanitizeSettingsPatch(patch: unknown): VideoSettingsPatch {
  const out: VideoSettingsPatch = {};
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return out;
  const p = patch as Record<string, unknown>;
  if (typeof p.captions_on === 'boolean') out.captions_on = p.captions_on;
  if (typeof p.music_on === 'boolean') out.music_on = p.music_on;
  if (DENSITIES.includes(p.caption_emphasis_density as CaptionEmphasisDensity)) {
    out.caption_emphasis_density = p.caption_emphasis_density as CaptionEmphasisDensity;
  }
  if (ASPECTS.includes(p.aspect_ratio as AspectRatio)) {
    out.aspect_ratio = p.aspect_ratio as AspectRatio;
  }
  if (FPSES.includes(p.fps as Fps)) out.fps = p.fps as Fps;
  if (COLOR_LOOKS.includes(p.color_look as ColorLook)) out.color_look = p.color_look as ColorLook;
  return out;
}

// Parse stored settings JSON into typed values, backfilling defaults for missing or
// invalid keys. Reuses sanitizeSettingsPatch for the patchable keys (DRY).
export function parseVideoSettings(raw: unknown): VideoSettings {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const clean = sanitizeSettingsPatch(p);
  const target_length =
    typeof p.target_length === 'number' && p.target_length > 0
      ? p.target_length
      : SETTINGS_DEFAULTS.target_length;
  return { ...SETTINGS_DEFAULTS, ...clean, target_length };
}
