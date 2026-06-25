# Reelscript V2 — Slice 6a: Master pipeline spine + G1 storyboard gate — Design

> **Reelscript V2 program, Slice 6 (master orchestration), sub-slice 6a.**
> The capstone that finally connects the generative pipeline end-to-end. Slices 1b/2b built
> generation (`generation/run`) and ingest (`ingest/run`) behind events **nothing sends in
> production**; Slice 3a's assembly already *consumes* the `clip_key`/`footage_key` those
> write; Slice 4 built the reusable `runGate` primitive (G2 preview proven; **G1 storyboard
> wiring deferred to here**). 6a is the master `reelscript.pipeline` Inngest function that
> fans out generation + ingest, fans in, runs the G1 storyboard gate, then the render
> (which already carries G2) — one job, one cancel key, all existing functions reused via
> `step.invoke`. **Budget guardrail = 6b (deferred); auto-revise loop, auto-voice, full
> prompt→video = deferred.**

## 0. Context & locked decisions

- **Program runtime/data** locked in the V2 program (Next.js + Supabase + RLS + Inngest +
  Remotion Lambda + R2). See `2026-06-24-v2-slice0-shot-model-contract-design.md` §0.
- **Slice 5 (provenance disclosure) DROPPED** by the operator (2026-06-25) — the provenance
  *data* is already captured (Slice 0 column + 1b writes it); only the disclosure surfacing
  was dropped. 6 follows 4 directly.
- **6a decisions (this doc):**
  1. **Entry = post-voice** (operator choice). The operator runs script-gen + voice (existing
     manual steps), then triggers the pipeline; 6a automates generation + ingest → G1 →
     render → G2 → done. Auto-voice / full-prompt→video are deferred.
  2. **`step.invoke` fan-out/fan-in** (Inngest v4.5, first use in the codebase). The master
     calls `generateShots`, `ingestShots`, `renderVideo` and awaits their returns. **No
     change to those functions' internals.** A pre-flight invoke+cancel smoke check is the
     plan's first task (de-risk the first `step.invoke`).
  3. **One job, one cancel key.** A new `job_type='pipeline'` row is the single owner. The
     master threads its `jobId` into every invoked child's event data, so each child's
     existing `cancelOn: jobs/cancel (async.data.jobId == event.data.jobId)` matches — **a
     Cancel on the pipeline job cancels the whole tree** (master + invoked children + a run
     suspended at a gate) with no new code. The master owns `phase`
     (`generating` → `awaiting_storyboard_review` → `rendering`); `renderVideo` drives the
     render phases + completion exactly as today.
  4. **Reuse `renderVideo` whole** (incl. its compose-with-segments, automated `gate2`,
     color grade, and the opt-in **G2** preview gate). The master `step.invoke`s it with the
     master `jobId` + the pre-created `renderId`. G2 stays inside `renderVideo`; the master
     does not restructure it.
  5. **G1 only pauses when there is something to review.** If the video has ≥1 generative
     shot (which `generateShots` turns into a keyframe storyboard), the master runs the G1
     gate; otherwise it skips straight to the render (a legacy/all-motion-graphic video run
     through the pipeline = gen+ingest no-ops + a normal render).
  6. **Reject = terminate, recoverable** (Slice-4 pattern). G1 reject → render + job `failed`
     with `{phase:'storyboard_gate'}`; the operator edits shots/scenes and re-triggers. **No
     auto-revise loop** (deferred). G1 timeout (7d) → auto-reject (the `runGate` default).
  7. **Additive entry point.** A new `startPipelineRun` action + an "Auto-produce" button run
     ALONGSIDE the existing manual `Generate Video` (`startVideoRender`) path — neither is
     removed.
- **Migration:** one — `job_type` += `'pipeline'`. Nothing else (gate state already rides
  `jobs.status='paused'`+`phase` from Slice 4; keys/columns already exist from 0/1b/2b/3a).

## 1. Goal & non-goals

**Goal.** A one-trigger master pipeline: from a voiced video, automatically run generation +
ingest in parallel, pause for a human **storyboard (G1)** review of the generated keyframes,
then run the full render (which carries the automated gate2 + the opt-in **preview (G2)**
gate) to a final MP4 — as a single cancellable `pipeline` job whose progress surfaces through
the existing jobs Realtime + the editor. This is the seam that gives the long-deferred
`generation/run` + `ingest/run` events their first production sender.

**Non-goals (deferred).** No budget guardrail (6b). No auto-revise loop on gate reject (the
operator edits + re-triggers). No auto-voice / no script-gen inside the pipeline (entry is
post-voice). No generation cost metering (the Higgsfield adapter is still the fake — metered
when the real adapter ships). No change to `generateShots`/`ingestShots`/`renderVideo`
internals, to composition/captions/voice/music, or to the manual `Generate Video` path. No
new gate kinds (G1 reuses the existing `storyboard` kind from Slice 4).

## 2. Current state (anchors)

- `src/app/api/inngest/route.ts` — the registered function list. **6a registers
  `reelscriptPipeline`.**
- `src/lib/inngest/client.ts` — typed event-data interfaces. **6a adds `PipelineStartData`**
  and the `pipeline/start` event.
- `src/lib/inngest/functions/generate-shots.ts` — `generateShots`, trigger `generation/run`,
  data `{ videoId, accountId, jobId? }`, returns `{ generated }`. Loads `kind='generative'`
  shots via scene ids, `.is('clip_key', null)` (idempotent), writes `clip_key`. No job-status
  writes (the master owns the job).
- `src/lib/inngest/functions/ingest-shots.ts` — `ingestShots`, trigger `ingest/run`, data
  `{ videoId, accountId, jobId? }`, returns `{ ingested }`. Loads `kind='live_action' AND
  source='resource' AND footage_key IS NULL` shots, writes `footage_key`/`style_ref_key`. No
  job-status writes.
- `src/lib/inngest/functions/render.ts` — `renderVideo`, trigger `render/start`, data
  `{ jobId, renderId, videoId }`. `loadBrief` turns shots with a non-null
  `clip_key`/`footage_key` into assembly **segments** (else compose hints). Carries automated
  `gate2`, color grade, the **G2** preview gate (opt-in), and music/finalize (which marks the
  job complete). **The private `runGate` helper lives here (~line 985).**
- `src/lib/gates/gate.ts` — `GateKind` (`'storyboard'|'preview'`), `GATE_EVENT`
  (`'pipeline/gate.resolved'`), `GATE_PHASE` (incl. `.storyboard='awaiting_storyboard_review'`),
  `GATE_TIMEOUT='7d'`, `gateResolution`. `runGate(step, admin, {jobId, kind})` is fully
  parameterized by kind — **G1 needs no change to it**, only that it be importable.
- `src/app/(app)/videos/[id]/render-actions.ts` — `startVideoRender` (preconditions →
  snapshot revision → render row → render job → `render/start`) and `getRenderState` (polled
  by the editor; returns `{status, url, error, awaitingPreview, previewUrl, jobId}`). **6a
  extracts the snapshot+render-row logic into a shared helper and adds `awaitingStoryboard`.**
- `src/app/(app)/videos/[id]/gate-actions.ts` — `resolveGate(jobId, decision)` (sends
  `pipeline/gate.resolved`). **Reused as-is for G1.**
- `src/app/(app)/videos/[id]/Editor.tsx` — the editor; render poll + jobs Realtime + the G2
  preview banner. **6a adds the "Auto-produce" button + the G1 storyboard banner.**
- `src/lib/jobs/monitor.ts` — `gatePhaseLabel` (already maps `awaiting_storyboard_review` →
  "Awaiting storyboard review", shipped in Slice 4) + `isAwaitingPreview`. **6a adds
  `isAwaitingStoryboard` (or generalizes the Review-link predicate).**
- `job_type` enum: `script_generation | voice_synthesis | render | primitive_deploy` — **no
  `pipeline`**. Migration adds it.
- Tests: `npm test` = `node --experimental-strip-types --import ./scripts/register-loader.mjs
  --test "src/**/*.test.ts"`.

## 3. Migration — `job_type` += `'pipeline'`

A single additive migration: `ALTER TYPE job_type ADD VALUE IF NOT EXISTS 'pipeline';`
(Postgres enum add-value; new migration file under the migrations dir, applied via
`npm run db:apply`). `monitor.ts`'s `JobStatus`/labels are status-keyed, not type-keyed, so no
pure-code change is forced; `/jobs` renders `job.type` raw (`'pipeline'` reads fine). No RLS
change (jobs RLS already account-scoped).

## 4. The master function — `src/lib/inngest/functions/pipeline.ts`

`reelscriptPipeline` (`id: 'reelscript-pipeline'`, `retries: 2`, `cancelOn: [{event:
'jobs/cancel', if:'async.data.jobId == event.data.jobId'}]`, trigger `{event:
'pipeline/start'}`). Not unit-tested (Inngest orchestration / step.invoke, matching the
pipeline precedent); its only branching logic that warrants a pure test is the
"has-generative-shots?" predicate (extracted pure — see §6).

```ts
async ({ event, step }) => {
  const { jobId, videoId, accountId, renderId } = event.data as PipelineStartData;
  const admin = createAdminClient();

  await step.run('mark-running', async () => {
    await admin.from('jobs').update({ status: 'running', phase: 'generating' }).eq('id', jobId);
  });

  // Fan-out → fan-in: generation + ingest are independent (different shot kinds). Both get
  // the master jobId (cancel cascade). They populate clip_key / footage_key that the render's
  // loadBrief reads — so they MUST finish before the render. step.invoke awaits their returns.
  await Promise.all([
    step.invoke('run-generation', { function: generateShots, data: { videoId, accountId, jobId } }),
    step.invoke('run-ingest', { function: ingestShots, data: { videoId, accountId, jobId } }),
  ]);

  // G1 storyboard gate — only when there is a storyboard to review (≥1 generative shot).
  const hasStoryboard = await step.run('check-storyboard', async () => {
    const sceneIds = await sceneIdsForVideo(admin, videoId);          // helper
    if (sceneIds.length === 0) return false;
    const { count } = await admin.from('shots')
      .select('id', { count: 'exact', head: true })
      .in('scene_id', sceneIds).eq('kind', 'generative');
    return (count ?? 0) > 0;
  });
  if (hasStoryboard) {
    const decision = await runGate(step, admin, { jobId, kind: 'storyboard' });
    if (decision === 'reject') {
      await step.run('reject-storyboard', async () => {
        const error = { phase: 'storyboard_gate', message: 'Storyboard rejected by operator' };
        await admin.from('renders').update({ status: 'failed', error }).eq('id', renderId);
        await admin.from('jobs').update({ status: 'failed', phase: 'failed', error }).eq('id', jobId);
      });
      return { jobId, failed: 'storyboard_gate' as const };
    }
    await step.run('resume-after-storyboard', async () => {
      await admin.from('jobs').update({ status: 'running', phase: 'rendering' }).eq('id', jobId);
    });
  }

  // Render: reuses compose-with-segments + automated gate2 + grade + G2 + music/finalize.
  // Invoked with the master jobId → it drives this job through the render phases + completion
  // (and its G2 pauses THIS job). The master returns after it resolves; music-remux (if any)
  // completes the job async, exactly as in the manual path.
  await step.invoke('run-render', { function: renderVideo, data: { jobId, renderId, videoId } });

  return { jobId, ok: true as const };
}
```

- **Gate sequencing:** G1's `waitForEvent` fully resolves before `renderVideo` (and thus G2's
  `waitForEvent`) starts — only one gate waits at a time, so `resolveGate(jobId, decision)`
  (correlated on `jobId` only) is unambiguous.
- **Failure:** if `renderVideo` fails (compose/gate2/G2-reject), it marks THIS job `failed`
  and returns `{failed}`; the master returns without re-marking. The reject path mirrors
  Slice 4's structured `{phase}` error (Slice-A `RenderErrorCard` renders it).
- **Shared `runGate`:** extract the private helper from `render.ts` into
  `src/lib/inngest/run-gate.ts` (exported); `render.ts` imports it (its G2 behavior unchanged).

## 5. Entry point — `startPipelineRun` (+ shared snapshot helper)

`src/app/(app)/videos/[id]/render-actions.ts` (or a sibling `pipeline-actions.ts`):

- Extract the shared body of `startVideoRender` — completeness gate (no `not_synthesized`;
  `stale` needs override) + revision snapshot + idempotency-keyed `renders` row — into a
  helper `prepareRender(supabase, videoId, accountId, overrideStale)` returning
  `{ renderId } | { blocked }`. `startVideoRender` calls it then creates a `type='render'`
  job + sends `render/start`. **`startPipelineRun(videoId, overrideStale?)`** calls the SAME
  helper, then creates a `type='pipeline'` job + sends `pipeline/start {jobId, videoId,
  accountId, renderId}`. Same return contract (`{renderId, jobId, reused} | {blocked,
  sceneIds}`). DRY; the manual path is byte-identical.

## 6. Editor surfacing — G1 storyboard banner

- `getRenderState` (render-actions.ts) gains `awaitingStoryboard: boolean` (cheap: the job it
  already reads is `paused` AND `phase === GATE_PHASE.storyboard`). Additive field; existing
  callers unaffected (like Slice 4's `awaitingPreview`).
- New action `loadStoryboard(videoId): Promise<StoryboardFrame[]>` where `StoryboardFrame =
  { shotId, label, keyframeUrl }`: account-scoped, loads the video's `kind='generative'`
  shots (via scene ids) with a non-null `keyframe_first_key`, signs each, and a `label` from
  `visual_brief.entity_name || description`. Called ONCE by the editor when
  `awaitingStoryboard` flips true (not on every poll).
- Pure `storyboardLabel(brief, description)` in a small module (tested) — mirrors
  `formatShotHint`'s label choice. Keeps the action thin/testable.
- Editor: a **storyboard-review banner** (rendered when `awaitingStoryboard`): a thumbnail
  grid of `keyframeUrl` + `label`, with **Approve** / **Reject** → `resolveGate(jobId,
  decision)` (the `jobId` already returned by `getRenderState`). Mirrors the G2 banner's busy
  / optimistic-clear handling. The G2 preview banner is unchanged; the two never show at once
  (sequential gates).
- "**Auto-produce**" button next to "Generate Video": calls `startPipelineRun(videoId)`,
  then `begin(renderId)` (the existing poll start) so the editor tracks the pipeline through
  both gates. Gated by the same `canRender` (synthesized + readiness) check.
- `/jobs`: `gatePhaseLabel` already labels `awaiting_storyboard_review`; add
  `isAwaitingStoryboard(job)` to `monitor.ts` (+ test) and show the existing Review link for
  a pipeline job at either gate.

## 7. Operator proof — `scripts/drive-pipeline.ts`

`npm run drive:pipeline -- <videoId>`: against the **fake** generation provider, on a video
with synthesized voice + ≥1 generative shot (+ optional resource-pinned live-action shot),
create the pipeline job + render row and send `pipeline/start`; print the job id. The operator
watches: gen+ingest populate `clip_key`/`footage_key` → job pauses at
`awaiting_storyboard_review` → `resolveGate(jobId,'approve')` (the editor button or a one-liner)
→ render runs → done. Repeat with reject → job `failed` with the storyboard-gate error; Cancel
on a paused pipeline job terminates the whole tree. The `step.invoke`/gate/render path is not
unit-tested (Inngest/AWS), matching the generation/ingest/remux precedent.

## 8. Testing

- **Unit (node:test):** the pure pieces only — `storyboardLabel` and `isAwaitingStoryboard`.
  The has-generative-shots check is a DB count (not pure → not unit-tested). The master
  function, `step.invoke` wiring, the actions, and the UI are verified by the drive script +
  the gates (Inngest/AWS not unit-tested, matching every prior pipeline slice).
- **Plan task 1 = a `step.invoke` smoke check** (invoke one child from a throwaway/the master
  against the fake, confirm it runs, returns, and a `jobs/cancel` cascades) before building
  the full spine — de-risks the first `step.invoke`.
- **Gates:** `npm test`, `npm run typecheck`, `npm run lint`, `npm run build` all green.
- **One migration** (`job_type` += `pipeline`), applied + verified.

## 9. Backward compatibility

Additive. The manual `Generate Video` (`startVideoRender` → `render/start`) path is unchanged
(the shared `prepareRender` helper is a pure extraction). `generateShots`/`ingestShots`/
`renderVideo` are reused via `step.invoke` with no internal changes. A video with no
generative/live-action shots run through the pipeline = gen+ingest no-ops + skip-G1 + a normal
render (same output as the manual path). The only schema change is the additive `job_type`
enum value. Gate state, cancel, and Realtime all reuse Slice-4 machinery.

## 10. File structure (drives the plan)

| File | Responsibility |
| --- | --- |
| `supabase/migrations/<ts>_v2_pipeline_job_type.sql` (create) | `job_type` += `'pipeline'` |
| `src/lib/inngest/run-gate.ts` (create) + `render.ts` (modify) | extract+export `runGate`; render imports it |
| `src/lib/inngest/client.ts` (modify) | `PipelineStartData` + `pipeline/start` event type |
| `src/lib/inngest/functions/pipeline.ts` (create) | `reelscriptPipeline` master function |
| `src/app/api/inngest/route.ts` (modify) | register `reelscriptPipeline` |
| `src/app/(app)/videos/[id]/render-actions.ts` (modify) | `prepareRender` helper + `startPipelineRun` + `getRenderState.awaitingStoryboard` |
| `src/app/(app)/videos/[id]/pipeline-actions.ts` (create) | `loadStoryboard(videoId)` + pure `storyboardLabel` (+ test) |
| `src/app/(app)/videos/[id]/Editor.tsx` (modify) | "Auto-produce" button + storyboard banner |
| `src/lib/jobs/monitor.ts` (modify) (+ test) | `isAwaitingStoryboard` |
| `scripts/drive-pipeline.ts` (create) + `package.json` (modify) | `drive:pipeline` operator proof |

## 11. Open items (resolved-by-default; flagged for the plan)

- **`step.invoke` return inspection:** the master awaits each child's return but does not need
  to branch on `generateShots`/`ingestShots` results (idempotent, they write their own keys);
  it relies on `renderVideo` to own render-phase failure/completion. A child that throws
  propagates through `step.invoke` and fails the master job (Inngest default) — acceptable
  (the operator re-triggers).
- **renderId lifecycle:** the trigger pre-creates the `renders` row (status `queued`) so the
  master can pass `renderId` to `renderVideo`; idempotency key = `hash(revisionId)` (reused
  from `prepareRender`). A pipeline that's re-triggered for the same revision reuses the
  in-flight render exactly like the manual path.
- **Phase labels:** master writes `generating` → (`awaiting_storyboard_review` via runGate) →
  `rendering`; `renderVideo` then writes `composing`/`rendering`/`encoding`/`done`. All
  free-text `phase` strings; no enum/`render_status` change.
- **G1 with zero keyframes:** `check-storyboard` counts generative shots; if a generative shot
  somehow has no `keyframe_first_key` yet (generation partial-failed), `loadStoryboard` simply
  omits it — the grid shows what exists. Generation failure itself fails the master job via
  the `step.invoke` throw.
- **6b budget guardrail** slots in as a pre-fan-out `step.run` that estimates cost vs
  `accounts.monthly_cost_alert_usd` and aborts — no change to 6a's shape.
