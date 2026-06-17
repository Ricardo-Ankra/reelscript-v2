// Shared render-layer helpers. The Phase-6 zone contract (separate caption /
// kinetic bands) was removed in the 2026-06-16 caption emphasis revision: there is
// one animated caption track now, so no zones to reserve. The deprecated
// KineticText component carries its own anchors inline.

// Append an alpha byte to a resolved #rrggbb theme colour (bakeTheme yields hex).
// Used for the legibility scrim so it tints with the brand background, not a flat
// black. Falls back to the colour unchanged if it isn't 6-digit hex.
export function withAlpha(hex: string, alpha: number): string {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return hex;
  const a = Math.round(Math.min(1, Math.max(0, alpha)) * 255)
    .toString(16)
    .padStart(2, '0');
  return `${hex}${a}`;
}
