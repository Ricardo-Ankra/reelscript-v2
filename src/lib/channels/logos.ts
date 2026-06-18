// Pure channel-logo validation (Phase 8 — logo uploads). No react/server/network.
// brand_kit.logos is a 4-slot map of R2 keys; this validates an upload's type +
// slot and sanitizes a stored logos object. Key generation (uuid) lives in the
// server action, not here.

export const LOGO_SLOTS = ['primary', 'monoLight', 'monoDark', 'icon'] as const;
export type LogoSlot = (typeof LOGO_SLOTS)[number];
export type Logos = Partial<Record<LogoSlot, string>>; // slot → R2 key

export const MAX_LOGO_BYTES = 2 * 1024 * 1024; // 2 MB (client-side guard)

// Accepted upload content types → file extension.
const EXT_FOR_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};

export function isLogoSlot(value: unknown): value is LogoSlot {
  return typeof value === 'string' && (LOGO_SLOTS as readonly string[]).includes(value);
}

export function validateLogoUpload(
  input: unknown,
): { ok: true; ext: string } | { ok: false; reason: string } {
  if (!input || typeof input !== 'object') return { ok: false, reason: 'Invalid upload.' };
  const { slot, contentType } = input as { slot?: unknown; contentType?: unknown };
  if (!isLogoSlot(slot)) return { ok: false, reason: 'Unknown logo slot.' };
  const ext = typeof contentType === 'string' ? EXT_FOR_TYPE[contentType] : undefined;
  if (!ext) return { ok: false, reason: 'Use a PNG, JPEG, WebP, or SVG.' };
  return { ok: true, ext };
}

// Keep only the 4 known slots whose value is a non-empty string (R2 key).
export function sanitizeLogos(input: unknown): Logos {
  const out: Logos = {};
  if (!input || typeof input !== 'object') return out;
  const o = input as Record<string, unknown>;
  for (const slot of LOGO_SLOTS) {
    const v = o[slot];
    if (typeof v === 'string' && v) out[slot] = v;
  }
  return out;
}
