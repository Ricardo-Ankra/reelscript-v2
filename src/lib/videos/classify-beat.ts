import type { Specificity, RecommendedSource } from './visual-brief';
import type { ShotKind } from './cinematography';

// Derive a shot's source class deterministically from the authored visual brief.
// kind is an auditable pure function of (specificity, recommendedSource) — never an
// LLM freeform choice. The authenticity test wins: a specific named entity must be
// real footage (live_action), regardless of what was recommended.
export function classifyBeat(
  specificity: Specificity,
  recommendedSource: RecommendedSource,
): ShotKind {
  if (specificity === 'entity') return 'live_action';
  if (recommendedSource === 'primitive') return 'motion_graphic';
  if (recommendedSource === 'generate') return 'generative';
  return 'live_action'; // 'stock' | 'upload'
}
