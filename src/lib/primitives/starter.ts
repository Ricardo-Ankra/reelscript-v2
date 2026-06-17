// Prop schemas + metadata for the starter primitive set (spec 9.9, Phase 4 subset:
// Text / Shape / FullBleed). The Remotion components in remotion/primitives/*.tsx
// are the rendering source; THIS is the server-/AI-facing contract derived from the
// primitive contract (src/lib/primitives/contract.ts):
//   * the composition AI is shown the active props (aiFacingSchema) to know how to
//     use each brick,
//   * Gate 1 validates the AI's emitted instances against these (buildPropValidator
//     + token/timing semantics).
// Pure (no react/server-only) so Gate 1 and the prompt builder share it and it is
// unit-testable. Colour props are type 'token' (tokenGroup 'colors') so Gate 1's
// "brand-token references resolve" check is meaningful (spec 8.1 / 11.1).
import type { PropSchema, PrimitiveMeta } from './contract';

export interface StarterPrimitive {
  propSchema: PropSchema;
  meta: PrimitiveMeta;
}

// Mirrors remotion/primitives/Text.tsx.
const TEXT: StarterPrimitive = {
  meta: { name: 'Text', version: 1, description: 'A title or label. Brand display font, fades in. Use for headlines and short on-screen text.' },
  propSchema: [
    { name: 'text', type: 'string', state: 'active', required: true, description: 'The text to show. Keep it short enough to fit the frame.' },
    { name: 'colorToken', type: 'token', tokenGroup: 'colors', state: 'active', default: 'foreground', description: 'Which palette colour the text uses.' },
    { name: 'fontSizePx', type: 'number', state: 'active', default: 96, description: 'Font size in pixels (frame is 1080 wide for 9:16).' },
    { name: 'align', type: 'enum', enumValues: ['left', 'center', 'right'], state: 'active', default: 'center', description: 'Horizontal alignment.' },
  ],
};

// Mirrors remotion/primitives/Shape.tsx — rectangles/lines/accents/backgrounds
// (the basis of the no-stock graphic path, spec 8.9).
const SHAPE: StarterPrimitive = {
  meta: { name: 'Shape', version: 1, description: 'A rectangle or line in a brand colour. Backgrounds, bars, dividers, accents — the graphic building block.' },
  propSchema: [
    { name: 'shape', type: 'enum', enumValues: ['rect', 'line'], state: 'active', default: 'rect', description: 'Rectangle or thin line.' },
    { name: 'colorToken', type: 'token', tokenGroup: 'colors', state: 'active', default: 'accent', description: 'Fill colour token.' },
    { name: 'xPct', type: 'number', state: 'active', default: 0, description: 'Left position as a percent of width (0–100).' },
    { name: 'yPct', type: 'number', state: 'active', default: 0, description: 'Top position as a percent of height (0–100).' },
    { name: 'widthPct', type: 'number', state: 'active', default: 100, description: 'Width as a percent (0–100).' },
    { name: 'heightPct', type: 'number', state: 'active', default: 2, description: 'Height as a percent for rect (ignored for line).' },
  ],
};

// Mirrors remotion/primitives/FullBleed.tsx — full-frame solid brand colour
// (later phases back it with an image/video).
const FULLBLEED: StarterPrimitive = {
  meta: { name: 'FullBleed', version: 1, description: 'A full-frame solid brand colour background. Lay other primitives over it.' },
  propSchema: [
    { name: 'colorToken', type: 'token', tokenGroup: 'colors', state: 'active', default: 'background', description: 'Background colour token.' },
  ],
};

// Mirrors remotion/primitives/Image.tsx — a still (stock/resource) with optional
// Ken-Burns pan. The `asset` prop references a manifest asset id (spec 8.3).
const IMAGE: StarterPrimitive = {
  meta: { name: 'Image', version: 1, description: 'A real photo (stock or uploaded). At layer 0 with fit "cover" it is a full-bleed background; lay text/shapes over it.' },
  propSchema: [
    { name: 'asset', type: 'asset', state: 'active', required: true, description: 'The chosen image asset id from your stock search.' },
    { name: 'fit', type: 'enum', enumValues: ['cover', 'contain'], state: 'active', default: 'cover', description: 'cover fills the frame (crops); contain fits inside.' },
    { name: 'pan', type: 'boolean', state: 'active', default: true, description: 'Slow Ken-Burns zoom for life.' },
  ],
};

// Mirrors remotion/primitives/Video.tsx — trimmed footage, muted (voiceover is the
// audio).
const VIDEO: StarterPrimitive = {
  meta: { name: 'Video', version: 1, description: 'Real video footage (stock or uploaded), muted. At layer 0 fit "cover" it is a moving full-bleed background.' },
  propSchema: [
    { name: 'asset', type: 'asset', state: 'active', required: true, description: 'The chosen video asset id from your stock search.' },
    { name: 'fit', type: 'enum', enumValues: ['cover', 'contain'], state: 'active', default: 'cover', description: 'cover fills the frame (crops); contain fits inside.' },
    { name: 'mute', type: 'boolean', state: 'active', default: true, description: 'Keep muted so the voiceover is heard.' },
    { name: 'trimStartSec', type: 'number', state: 'active', default: 0, description: 'Seconds into the source clip to start from.' },
  ],
};

// DEPRECATED (caption emphasis revision, 2026-06-16). Kinetic text is folded into
// the animated caption track — emphasis is now a three-axis annotation on caption
// words, not a separate primitive. Every prop is state 'deprecated', so aiFacingSchema
// is empty (the composition AI is never offered it) while validationSchema still
// accepts it, so in-flight specs that reference KineticText keep validating. The
// remotion/primitives/KineticText.tsx component is retained so those specs still
// render. Do not place it in new compositions.
const KINETICTEXT: StarterPrimitive = {
  meta: { name: 'KineticText', version: 1, description: 'DEPRECATED — superseded by the animated caption track. Retained only so in-flight specs still validate and render; not offered for new compositions.' },
  propSchema: [
    { name: 'text', type: 'string', state: 'deprecated', required: true, description: 'The short emphasis word or phrase (1–4 words).' },
    { name: 'animation', type: 'enum', enumValues: ['bounce', 'pop'], state: 'deprecated', default: 'pop', description: 'bounce = drops/springs in; pop = scales up.' },
    { name: 'position', type: 'enum', enumValues: ['upper', 'center'], state: 'deprecated', default: 'center', description: 'Where it sits (upper or center).' },
    { name: 'accentToken', type: 'token', tokenGroup: 'colors', state: 'deprecated', default: 'accent', description: 'Accent colour token for the word.' },
    { name: 'fontSizePx', type: 'number', state: 'deprecated', default: 150, description: 'Font size in pixels.' },
  ],
};

export const STARTER_REGISTRY: Record<string, StarterPrimitive> = {
  Text: TEXT,
  Shape: SHAPE,
  FullBleed: FULLBLEED,
  Image: IMAGE,
  Video: VIDEO,
  KineticText: KINETICTEXT,
};

export type StarterRegistry = typeof STARTER_REGISTRY;
