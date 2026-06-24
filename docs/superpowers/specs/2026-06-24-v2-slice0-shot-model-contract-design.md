# Reelscript V2 — Slice 0: Shot-model contract & beat classification — Design

> **Phase 8 → Reelscript V2 program.** This is the first slice of the V2 upgrade
> driven by the "Reelscript Higgsfield Build Spec v3.0" (TS/Inngest/Lambda/Remotion
> mapping). V2 introduces generative video (Higgsfield), three source classes, an
> assembly model, live-action ingest, provenance/disclosure, and two gates. Slice 0
> lays the **data-model contract** every later slice consumes. It is mostly additive
> and changes no rendering behavior.

## 0. Context — the V2 program & where Slice 0 sits

The V2 build is decomposed into sequential sub-projects, each its own spec→plan→build:

- **Slice 0 (this) — shot-model contract & beat classification.**
- Slice 1 — Higgsfield generation spine (riskiest integration: still→clip→R2; keyframe-gen, native client, router, motion presets, durable Inngest poll, seed/continuity).
- Slice 2 — live-action ingest (extend the existing ffmpeg Lambda: probe/conform/trim/reframe/keyframe+styleRef; stock resolve).
- Slice 3 — assembly spine (`FinalTimeline` Remotion comp: sequence clips/footage/gfx + master LUT + match-grade + overlays + captions; VO-first audio). Needs a spike.
- Slice 4 — gates G1 (storyboard) + G2 (preview), in-app via Inngest `waitForEvent`.
- Slice 5 — provenance ledger rollup + disclosure (`Disclosure.tsx`, platform flag).
- Slice 6 — master `reelscript.pipeline` orchestration (fan-out/fan-in, both gates, budget guardrail). Later: dynamic storyboarding + analytics.

**Resolved program-level decisions (locked):**

1. **Runtime:** the spec's principles land in the **existing TS stack** (Next.js + Supabase + Inngest + Remotion Lambda + R2), not the spec's literal Python/agent-skills or Neon/Drizzle. Refactor existing code; do not replace foundations.
2. **Data layer:** **keep Supabase + RLS + Auth + Realtime.** Map v3's "job" onto the existing account/channel-scoped **`video`**; keep the **`scenes`** table as the narrative grouping (= v3 `sceneId`). Extend `shots` in place.
3. **Shot model:** **extend additively** — keep `VisualBrief`/`specificity`/`source`; add `kind` + `CameraSpec`/`LightingSpec`/`provenance` on top. The existing readiness gate already encodes v3's authenticity test (`specificity==='entity'` must be a real attached asset).
4. **Slice 0 scope:** contract **+ script-time authoring** (populate `kind`, author cinematography for generative shots). Not pure-dormant.

Sandbox build: **no concern for data migration / data loss.** Migrations may be liberal.

## 1. Goal & non-goals

**Goal.** Every newly generated shot carries (a) a deterministic `kind` (`generative | motion_graphic | live_action`), (b) for generative shots, AI-authored `CameraSpec` + `LightingSpec`, and (c) a `provenance` stub — all persisted on `shots`, derived/authored at script-generation time, fully typed and tested.

**Non-goals (deferred, by slice).** No Higgsfield client, keyframe generation, motion-preset map, or router (Slice 1). No `seed`/`entities`/continuity (Slice 1). No generation-output columns — keyframe/styleRef/render keys, `routed_model` (Slice 1). No ingest (Slice 2), assembly (Slice 3), gates (Slice 4), disclosure overlay/publish (Slice 5). **Nothing renders, resolves, or gates differently** — compose/render/`shotReadiness` ignore the new fields this slice.

## 2. Current state (anchors)

- `shots` (`supabase/migrations/…`): `id, account_id, scene_id, position, description, source shot_source ('stock'|'resource'|'procedural'|'generated'), resource_id, stock_query, duration_seconds, visual_brief jsonb`.
- `VisualBrief` (`src/lib/videos/visual-brief.ts`): `subject, action, setting, framing, mood, specificity ('generic'|'entity'|'abstract'|'spokesperson'), entity_name, recommended_source ('stock'|'upload'|'generate'|'primitive')`. `parseVisualBrief` is a never-throw normalizer.
- `shotReadiness` (`src/lib/videos/shot-readiness.ts`): blocks `specificity==='entity'` without `source==='resource' && resource_id`.
- Script-gen (`src/lib/ai/script-generation.ts`): zod `generatedVisualBriefSchema` (camelCase), `parseSceneLine`, **single** `sceneToRpcArgs` conversion (camelCase→snake_case), `buildSystemPrompt`, `buildUserPrompt`. Inngest `generate-script.ts` calls the RPC `upsert_scene_with_shots`.

## 3. Migration (additive)

Extend `shots`:

- New enum `shot_kind` as `('generative','motion_graphic','live_action')`.
- `kind shot_kind not null default 'live_action'`, backfilled from `source`:
  `procedural → motion_graphic`, `generated → generative`, `stock|resource → live_action`.
- `camera_spec jsonb` (nullable; generative only).
- `lighting_spec jsonb` (nullable; generative only).
- `provenance jsonb` (nullable; script-time stub).
- `hero boolean not null default false`, `needs_speech boolean not null default false`, `broadcast_4k boolean not null default false`.
- Rewrite `upsert_scene_with_shots` to read and persist `kind`, `camera_spec`,
  `lighting_spec`, `provenance`, `hero`, `needs_speech`, `broadcast_4k` from each
  element of the `p_shots` jsonb array (alongside the existing `visual_brief`).

RLS: inherited — no policy change (`shots` already account-scoped). Applied to the
sandbox DB and verified via `information_schema`.

## 4. Types & parsers — `src/lib/videos/cinematography.ts` (+ test)

Mirror the `visual-brief.ts` pattern: plain TS types + never-throw normalizers for
the **stored snake_case** shape. (The AI-output camelCase shape is a zod schema in
`script-generation.ts`, §6.)

```ts
export type ShotKind = 'generative' | 'motion_graphic' | 'live_action';
export const SHOT_KINDS: readonly ShotKind[] = ['generative','motion_graphic','live_action'];

export type ShotSize = 'ECU'|'CU'|'MS'|'WS'|'EWS'|'two_shot'|'OTS'|'POV';
export type CameraAngle = 'eye_level'|'low'|'high'|'dutch'|'aerial'|'overhead';
export type CameraMove =
  | 'static'|'dolly_in'|'dolly_out'|'arc_left'|'arc_right'|'orbit_360'
  | 'crane_up'|'crane_down'|'tracking'|'pan_left'|'pan_right'|'tilt_up'
  | 'tilt_down'|'whip_pan'|'push_in'|'pull_back'|'handheld'|'bullet_time'
  | 'boom'|'snorricam'|'fpv_drone';
export type Dof = 'shallow'|'deep'|'rack_focus';

export interface CameraSpec {
  shot_size: ShotSize;        // default 'MS'
  angle: CameraAngle;         // default 'eye_level'
  move: CameraMove;           // default 'static' (ONE primary move — single value, not array)
  lens_mm: number;            // default 35
  dof: Dof;                   // default 'shallow'
  motion_strength: number;    // default 0.7, clamped [0,1]
}

export interface LightingSpec {
  key: string;                // default 'soft key from frame left'
  ratio: string;              // default '3:1'
  time_of_day: string;        // default 'golden hour'
  palette: string;            // default 'teal shadows, warm highlights'
  texture: string;            // default 'subtle film grain'
}

export interface Provenance {
  synthetic: boolean;
  source: string | null;      // e.g. 'higgsfield:dop-preview' | 'remotion' | 'stock:pexels' | 'shot:on-site'; null at stub time
  model: string | null;
  seed: number | null;
  source_uri: string | null;
  created_at: string | null;
  operator: string | null;
}

export function parseCameraSpec(value: unknown): CameraSpec | null;   // null when absent; enums fall back to defaults; lens_mm coerced int; motion_strength clamped
export function parseLightingSpec(value: unknown): LightingSpec | null; // null when absent; strings default
export function parseProvenance(value: unknown): Provenance | null;    // null when absent; synthetic coerced bool; other fields nullable
```

Rules: enum fields fall back to the stated default when the stored value is not a
member; `lens_mm` coerced to int (default 35); `motion_strength` clamped to `[0,1]`
(default 0.7); absent object → `null` (never throws), exactly like `parseVisualBrief`.

## 5. `classifyBeat` — `src/lib/videos/classify-beat.ts` (+ test)

Pure, deterministic, total. `kind` is a function of the already-authored brief —
**not** an LLM freeform choice — so classification is auditable.

```ts
import type { Specificity, RecommendedSource } from './visual-brief';
import type { ShotKind } from './cinematography';

export function classifyBeat(
  specificity: Specificity,
  recommendedSource: RecommendedSource,
): ShotKind {
  if (specificity === 'entity') return 'live_action';   // authenticity test wins
  switch (recommendedSource) {
    case 'primitive': return 'motion_graphic';
    case 'generate':  return 'generative';
    case 'stock':
    case 'upload':    return 'live_action';
  }
}
```

(Adaptation note: v3 frames `classifyBeat` as a *pre*-filter before the LLM. Our
script-gen already has the LLM author `specificity` + `recommended_source`; we derive
`kind` deterministically *from* those authored fields right after parse — same
auditability, no second model call.)

## 6. Script-gen authoring — `src/lib/ai/script-generation.ts`

1. **Generated-shot schema.** Add optional camelCase `camera` + `lighting` objects to
   the generated-shot zod schema (alongside `visualBrief`), each with the CameraSpec/
   LightingSpec fields and defaults from §4. Authored only for generative-bound shots;
   optional everywhere so non-generative shots omit them.
2. **`buildSystemPrompt`.** Add the CameraSpec/LightingSpec vocabulary (the enum value
   lists + the "one primary move" rule) and the instruction: *author `camera` and
   `lighting` when `recommendedSource` is `generate`; omit them otherwise.*
3. **`sceneToRpcArgs`** (the single conversion site). For each shot:
   - compute `kind = classifyBeat(specificity, recommendedSource)`;
   - convert `camera`/`lighting` camelCase→snake_case (or omit when absent);
   - attach a provenance stub: `{ synthetic: kind === 'generative', source: null,
     model: null, seed: null, source_uri: null, created_at: null, operator: null }`;
   - default `hero`/`needs_speech`/`broadcast_4k` to `false` (authored later slices may set them);
   - include all new keys in the `p_shots` element passed to the RPC.

No change to `parseSceneLine`/`createNdjsonAccumulator`/`buildUserPrompt`.

## 7. Testing

- `classifyBeat` — exhaustive over (specificity × recommendedSource), including the
  `entity`-override beating every `recommendedSource`.
- `parseCameraSpec` / `parseLightingSpec` / `parseProvenance` — absent→null; bad enum
  →default; `motion_strength` clamp; `lens_mm` int coercion; full round-trip of a valid
  object; never-throws on garbage.
- `sceneToRpcArgs` — `kind` derivation per shot; camera/lighting camelCase→snake_case
  conversion (and omission when absent); provenance stub shape; flags default false;
  existing `visual_brief` conversion unchanged (regression).
- Generated-shot zod schema — parses a scene line carrying `camera`/`lighting`;
  tolerates their absence.
- Migration applied to the sandbox DB; `kind`/jsonb columns verified present and
  backfilled.

## 8. Backward compatibility

- Additive columns + a defaulted/backfilled `kind`; existing rows become valid
  (`kind` derived from `source`).
- `parseVisualBrief`, `shotReadiness`, compose, and render are untouched and ignore
  the new fields — an unbriefed or pre-V2 shot behaves byte-identically.
- The new generated-shot schema fields are optional → a script-gen response without
  `camera`/`lighting` parses exactly as today.

## 9. File structure (drives the plan)

| File | Responsibility |
| --- | --- |
| `supabase/migrations/<ts>_v2_shot_kind.sql` (create) | `shot_kind` enum, new columns, backfill, RPC rewrite |
| `src/lib/videos/cinematography.ts` (+ test) (create) | `CameraSpec`/`LightingSpec`/`Provenance`/`ShotKind` types + never-throw parsers |
| `src/lib/videos/classify-beat.ts` (+ test) (create) | pure `classifyBeat` |
| `src/lib/ai/script-generation.ts` (+ test) (modify) | schema `camera`/`lighting`; prompt vocab; `sceneToRpcArgs` kind+cinematography+provenance |

## 10. Open items (resolved-by-default; flagged for the plan)

- `shot_kind` is a **new enum** distinct from `shot_source` (kind = producing
  subsystem; source = acquisition path within a kind). Confirmed intentional.
- `seed`/`entities`/continuity intentionally deferred to Slice 1 (continuity belongs
  with generation), so Slice 0 adds no seed column.
