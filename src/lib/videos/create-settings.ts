// Pure helpers for the video creation seed (Phase 8 — navigation/creation overhaul).
// No react/server/network. The channel ALREADY stores the full option set in
// channels.defaults (format keys via the video-defaults editor; captions/density/
// music via the brand editor), under the same snake_case keys videos.settings uses —
// so parseVideoSettings reads them directly. We add a documented read for prefill and
// a per-video override merge for creation. Unit-tested.
import {
  parseVideoSettings,
  sanitizeSettingsPatch,
  type VideoSettings,
} from './settings';
import { MIN_TARGET_LENGTH, MAX_TARGET_LENGTH } from './regenerate';

// The six creation options == the stored videos.settings shape.
export type CreateOptions = VideoSettings;

// Read the full option set from channels.defaults, backfilling SETTINGS_DEFAULTS per
// missing/invalid key. channels.defaults uses the identical snake_case keys, so this
// reuses parseVideoSettings (DRY).
export function parseChannelCreateOptions(defaults: unknown): CreateOptions {
  return parseVideoSettings(defaults);
}

// Overlay a loosely-typed per-video override onto a base, re-validating every key:
// the five non-length keys via sanitizeSettingsPatch, target_length via the bounds.
// Missing/invalid keys fall back to the base value. Returns the seed.
export function mergeCreateSettings(base: CreateOptions, override: unknown): CreateOptions {
  const patch = sanitizeSettingsPatch(override);
  const o = override && typeof override === 'object' ? (override as Record<string, unknown>) : {};
  const tl = o.target_length;
  const target_length =
    typeof tl === 'number' && Number.isInteger(tl) && tl >= MIN_TARGET_LENGTH && tl <= MAX_TARGET_LENGTH
      ? tl
      : base.target_length;
  return { ...base, ...patch, target_length };
}
