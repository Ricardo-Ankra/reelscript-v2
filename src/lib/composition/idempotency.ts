import { createHash } from 'node:crypto';
import type { CompositionSpec } from './spec';

// Deterministic render idempotency key (spec 10.5). Phase 1 hashes the spec
// alone — there is no real script revision yet — so re-submitting the same spec
// returns the existing render instead of paying for a duplicate. Later phases
// fold the script_revision_id into the key.
export function specIdempotencyKey(spec: CompositionSpec): string {
  return createHash('sha256').update(JSON.stringify(spec)).digest('hex');
}
