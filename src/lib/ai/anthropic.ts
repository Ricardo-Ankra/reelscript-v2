import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import { serverEnv } from '../env.server';
import { DEFAULT_MODELS } from './model-routing';

// Server-only Anthropic client. Cached across invocations in the same worker.
let cached: Anthropic | null = null;
// Returns the env-keyed cached client by default. When an explicit apiKey is given
// (an account's stored credential), returns a fresh UNCACHED client for that key —
// never caching a per-account key into the shared singleton.
export function anthropic(apiKey?: string): Anthropic {
  if (apiKey) return new Anthropic({ apiKey });
  if (cached) return cached;
  cached = new Anthropic({ apiKey: serverEnv.anthropic.apiKey });
  return cached;
}

// The CODE DEFAULTS, now sourced from DEFAULT_MODELS (the single source of truth
// model_routing also reads). These are the values used when an account has no
// per-task override; the operator can re-route any task on /settings. Default for
// script generation = Opus (build plan). Opus 4.8 removed temperature/top_p/top_k,
// so NDJSON reliability comes from the prompt + per-line validation, not sampling.
export const SCRIPT_MODEL = DEFAULT_MODELS.script_generation;

// Composition default = Sonnet with extended (adaptive) thinking (build plan +
// spec 8.7). Sonnet 4.6 removed budget_tokens — use thinking: {type: 'adaptive'}
// (no fixed budget). Reliability of the emitted JSON comes from the firm prompt +
// Gate 1's validate-and-retry. Also the default for the vision QA calls that
// follow composition. Still used as the gates.ts fallback (effect-gate path).
export const COMPOSITION_MODEL = DEFAULT_MODELS.video_composition;

// Primitive drafting default = Opus with the primitive skill loaded (spec 3.4 /
// 9.5). Code generation wants the strongest model.
export const PRIMITIVE_DRAFT_MODEL = DEFAULT_MODELS.primitive_drafting;

// Caption emphasis default = Haiku (caption emphasis revision, 2026-06-16). A
// small, cheap, per-scene classification (pick emphasis words + label axes).
// Reliability comes from the firm prompt + the coherence validator; a bad/missing
// pass degrades to no emphasis, never an error.
export const EMPHASIS_MODEL = DEFAULT_MODELS.caption_emphasis;
