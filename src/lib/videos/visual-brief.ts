// The structured visual brief authored per shot at script time (slice C1).
// Stored snake_case on shots.visual_brief; this is the single source of the shape
// for the editor, the readiness gate, and (slice C2) the resolver router.
export type Specificity = 'generic' | 'entity' | 'abstract' | 'spokesperson';
export type RecommendedSource = 'stock' | 'upload' | 'generate' | 'primitive';

export interface VisualBrief {
  subject: string;
  action: string;
  setting: string;
  framing: string;
  mood: string;
  specificity: Specificity;
  entity_name: string | null;
  recommended_source: RecommendedSource;
}

export const SPECIFICITIES: readonly Specificity[] = [
  'generic',
  'entity',
  'abstract',
  'spokesperson',
];

export const RECOMMENDED_SOURCES: readonly RecommendedSource[] = [
  'stock',
  'upload',
  'generate',
  'primitive',
];

// Normalize a stored/unknown value into a VisualBrief, or null when absent. Never
// throws. Strings default to ''; specificity/recommended_source fall back to the
// first option; entity_name is kept (trimmed) only when specificity === 'entity'.
export function parseVisualBrief(value: unknown): VisualBrief | null {
  if (!value || typeof value !== 'object') return null;
  const o = value as Record<string, unknown>;
  const str = (k: string): string => (typeof o[k] === 'string' ? (o[k] as string) : '');

  const specificity: Specificity = SPECIFICITIES.includes(o.specificity as Specificity)
    ? (o.specificity as Specificity)
    : 'generic';
  const recommended_source: RecommendedSource = RECOMMENDED_SOURCES.includes(
    o.recommended_source as RecommendedSource,
  )
    ? (o.recommended_source as RecommendedSource)
    : 'stock';
  const entityRaw = typeof o.entity_name === 'string' ? (o.entity_name as string).trim() : '';

  return {
    subject: str('subject'),
    action: str('action'),
    setting: str('setting'),
    framing: str('framing'),
    mood: str('mood'),
    specificity,
    entity_name: specificity === 'entity' && entityRaw ? entityRaw : null,
    recommended_source,
  };
}
