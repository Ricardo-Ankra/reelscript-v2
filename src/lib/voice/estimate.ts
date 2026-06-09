// Cost estimation for voice synthesis (spec 6.4: a cost estimate is shown before
// each synthesis action). ElevenLabs bills per character; the spec's cost shape
// (13.7) puts narration at ~$0.30/min, which is ~$0.30 per ~1000 characters of
// speech. This is a deliberate UPPER-BOUND preview computed from the raw narration
// length (pre-fallback). The ledger (cost_events) records the ACTUAL post-fallback
// characters sent, so the estimate and the ledger are not expected to match exactly
// — the estimate over-counts by any stripped tags, never under-counts.
export const USD_PER_1K_CHARS = 0.3;

export function countCharacters(narration: string): number {
  return narration.length;
}

export function estimateUsd(characters: number): number {
  return (characters / 1000) * USD_PER_1K_CHARS;
}

// Sum the raw narration characters across the scenes that will be synthesized, and
// the matching dollar estimate. Pre-fallback by design (see note above).
export function estimateSynthesisCost(narrations: string[]): {
  characters: number;
  estimatedUsd: number;
} {
  const characters = narrations.reduce((sum, n) => sum + countCharacters(n), 0);
  return { characters, estimatedUsd: estimateUsd(characters) };
}
