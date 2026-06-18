import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import { serverEnv } from '../env.server';
import { DEFAULT_MODELS } from './model-routing';

// Server-only Anthropic client. Cached across invocations in the same worker.
let cached: Anthropic | null = null;
export function anthropic(): Anthropic {
  if (cached) return cached;
  cached = new Anthropic({ apiKey: serverEnv.anthropic.apiKey });
  return cached;
}

// Latest Opus, per the build plan (script generation = Opus). Pinned here until
// model_routing is wired (Phase 9). Opus 4.8 removed temperature/top_p/top_k, so
// NDJSON reliability comes from the prompt + per-line validation, not sampling.
export const SCRIPT_MODEL = DEFAULT_MODELS.script_generation;

// Composition = Sonnet with extended (adaptive) thinking, per the build plan +
// spec 8.7. Pinned until model_routing (Phase 9). Sonnet 4.6 also removed
// budget_tokens — use thinking: {type: 'adaptive'} (no fixed budget). Reliability
// of the emitted JSON comes from the firm prompt + Gate 1's validate-and-retry.
export const COMPOSITION_MODEL = DEFAULT_MODELS.video_composition;

// Primitive drafting = Opus with the primitive skill loaded (spec 3.4 / 9.5). Pinned
// until model_routing (Phase 8). Code generation wants the strongest model.
export const PRIMITIVE_DRAFT_MODEL = DEFAULT_MODELS.primitive_drafting;

// Caption emphasis pass = Haiku (caption emphasis revision, 2026-06-16). A small,
// cheap, per-scene classification (pick emphasis words + label axes), pinned here
// until model_routing (Phase 8). Reliability comes from the firm prompt + the
// coherence validator; a bad/missing pass degrades to no emphasis, never an error.
export const EMPHASIS_MODEL = DEFAULT_MODELS.caption_emphasis;
