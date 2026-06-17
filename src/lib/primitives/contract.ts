// =============================================================================
// Reelscript V2 — Primitive Contract
// =============================================================================
// A primitive is a reusable visual building block, authored once in the studio,
// validated once at authoring time, then composed by the AI across many renders.
// This file is the contract every primitive must satisfy and the machinery the
// authoring studio and render-time Gate 1 validate against. It is also the
// reference the primitive-skill teaches the drafting AI from.
//
// Maps to the database: a row in `primitives` carries { code, prop_schema,
// version, status }. prop_schema is the serialized PropSchema defined below.
//
// Depends on: react, remotion, zod.
// =============================================================================

import { z, type ZodTypeAny } from 'zod';

// -----------------------------------------------------------------------------
// 1. Theme — the brand kit a primitive receives
// -----------------------------------------------------------------------------
// A primitive is brand-agnostic by construction: it reads colours and fonts
// from the Theme it is handed, never from literals. At render time the Theme is
// the baked snapshot embedded in the composition spec (spec 8.2), so editing the
// channel later never changes an old render. Logo/asset URLs are already-signed
// R2 URLs by the time they reach a primitive (spec 10.3).

export interface Theme {
  colors: {
    background: string; // resolved hex, e.g. "#14213d"
    foreground: string;
    primary: string;
    secondary: string;
    accent: string;
    bodyText: string;
    positive: string; // sentiment token — caption emphasis tone 'positive' (default green)
    negative: string; // sentiment token — caption emphasis tone 'negative' (default red)
  };
  fonts: {
    display: string; // font family name, already registered before first frame
    body: string;
    mono: string;
  };
  logos: {
    primary?: string; // signed R2 URL
    monoLight?: string;
    monoDark?: string;
    icon?: string;
  };
  motion: 'subtle' | 'standard' | 'punchy';
}

// The React provider/hook for handing a baked theme to primitives lives in
// ./theme-context (it imports react hooks, which can't be pulled into a
// react-server bundle — this file must stay server-importable for Gate 1).

// -----------------------------------------------------------------------------
// 2. Prop schema — what a primitive accepts, and its lifecycle
// -----------------------------------------------------------------------------
// The prop schema is the contract between a primitive and the composition AI.
// It does triple duty (spec 9.2): the studio generates the preview's sample-prop
// controls from it; the AI reads it to know how to use the primitive; and Gate 1
// validates the AI's emitted props against it.

// Per-prop lifecycle (spec 9.3). active: live and AI-facing. deprecated: kept in
// the validation schema so old specs stay valid, but hidden from the AI so new
// specs never include it. removed: only once no spec references it (zero usage).
export type PropState = 'active' | 'deprecated' | 'removed';

export type PropType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'enum'
  | 'token' // a reference to a Theme token, e.g. "accent" or "display"
  | 'asset'; // a reference to an asset in the composition's manifest

export interface PropDef {
  name: string;
  type: PropType;
  state: PropState;
  /** Required props must be supplied by the AI. Props with a default may be omitted. */
  required?: boolean;
  /** Mandatory for any prop added after a primitive's first version (spec 9.3),
   *  so that older specs which omit it still validate. */
  default?: unknown;
  /** Allowed values when type === 'enum'. */
  enumValues?: string[];
  /** Which Theme group a 'token' prop selects from. */
  tokenGroup?: 'colors' | 'fonts';
  /** Short guidance shown to the composition AI to help it use the prop well. */
  description?: string;
}

export type PropSchema = PropDef[];

// -- Two derived views of one schema. They come from the same array, so they
// -- cannot drift (spec 9.3). -------------------------------------------------

/** What the composition AI is shown: active props only. */
export function aiFacingSchema(schema: PropSchema): PropSchema {
  return schema.filter((p) => p.state === 'active');
}

/** What Gate 1 validates against: active + deprecated (so old specs pass). */
export function validationSchema(schema: PropSchema): PropSchema {
  return schema.filter((p) => p.state !== 'removed');
}

// -----------------------------------------------------------------------------
// 3. Schema evolution guard (authoring-studio rule, spec 9.3)
// -----------------------------------------------------------------------------
// Editing a primitive must never invalidate an existing composition spec. The
// studio calls this before saving a schema change and refuses destructive edits.
// Rules:
//   * an existing prop may not be removed outright, renamed, or retyped
//     (renaming = remove + add, which trips the "still present" check);
//   * an existing prop may only change state forward (active -> deprecated ->
//     removed); it cannot come back from 'removed';
//   * a newly added prop must carry a default.
// A prop already in state 'removed' may be dropped from the array entirely.

export function assertSchemaEvolution(oldSchema: PropSchema, newSchema: PropSchema): void {
  const byName = (s: PropSchema) => new Map(s.map((p) => [p.name, p]));
  const oldMap = byName(oldSchema);
  const newMap = byName(newSchema);
  const order: Record<PropState, number> = { active: 0, deprecated: 1, removed: 2 };

  for (const [name, oldProp] of oldMap) {
    const next = newMap.get(name);
    if (!next) {
      // Dropping is only allowed if the prop was already removed.
      if (oldProp.state !== 'removed') {
        throw new Error(
          `Prop "${name}" cannot be deleted (state="${oldProp.state}"). ` +
            `Deprecate it instead, or create a new primitive.`,
        );
      }
      continue;
    }
    if (next.type !== oldProp.type) {
      throw new Error(
        `Prop "${name}" cannot change type (${oldProp.type} -> ${next.type}). ` +
          `Add a new prop instead.`,
      );
    }
    if (order[next.state] < order[oldProp.state]) {
      throw new Error(
        `Prop "${name}" cannot move backward in lifecycle ` +
          `(${oldProp.state} -> ${next.state}).`,
      );
    }
  }

  for (const [name, newProp] of newMap) {
    if (!oldMap.has(name) && newProp.default === undefined && newProp.required) {
      throw new Error(`New prop "${name}" must define a default (so older specs stay valid).`);
    }
  }
}

// -----------------------------------------------------------------------------
// 4. Prop validator (render-time Gate 1, spec 11.1)
// -----------------------------------------------------------------------------
// Build a Zod validator from a prop schema. Gate 1 runs the AI's emitted props
// for a primitive instance through this. Built from the *validation* schema
// (active + deprecated), and strict, so:
//   * a missing required prop fails,
//   * a prop the primitive never declared (an AI hallucination) fails,
//   * a deprecated prop on an old spec still passes.
// Token and asset props are validated here as strings; that they *resolve*
// (the token exists in the theme, the asset exists in the manifest) is the
// semantic half of Gate 1, checked separately against theme + manifest.

export function buildPropValidator(schema: PropSchema): ZodTypeAny {
  const shape: Record<string, ZodTypeAny> = {};

  for (const def of validationSchema(schema)) {
    let base: ZodTypeAny;
    switch (def.type) {
      case 'string':
      case 'token':
      case 'asset':
        base = z.string();
        break;
      case 'number':
        base = z.number();
        break;
      case 'boolean':
        base = z.boolean();
        break;
      case 'enum':
        if (!def.enumValues || def.enumValues.length === 0) {
          throw new Error(`Enum prop "${def.name}" must declare enumValues.`);
        }
        base = z.enum(def.enumValues as [string, ...string[]]);
        break;
      default:
        throw new Error(`Unknown prop type for "${def.name}".`);
    }

    // Deprecated props are always optional; new specs never include them.
    if (def.state === 'deprecated') {
      shape[def.name] = base.optional();
    } else if (def.default !== undefined) {
      shape[def.name] = base.default(def.default as never);
    } else if (def.required) {
      shape[def.name] = base;
    } else {
      shape[def.name] = base.optional();
    }
  }

  return z.object(shape).strict();
}

// -----------------------------------------------------------------------------
// 5. The primitive module shape
// -----------------------------------------------------------------------------
// A primitive file default-exports its component and named-exports its schema
// and metadata. The build step assembles all primitives into the registry that
// gets bundled into the Remotion site (spec 9.7).

import type { FC } from 'react';

export interface PrimitiveMeta {
  name: string; // unique within an account; matches primitives.name
  description: string; // what the brick does, for the AI and the library list
  version: number; // matches primitives.version (pragmatic versioning, spec 8.2)
}

// A primitive component receives exactly the props its schema declares (plus the
// scene-level timing Remotion provides via context: useCurrentFrame, etc.). It
// obtains brand values via useTheme(), never via props or literals.
export type PrimitiveComponent<P extends Record<string, unknown> = Record<string, unknown>> = FC<P>;

export interface PrimitiveModule<P extends Record<string, unknown> = Record<string, unknown>> {
  component: PrimitiveComponent<P>;
  propSchema: PropSchema;
  meta: PrimitiveMeta;
}

export type PrimitiveRegistry = Record<string, PrimitiveModule>;

// -----------------------------------------------------------------------------
// 6. How a scene references a primitive (the composition spec, spec 8.3)
// -----------------------------------------------------------------------------
// The AI does not write code; it emits instances. Each instance names a
// primitive, supplies props (validated against that primitive's schema), and
// places it in the scene's layer/timing. This is the structural half of the
// composition spec that Gate 1 checks.

export interface PrimitiveInstance {
  primitive: string; // must exist in the registry
  props: Record<string, unknown>; // must satisfy buildPropValidator(schema)
  layer: number; // stacking order within the scene
  startFrame: number; // relative to the scene
  durationInFrames: number;
}

// Convenience: validate one instance against the registry. Used by Gate 1.
export function validateInstance(instance: PrimitiveInstance, registry: PrimitiveRegistry):
  | { ok: true }
  | { ok: false; error: string } {
  const mod = registry[instance.primitive];
  if (!mod) {
    return { ok: false, error: `Unknown primitive "${instance.primitive}".` };
  }
  const result = buildPropValidator(mod.propSchema).safeParse(instance.props);
  if (!result.success) {
    return { ok: false, error: result.error.message };
  }
  return { ok: true };
}

// -----------------------------------------------------------------------------
// 7. The lint contract (enforced statically by Gate "lint", spec 9.6)
// -----------------------------------------------------------------------------
// These rules are enforced by AST analysis at authoring time, not by types.
// Documented here as the single source of truth the linter and the
// primitive-skill share.
//
//   * Imports are restricted to this whitelist. Anything else fails lint.
//   * No nondeterministic calls: Math.random, Date.now, performance.now, new Date().
//   * No network or I/O: fetch, XMLHttpRequest, dynamic import().
//   * No hardcoded colours or font families — read them from useTheme().
//   * No hardcoded pixel dimensions for the frame — read useVideoConfig().
//   * Animation is driven by useCurrentFrame()/interpolate()/spring(), never by
//     wall-clock time.
//   * Media uses Remotion's <Img> / <OffthreadVideo>, never raw <img>/<video>.

export const IMPORT_WHITELIST: readonly string[] = [
  'react',
  'remotion',
  '@remotion/google-fonts', // font loading by name
  './theme', // useTheme, Theme (this contract)
  './animation', // shared easing/animation utilities
] as const;

// =============================================================================
// Notes
// * Token props (type 'token') let a primitive expose a *choice* of brand token
//   (e.g. "which palette colour to accent with") without hardcoding — the value
//   is a token key like "accent", resolved against the theme at render.
// * The lint contract above is intentionally not expressible in the type system;
//   it is the linter's spec. Keeping it beside the types means the linter, the
//   skill, and reviewers all read the same list.
// * assertSchemaEvolution + buildPropValidator together are what make pragmatic
//   primitive versioning safe: code may change freely and the deployed site
//   holds the current version, while the prop-schema rules guarantee no edit can
//   invalidate a spec an existing render relies on.
// =============================================================================
