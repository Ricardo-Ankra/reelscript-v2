// Pure derivation for the editor's per-scene asset tray: which resources are
// currently attached to a scene's shots. A shot contributes when it is pinned
// (source === 'resource') to a resource_id that resolves to a known resource;
// stock shots and dangling pins are omitted. Sorted by shot position.
export interface ResourceLike {
  id: string;
  kind: string;
  description: string;
}

export interface ShotLike {
  id: string;
  position: number;
  source: string;
  resource_id: string | null;
}

export interface AttachedAsset {
  shotId: string;
  shotPosition: number;
  resource: ResourceLike;
}

export function sceneAttachedResources(
  shots: ShotLike[],
  resources: ResourceLike[],
): AttachedAsset[] {
  const byId = new Map(resources.map((r) => [r.id, r]));
  return shots
    .filter((s) => s.source === 'resource' && s.resource_id != null)
    .map((s): AttachedAsset | null => {
      const resource = byId.get(s.resource_id as string);
      return resource ? { shotId: s.id, shotPosition: s.position, resource } : null;
    })
    .filter((a): a is AttachedAsset => a !== null)
    .sort((a, b) => a.shotPosition - b.shotPosition);
}
