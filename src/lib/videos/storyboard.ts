// Pure label for a storyboard thumbnail (V2 Slice 6a). No react/server/network — unit-tested
// and shared by the loadStoryboard action. A named entity reads best; else the shot
// description; else a generic fallback. Mirrors formatShotHint's label preference.
export function storyboardLabel(brief: { entity_name?: string | null } | null, description: string): string {
  const entity = brief?.entity_name?.trim();
  if (entity) return entity;
  const desc = (description ?? '').trim();
  return desc.length > 0 ? desc : 'Shot';
}
