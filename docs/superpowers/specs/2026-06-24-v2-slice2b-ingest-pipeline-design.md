# Reelscript V2 — Slice 2b: Ingest pipeline — Design

> **Reelscript V2 program, Slice 2 (live-action ingest), sub-slice 2b.**
> Slice 2 conforms live-action footage (probe → conform/trim/reframe → keyframe) so the
> assembly spine (Slice 3) can sequence consistent clips. 2a shipped the foundation
> (Lambda probe mode + `invokeProbe` + the pure `parseProbe`/`buildConformArgs`/
> `buildKeyframeArgs` cores, all unit-tested). **2b wires those cores into a durable
> `ingestShots` Inngest function**, adds the `shots.footage_key`/`shots.style_ref_key`
> contract, and ships an operator drive script. Like 1b's `generateShots`, it is additive
> and **fires only on an explicit `ingest/run` event nothing sends yet** (Slice 6 wires it
> into the master pipeline).

## 0. Context & locked decisions

- **Program runtime/data decisions** are locked in the V2 program (existing Next.js +
  Supabase + RLS + Inngest + Remotion Lambda + R2). See
  `2026-06-24-v2-slice0-shot-model-contract-design.md` §0.
- **Slice 2 decisions (this sub-slice's parents):** probe IS included; styleRef =
  extract + store only (defer wiring); **uploaded/resource footage only**
  (`source='resource'`, bytes already in R2 via `channel_resources.r2_key`; the stock
  search/agentic loop is untouched, stock-sourced conform defers to Slice 3). See
  `2026-06-24-v2-slice2a-ingest-foundation-design.md` §0.
- **2b decisions (this doc):**
  1. **Mirror 1b's `generateShots` spine exactly.** Same shape: a job-style Inngest fn
     fired by an explicit event nothing sends yet, 2-arg `triggers` + `cancelOn` by
     `jobId`, loads its shots via scene ids (shots have no `video_id`), filters on the
     output column being null so re-runs are idempotent, and runs a per-shot durable
     spine with every step **namespaced by shot UUID** (no Inngest checkpoint collision).
  2. **Reframe images too, not just video.** A `source='resource'` shot can pin an image
     or a video (`channel_resources.kind`). Video shots run probe → conform (reframe +
     normalize + trim + autorotate) → styleRef keyframe. **Image shots run a single
     image-conform** (reframe to target dims; no fps/trim/audio/probe) and use the
     conformed still as their own styleRef. This needs one new pure builder,
     `buildImageConformArgs`, beside 2a's two.
  3. **No fake seam — the drive script is operator-run against the real Lambda.** Unlike
     generation (which has a `fake-provider` seam), ingest calls the deployed ffmpeg
     Lambda directly. The pure cores are unit-tested and the wiring is verified by an
     operator `drive:ingest` against the real Lambda (the `drive:remux` precedent). 2a's
     operator gate (redeploy the probe Lambda + `smoke:probe`) is a prerequisite for that
     proof; building 2b (migration + fn + drive script + all gates) needs no AWS.
  4. **styleRef = store only.** Write `shots.style_ref_key`; do **not** wire it into any
     generative sibling's `styleRefUrl` (no generative↔live-action link in the model yet —
     mirrors 1b's unused-`entities` deferral).
- Sandbox build: no concern for DB migration / data loss.

## 1. Goal & non-goals

**Goal.** Ship the durable ingest pipeline: a `shots.footage_key` + `shots.style_ref_key`
migration, an `ingestShots` Inngest function that conforms every uploaded/resource
live-action shot of a video (video → probe/conform/trim/keyframe; image → reframe) to the
video's target dims + fps and records the conformed footage key + styleRef key
idempotently, and a `scripts/drive-ingest.ts` operator proof.

**Non-goals (deferred).** No styleRef *wiring* into generation (store only). No
stock-sourced conform (Slice 3 resolve restructure). No in-point/trim-window (trim is
front-anchored to `shot.duration_seconds`). **No change to `render.ts`/compose/assembly** —
the conformed footage + styleRef are *recorded* this slice; the assembly spine (Slice 3)
consumes them. Nothing renders or resolves differently. No new fake provider. No cost
metering of the ffmpeg Lambda calls.

## 2. Current state (anchors)

- `src/lib/inngest/functions/generate-shots.ts` — **the spine to mirror.** `generateShots`:
  `triggers:[{event:'generation/run'}]` + `cancelOn:[{event:'jobs/cancel', if:'async.data.jobId == event.data.jobId'}]`; `load-video` step reads `settings.aspect_ratio`;
  `load-shots` resolves scene ids then `shots…in('scene_id',…).eq('kind',…).is('clip_key',null)`;
  a per-shot `runGenerationSpine` with `step.run` names suffixed `-${shot.id}`.
- `src/lib/ingest/probe.ts` — `parseProbe(raw): ProbeResult` (never-throws).
- `src/lib/ingest/ffmpeg.ts` — `buildConformArgs(ConformInput)` and
  `buildKeyframeArgs(KeyframeInput)` (pure, unit-tested). **2b adds `buildImageConformArgs`.**
- `src/lib/music/remux-invoke.ts` — `invokeRemux({args, inputs, outputs, outputContentType})`
  runs the ffmpeg Lambda (one output per call here); `invokeProbe(inputUrl): RawProbe`.
- `src/lib/assets/resolve.ts` — `resolveResourceAssets` shows the resource lookup:
  `channel_resources.select('r2_key, kind').eq('id',resourceId).eq('account_id',…)`;
  `kind === 'video' ? 'video' : 'image'`.
- `src/lib/r2.ts` — `signedGetUrl(key, ttl=3600)`, `signedPutUrl(key, contentType, ttl=600)`.
- `src/lib/inngest/functions/render.ts` — `DIMS = {'9:16':{1080,1920},'1:1':{1080,1080},
  '16:9':{1920,1080}}`; `fps = settings.fps ?? 30`; `ratio = settings.aspect_ratio ?? '9:16'`.
  (2b reuses the same target derivation; `DIMS` is re-declared locally — small, stable map,
  matching how `generateShots` re-reads `settings.aspect_ratio` rather than importing.)
- `src/app/(app)/videos/[id]/shot-actions.ts` — `setShotResource` writes
  `shots.{source:'resource', resource_id}` (the pin 2b reads).
- Tests: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test`;
  sibling imports use explicit `.ts` extensions.

## 3. Migration — `supabase/migrations/<ts>_v2_ingest_contract.sql`

Additive; mirrors `20260624130000_v2_generation_contract.sql`. No RPC change — these are
pipeline outputs, never authored by script-gen.

```sql
-- Reelscript V2 Slice 2b: the ingest data contract. Additive — conform-output columns on
-- shots, written by 2b's ingestShots pipeline. footage_key = the conformed clip/still in
-- R2 (target dims/fps); style_ref_key = a representative still (extract+store only, not
-- wired to generation yet).
alter table shots add column if not exists footage_key   text;
alter table shots add column if not exists style_ref_key text;
```

## 4. Pure image-conform builder — `src/lib/ingest/ffmpeg.ts` (+ test)

Add beside `buildConformArgs`/`buildKeyframeArgs`. Reframe a still image to target dims
(cover), one image out. No fps/audio/trim/movflags (those are video concerns); geometry is
target-driven, never source-dim arithmetic (same invariant as `buildConformArgs`).

```ts
export interface ImageConformInput {
  inPath: string;
  outPath: string;
  target: { width: number; height: number };
}
export function buildImageConformArgs(input: ImageConformInput): string[];
// -y -i in -vf scale=W:H:force_original_aspect_ratio=increase,crop=W:H -frames:v 1 out
```

Tested: scale+crop present for the target; `-frames:v 1` present; no `-c:a`/`-r`/`-t`/
`-movflags`; no source-dimension arithmetic (target dims only).

## 5. Ingest pipeline — `src/lib/inngest/functions/ingest-shots.ts` (new)

Mirrors `generate-shots.ts` structurally.

### 5.1 Function shell
```ts
export const ingestShots = inngest.createFunction(
  {
    id: 'ingest-shots',
    retries: 2,
    triggers: [{ event: 'ingest/run' }],
    cancelOn: [{ event: 'jobs/cancel', if: 'async.data.jobId == event.data.jobId' }],
  },
  async ({ event, step }) => { … },
);
```
- `event.data = { videoId, accountId, jobId? }`. `admin = createAdminClient()`.
- `load-video` step → target: `{ width, height, fps }` from `settings.aspect_ratio`
  (`DIMS[ratio] ?? DIMS['9:16']`) + `settings.fps ?? 30`.
- `load-shots` step: resolve `scenes.id` for the video, then
  `shots.select('id, resource_id, duration_seconds').in('scene_id', sceneIds)
  .eq('kind','live_action').eq('source','resource').not('resource_id','is',null)
  .is('footage_key', null)`. (Idempotent: a shot already conformed has a `footage_key`.)
- `for (const shot of shots) await runIngestSpine(step, admin, shot, target);`
- return `{ ingested: shots.length }`.

### 5.2 Per-shot spine — `runIngestSpine`
Each external touch is its own durable `step.run`, named `…-${shot.id}`.

1. **Resolve resource** (`resolve-${shot.id}`): look up
   `channel_resources.select('r2_key, kind').eq('id', shot.resource_id)
   .eq('account_id', accountId).single()`. Throw on missing/foreign/`!r2_key`
   (degrade loudly, like `resolveResourceAssets`). Return `{ r2Key, kind }`
   (`kind === 'video' ? 'video' : 'image'`).

2. **Branch on kind:**

   **Video** (`kind === 'video'`):
   - `probe-${shot.id}`: `signedGetUrl(r2Key)` → `invokeProbe(url)` → `parseProbe(raw)`;
     return the `ProbeResult` (plain serializable object — safe across the step boundary).
   - `conform-${shot.id}`: `inUrl = signedGetUrl(r2Key)`; `outKey =
     ingest/${shot.id}/footage.mp4`; `outUrl = signedPutUrl(outKey, 'video/mp4')`;
     `args = buildConformArgs({ inPath:'/tmp/in', outPath:'/tmp/out.mp4', target, probe,
     durationSec: shot.duration_seconds ?? undefined })`;
     `invokeRemux({ args, inputs:{'/tmp/in': inUrl}, outputs:{'/tmp/out.mp4': outUrl},
     outputContentType:'video/mp4' })`; then `shots.update({ footage_key: outKey })`.
     Return `outKey`.
   - `keyframe-${shot.id}`: `inUrl = signedGetUrl(footageKey)` (the just-conformed clip);
     `styleKey = ingest/${shot.id}/styleref.png`; `outUrl = signedPutUrl(styleKey,
     'image/png')`; `args = buildKeyframeArgs({ inPath:'/tmp/in.mp4', outPath:'/tmp/out.png',
     atSec: styleRefAt(shot.duration_seconds) })`; `invokeRemux({ …, outputContentType:
     'image/png' })`; `shots.update({ style_ref_key: styleKey })`.

   **Image** (`kind === 'image'`):
   - `conform-image-${shot.id}`: `inUrl = signedGetUrl(r2Key)`; `outKey =
     ingest/${shot.id}/footage.png`; `outUrl = signedPutUrl(outKey, 'image/png')`;
     `args = buildImageConformArgs({ inPath:'/tmp/in', outPath:'/tmp/out.png',
     target:{ width, height } })`; `invokeRemux({ …, outputContentType:'image/png' })`;
     `shots.update({ footage_key: outKey, style_ref_key: outKey })` — the conformed still
     IS its own styleRef (no separate keyframe extraction). Return `outKey`.

`styleRefAt(dur)`: a representative, deterministic timestamp — `min(0.5, dur/2)` when
`dur > 0`, else `0` (avoids a black/fade-in frame 0 without needing the probe). Pure +
tested with the other ingest cores.

> **Why per-step DB writes (not a final finalize).** Matches 1b: writing `footage_key`
> inside `conform-` means a keyframe-step failure resumes without re-running the expensive
> conform, and the null-filter idempotency holds at the conform granularity.

## 6. Register the function

Add `ingestShots` to the Inngest function registry (wherever `generateShots` is exported
to the Inngest serve handler) so the dev/prod Inngest server knows it. No event is sent yet.

## 7. Operator drive script — `scripts/drive-ingest.ts` (+ `package.json`)

`npm run drive:ingest -- <videoId>` — sends an `ingest/run` event for the video (mirrors
`drive:generation`). Because ingest hits the **real** ffmpeg Lambda, this is an operator
step run against deployed infra (the `drive:remux`/`smoke:probe` precedent), gated on 2a's
redeploy. It never fabricates shots — it conforms whatever resource-pinned live-action
shots the video already has; prints `{ ingested }` and the resulting `footage_key`/
`style_ref_key` per shot for eyeballing. Documented in-file: requires the redeployed probe
Lambda + at least one `source='resource'` live-action shot on the target video.

## 8. Testing

- **Unit (node:test):** `buildImageConformArgs` (scale+crop+`-frames:v 1`; no video-only
  flags; target-dims-only); `styleRefAt` (dur>0 → `min(0.5,dur/2)`, dur≤0 → 0). The 2a
  cores (`parseProbe`, `buildConformArgs`, `buildKeyframeArgs`) are already covered.
- **Pipeline wiring:** proven by the operator `drive:ingest` against the real Lambda
  (Lambda I/O is not unit-tested, per the `drive:remux`/1b precedent). The Inngest fn's
  pure decisions (target derivation, shot filter, key naming) are exercised by the drive
  run; no in-process fake is built for ingest.
- **Gates:** `npm test`, `npm run typecheck`, `npm run lint`, `npm run build` all green.
- **Migration** applied via `npm run db:apply` (operator).

## 9. Backward compatibility

Additive: two new shots columns, one new pure builder + one new pure helper, one new
Inngest function fired by an event nothing sends, one registry line, one drive script. The
music remux path, the generation pipeline, compose, render, script-gen, and readiness are
all untouched. A video with no resource-pinned live-action shots ingests zero shots
(`{ ingested: 0 }`). Re-running `ingest/run` on an already-conformed video is a no-op
(every shot has a `footage_key`).

## 10. File structure (drives the plan)

| File | Responsibility |
| --- | --- |
| `supabase/migrations/<ts>_v2_ingest_contract.sql` (create) | `shots.footage_key` + `shots.style_ref_key` |
| `src/lib/ingest/ffmpeg.ts` (modify) + test | add `buildImageConformArgs` |
| `src/lib/ingest/keyframe-at.ts` (create) + test | pure `styleRefAt(dur)` (or fold into ffmpeg.ts) |
| `src/lib/inngest/functions/ingest-shots.ts` (create) | `ingestShots` + `runIngestSpine` |
| Inngest function registry (modify) | register `ingestShots` |
| `scripts/drive-ingest.ts` (create) + `package.json` (modify) | operator `drive:ingest` |

## 11. Open items (resolved-by-default; flagged for the plan)

- **Image conform semantics:** images use the same cover (scale-to-fill + crop) as video,
  for frame consistency at assembly. A wide logo cropped to a tall frame is the operator's
  pin choice; letterboxing is an assembly-time refinement (Slice 3) if ever wanted.
- **styleRef timestamp:** `min(0.5, dur/2)` — deterministic, avoids frame-0 fade-ins,
  needs no probe round-trip. Refine later if a source needs a smarter representative frame.
- **One output per Lambda call:** each `invokeRemux` here carries exactly one output, so
  the single `outputContentType` field suffices (no multi-output content-type map needed).
- **Drive proof is operator-run** against the real Lambda (gated on 2a's redeploy);
  subagents/CI verify only the pure cores + gates.
- `styleRefAt` + `buildImageConformArgs` may live in one file or two; the plan picks
  (leaning: both in `ingest/ffmpeg.ts` since `styleRefAt` feeds `buildKeyframeArgs`).
