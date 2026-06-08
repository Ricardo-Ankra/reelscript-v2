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
