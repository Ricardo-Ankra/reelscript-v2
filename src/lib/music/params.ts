import { createHash } from 'node:crypto';

// Music mix parameters (Phase 6, spec 6.6). The full set the remux accepts; only a
// subset has UI in Phase 6 (reroll + master volume), the rest carry defaults until
// the Phase-8 panel. These are stored on renders.music_params and consumed by the
// ffmpeg Lambda.
export interface MusicParams {
  masterVolume: number; // 0..1 — bed level under the voiceover
  duckingDepth: number; // 0..1 — how hard music ducks under speech
  loop: boolean; // loop the bed to the video length if it's shorter
  cropStartSec: number; // in-point into the source track
  fadeInSec: number;
  fadeOutSec: number;
}

export const DEFAULT_MUSIC_PARAMS: MusicParams = {
  masterVolume: 0.18,
  duckingDepth: 0.6,
  loop: true,
  cropStartSec: 0,
  fadeInSec: 0.5,
  fadeOutSec: 1.0,
};

// Clamp + round so cosmetically-different inputs (0.2 vs 0.20000001, out-of-range
// sliders) normalize to the same canonical value — the basis of a stable cache key.
function num(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  const clamped = Math.min(max, Math.max(min, n));
  // 3-decimal precision; +0 to kill any -0 so JSON is identical.
  return Math.round(clamped * 1000) / 1000 + 0;
}

// Fill defaults and normalize every field. Always returns a fully-populated, range-
// checked MusicParams regardless of how partial/sloppy the input was.
export function canonicalizeMusicParams(input: Partial<MusicParams> | null | undefined): MusicParams {
  const p = input ?? {};
  return {
    masterVolume: num(p.masterVolume, DEFAULT_MUSIC_PARAMS.masterVolume, 0, 1),
    duckingDepth: num(p.duckingDepth, DEFAULT_MUSIC_PARAMS.duckingDepth, 0, 1),
    loop: typeof p.loop === 'boolean' ? p.loop : DEFAULT_MUSIC_PARAMS.loop,
    cropStartSec: num(p.cropStartSec, DEFAULT_MUSIC_PARAMS.cropStartSec, 0, 3600),
    fadeInSec: num(p.fadeInSec, DEFAULT_MUSIC_PARAMS.fadeInSec, 0, 30),
    fadeOutSec: num(p.fadeOutSec, DEFAULT_MUSIC_PARAMS.fadeOutSec, 0, 30),
  };
}

// Canonical JSON: defaults applied, fixed key order, normalized numbers. Two
// semantically-identical param sets serialize identically → identical hash.
export function canonicalMusicJson(input: Partial<MusicParams> | null | undefined): string {
  const c = canonicalizeMusicParams(input);
  // Explicit key order (don't rely on insertion order across call sites).
  return JSON.stringify([
    ['cropStartSec', c.cropStartSec],
    ['duckingDepth', c.duckingDepth],
    ['fadeInSec', c.fadeInSec],
    ['fadeOutSec', c.fadeOutSec],
    ['loop', c.loop],
    ['masterVolume', c.masterVolume],
  ]);
}

// Remux idempotency key (design §Remux trigger): identical (base video, track, mix)
// → identical key, so a no-op re-save hits the cache instead of re-muxing. Params are
// canonicalized first so cosmetic differences don't miss the cache.
export function remuxIdempotencyKey(
  baseKey: string,
  trackId: string,
  params: Partial<MusicParams> | null | undefined,
): string {
  return createHash('sha256')
    .update(`${baseKey}|${trackId}|${canonicalMusicJson(params)}`)
    .digest('hex');
}
