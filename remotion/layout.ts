// Vertical zone contract (Phase 6, spec 8.4/8.5 — collision prevention by
// construction). Captions own the lower third EXCLUSIVELY; kinetic text is confined
// to the upper/center zones above it. Shared by CaptionTrack and KineticText so the
// boundary is defined once and the two can't disagree.

// The caption band: everything from this % of height to the bottom belongs to
// captions. Kinetic text never enters it (its `position` enum has no 'lower').
export const CAPTION_BAND_TOP_PCT = 78;

// Kinetic vertical anchors (top of the element), both safely above the caption band.
export const KINETIC_UPPER_TOP_PCT = 14;
export const KINETIC_CENTER_TOP_PCT = 40;

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
