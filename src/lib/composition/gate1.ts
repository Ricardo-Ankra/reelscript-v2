// Gate 1 — render-time spec validation (spec 11.1). A combined structural +
// semantic check between the composition AI and the render. Structural: required
// fields, types, enums, timing consistency. Semantic: referenced primitives exist
// and props satisfy their active+deprecated schema; brand-token references resolve
// in the baked theme; voiceover asset references resolve in the manifest.
//
// On failure it returns STRUCTURED, per-error detail (which scene, which instance,
// which primitive, which prop, which rule) — vague feedback makes the retry budget
// theatre; specific feedback is what lets the composition AI's retry actually fix
// the spec. Pure (no secrets/network), so it is unit-testable and runs in ms.
import type { CompositionSpec } from './spec';
import { buildPropValidator, type PropDef, type Theme } from '../primitives/contract';
import { STARTER_REGISTRY, type StarterRegistry } from '../primitives/starter';

export interface Gate1Error {
  scene?: number; // scene index
  instance?: number; // instance index within the scene
  primitive?: string;
  prop?: string;
  rule: string; // short machine label, e.g. 'unknown-primitive', 'timing'
  detail: string; // human/AI-readable explanation
}

export type Gate1Result = { ok: true } | { ok: false; errors: Gate1Error[] };

export function validateSpec(
  spec: CompositionSpec,
  theme: Theme,
  registry: StarterRegistry = STARTER_REGISTRY,
): Gate1Result {
  const errors: Gate1Error[] = [];
  const push = (e: Gate1Error) => errors.push(e);

  // --- top-level structure -------------------------------------------------
  if (spec.version !== 2) {
    push({ rule: 'version', detail: `Spec version must be 2, got ${JSON.stringify(spec.version)}.` });
  }
  const m = spec.metadata;
  if (!m || !isPosInt(m.width) || !isPosInt(m.height) || !isPosInt(m.fps) || !isPosInt(m.durationInFrames)) {
    push({ rule: 'metadata', detail: 'metadata.width/height/fps/durationInFrames must all be positive integers.' });
  }
  if (!Array.isArray(spec.scenes) || spec.scenes.length === 0) {
    push({ rule: 'scenes', detail: 'Spec must have at least one scene.' });
    return { ok: false, errors }; // nothing more to check
  }

  // --- asset manifest ------------------------------------------------------
  const assetIds = new Set<string>();
  for (const a of spec.assets ?? []) {
    if (!a.id || assetIds.has(a.id)) {
      push({ rule: 'asset-id', detail: `Asset id "${a.id}" is missing or duplicated.` });
    }
    assetIds.add(a.id);
    if (!a.r2Key) push({ rule: 'asset-key', detail: `Asset "${a.id}" must carry an r2Key.` });
  }

  // --- duration consistency: metadata == sum of scene durations ------------
  const sumScenes = spec.scenes.reduce((s, sc) => s + (Number(sc.durationInFrames) || 0), 0);
  if (m && isPosInt(m.durationInFrames) && m.durationInFrames !== sumScenes) {
    push({ rule: 'duration-consistency', detail: `metadata.durationInFrames (${m.durationInFrames}) must equal the sum of scene durations (${sumScenes}).` });
  }

  // --- per-scene -----------------------------------------------------------
  spec.scenes.forEach((scene, si) => {
    if (!scene.id) push({ scene: si, rule: 'scene-id', detail: `Scene ${si} is missing an id.` });
    const sceneDur = Number(scene.durationInFrames);
    if (!isPosInt(sceneDur)) {
      push({ scene: si, rule: 'scene-duration', detail: `Scene ${si} durationInFrames must be a positive integer.` });
    }
    if (scene.voiceover && !assetIds.has(scene.voiceover.assetId)) {
      push({ scene: si, rule: 'asset-ref', detail: `Scene ${si} voiceover references unknown asset "${scene.voiceover.assetId}".` });
    }
    if (!Array.isArray(scene.instances) || scene.instances.length === 0) {
      push({ scene: si, rule: 'instances', detail: `Scene ${si} has no primitive instances.` });
      return;
    }

    scene.instances.forEach((inst, ii) => {
      const prim = registry[inst.primitive];
      if (!prim) {
        push({ scene: si, instance: ii, primitive: inst.primitive, rule: 'unknown-primitive', detail: `Scene ${si} instance ${ii} uses unknown primitive "${inst.primitive}". Available: ${Object.keys(registry).join(', ')}.` });
        return;
      }

      // Structural prop validation against the active+deprecated schema.
      const parsed = buildPropValidator(prim.propSchema).safeParse(inst.props ?? {});
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          push({ scene: si, instance: ii, primitive: inst.primitive, prop: String(issue.path[0] ?? ''), rule: 'props', detail: `Scene ${si} ${inst.primitive} instance ${ii}: ${issue.path.join('.') || '(prop)'} — ${issue.message}.` });
        }
      }

      // Semantic: token props must resolve in the baked theme; asset props must
      // resolve in the manifest.
      for (const def of prim.propSchema) {
        const raw = (inst.props ?? {})[def.name];
        if (def.type === 'token') {
          if (raw === undefined) continue; // omitted → component default applies
          const group = def.tokenGroup ?? 'colors';
          const bag = (theme as unknown as Record<string, Record<string, unknown>>)[group] ?? {};
          if (typeof raw !== 'string' || !(raw in bag)) {
            push({ scene: si, instance: ii, primitive: inst.primitive, prop: def.name, rule: 'token-ref', detail: `Scene ${si} ${inst.primitive} instance ${ii}: prop "${def.name}"=${JSON.stringify(raw)} is not a theme ${group} token (valid: ${Object.keys(bag).join(', ')}).` });
          }
        } else if (def.type === 'asset') {
          if (raw === undefined) continue;
          if (typeof raw !== 'string' || !assetIds.has(raw)) {
            push({ scene: si, instance: ii, primitive: inst.primitive, prop: def.name, rule: 'asset-ref', detail: `Scene ${si} ${inst.primitive} instance ${ii}: prop "${def.name}"=${JSON.stringify(raw)} is not a manifest asset id. Use an assetId returned by search_stock.` });
          }
        }
      }

      // Semantic: timing must fit inside the scene.
      const sf = Number(inst.startFrame);
      const dur = Number(inst.durationInFrames);
      if (!Number.isInteger(sf) || sf < 0) {
        push({ scene: si, instance: ii, primitive: inst.primitive, rule: 'timing', detail: `Scene ${si} instance ${ii}: startFrame must be a non-negative integer.` });
      } else if (!isPosInt(dur)) {
        push({ scene: si, instance: ii, primitive: inst.primitive, rule: 'timing', detail: `Scene ${si} instance ${ii}: durationInFrames must be a positive integer.` });
      } else if (isPosInt(sceneDur) && sf + dur > sceneDur) {
        push({ scene: si, instance: ii, primitive: inst.primitive, rule: 'timing', detail: `Scene ${si} instance ${ii}: startFrame+durationInFrames (${sf + dur}) exceeds the scene duration (${sceneDur}).` });
      }
      if (typeof inst.layer !== 'number') {
        push({ scene: si, instance: ii, primitive: inst.primitive, rule: 'layer', detail: `Scene ${si} instance ${ii}: layer must be a number.` });
      }
    });
  });

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

// Render the errors as compact feedback for the composition AI's retry.
export function formatGate1Feedback(errors: Gate1Error[]): string {
  return errors.map((e) => `- [${e.rule}] ${e.detail}`).join('\n');
}

function isPosInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n > 0;
}

// Re-exported for callers that only need the prop-def type.
export type { PropDef };
