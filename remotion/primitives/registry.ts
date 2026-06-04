import type { ComponentType } from 'react';
import { Text } from './Text';
import { Shape } from './Shape';
import { FullBleed } from './FullBleed';

// The starter primitive set (spec 9.9, Phase 1 subset). The composition maps a
// spec's primitive-instance name to its component through this registry.
export type PrimitiveComponent = ComponentType<Record<string, unknown>>;

export const PRIMITIVES: Record<string, PrimitiveComponent> = {
  Text: Text as unknown as PrimitiveComponent,
  Shape: Shape as unknown as PrimitiveComponent,
  FullBleed: FullBleed as unknown as PrimitiveComponent,
};
