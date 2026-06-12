import type { ComponentType } from 'react';
import { Text } from './Text';
import { Shape } from './Shape';
import { FullBleed } from './FullBleed';
import { Image } from './Image';
import { Video } from './Video';
import { KineticText } from './KineticText';

// The starter primitive set (spec 9.9). The composition maps a spec's
// primitive-instance name to its component through this registry. Phase 5 adds the
// media primitives (Image/Video); Phase 6 adds KineticText (animated emphasis).
export type PrimitiveComponent = ComponentType<Record<string, unknown>>;

export const PRIMITIVES: Record<string, PrimitiveComponent> = {
  Text: Text as unknown as PrimitiveComponent,
  Shape: Shape as unknown as PrimitiveComponent,
  FullBleed: FullBleed as unknown as PrimitiveComponent,
  Image: Image as unknown as PrimitiveComponent,
  Video: Video as unknown as PrimitiveComponent,
  KineticText: KineticText as unknown as PrimitiveComponent,
};
