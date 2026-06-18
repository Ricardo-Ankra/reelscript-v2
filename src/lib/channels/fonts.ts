// Curated brand fonts — the SINGLE source of truth for which fonts the editor
// offers, validation accepts, brand_kit stores, and the renderer must load. The
// renderer can't import this list (it pulls @remotion/google-fonts, which the
// node:test loader can't load), so remotion/brand-fonts.ts duplicates the family
// names — fonts.test.ts asserts the two stay in sync.
export const FONT_ALLOWLIST = [
  'Poppins',
  'Montserrat',
  'Inter',
  'Roboto',
  'Playfair Display',
  'Bebas Neue',
] as const;

export type BrandFont = (typeof FONT_ALLOWLIST)[number];

export function isBrandFont(value: unknown): value is BrandFont {
  return typeof value === 'string' && (FONT_ALLOWLIST as readonly string[]).includes(value);
}

// Family name → @remotion/google-fonts subpath (space-less PascalCase).
// 'Playfair Display' → 'PlayfairDisplay'.
export function fontSubpath(family: string): string {
  return family.replace(/\s+/g, '');
}
