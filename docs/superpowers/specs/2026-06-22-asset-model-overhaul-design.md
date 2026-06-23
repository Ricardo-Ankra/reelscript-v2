# Asset model overhaul — visual briefs, a provider-registry resolver, and formatted errors — design

**Date:** 2026-06-22
**Phase:** 8 (Full surfaces) — reliability & workflow
**Status:** design approved (sections 1–2), ready to write the spec review gate → implementation plans (slice A first)

## Context

A render failed at Gate 2 with a structured payload:

```json
{"phase":"gate2","issues":["Vehicle shown is a white Jeep Wrangler, not a Rivian R2; frame does not match intended content"],"message":"Smoke frame failed QA","frameUrl":"https://…/out.png"}
```

Two problems surfaced:

1. **The error is dumped as raw JSON on the frontend.** The editor does
   `setRenderError(s.error ?? 'Render failed.')`
   (`src/app/(app)/videos/[id]/Editor.tsx:364`) — `s.error` is the structured
   object above, stringified. This applies to every composition/render error or
   alert, not just Gate 2.
2. **The flow dead-ends on an unsatisfiable shot.** Stock search returned a white
   Jeep for a shot that needed a *Rivian R2*. Gate-2 vision QA *correctly* caught
   the mismatch — but there is no recovery. Stock libraries structurally cannot
   depict a specific named entity, and **text-to-video generation has the same
   weakness** (it hallucinates specific real products just as stock substitutes
   them). Swapping the source does not fix this class of failure; routing does.

### Core insight

Reliability here is a **routing problem, not a sourcing problem.** Each shot's
visual need has a *kind*, and only some sources can satisfy each kind:

| Visual need (`specificity`) | Reliable source |
| --- | --- |
| **`entity`** — a specific named product/person/place ("Rivian R2") | **operator-supplied asset** — the only reliable option |
| **`generic`** — a concept ("EV charging at night") | stock (great); generation (fine) |
| **`abstract`** — branded motion / stylized / data-viz | generation or a primitive |
| **`spokesperson`** — talking head | an avatar provider (Heygen), later |

The fix is to make each shot declare a structured **visual requirement**, route
on it, and **fail forward** (ask the operator before spending a render) rather
than guess-and-validate.

### Current state (verified)

- **`shots`** (`supabase/migrations/20260604184050_init_schema.sql`):
  `id, scene_id, position, description text ('the AI's intent for this shot'),
  source shot_source ('stock'|'resource'|'procedural'), resource_id (FK
  channel_resources ON DELETE SET NULL), stock_query text`. The shot is already
  the visual unit; `description` is a terse one-liner.
- **`shot_source` enum:** `stock`, `resource`, `procedural`.
- **`channel_resources`:** `id, channel_id, kind (resource_kind), r2_key,
  source_url (for kind='url'), original_filename, description, tags,
  content_hash, created_at`. Already supports image/video/url + R2 and is the
  store behind the existing per-shot resource binding.
- **Resolver / compose:** `src/lib/assets/*` has `pexels`/`pixabay` adapters,
  `searchStock` (cached), the agentic vision selection loop, and
  `resolveResourceAssets`; `src/lib/composition/compose.ts` builds the prompt
  (`buildCompositionUserPrompt`) and honors `SceneBrief.pinnedResources` as a
  strong pin (shipped in the channel-resource-library slice). Gate 2 (smoke
  frame + vision QA) lives in `src/lib/inngest/functions/render.ts`.
- **Script generation** (the Inngest `generateScript` function) writes scenes +
  shots; the shot `description` and `stock_query` are produced here.
- **Editor** subscribes to `jobs`/`scenes` Realtime; the render readiness today
  is just "are there scenes" — there is no per-shot asset-readiness gate.

## Goal

A shot carries a rich, editable visual brief authored at script time; the asset
resolver routes each shot to the source that can actually satisfy it; the editor
flags shots that need an operator-supplied asset and gates **Generate Video**
until they are resolved; and every composition/render error renders as a clean,
human-readable card instead of raw JSON. The architecture admits AI generation
(text-to-image, then text-to-video / Heygen / Higgsfield) as a later plug-in
with no pipeline change.

## The shared spine (cross-cutting; A/B/C/D all sit on it)

### 1. The Visual Brief — replaces the terse shot `description`

A structured, AI-authored, **operator-editable** brief stored on the `shots` row
(authored at **script time**, Phase 2; surfaced and editable in the scene
editor). Stored as a single `visual_brief jsonb` column (additive; the legacy
`description` is retained for back-compat and seeded from `subject`/`action`):

```ts
export interface VisualBrief {
  subject: string;        // what is literally on screen
  action: string;         // what is happening
  setting: string;        // where / context
  framing: string;        // shot type: wide | close-up | aerial | screen-recording | …
  mood: string;           // tone / lighting
  specificity: 'generic' | 'entity' | 'abstract' | 'spokesperson'; // the routing key
  entity_name?: string;   // required when specificity === 'entity' (e.g. "Rivian R2")
  recommended_source: 'stock' | 'upload' | 'generate' | 'primitive';
}
```

One artifact, three consumers: the **operator** (clarity + editability), the
**router** (reliability), and the **generator** (prompt quality, later). It is
deliberately rich enough to *be* a text-to-video prompt — that is the
generation-ready property.

### 2. The resolver becomes a provider registry

Today's stock path becomes one adapter among several behind a single interface:

```ts
export interface AssetProvider {
  readonly id: 'upload' | 'stock' | 'primitive' | 'heygen' | 'higgsfield' | string;
  // Can this provider satisfy this brief at all? (cheap, no network)
  canHandle(brief: VisualBrief): boolean;
  // Produce/return an asset for the brief, or null if it cannot this time.
  resolve(brief: VisualBrief, ctx: ResolveContext): Promise<ResolvedAsset | null>;
}
```

The registry resolves a shot by walking a **fallback ladder** ordered by the
brief's `specificity` and `recommended_source`:

- `entity` → `upload` only (if no operator asset: the readiness gate stops it
  before render — see §3). Never silently substituted by stock/generation.
- `generic` → `upload` (if pinned) → `stock` → `primitive`.
- `abstract` → `upload` (if pinned) → `generate` (when available) → `primitive`.
- `spokesperson` → `upload` (if pinned) → `generate`/avatar (when available) →
  `primitive`.

`upload`, `stock`, and `primitive` adapters ship in slices B/C by wrapping
existing code (`resolveResourceAssets`, `searchStock`). `heygen`/`higgsfield`
(and a text-to-image adapter) register later in slice D with **no pipeline
change** — the ladder already lists `generate`; until a generate provider is
registered, a `generate` recommendation falls through to the next rung
(`primitive`) with a logged note. `generated` is added to the `shot_source` enum
now so the data model can represent the eventual outcome.

### 3. Fail forward — an editor-side readiness gate (not a mid-pipeline pause)

The editor computes per-shot **readiness**: a shot with `specificity === 'entity'`
and no attached asset (`source !== 'resource'`/no `resource_id`) is **unresolved**.
The **Generate Video** button warns and blocks while any shot is unresolved; the
operator resolves each by attaching an asset (slice B) or explicitly overriding
to "accept a generic/stock alternative" (which relaxes the routing for that shot).
The pipeline never spends a render on a known-unsatisfiable shot. **Gate-2 vision
QA stays as the backstop** for everything the gate cannot predict.

Chosen over pausing the Inngest run mid-flight and resuming on operator input:
that is real pause/resume machinery (Phase 9 resumability) and a single operator
is already in the editor. The readiness gate is pure, testable, and cheap.

## The four slices

### Slice A — Formatted composition/render errors *(ship first; independent; no schema change)*

- A pure formatter (`src/lib/errors/render-error.ts` or similar) parses the
  structured error into a typed shape:
  `{ phase: string | null; message: string; issues: string[]; frameUrl: string | null }`,
  tolerant of a plain-string error (`{ message: <string> }`, no issues/frame) and
  of an unparseable value (fallback message).
- A React card component renders: a **phase badge** (e.g. "Smoke-frame QA · gate2"),
  the human `message`, the `issues` as a bulleted list, and — when `frameUrl` is
  present — the **smoke frame inline** (a thumbnail linking to the full image).
- Surfaced wherever an error shows today: the editor `renderError` path
  (`Editor.tsx:364` and its render site) and the `/jobs` rows' error display.
- **Unit-tested** at the pure formatter (string error, structured error,
  missing fields, garbage). UI verified by `tsc`/`lint`/`build`.

### Slice B — Scene asset tray + operator upload *(biggest reliability win)*

- A per-scene **asset tray** in the scene editor: shows assets attached to the
  scene's shots and an **"upload here"** affordance. Upload reuses the existing
  signed-PUT + `channel_resources` machinery (`createResourceUpload`/
  `confirmResourceUpload` from Phase 5) — the uploaded file becomes a
  `channel_resource` and is bound to the shot via the existing
  `setShotResource` (`source='resource'`, `resource_id=…`).
- This alone fixes the Rivian case: attach the footage to the shot; the resolver
  then prefers it and the readiness gate clears.
- Minimal/no schema change (reuses `channel_resources` + `shots.resource_id`).
  The "tray" is a UI grouping over the scene's shots' resources, not a new table.
- Server actions are RLS-scoped + dual-keyed per existing convention; verified by
  `tsc`/`lint`/`build` (pure grouping logic, if any, unit-tested).

### Slice C — Visual brief authoring + resolver router + readiness gate *(the intelligent layer; biggest slice)*

- **Schema:** add `visual_brief jsonb` to `shots`; add `'generated'` to the
  `shot_source` enum (`ALTER TYPE … ADD VALUE IF NOT EXISTS`). Additive; no
  destructive change.
- **Script generation** emits the structured `VisualBrief` per shot (the prompt
  is extended to author subject/action/setting/framing/mood/specificity/
  entity_name/recommended_source). Existing shot fields stay; `description` is
  seeded from the brief for back-compat.
- **Scene editor** renders and edits the brief per shot (a compact, structured
  form), with `specificity`/`entity_name`/`recommended_source` visible — this is
  where the operator reads and improves the previously-terse descriptions.
- **Resolver** is refactored into the provider registry (§2), wrapping
  `resolveResourceAssets`/`searchStock` as the `upload`/`stock` adapters and the
  procedural path as `primitive`; routing follows the §2 ladder. `compose.ts`
  consumes the brief (the richer intent flows into `buildCompositionUserPrompt`,
  replacing/augmenting the terse description).
- **Readiness gate** (§3): a pure `shotReadiness(brief, shot)` helper
  (unit-tested across the specificity × attached-asset matrix) drives the
  editor's per-shot flag and the **Generate Video** block/override.
- Pure logic (brief parsing/validation, the routing ladder, readiness) is
  unit-tested; the script-gen prompt, server actions, and UI are verified by
  `tsc`/`lint`/`build` + an app-run e2e.

### Slice D — Generation providers *(later; architecture already accommodates)*

- Register a **text-to-image** adapter first (cheaper, the pipeline already
  renders images, far more controllable), then **text-to-video** / **Heygen**
  (avatar/`spokesperson`) / **Higgsfield** (cinematic/`abstract`) as additional
  providers implementing `AssetProvider`. Outcomes are stored with
  `source='generated'`.
- **No pipeline change** — purely "register an adapter." The brief is already a
  generation-grade prompt; the ladder already lists `generate`. Out of scope for
  this round; listed so the spine's decisions are validated against it.

## Data flow

```
Script time (Phase 2):
  generateScript → per shot: VisualBrief {subject…specificity,recommended_source}
    → shots.visual_brief (+ description seeded); editable in the scene editor

Pre-render (editor):
  shotReadiness(brief, shot) per shot
    entity + no asset → UNRESOLVED → Generate Video blocked
    operator: attach asset (slice B)  OR  override → accept generic/stock
    all resolved → Generate Video enabled

Compose / resolve (Phase 4):
  for each shot: registry.resolve(brief) walks the ladder by specificity
    upload (pinned) → stock → generate(when registered) → primitive
  brief flows into buildCompositionUserPrompt (richer than the old description)
  Gate 2 vision QA remains the backstop

Error (any phase):
  job.error / render.error → parseRenderError → <RenderErrorCard>
    phase badge · message · issues[] · smoke-frame thumbnail
```

## Error handling

- **Slice A formatter** never throws: a plain string → `{message}`; a structured
  object → typed fields; anything else → a generic fallback message. The card
  degrades (no `frameUrl` → no image; no `issues` → just the message).
- **Readiness gate** is advisory-with-teeth: it blocks the button but always
  offers an explicit override, so the operator is never hard-stuck (the inverse
  of today's dead-end).
- **Resolver** ladder: a provider returning `null` falls to the next rung; an
  exhausted ladder yields a primitive/typographic fallback (never a crash). A
  `generate` rung with no registered provider logs and falls through.
- **Back-compat:** unset/old `visual_brief` → the resolver falls back to the
  legacy `description`/`stock_query` path (existing behavior), so in-flight
  videos created before this change still compose.

## Back-compatibility

- Additive schema only: a new `shots.visual_brief jsonb` column and a new
  `shot_source` enum value (`generated`). No column drops; `description`/
  `stock_query`/`resource_id` retained and still honored.
- Slice A is fully independent (no schema, no asset-model coupling).
- The resolver refactor preserves the existing stock + resource + procedural
  behavior as the default ladder; videos without a `visual_brief` behave exactly
  as today.
- `regenerateVideo`/voice/render flows are unchanged except that compose now
  prefers the richer brief when present.

## Testing

- **Unit:** the slice-A error formatter (string / structured / missing-field /
  garbage); the `VisualBrief` parser+validator (defaults, `entity` requires
  `entity_name`); the routing ladder (each specificity → expected order); the
  `shotReadiness` matrix (specificity × asset-attached → resolved/unresolved).
- **Regression:** `npm test` green; `npx tsc --noEmit` + `npm run lint` clean;
  `npm run build` succeeds per slice; slice C runs the full gate.
- **App-run e2e (per slice):** A — trigger a Gate-2 failure, see the formatted
  card with the smoke frame. B — attach footage to a shot, the tray shows it,
  the readiness flag clears. C — generate a script, read/edit a shot's brief, set
  a shot to `entity` with no asset → Generate Video blocks → attach or override →
  unblocks → compose prefers the brief.

## Sequencing

**A → B → C → D**, each its own implementation plan and review cycle. A ships
first (independent, unblocks the ugly errors today). B delivers immediate
reliability (operator can satisfy any `entity` shot). C adds the intelligence
(briefs + routing + gate). D adds generation last, behind the registry.

## Open questions

None blocking. Settled: visual brief on `shots.visual_brief` (jsonb), authored
at script time and editable; `specificity` is the routing key; the resolver is a
provider registry with a specificity-ordered fallback ladder; reliability via an
editor-side readiness gate (not a mid-pipeline pause), with Gate-2 vision QA as
the backstop; generation is a later-registered adapter the spine already
accommodates; slice A (formatted errors) is independent and ships first.
