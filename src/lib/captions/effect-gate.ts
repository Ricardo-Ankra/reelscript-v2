import 'server-only';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { runGates, type GatesOutcome } from '../primitives/gates';
import { buildEffectBrandQaPrompt } from '../ai/vision';
import { buildEffectProbe } from './effect-probe';
import { EMPHASIS_EFFECTS, type EmphasisEffect } from './types';

// Run a starter caption effect through the SAME four authoring gates as a studio
// primitive (lint → compile → smoke → brand), by wrapping its source in a render
// probe and handing it to the unchanged runGates. One trust class: the registry
// holds no gate-exempt artifact.
//
// Lambda-backed (compile/smoke/brand deploy a site + render on Lambda + a vision
// call), so this runs via the seed:effects driver where creds exist — not in the
// pure unit suite. The lint gate of the same probe IS proven in unit tests
// (effect-probe.test.ts).

const EFFECTS_DIR = path.join(process.cwd(), 'src', 'lib', 'captions', 'effects');

export async function gateEffect(name: EmphasisEffect): Promise<GatesOutcome> {
  const source = await readFile(path.join(EFFECTS_DIR, `${name}.ts`), 'utf8');
  const { code, propSchema } = buildEffectProbe(name, source);
  // Same gates + sequence as a primitive; the brand rubric is animation-aware so an
  // intentional mid-entrance split (e.g. shatter) is not misread as a render defect.
  return runGates({ code, propSchema, brandPrompt: buildEffectBrandQaPrompt });
}

export async function gateAllStarterEffects(): Promise<
  { name: EmphasisEffect; outcome: GatesOutcome }[]
> {
  // Sequential — each gate run deploys + renders on Lambda; serialize to respect
  // the account's render-concurrency limit (the Phase-9 governor is deferred).
  const results: { name: EmphasisEffect; outcome: GatesOutcome }[] = [];
  for (const name of EMPHASIS_EFFECTS) {
    results.push({ name, outcome: await gateEffect(name) });
  }
  return results;
}
