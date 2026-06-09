import { createHash } from 'node:crypto';
import type { CompositionSpec } from './spec';

// Deterministic render idempotency key (spec 10.5). Phase 1 hashes the spec
// alone — there is no real script revision yet — so re-submitting the same spec
// returns the existing render instead of paying for a duplicate. Later phases
// fold the script_revision_id into the key.
export function specIdempotencyKey(spec: CompositionSpec): string {
  return createHash('sha256').update(JSON.stringify(spec)).digest('hex');
}

// Phase 4 render idempotency (spec 10.5, adapted): the composition is
// non-deterministic so the spec isn't known at kickoff — key on the immutable
// script_revision instead (it captures the committed scene state). Reuse is scoped
// to in-flight renders, so an explicit re-render of the same revision still makes a
// new preserved version (spec 7.2).
export function renderIdempotencyKey(revisionId: string): string {
  return createHash('sha256').update(`revision:${revisionId}`).digest('hex');
}
