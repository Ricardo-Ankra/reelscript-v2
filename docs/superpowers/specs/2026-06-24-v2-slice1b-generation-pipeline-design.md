# Reelscript V2 — Slice 1b: Generation pipeline — Design

> **Reelscript V2 program, Slice 1 (Higgsfield generation spine), sub-slice 1b.**
> 1a shipped the cores + provider seam + fake + the generation data contract
> (columns + `entities` table), unit-proven with zero external calls and **nothing
> wired into the pipeline**. 1b wires the seam into Inngest: a per-generative-shot
> keyframe → Higgsfield-clip → R2 flow, proven end-to-end against the fake provider
> with no credentials.

## 0. Context & locked decisions

- **Program runtime/data decisions** are locked in the V2 program (existing Next.js +
  Supabase + RLS + Inngest + Remotion Lambda + R2). See
  `2026-06-24-v2-slice0-shot-model-contract-design.md` §0 and
  `2026-06-24-v2-slice1a-generation-cores-design.md` §0.
- **Slice 1b decisions (this sub-slice):**
  1. **Continuity = a deterministic per-video seed only.** All generative shots in a
     video share one seed derived from the video id; it is recorded on each clip's
     `provenance`. The image-to-video keyframe is the inherent per-shot reference. True
     per-recurring-entity seed-locking + reference-image carry **defer to a later slice**
     that first adds recurring-entity extraction to script-gen. The `entities` table
     (shipped in 1a) stays forward-provisioned and **unused in 1b**.
     - *Why:* `classifyBeat` maps `specificity==='entity'` → `live_action` (a real
       attached asset), so a generative "entity" is a recurring character/location across
       generative shots — which we have no extraction mechanism for yet. A per-video seed
       is the faithful minimal continuity primitive; it does not pretend to lock entities
       it cannot identify.
  2. **Provider resolution = an env-gated factory** (`getGenerationProvider`) defaulting
     to the fake. Real adapters drop in behind it when creds exist.
  3. **Trigger = a standalone Inngest function + a drive script.** The master
     `reelscript.pipeline` orchestration is Slice 6; 1b is invoked directly (a
     `generation/run` event) so the spine is provable in isolation.
  4. **first/last-frame chaining still defers** past Slice 2 (needs ffmpeg last-frame
     extraction). 1b writes `keyframe_first_key` and `clip_key`; `keyframe_last_key`
     stays null.
- Sandbox build: no concern for DB migration / data loss.

## 1. Goal & non-goals

**Goal.** For each `kind==='generative'` shot in a video, durably: generate a keyframe
still from its `VisualBrief` + `CameraSpec` + `LightingSpec`, stream it to R2
(`shots.keyframe_first_key`); then submit a Higgsfield clip (keyframe + motion + routed
model + per-video seed), poll it to completion mirroring `runLambdaSpine`, stream the
result to R2 (`shots.clip_key`), and record `routed_model` + a filled `provenance`. Prove
the whole flow headlessly against the fake provider with a drive script — no creds.

**Non-goals (deferred).** No real Higgsfield/image adapters (behind the factory when
creds exist). No recurring-entity extraction, no per-entity seed-locking, no
reference-image carry (later slice; `entities` table stays unused). No first/last-frame
chaining (post–Slice 2). No assembly — the generated `clip_key` is consumed at the
assembly spine (Slice 3); **nothing renders or composes differently this slice.** No cost
metering of generation (added with the real adapter). No gate/UI (Slice 4). No master
pipeline (Slice 6).

## 2. Current state (anchors)

- `src/lib/generation/` (1a) — `provider.ts` (the seam), `fake-provider.ts`
  (`createFakeProvider({ pollsUntilReady, stillUrl?, clipUrl? })` + `failNext()`),
  `motion-presets.ts` (`resolveMotion`), `prompt.ts` (`buildClipPrompt`), `router.ts`
  (`route(shot) → Engine`, `Engine = 'remotion' | 'ingest' | \`higgsfield.${string}\``).
- `src/lib/r2.ts` — `streamUrlToR2(url, key, contentType?)`, `signedGetUrl(key, ttl)`,
  `putObject`.
- `shots` carries (Slice 0) `kind`/`camera_spec`/`lighting_spec`/`provenance`/`hero`/
  `needs_speech`/`broadcast_4k`/`visual_brief` and (Slice 1a) `keyframe_first_key`/
  `keyframe_last_key`/`clip_key`/`routed_model`.
- `src/lib/inngest/functions/render.ts` — `runLambdaSpine(step, params)` is the durable
  poll reference: `step.run('invoke-lambda')` → `for attempt<MAX_POLLS { step.run(\`poll-${attempt}\`); if done return; await step.sleep(\`wait-${attempt}\`,'3s') }`.
  Functions take `createAdminClient()`; events fire via `inngest.send(...)`.
- `src/app/api/inngest/route.ts` — `functions: [renderVideo, renderSample, generateScript, synthesizeVoice, musicRemux, deployPrimitive]`.
- `scripts/drive-render.ts` (+ `npm run drive:render`) — the drive-script pattern:
  admin client + `inngest.send` to the local dev server, then inspect.
- Parsers: `parseVisualBrief` (`videos/visual-brief.ts`), `parseCameraSpec`/
  `parseLightingSpec`/`parseProvenance` (`videos/cinematography.ts`).

## 3. Provider factory — `src/lib/generation/provider-factory.ts` (server-only)

The single resolution point so orchestration never names a concrete provider.

```ts
import type { GenerationProvider } from './provider';
import { createFakeProvider } from './fake-provider';

// Resolve the generation provider. Default 'fake' (headless, no creds). Real adapters
// (Higgsfield clip + a text→still image model) drop in here behind the same seam when
// credentials exist — no orchestration change.
export function getGenerationProvider(): GenerationProvider {
  const which = process.env.GENERATION_PROVIDER ?? 'fake';
  switch (which) {
    case 'fake':
      return createFakeProvider({
        stillUrl: process.env.GEN_FAKE_STILL_URL,
        clipUrl: process.env.GEN_FAKE_CLIP_URL,
      });
    case 'higgsfield':
      throw new Error('GENERATION_PROVIDER=higgsfield not configured yet (no adapter)');
    default:
      throw new Error(`Unknown GENERATION_PROVIDER: ${which}`);
  }
}
```

When `which==='fake'`, the factory also reads two **optional** fixture env vars and
passes them through to the fake — `createFakeProvider({ stillUrl: process.env.GEN_FAKE_STILL_URL, clipUrl: process.env.GEN_FAKE_CLIP_URL })`
(undefined when unset → the fake's built-in defaults). This is the **only** seam the
drive script needs: it triggers the Inngest function (which builds its own provider via
the factory), so the fixtures must reach the fake through env, not a direct constructor
call (§7). In normal runs both are unset.

## 4. Pure additions (tested)

### 4.1 `src/lib/generation/seed.ts` (+ test)
`videoSeed(videoId: string): number` — a deterministic, stable, non-negative 32-bit
integer hash of the video id (e.g. FNV-1a over the UTF-8 bytes, `>>> 0`). Same id →
same seed across runs and processes. Pure, total. Tested: deterministic (same input →
same output), differs across ids, always a non-negative safe integer.

### 4.2 `src/lib/generation/prompt.ts` — add `buildStillPrompt` (+ test)
A keyframe is a **still**: it has framing/subject/setting/lighting but **no motion**.
`buildStillPrompt(brief, camera, lighting): string` mirrors `buildClipPrompt` minus the
`Camera: {move}…` line:

```
"{shot_size} {angle} angle, {lens_mm}mm lens, {dof} depth of field. {subject}.
{action}. {setting}. {lighting.key}, {lighting.ratio} key-to-fill,
{lighting.time_of_day}, {lighting.palette}, {lighting.texture}. Negative: {NEGATIVE}."
```

`NEGATIVE` is the same fixed default already in `prompt.ts` (reused, not duplicated).
Pure, total. Tested: front-loads shot size; includes subject/setting + lighting; **omits
the camera-move clause**; ends with the negative.

## 5. The generation spine + Inngest function

### 5.1 `src/lib/inngest/functions/generate-shots.ts` (create) → `generateShots`

- **Trigger:** `triggers: [{ event: 'generation/run' }]`; `data: { videoId, accountId, jobId? }`.
- **`cancelOn`:** mirror the existing pattern —
  `[{ event: 'jobs/cancel', if: 'async.data.jobId == event.data.jobId' }]`.
- **Body:**
  1. `const admin = createAdminClient(); const provider = getGenerationProvider();`
  2. `const seed = videoSeed(videoId);`
  3. Load the video's generative shots (one query):
     `admin.from('shots').select('id, visual_brief, camera_spec, lighting_spec, hero, needs_speech, broadcast_4k').eq('kind','generative')` joined to the video's scenes
     (shots have no `video_id`; filter by `scene_id in (scenes where video_id=…)` — same
     two-step as `drive-render.ts`). Skip shots that already have a `clip_key` (idempotent
     re-runs).
  4. For each shot, run the per-shot spine (§5.2). Per-shot `step.run`/`step.sleep` ids
     are namespaced by `shot.id` so Inngest checkpoints are unique and a mid-run failure
     resumes per shot.
  5. Return a summary `{ generated: <count> }` (and, if `jobId`, no job-status writes in
     1b — job rows are a Slice-6 concern; keep 1b self-contained).

### 5.2 `runGenerationSpine(step, provider, admin, shot, seed)` (a module-local helper)

Mirrors `runLambdaSpine`'s shape (takes `step: any`); each external touch is its own
durable `step.run`:

1. **`keyframe-${shot.id}`** — parse the shot's brief/camera/lighting (the never-throw
   parsers; a generative shot authored by script-gen always has camera/lighting, but
   default if absent). `prompt = buildStillPrompt(brief, camera, lighting)`.
   `const { url } = await provider.generateStill({ prompt, aspectRatio, seed, styleRefUrl: null })`.
   `const keyframeKey = \`generation/${shot.id}/keyframe.png\`; await streamUrlToR2(url, keyframeKey, 'image/png');`
   then write `admin.from('shots').update({ keyframe_first_key: keyframeKey }).eq('id', shot.id)`.
   Return `keyframeKey`. (`aspectRatio` — derive from the video's settings; pass `'9:16'`
   as the default if unavailable. Loaded once at the top of `generateShots` and threaded
   in.)
2. **`submit-${shot.id}`** — `const imageUrl = await signedGetUrl(keyframeKey, 3600);`
   `const { motionId, motionStrength } = resolveMotion(camera);`
   `const clipPrompt = buildClipPrompt(brief, camera, lighting);`
   `const engine = route({ kind:'generative', camera, hero, needs_speech, broadcast_4k });`
   `const model = engine.replace('higgsfield.', '');`
   `const { requestId } = await provider.submitClip({ prompt: clipPrompt, imageUrl, motionId, motionStrength, seed, model });`
   Return `{ requestId, model }`.
3. **Poll loop** — `for (let attempt=0; attempt<MAX_POLLS; attempt++)`:
   `const status = await step.run(\`poll-${shot.id}-${attempt}\`, () => provider.checkClip(requestId));`
   if `status.state==='failed'` → `throw new Error(\`clip failed: ${status.error}\`)`;
   if `status.state==='completed'` → break with `status.mediaUrl`;
   else `await step.sleep(\`wait-${shot.id}-${attempt}\`, '3s')`. After the loop with no
   completion → `throw new Error('clip generation timed out')`. (`MAX_POLLS` a module
   const, e.g. 150 — same as render.)
4. **`finalize-${shot.id}`** — `const clipKey = \`generation/${shot.id}/clip.mp4\`;`
   `await streamUrlToR2(mediaUrl, clipKey, 'video/mp4');`
   `const provenance: Provenance = { synthetic: true, source: \`higgsfield:${model}\`, model, seed, source_uri: null };`
   (the full `Provenance` shape from `cinematography.ts` — `synthetic`/`source`/`model`/`seed`/`source_uri`)
   `await admin.from('shots').update({ clip_key: clipKey, routed_model: model, provenance }).eq('id', shot.id);`

> **`shots.keyframe_first_key` vs `entities.keyframe_key`:** the shot column is the
> per-shot generated keyframe written here; `entities.keyframe_key` (1a, unused in 1b)
> is the future per-recurring-entity reference anchor for seed-locking. A code comment
> at the writer notes the distinction (carried 1a minor).

### 5.3 Registration
Add `generateShots` to `src/app/api/inngest/route.ts`'s `functions` array.

## 6. The 1a minor carried into router

Tighten `HERO_MOVES` in `router.ts` from `string[]` to `readonly CameraMove[]` (a
typed tuple) so a future move-name typo is a compile error. No behavior change.

## 7. Drive script — `scripts/drive-generation.ts` (+ `npm run drive:generation`)

Mirrors `drive-render.ts`. Proves keyframe→clip→R2 **fully offline**:

1. `const videoId = process.argv[2]` (usage error if absent). Admin-load the video for
   `account_id` and settings (aspect ratio).
2. **Ensure a generative shot exists.** If the video has no `kind='generative'` shot,
   the script logs and exits with guidance (1b does not author shots — script-gen does;
   the drive script operates on an existing video). It does **not** fabricate scenes.
3. Configure the fake with `data:`-URL fixtures so `streamUrlToR2`'s `fetch` resolves
   with **zero external HTTP** (Node's undici `fetch` supports `data:` URLs). Because the
   Inngest function builds its own provider via `getGenerationProvider()`, the fixtures
   are supplied through env the factory reads when present:
   `GEN_FAKE_STILL_URL` / `GEN_FAKE_CLIP_URL` (the factory passes them into
   `createFakeProvider({ stillUrl, clipUrl })` when set). The drive script sets these to
   tiny `data:image/png;base64,…` / `data:video/mp4;base64,…` fixtures (trivial bytes —
   R2 `putObject` does not validate content; we only prove the round-trip + key write).
4. `await inngest.send({ name: 'generation/run', data: { videoId, accountId } })`.
5. Poll the shots' `clip_key`/`keyframe_first_key` until populated (or timeout), then
   `signedGetUrl` each and report. Confirms the keys exist in R2.

> The factory gains two optional env reads (`GEN_FAKE_STILL_URL`/`GEN_FAKE_CLIP_URL`)
> used only when `GENERATION_PROVIDER` is `fake` (the default) — so the drive script
> needs no separate code path into the function. In normal runs they are unset and the
> fake's built-in defaults apply.

## 8. Testing

- **Unit (node:test):** `videoSeed` (deterministic/stable/non-negative-int);
  `buildStillPrompt` (framing+subject+lighting, no move clause, ends with negative).
- **Spine + function:** proven via `npm run drive:generation` against the fake (following
  the `runLambdaSpine`/`drive:render` precedent — Inngest spines are proven by drive
  scripts, not unit-tested, because they need the Inngest runtime + R2).
- **Gates:** `npm test`, `npm run typecheck`, `npm run lint`, `npm run build` all green.
- **No migration** (1a added the columns + `entities` table).

## 9. Backward compatibility

Additive: new modules (`provider-factory.ts`, `seed.ts`, `generate-shots.ts`,
`drive-generation.ts`), one new pure function in `prompt.ts`, one typed-tuple tightening
in `router.ts`, one new Inngest registration. The new function only fires on an explicit
`generation/run` event — nothing in the existing pipeline sends it yet (Slice 6 wires it
in). Compose/render/readiness/script-gen are untouched; videos with no generative shots
are unaffected.

## 10. File structure (drives the plan)

| File | Responsibility |
| --- | --- |
| `src/lib/generation/seed.ts` (+ test) (create) | `videoSeed(videoId)` deterministic per-video seed |
| `src/lib/generation/prompt.ts` (modify, + test) | add `buildStillPrompt` (keyframe, no motion) |
| `src/lib/generation/provider-factory.ts` (create) | env-gated `getGenerationProvider()` (default fake) |
| `src/lib/generation/router.ts` (modify) | `HERO_MOVES: readonly CameraMove[]` (1a minor) |
| `src/lib/inngest/functions/generate-shots.ts` (create) | `generateShots` + `runGenerationSpine` (keyframe→submit→poll→finalize) |
| `src/app/api/inngest/route.ts` (modify) | register `generateShots` |
| `scripts/drive-generation.ts` (create) + `package.json` (modify) | headless keyframe→clip→R2 proof against the fake (`data:`-URL fixtures) |

## 11. Open items (resolved-by-default; flagged for the plan)

- `MOTION_ID` UUIDs remain placeholders (1a flag) — unchanged; the fake ignores them.
- Cost metering of generation is deferred to the real-adapter slice (the fake has no
  cost). Flagged so the ledger pattern is added alongside real creds.
- Per-video seed is the minimal continuity primitive; per-entity seed-locking +
  reference-image carry + recurring-entity extraction are a later slice. The `entities`
  table stays unused in 1b.
- Aspect ratio for `generateStill` is read from the video settings with a `'9:16'`
  default; the fake ignores it (real image adapter uses it).
