// Pure normalization of a shot's resource pick (Phase 8 slice 2). A non-empty id pins
// the shot to a channel resource (source='resource'); null/empty clears it back to
// stock. No imports — the server action + UI both rely on this single rule.

export function validateShotResource(
  input: { resourceId: string | null },
): { source: 'resource'; resourceId: string } | { source: 'stock'; resourceId: null } {
  const id = typeof input.resourceId === 'string' ? input.resourceId.trim() : '';
  if (id === '') return { source: 'stock', resourceId: null };
  return { source: 'resource', resourceId: id };
}
