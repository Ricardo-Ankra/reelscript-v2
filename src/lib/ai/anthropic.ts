import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import { serverEnv } from '../env.server';

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
export const SCRIPT_MODEL = 'claude-opus-4-8';

// Composition = Sonnet with extended (adaptive) thinking, per the build plan +
// spec 8.7. Pinned until model_routing (Phase 9). Sonnet 4.6 also removed
// budget_tokens — use thinking: {type: 'adaptive'} (no fixed budget). Reliability
// of the emitted JSON comes from the firm prompt + Gate 1's validate-and-retry.
export const COMPOSITION_MODEL = 'claude-sonnet-4-6';

// Primitive drafting = Opus with the primitive skill loaded (spec 3.4 / 9.5). Pinned
// until model_routing (Phase 8). Code generation wants the strongest model.
export const PRIMITIVE_DRAFT_MODEL = 'claude-opus-4-8';
