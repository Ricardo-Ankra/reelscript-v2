// Pure channel video-defaults parse + validation (Phase 8 — video defaults).
// No react/server/network: reuses the pure AspectRatio/Fps types and the
// target-length bounds. The three format keys live in channels.defaults beside
// the brand editor's keys (captions_on / caption_emphasis_density / music_on);
// this module only ever reads/writes its own three.
import type { AspectRatio, Fps } from '../videos/settings';
import { MIN_TARGET_LENGTH, MAX_TARGET_LENGTH } from '../videos/regenerate';

export interface VideoDefaultsForm {
  aspectRatio: AspectRatio;
  fps: Fps;
  targetLength: number;
}

// Mirror of DEFAULT_VIDEO_CONFIG (9:16 / 30 / 30) — the code defaults shown when
// channels.defaults has none of the three keys.
export const VIDEO_DEFAULTS_FALLBACK: VideoDefaultsForm = {
  aspectRatio: '9:16',
  fps: 30,
  targetLength: 30,
};

const ASPECTS: readonly AspectRatio[] = ['9:16', '1:1', '16:9'];

function isAspect(v: unknown): v is AspectRatio {
  return typeof v === 'string' && (ASPECTS as readonly string[]).includes(v);
}
function isFps(v: unknown): v is Fps {
  return v === 24 || v === 30;
}
function isTargetLength(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= MIN_TARGET_LENGTH && v <= MAX_TARGET_LENGTH;
}

// Build the form from channels.defaults, backfilling the fallback per field.
// Used by the editor and by the creation path (to seed a new video's format).
export function parseVideoDefaults(defaults: unknown): VideoDefaultsForm {
  const o = defaults && typeof defaults === 'object' ? (defaults as Record<string, unknown>) : {};
  return {
    aspectRatio: isAspect(o.aspect_ratio) ? o.aspect_ratio : VIDEO_DEFAULTS_FALLBACK.aspectRatio,
    fps: isFps(o.fps) ? o.fps : VIDEO_DEFAULTS_FALLBACK.fps,
    targetLength: isTargetLength(o.target_length) ? o.target_length : VIDEO_DEFAULTS_FALLBACK.targetLength,
  };
}

// Validate a form submission → the snake_case object to merge into
// channels.defaults.
export function validateVideoDefaultsForm(
  input: unknown,
):
  | { ok: true; value: { aspect_ratio: AspectRatio; fps: Fps; target_length: number } }
  | { ok: false; reason: string } {
  const o = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  if (!isAspect(o.aspectRatio)) return { ok: false, reason: 'Pick a valid aspect ratio.' };
  if (!isFps(o.fps)) return { ok: false, reason: 'Pick a valid frame rate.' };
  if (!isTargetLength(o.targetLength)) {
    return { ok: false, reason: `Target length must be a whole number of seconds, ${MIN_TARGET_LENGTH}–${MAX_TARGET_LENGTH}.` };
  }
  return {
    ok: true,
    value: { aspect_ratio: o.aspectRatio, fps: o.fps, target_length: o.targetLength },
  };
}
