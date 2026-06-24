# Reelscript V2 — Slice 1a: Generation cores & provider seam — Design

> **Reelscript V2 program, Slice 1 (Higgsfield generation spine), sub-slice 1a.**
> Slice 1 is the riskiest integration (the long-deferred asset-overhaul Slice D) and
> was sub-decomposed into **1a (cores + seam, this doc)** and **1b (pipeline)**. 1a
> delivers everything 1b needs to orchestrate generation — the provider seam + a fake,
> the pure cores (motion presets, prompt, router), an R2 stream helper, and the
> generation data-contract schema — **all unit-tested with zero external calls**.

## 0. Context & locked decisions

- **Program runtime/data decisions** are locked in the V2 program: existing Next.js +
  Supabase + RLS + Inngest + Remotion Lambda + R2; see
  `2026-06-24-v2-slice0-shot-model-contract-design.md` §0.
- **Slice 1 decisions (this sub-slice's parents):**
  1. **Build behind a provider seam + a fake.** The full generation pipeline is proven
     headlessly with a fake provider; real Higgsfield + text→still image-model adapters
     drop in behind the same interface when credentials exist (env / credentials vault).
  2. **Sub-decompose 1a → 1b.** 1a = cores + seam + schema (unit-proven, no Inngest).
     1b = the Inngest pipeline (keyframeGenerator + higgsfieldShot durable poll), seed
     assignment + reference-image carry, and a drive script proving keyframe→clip→R2
     end-to-end with the fake.
  3. **first/last-frame chaining defers** past Slice 2 (it needs the media-conform ffmpeg
     Lambda to extract a clip's last frame). 1a/1b continuity = locked-seed-per-entity +
     reference-image carry only.
- Sandbox build: no concern for DB migration / data loss.

## 1. Goal & non-goals

**Goal.** Ship the generation building blocks 1b consumes: a typed `GenerationProvider`
seam, a configurable fake provider that simulates the async clip lifecycle, the pure
cores (`resolveMotion`, `buildClipPrompt`, `route`), an R2 stream-to-key helper, and the
generation data-contract schema (`shots` generation-output columns + an `entities`
table). All pure logic is unit-tested; nothing calls an external API.

**Non-goals (deferred).** No Inngest functions, no durable poll, no keyframe/clip flow
(1b). No real Higgsfield/image-model adapters (written when creds exist, behind this
seam). No seed-assignment logic or reference-image carry (1b). No first/last-frame
chaining (post–Slice 2). No change to `render.ts`/compose/assembly (the generated clip
is consumed at assembly, Slice 3). Nothing renders or resolves differently this slice.

## 2. Current state (anchors)

- `src/lib/r2.ts` — `putObject(key, body, contentType)`, `signedGetUrl(key, ttl)`,
  `signedPutUrl`, `deleteObject`. (Stream-to-key = `fetch(url)` → `putObject`.)
- `src/lib/inngest/functions/render.ts` — `runLambdaSpine` is the durable-poll
  reference (`invoke-lambda` step → `poll-${attempt}` step loop → `step.sleep('3s')`);
  1b's Higgsfield poll mirrors it. Asset resolution has no generation path yet.
- Slice 0 (`src/lib/videos/cinematography.ts`) — `ShotKind`, `CameraSpec`,
  `LightingSpec`, `CameraMove` (the move enum), `Provenance`; `src/lib/videos/visual-brief.ts`
  — `VisualBrief`. `shots` carries `kind`/`camera_spec`/`lighting_spec`/`provenance`/
  `hero`/`needs_speech`/`broadcast_4k`.

## 3. Provider seam — `src/lib/generation/provider.ts` (types only)

Image generation is fast (await a result); video generation is the long async job 1b
drives with a durable poll. Two interfaces, composed.

```ts
export interface StillRequest {
  prompt: string;                 // from buildClipPrompt or a still-specific prompt (1b passes it)
  aspectRatio: string;            // '9:16' | '1:1' | '16:9'
  seed: number | null;            // continuity
  styleRefUrl: string | null;     // a live_action sibling frame (Slice 2+); null in 1a/1b
}
export interface StillResult { url: string }   // a fetchable URL the pipeline streams to R2

export interface ClipRequest {
  prompt: string;                 // buildClipPrompt(...)
  imageUrl: string;               // the ingredient keyframe (a presigned R2 GET url)
  motionId: string;               // resolveMotion(...).motionId
  motionStrength: number;         // resolveMotion(...).motionStrength
  seed: number | null;
  model: string;                  // routed model, e.g. 'dop-preview'
}
export interface ClipSubmit { requestId: string }
export type ClipStatus =
  | { state: 'pending' }
  | { state: 'completed'; mediaUrl: string }   // fetchable URL (expires ~1h → stream to R2 now)
  | { state: 'failed'; error: string };

export interface ImageProvider { generateStill(req: StillRequest): Promise<StillResult> }
export interface VideoProvider {
  submitClip(req: ClipRequest): Promise<ClipSubmit>;
  checkClip(requestId: string): Promise<ClipStatus>;
}
export interface GenerationProvider extends ImageProvider, VideoProvider {}
```

## 4. Fake provider — `src/lib/generation/fake-provider.ts` (+ test)

A configurable test double (constructed with `{ pollsUntilReady?: number; stillUrl?; clipUrl? }`,
default `pollsUntilReady: 2`). It is the harness that proves the spine headlessly in 1b.

- `generateStill(req)` → `{ url: stillUrl }` (default a fixture `https://fake.local/still/<seed|noseed>.png`).
- `submitClip(req)` → `{ requestId }` (deterministic, e.g. `fake-<n>` from an internal counter).
- `checkClip(requestId)` → `{ state: 'pending' }` for the first `pollsUntilReady` calls
  on that id, then `{ state: 'completed', mediaUrl: clipUrl }`. An in-memory
  `Map<requestId, count>` tracks calls (a stateful test double — acceptable; it is not
  presented as pure).
- Exposes a way to force a failure path (e.g. a request whose prompt contains a sentinel,
  or a `failNext()` toggle) so 1b can test the `failed` branch.

Tested: still URL returned; submit returns an id; checkClip returns `pending` exactly
`pollsUntilReady` times then `completed`; the failure path yields `{state:'failed'}`.

## 5. Pure cores

### 5.1 `src/lib/generation/motion-presets.ts` (+ test)
`MOTION_ID: Record<CameraMove, string>` — every `CameraMove` from Slice 0 mapped to a
placeholder UUID, with a header comment: **confirm against the live Higgsfield preset
list before going live (v3 §12).** `resolveMotion(camera: CameraSpec) → { motionId: string;
motionStrength: number }` returns `MOTION_ID[camera.move]` + `camera.motion_strength`.
Tested: every move resolves to a non-empty id; motionStrength passes through.

### 5.2 `src/lib/generation/prompt.ts` (+ test)
`buildClipPrompt(brief: VisualBrief, camera: CameraSpec, lighting: LightingSpec) → string`
per v3 §6: `"{shot_size} {angle} angle, {lens_mm}mm lens, {dof} depth of field.
{subject}. {action}. {setting}. {lighting.key}, {lighting.ratio} key-to-fill,
{lighting.time_of_day}, {lighting.palette}, {lighting.texture}. Camera: {move (spaced)},
smooth and deliberate. Negative: {NEGATIVE}."` where `NEGATIVE` is the fixed default
`"no text, no logo, no warped anatomy, no smeared motion blur"`. Pure, total. Tested:
front-loads shot size; one move (spaces underscores); includes the negative.

### 5.3 `src/lib/generation/router.ts` (+ test)
`type Engine = 'remotion' | 'ingest' | \`higgsfield.${string}\``; `route(shot) → Engine`
per v3 §4, consuming Slice-0 fields:
- `kind==='motion_graphic'` → `'remotion'`; `kind==='live_action'` → `'ingest'`.
- `kind==='generative'`: if `camera.move ∈ {orbit_360,bullet_time,arc_left,arc_right,snorricam,whip_pan,fpv_drone}` → `'higgsfield.dop-preview'`; else `needs_speech` → `'higgsfield.veo-3.1'`; else `broadcast_4k` → `'higgsfield.kling-3.0'`; else `hero` → `'higgsfield.seedance-2.0'`; else `'higgsfield.dop-preview'`.
Input is a minimal structural type (`{ kind; camera: CameraSpec | null; hero; needs_speech; broadcast_4k }`) so it stays a pure unit. Tested: each branch + the default; a generative shot with no camera → default dop-preview.

(`fallbacks` from v3 §4 — `seedance→dop-preview`, `veo→kling`, `dop-preview→dop-lite` —
are a 1b/runtime concern; not in 1a's pure router.)

## 6. R2 stream helper — `src/lib/r2.ts`

Add `streamUrlToR2(url: string, key: string, contentType?: string): Promise<string>`:
`fetch(url)` → error-check → `putObject(key, Buffer.from(await res.arrayBuffer()),
contentType ?? res.headers content-type ?? 'application/octet-stream')` → return `key`.
(server-only, mirrors the existing fetch-then-`putObject` pattern in `render.ts`'s
`store-mp4-in-r2` step.) Not unit-tested (network I/O); exercised via 1b's drive script.

## 7. Schema — `supabase/migrations/<ts>_v2_generation_contract.sql`

Additive (the generation-output columns deferred from Slice 0):
- `shots`: `keyframe_first_key text`, `keyframe_last_key text`, `clip_key text`,
  `routed_model text` (all nullable; populated by 1b).
- New `entities` table (locked-seed-per-entity continuity):
  `id uuid pk default gen_random_uuid()`, `account_id uuid not null references accounts(id) on delete cascade`,
  `video_id uuid not null references videos(id) on delete cascade`, `name text not null`,
  `seed integer not null`, `keyframe_key text`, `created_at timestamptz not null default now()`,
  `unique (video_id, name)`.
- RLS on `entities`: enable + an account-isolation policy keyed to the account (mirror
  the existing per-table `acct_isolation` policy pattern). Applied to the sandbox DB + verified.

**1a defines these; 1b populates them.** No RPC changes (the `upsert_scene_with_shots`
shot insert does not set generation-output columns — they're written later by 1b's
generation functions, not at script time).

## 8. Testing

- `resolveMotion`, `buildClipPrompt`, `route` — pure unit tests (every branch).
- Fake provider — lifecycle (still; submit; pending×N→completed; failed path).
- Migration applied to the sandbox DB; columns + `entities` table + RLS verified.
- `streamUrlToR2` — not unit-tested (network); proven via 1b's drive script.

## 9. Backward compatibility

Purely additive: new modules under `src/lib/generation/`, one new helper in `r2.ts`, new
nullable columns + a new table. Nothing existing imports them yet (1b wires them). No
behavior change to compose/render/readiness/script-gen.

## 10. File structure (drives the plan)

| File | Responsibility |
| --- | --- |
| `src/lib/generation/provider.ts` (create) | the seam — `GenerationProvider`/`ImageProvider`/`VideoProvider` + request/result types |
| `src/lib/generation/fake-provider.ts` (+ test) (create) | configurable fake simulating the async clip lifecycle |
| `src/lib/generation/motion-presets.ts` (+ test) (create) | `MOTION_ID` map + `resolveMotion` |
| `src/lib/generation/prompt.ts` (+ test) (create) | `buildClipPrompt` |
| `src/lib/generation/router.ts` (+ test) (create) | `route(shot) → Engine` |
| `src/lib/r2.ts` (modify) | add `streamUrlToR2` |
| `supabase/migrations/<ts>_v2_generation_contract.sql` (create) | generation-output columns + `entities` table + RLS |

## 11. Open items (resolved-by-default; flagged for the plan)

- `MOTION_ID` UUIDs are placeholders — confirm against the live Higgsfield preset list at
  go-live (v3 §12). Flagged in-file.
- The image (still) provider is `await`-style (fast); only the video provider is
  async submit/poll. Confirmed intentional.
- Real Higgsfield/image-model adapters are NOT written in 1a (untestable without creds);
  they land behind this seam when creds exist. The fake is the only provider 1a ships.
