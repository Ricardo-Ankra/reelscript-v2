// The caption effect registry (caption emphasis revision, 2026-06-16).
//
// A static map of the gate-validated starter effects, keyed by EmphasisEffect.
// The AnimatedCaptionTrack renderer reads it via applyEffect(); the emphasis pass
// selects an effect by name. New effects (Option-3 growth path) join this map
// once they pass the same four authoring gates — one trust class, no exemption.
import type { EmphasisEffect } from '../types';
import type { EffectFn, EffectLayer } from './contract';
import { pop } from './pop';
import { topple } from './topple';
import { shatter } from './shatter';
import { shake } from './shake';
import { rise } from './rise';
import { zoom } from './zoom';
import { glitch } from './glitch';

export type { EffectFn, EffectLayer } from './contract';

export const EFFECTS: Record<EmphasisEffect, EffectFn> = {
  pop,
  topple,
  shatter,
  shake,
  rise,
  zoom,
  glitch,
};

export const DEFAULT_EFFECT: EmphasisEffect = 'pop';

// Resolve + run an effect, falling back to the default for an unknown/undefined
// name (the validator should never hand us one, but the renderer stays safe).
export function applyEffect(name: EmphasisEffect | undefined, t: number): EffectLayer[] {
  const fn = name && EFFECTS[name] ? EFFECTS[name] : EFFECTS[DEFAULT_EFFECT];
  return fn(t);
}
