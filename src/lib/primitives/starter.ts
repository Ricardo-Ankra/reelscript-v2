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

export const STARTER_REGISTRY: Record<string, StarterPrimitive> = {
  Text: TEXT,
  Shape: SHAPE,
  FullBleed: FULLBLEED,
};

export type StarterRegistry = typeof STARTER_REGISTRY;
