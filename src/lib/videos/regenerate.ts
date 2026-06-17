// Pure payload assembly + input validation for regenerate-in-place (Phase 8). No
// react / server-only / network. The server action (regenerate-actions.ts) is a thin
// wrapper around these + DB/R2/Inngest.
import { parseVideoSettings } from './settings';
import type { VideoConfig, BrandContext } from '../ai/script-generation';

export const MIN_TARGET_LENGTH = 5; // seconds
export const MAX_TARGET_LENGTH = 180; // seconds

// Rebuild the generation config from the video's stored settings, overriding the
// length with the new value (in seconds — the same unit the panel displays).
export function buildGenerateConfig(settings: unknown, targetLengthSeconds: number): VideoConfig {
  const s = parseVideoSettings(settings);
  return {
    aspectRatio: s.aspect_ratio,
    targetLengthSeconds,
    fps: s.fps,
    captions: s.captions_on,
    music: s.music_on,
  };
}

// Brand context from the video's channel row. The channel + its name are REQUIRED;
// the action guarantees a loaded channel with a string name before calling, so there
// is NO fabricated fallback name (a wrong-but-plausible name would silently generate
// off-brand). Only the tone is optional.
export function buildBrandContext(channel: { name: string; brand_voice?: unknown }): BrandContext {
  const tone = (channel.brand_voice as { tone?: unknown } | null)?.tone;
  return typeof tone === 'string' && tone
    ? { channelName: channel.name, tone }
    : { channelName: channel.name };
}

export function validateRegenerateInput(input: {
  prompt?: unknown;
  targetLengthSeconds?: unknown;
}): { ok: true; value: { prompt: string; targetLengthSeconds: number } } | { ok: false; reason: string } {
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  if (!prompt) return { ok: false, reason: 'Enter a prompt.' };
  const n = input.targetLengthSeconds;
  if (
    typeof n !== 'number' ||
    !Number.isInteger(n) ||
    n < MIN_TARGET_LENGTH ||
    n > MAX_TARGET_LENGTH
  ) {
    return { ok: false, reason: `Length must be ${MIN_TARGET_LENGTH}–${MAX_TARGET_LENGTH} seconds.` };
  }
  return { ok: true, value: { prompt, targetLengthSeconds: n } };
}
