import type { VisualBrief } from './visual-brief';

// Pre-render readiness for a single shot. A shot that depicts a SPECIFIC named
// entity needs an operator-attached asset — stock/generation cannot reliably show
// it (slice C1's fail-forward gate). Everything else is resolvable downstream.
export interface ReadinessInput {
  brief: VisualBrief | null;
  source: string;
  resourceId: string | null;
}

export type Readiness = { resolved: true } | { resolved: false; reason: string };

export function shotReadiness(input: ReadinessInput): Readiness {
  const needsEntityAsset = input.brief?.specificity === 'entity';
  if (!needsEntityAsset) return { resolved: true };

  const hasAsset = input.source === 'resource' && input.resourceId != null;
  if (hasAsset) return { resolved: true };

  const name = input.brief?.entity_name;
  return {
    resolved: false,
    reason: name ? `Needs an asset for "${name}".` : 'Needs an attached asset.',
  };
}
