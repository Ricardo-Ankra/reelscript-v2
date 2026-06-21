// Pure validation + sanitization for the channel resource library (Phase 8 slice 1).
// No imports — mirrors src/lib/channels/logos.ts. The kind is derived here so the
// client can never spoof it.

export type ResourceKind = 'image' | 'video';

export const RESOURCE_CONTENT_TYPES: Record<string, { kind: ResourceKind; ext: string }> = {
  'image/jpeg': { kind: 'image', ext: 'jpg' },
  'image/png': { kind: 'image', ext: 'png' },
  'image/webp': { kind: 'image', ext: 'webp' },
  'video/mp4': { kind: 'video', ext: 'mp4' },
};

export const MAX_RESOURCE_BYTES = 100 * 1024 * 1024; // 100 MB (videos)
export const MAX_DESCRIPTION_LEN = 500;
export const MAX_TAGS = 20;
export const MAX_TAG_LEN = 40;

// Validate an upload's content type → its kind + stored extension, or a reason.
export function validateResourceUpload(
  input: { contentType: string },
): { ok: true; kind: ResourceKind; ext: string } | { ok: false; reason: string } {
  const match = RESOURCE_CONTENT_TYPES[input.contentType];
  if (!match) {
    return { ok: false, reason: 'Unsupported file type. Use JPG, PNG, WebP, or MP4.' };
  }
  return { ok: true, kind: match.kind, ext: match.ext };
}

// Normalize editable fields. description → trimmed + capped (non-string → ''); tags →
// trimmed, non-empty, deduped (first-seen), each capped, count capped (non-array → []).
export function sanitizeResourceFields(
  input: { description?: unknown; tags?: unknown },
): { description: string; tags: string[] } {
  const description =
    typeof input.description === 'string'
      ? input.description.trim().slice(0, MAX_DESCRIPTION_LEN)
      : '';

  const tags: string[] = [];
  if (Array.isArray(input.tags)) {
    const seen = new Set<string>();
    for (const raw of input.tags) {
      const t = String(raw).trim().slice(0, MAX_TAG_LEN);
      if (t === '' || seen.has(t)) continue;
      seen.add(t);
      tags.push(t);
      if (tags.length >= MAX_TAGS) break;
    }
  }

  return { description, tags };
}
