// Authoring-time emphasis coherence validator (caption emphasis revision,
// 2026-06-16). Runs after the Haiku emphasis pass and BEFORE annotations reach
// the caption chunks — it never reaches the renderer with incoherent data.
//
// The constants here are the SHARED source of truth: the validator enforces
// them and the Haiku prompt (emphasis pass, step 6) documents the same values,
// so prompt guidance and validation cannot drift.
//
// The validator never throws; it degrades a word toward role+tone, then toward
// normal (dropped), rather than failing the pass.
//
// Pure (no react, no server-only, no network).
import {
  EMPHASIS_ROLES,
  EMPHASIS_TONES,
  EMPHASIS_EFFECTS,
  type EmphasisRole,
  type EmphasisTone,
  type EmphasisEffect,
  type WordEmphasis,
} from './types';

// At most ~1/3 of emphasized words may carry an effect. effect is the rare axis.
export const EMPHASIS_EFFECT_CEILING = 1 / 3;

// Each effect's inherent valence forbids the contradictory tone. neutral is
// coherent with every effect; pop and zoom are valence-free (coherent with any
// tone). This is the full initial map the validator and its test share.
export const INCOHERENT_TONE_EFFECT: Record<EmphasisEffect, EmphasisTone[]> = {
  pop: [],
  zoom: [],
  rise: ['negative'], // up / growth
  topple: ['positive'], // fall / collapse
  shatter: ['positive'], // break apart
  glitch: ['positive'], // malfunction / fake
  shake: ['positive'], // alarm / instability
};

// Which words keep their effect when the ceiling is exceeded: higher rank wins.
const ROLE_RANK: Record<EmphasisRole, number> = {
  shout: 3,
  number: 2,
  key: 1,
  contrast: 0,
};

const isRole = (v: unknown): v is EmphasisRole => EMPHASIS_ROLES.includes(v as EmphasisRole);
const isTone = (v: unknown): v is EmphasisTone => EMPHASIS_TONES.includes(v as EmphasisTone);
const isEffect = (v: unknown): v is EmphasisEffect =>
  EMPHASIS_EFFECTS.includes(v as EmphasisEffect);

export function validateEmphasisCoherence(
  raw: WordEmphasis[],
  tokenCount: number,
): WordEmphasis[] {
  const seen = new Set<number>();
  const cleaned: WordEmphasis[] = [];

  // 1) Validate indices + enums; dedupe by index (first valid wins).
  for (const entry of raw ?? []) {
    const index = entry?.index;
    if (!Number.isInteger(index) || index < 0 || index >= tokenCount) continue;
    if (seen.has(index)) continue;
    if (!isRole(entry.role)) continue; // no emphasis without a valid role
    seen.add(index);
    const next: WordEmphasis = { index, role: entry.role };
    if (isTone(entry.tone)) next.tone = entry.tone;
    if (isEffect(entry.effect)) next.effect = entry.effect;
    cleaned.push(next);
  }

  // 2) Strip incoherent tone↔effect pairings (keep role + tone).
  for (const entry of cleaned) {
    if (entry.effect && entry.tone) {
      const forbidden = INCOHERENT_TONE_EFFECT[entry.effect] ?? [];
      if (forbidden.includes(entry.tone)) delete entry.effect;
    }
  }

  // 3) Enforce the effect ceiling: keep effects on the highest-role words.
  const maxEffects = Math.max(1, Math.round(cleaned.length * EMPHASIS_EFFECT_CEILING));
  const withEffect = cleaned.filter((e) => e.effect);
  if (withEffect.length > maxEffects) {
    const keep = new Set(
      withEffect
        .slice()
        .sort((a, b) => ROLE_RANK[b.role] - ROLE_RANK[a.role] || a.index - b.index)
        .slice(0, maxEffects),
    );
    for (const entry of withEffect) {
      if (!keep.has(entry)) delete entry.effect;
    }
  }

  return cleaned;
}
