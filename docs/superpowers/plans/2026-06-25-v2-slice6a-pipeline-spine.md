# Reelscript V2 — Slice 6a: Master pipeline spine + G1 storyboard gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A one-trigger master `reelscript.pipeline` Inngest function that, from a voiced video, fans out `generateShots` + `ingestShots` (via `step.invoke`), pauses at a human G1 storyboard gate, then runs `renderVideo` — as a single cancellable `pipeline` job.

**Architecture:** One new Inngest function (`pipeline.ts`) reuses the existing `generateShots`/`ingestShots`/`renderVideo` functions verbatim through Inngest v4's `step.invoke` (first use). The master threads its `jobId` into every invoked child so the children's existing `cancelOn` matches it (Cancel cascades). Gate state reuses Slice 4's `runGate` (extracted to a shared module) + the `jobs.status='paused'`+`phase` machinery. A new `startPipelineRun` action + "Auto-produce" button + a storyboard review banner surface it. One additive migration (`job_type += 'pipeline'`).

**Tech Stack:** TypeScript, Next.js (App Router) server actions + client components, Supabase (Postgres enum migration + Realtime), Inngest `^4.5.0` (`step.invoke` — first use; `Promise.all` for fan-in), Remotion Lambda render (reused), R2, `node:test` unit tests.

## Global Constraints

- **One migration only:** `ALTER TYPE job_type ADD VALUE IF NOT EXISTS 'pipeline';`. No other schema change (gate state, keys, columns all already exist).
- **`step.invoke` shape (verified):** `step.invoke('<step-id>', { function: <fn>, data: <obj> })`. The `data` object becomes the invoked run's `event.data`. So passing `{ videoId, accountId, jobId }` to `generateShots`/`ingestShots` and `{ jobId, renderId, videoId }` to `renderVideo` makes each child read `event.data` exactly as it does under its normal trigger — **no child-function changes**. The master `jobId` in each child's `data` makes the child's existing `cancelOn: jobs/cancel (async.data.jobId == event.data.jobId)` match.
- **Reuse existing functions verbatim.** Do NOT modify the internals of `generateShots`, `ingestShots`, or `renderVideo`. The only render.ts change is extracting the `runGate` helper to a shared module.
- **One job, threaded jobId.** The `type='pipeline'` job is the single owner; its `jobId` is passed to every `step.invoke` child. The master owns `phase` (`generating` → `awaiting_storyboard_review` via runGate → `rendering`); `renderVideo` then drives `composing`/`rendering`/`encoding`/`done` and completes the job (as in the manual path).
- **Gate reuse:** `runGate(step, admin, {jobId, kind})` is parameterized by kind — G1 uses `kind: 'storyboard'` (the `GATE_PHASE.storyboard='awaiting_storyboard_review'` label already exists from Slice 4). Gate event = `pipeline/gate.resolved` (`GATE_EVENT`), resolved by the existing `resolveGate(jobId, decision)` action. The two gates (G1 then G2) run sequentially → never overlap → `resolveGate` correlated on `jobId` is unambiguous.
- **G1 only when there's a storyboard:** the master runs the G1 gate only if the video has ≥1 generative shot; otherwise it skips to the render.
- **Reject = terminate, recoverable** (Slice-4 pattern): G1 reject → `renders.status='failed'` + `jobs` failed with `error={phase:'storyboard_gate', message:'Storyboard rejected by operator'}`. No auto-revise loop.
- **Additive entry point:** the manual `Generate Video`/`startVideoRender` path stays byte-identical (the shared `prepareRender` extraction is a pure refactor).
- **Import discipline:** node:test-run pure modules (`src/lib/videos/storyboard.ts`, `src/lib/jobs/monitor.ts`) import siblings via RELATIVE paths (the loader doesn't apply the `@/` alias) and avoid runtime imports of server-only code; build-only files (Inngest functions, server actions, client components) use `@/`.
- **Test command:** `npm test` = `node --experimental-strip-types --import ./scripts/register-loader.mjs --test "src/**/*.test.ts"`. Tests use `node:test` + `assert/strict` + import the module under test with the `.ts` extension.
- **Gates that must stay green:** `npm test`, `npm run typecheck`, `npm run lint`, `npm run build` (17/17 routes).
- **Not unit-tested (matching every prior pipeline slice):** the master function, `step.invoke` wiring, the actions, and the UI — verified by `drive:pipeline` (operator) + the gates. Only the pure `storyboardLabel` + `isAwaitingStoryboard` are unit-tested.

---

## File structure

| File | Task | Responsibility |
| --- | --- | --- |
| `src/lib/inngest/run-gate.ts` (create) + `functions/render.ts` (modify) | 1 | extract+export `runGate`; render imports it |
| `supabase/migrations/20260625120000_v2_pipeline_job_type.sql` (create) + `src/lib/inngest/client.ts` (modify) | 2 | `job_type += 'pipeline'` + `PipelineStartData`/`pipeline/start` |
| `src/lib/inngest/functions/pipeline.ts` (create) + `src/app/api/inngest/route.ts` (modify) | 3 | `reelscriptPipeline` master function + registration |
| `src/app/(app)/videos/[id]/render-actions.ts` (modify) | 4 | `prepareRender` helper + `startPipelineRun` + `getRenderState.awaitingStoryboard` |
| `src/lib/videos/storyboard.ts` (create) + test + `src/app/(app)/videos/[id]/pipeline-actions.ts` (create) | 5 | pure `storyboardLabel` + `loadStoryboard` action |
| `src/app/(app)/videos/[id]/Editor.tsx` (modify) | 6 | "Auto-produce" button + storyboard banner |
| `src/lib/jobs/monitor.ts` (modify) + test + `src/app/(app)/jobs/JobsList.tsx` (modify) | 7 | `isAwaitingStoryboard` + Review link at either gate |
| `scripts/drive-pipeline.ts` (create) + `package.json` (modify) | 8 | `drive:pipeline` operator proof (auto-approves G1) |

---

## Task 1: Extract `runGate` to a shared module

**Files:**
- Create: `src/lib/inngest/run-gate.ts`
- Modify: `src/lib/inngest/functions/render.ts` (import line ~52; remove the local `runGate` ~980-995)

**Interfaces:**
- Consumes: `GATE_EVENT`/`GATE_TIMEOUT`/`GATE_PHASE`/`gateResolution`/`GateKind`/`GateDecision` from `@/lib/gates/gate`; `createAdminClient`.
- Produces: `export async function runGate(step: any, admin: ReturnType<typeof createAdminClient>, opts: { jobId: string; kind: GateKind }): Promise<GateDecision>` — identical behavior to the current private helper.

**Context:** A faithful move (no behavior change). `render.ts` currently imports the gate constants only for `runGate`; after the move, `render.ts` imports `runGate` instead and drops the gate-constant import. Verify nothing else in `render.ts` references `GATE_*`/`gateResolution`/`GateKind`/`GateDecision` (the preview branch uses the `'preview'` string literal, not the type).

- [ ] **Step 1: Create `src/lib/inngest/run-gate.ts`**

```ts
import { createAdminClient } from '@/lib/supabase/admin';
import { GATE_EVENT, GATE_TIMEOUT, GATE_PHASE, gateResolution, type GateKind, type GateDecision } from '@/lib/gates/gate';

// Human gate (V2 Slice 4, extracted to share with the master pipeline in Slice 6a): pause
// the job durably, then suspend the run waiting for the in-app Approve/Reject event
// (correlated on jobId — the same key cancelOn uses, so a jobs/cancel still cancels a run
// suspended here). A timeout/malformed event → reject. `step` is `any` to match the other
// Inngest helpers (Inngest's step types are awkward to thread).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function runGate(step: any, admin: ReturnType<typeof createAdminClient>, opts: { jobId: string; kind: GateKind }): Promise<GateDecision> {
  await step.run(`enter-gate-${opts.kind}`, async () => {
    await admin.from('jobs').update({ status: 'paused', phase: GATE_PHASE[opts.kind] }).eq('id', opts.jobId);
  });
  const ev = await step.waitForEvent(`human-gate-${opts.kind}`, {
    event: GATE_EVENT,
    timeout: GATE_TIMEOUT,
    if: 'async.data.jobId == event.data.jobId',
  });
  return gateResolution(ev as { data?: { decision?: unknown } } | null);
}
```

(Confirm `createAdminClient` is exported from `@/lib/supabase/admin` — it is the same import `render.ts` uses. If `render.ts` imports it from a different path, use that same path here.)

- [ ] **Step 2: Update `render.ts`**

Replace the gate-constant import (line ~52, `import { GATE_EVENT, GATE_TIMEOUT, GATE_PHASE, gateResolution, type GateKind, type GateDecision } from '@/lib/gates/gate';`) with:

```ts
import { runGate } from '@/lib/inngest/run-gate';
```

Delete the local `runGate` function (the `// Human gate (V2 Slice 4)…` block, ~lines 980-995). The preview-gate branch (`await runGate(step, admin, { jobId, kind: 'preview' })`) now resolves to the imported helper.

- [ ] **Step 3: Typecheck, full suite, build**

Run: `npm run typecheck` → no errors (if it reports an unused import or a missing reference, the gate constants are still referenced somewhere in render.ts — search `GATE_`/`gateResolution` and resolve).
Run: `npm test` → `# fail 0`.
Run: `npm run build` → 17/17 routes.

- [ ] **Step 4: Commit**

```bash
git add src/lib/inngest/run-gate.ts src/lib/inngest/functions/render.ts
git commit -m "refactor(v2): extract runGate to shared module for the master pipeline — Slice 6a Task 1"
```

---

## Task 2: Pipeline contract — migration + event type

**Files:**
- Create: `supabase/migrations/20260625120000_v2_pipeline_job_type.sql`
- Modify: `src/lib/inngest/client.ts`

**Interfaces:**
- Produces: a `'pipeline'` value on the `job_type` enum; `export type PipelineStartData = { jobId: string; videoId: string; accountId: string; renderId: string }`.

**Context:** Mirror the existing `20260621170000_job_status_cancelled.sql` enum-add migration. Apply it with `npm run db:apply` (an operator/agent step that talks to the hosted DB).

- [ ] **Step 1: Create the migration**

`supabase/migrations/20260625120000_v2_pipeline_job_type.sql`:

```sql
-- V2 Slice 6a: a job_type for the master orchestration pipeline run. Additive — the
-- existing script_generation/voice_synthesis/render/primitive_deploy types are unchanged.
alter type job_type add value if not exists 'pipeline';
```

- [ ] **Step 2: Add the event-data type to `client.ts`**

After the `RenderStartData` type (or near the other event types), add:

```ts
// pipeline/start drives the master orchestration (V2 Slice 6a): from a voiced video, fan
// out generation + ingest, run the G1 storyboard gate, then the render. One pipeline job
// owns the run; its jobId threads into every step.invoke'd child so a jobs/cancel cascades.
// renderId is the pre-created render row the master hands to renderVideo.
export type PipelineStartData = { jobId: string; videoId: string; accountId: string; renderId: string };
```

- [ ] **Step 3: Apply the migration + verify**

Run: `npm run db:apply`
Expected: the migration applies cleanly. Verify the enum value exists (the apply script reports success; a follow-up `select` is optional). If `db:apply` requires the file be the newest timestamp, confirm `20260625120000` is later than `20260624140000` (it is).

- [ ] **Step 4: Typecheck + commit**

Run: `npm run typecheck` → no errors.

```bash
git add supabase/migrations/20260625120000_v2_pipeline_job_type.sql src/lib/inngest/client.ts
git commit -m "feat(v2): pipeline job_type + pipeline/start event contract — Slice 6a Task 2"
```

---

## Task 3: The master function — `reelscriptPipeline`

**Files:**
- Create: `src/lib/inngest/functions/pipeline.ts`
- Modify: `src/app/api/inngest/route.ts`

**Interfaces:**
- Consumes: `runGate` (Task 1), `PipelineStartData` (Task 2), `generateShots`/`ingestShots`/`renderVideo` (existing), `createAdminClient`, `inngest`.
- Produces: `export const reelscriptPipeline` (Inngest function, id `reelscript-pipeline`, trigger `pipeline/start`).

**Context:** This is the first `step.invoke` in the codebase. Follow the existing function shape (config object with `triggers`/`cancelOn`, then the handler — same 2-arg `createFunction(config, handler)` form as `generateShots`/`ingestShots`). `step.invoke('<id>', { function, data })` awaits the child's return; `Promise.all` of two invokes is the fan-out/fan-in. The data passed becomes each child's `event.data`. No unit test (Inngest wiring). Verify via typecheck/lint/build; the runtime is proven by `drive:pipeline` (Task 8).

- [ ] **Step 1: Create `src/lib/inngest/functions/pipeline.ts`**

```ts
import { inngest } from '@/lib/inngest/client';
import type { PipelineStartData } from '@/lib/inngest/client';
import { createAdminClient } from '@/lib/supabase/admin';
import { runGate } from '@/lib/inngest/run-gate';
import { generateShots } from '@/lib/inngest/functions/generate-shots';
import { ingestShots } from '@/lib/inngest/functions/ingest-shots';
import { renderVideo } from '@/lib/inngest/functions/render';

// Master orchestration (V2 Slice 6a). From a voiced video: fan out generation + ingest
// (step.invoke, parallel — they touch disjoint shot kinds and populate clip_key/footage_key
// the render reads), fan in, run the G1 storyboard gate (only when there are generative
// shots to review), then invoke the render (which carries the automated gate2 + the opt-in
// G2 preview gate + music/finalize and completes the job). One pipeline job owns the run;
// the master jobId is threaded into every child so a jobs/cancel cancels the whole tree.
export const reelscriptPipeline = inngest.createFunction(
  {
    id: 'reelscript-pipeline',
    retries: 2,
    triggers: [{ event: 'pipeline/start' }],
    cancelOn: [{ event: 'jobs/cancel', if: 'async.data.jobId == event.data.jobId' }],
  },
  async ({ event, step }) => {
    const { jobId, videoId, accountId, renderId } = event.data as PipelineStartData;
    const admin = createAdminClient();

    await step.run('mark-running', async () => {
      await admin.from('jobs').update({ status: 'running', phase: 'generating' }).eq('id', jobId);
    });

    // Fan-out → fan-in. Both children get the master jobId (cancel cascade). They are
    // idempotent (re-runs only touch shots whose key is still null), so a retry is safe.
    await Promise.all([
      step.invoke('run-generation', { function: generateShots, data: { videoId, accountId, jobId } }),
      step.invoke('run-ingest', { function: ingestShots, data: { videoId, accountId, jobId } }),
    ]);

    // G1 storyboard gate — only when there is a storyboard to review (≥1 generative shot).
    const hasStoryboard = await step.run('check-storyboard', async () => {
      const { data: scenes } = await admin.from('scenes').select('id').eq('video_id', videoId);
      const sceneIds = (scenes ?? []).map((s) => s.id as string);
      if (sceneIds.length === 0) return false;
      const { count } = await admin
        .from('shots')
        .select('id', { count: 'exact', head: true })
        .in('scene_id', sceneIds)
        .eq('kind', 'generative');
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
    // Invoked with the master jobId → it drives THIS job through the render phases + completion
    // (and its G2 pauses THIS job). renderVideo owns failure/completion; the master returns.
    await step.invoke('run-render', { function: renderVideo, data: { jobId, renderId, videoId } });

    return { jobId, ok: true as const };
  },
);
```

If `typecheck` complains about the `step.invoke` generic or the handler arg types, annotate the handler as `async ({ event, step }: { event: { data: unknown }; step: any })` with an `// eslint-disable-next-line @typescript-eslint/no-explicit-any` (matching the pragmatic `step: any` used elsewhere). Do NOT change the child functions to satisfy types.

- [ ] **Step 2: Register in `src/app/api/inngest/route.ts`**

Add the import:

```ts
import { reelscriptPipeline } from '@/lib/inngest/functions/pipeline';
```

Add it to the `functions` array:

```ts
  functions: [renderVideo, renderSample, generateScript, synthesizeVoice, musicRemux, deployPrimitive, generateShots, ingestShots, reelscriptPipeline],
```

- [ ] **Step 3: Typecheck, lint, build, full suite**

Run: `npm run typecheck` → no errors.
Run: `npm run lint` → no errors.
Run: `npm run build` → 17/17 routes.
Run: `npm test` → `# fail 0`.

- [ ] **Step 4: Commit**

```bash
git add src/lib/inngest/functions/pipeline.ts src/app/api/inngest/route.ts
git commit -m "feat(v2): reelscript.pipeline master function (step.invoke fan-out + G1) — Slice 6a Task 3"
```

---

## Task 4: Entry point — `prepareRender` + `startPipelineRun` + `getRenderState.awaitingStoryboard`

**Files:**
- Modify: `src/app/(app)/videos/[id]/render-actions.ts`

**Interfaces:**
- Consumes: `GATE_PHASE` from `@/lib/gates/gate` (already imported for `awaitingPreview`); `inngest`; the existing `renderIdempotencyKey`, `signedGetUrl`.
- Produces: `startPipelineRun(videoId, overrideStale?): Promise<StartVideoRenderResult>` (same result type as `startVideoRender`); `getRenderState` return GAINS `awaitingStoryboard: boolean`.

**Context:** Extract the shared body of `startVideoRender` (completeness gate → snapshot revision → idempotency → render row) into `prepareRender`, returning a discriminated result that carries `reusedJobId` for the in-flight-render case. `startVideoRender` and `startPipelineRun` both call it, then create their own job (`type='render'` vs `'pipeline'`) and send their own event (`render/start` vs `pipeline/start`). The manual path stays byte-identical.

- [ ] **Step 1: Extract `prepareRender`**

Add this helper (and refactor `startVideoRender` to use it). `prepareRender` contains everything `startVideoRender` does today from the scenes load through the render-row creation, returning:

```ts
type PrepareResult =
  | { ok: true; renderId: string; reusedJobId: string | null }
  | { blocked: 'unsynthesized_scenes' | 'stale_scenes'; sceneIds: string[] };

async function prepareRender(
  supabase: Awaited<ReturnType<typeof createClient>>,
  videoId: string,
  accountId: string,
  overrideStale: boolean,
): Promise<PrepareResult> {
  // Load scenes (+ shots) — the completeness gate and the revision snapshot.
  const { data: scenes } = await supabase
    .from('scenes')
    .select('id, position, narration, duration_seconds, audio_status, audio_r2_key, word_alignments')
    .eq('video_id', videoId)
    .order('position');
  const sceneRows = scenes ?? [];
  if (sceneRows.length === 0) throw new Error('No scenes to render.');

  const notSynth = sceneRows.filter((s) => s.audio_status === 'not_synthesized');
  if (notSynth.length > 0) return { blocked: 'unsynthesized_scenes', sceneIds: notSynth.map((s) => s.id as string) };
  const stale = sceneRows.filter((s) => s.audio_status === 'stale');
  if (stale.length > 0 && !overrideStale) return { blocked: 'stale_scenes', sceneIds: stale.map((s) => s.id as string) };

  const ids = sceneRows.map((s) => s.id as string);
  const { data: shotRows } = await supabase
    .from('shots')
    .select('id, scene_id, position, description, source, stock_query')
    .in('scene_id', ids)
    .order('position');
  const shotsByScene = new Map<string, unknown[]>();
  for (const sh of shotRows ?? []) {
    const list = shotsByScene.get(sh.scene_id as string) ?? [];
    list.push(sh);
    shotsByScene.set(sh.scene_id as string, list);
  }

  const content = {
    scenes: sceneRows.map((s) => ({
      id: s.id, position: s.position, narration: s.narration,
      duration_seconds: s.duration_seconds, audio_status: s.audio_status,
      shots: shotsByScene.get(s.id as string) ?? [],
    })),
  };
  const createdRev = await supabase
    .from('script_revisions')
    .insert({ account_id: accountId, video_id: videoId, content, edit_summary: overrideStale ? 'Render (stale audio accepted)' : 'Render' })
    .select('id')
    .single();
  if (createdRev.error || !createdRev.data) throw new Error(`snapshot: ${createdRev.error?.message}`);
  const revisionId = createdRev.data.id as string;

  const { data: revs } = await supabase
    .from('script_revisions').select('id').eq('video_id', videoId).order('created_at', { ascending: false });
  const stale_revs = (revs ?? []).slice(MAX_REVISIONS).map((r) => r.id as string);
  if (stale_revs.length) await supabase.from('script_revisions').delete().in('id', stale_revs);

  const idempotencyKey = renderIdempotencyKey(revisionId);
  const { data: existing } = await supabase
    .from('renders').select('id, status').eq('idempotency_key', idempotencyKey).maybeSingle();
  if (existing && RENDER_IN_FLIGHT.includes(existing.status as string)) {
    const { data: job } = await supabase.from('jobs').select('id').eq('render_id', existing.id as string).maybeSingle();
    return { ok: true, renderId: existing.id as string, reusedJobId: (job?.id as string) ?? null };
  }

  const createdRender = await supabase
    .from('renders')
    .insert({ account_id: accountId, video_id: videoId, script_revision_id: revisionId, status: 'queued', idempotency_key: idempotencyKey })
    .select('id')
    .single();
  if (createdRender.error || !createdRender.data) throw new Error(`render insert: ${createdRender.error?.message}`);
  return { ok: true, renderId: createdRender.data.id as string, reusedJobId: null };
}
```

Then rewrite `startVideoRender`'s body (after the auth + account lookup it already does) to:

```ts
  const prep = await prepareRender(supabase, videoId, accountId, overrideStale);
  if ('blocked' in prep) return prep;
  if (prep.reusedJobId) return { renderId: prep.renderId, jobId: prep.reusedJobId, reused: true };

  const createdJob = await supabase
    .from('jobs')
    .insert({ account_id: accountId, video_id: videoId, render_id: prep.renderId, type: 'render', status: 'queued' })
    .select('id').single();
  if (createdJob.error || !createdJob.data) throw new Error(`job insert: ${createdJob.error?.message}`);
  const jobId = createdJob.data.id as string;
  await inngest.send({ name: 'render/start', data: { jobId, renderId: prep.renderId, videoId } });
  return { renderId: prep.renderId, jobId, reused: false };
```

(Keep the existing auth + `accounts` lookup at the top of `startVideoRender` unchanged. `MAX_REVISIONS`/`RENDER_IN_FLIGHT`/`renderIdempotencyKey` are already in the file.)

- [ ] **Step 2: Add `startPipelineRun`**

```ts
// V2 Slice 6a: the master pipeline entry point. Same preconditions + snapshot + render row
// as startVideoRender (via prepareRender), then a type='pipeline' job + pipeline/start. The
// pipeline fans out generation + ingest, runs the G1 storyboard gate, then the render.
export async function startPipelineRun(
  videoId: string,
  overrideStale = false,
): Promise<StartVideoRenderResult> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in.');
  const { data: account, error: acctErr } = await supabase.from('accounts').select('id').single();
  if (acctErr || !account) throw new Error(`No account: ${acctErr?.message ?? 'not found'}`);
  const accountId = account.id as string;

  const prep = await prepareRender(supabase, videoId, accountId, overrideStale);
  if ('blocked' in prep) return prep;
  if (prep.reusedJobId) return { renderId: prep.renderId, jobId: prep.reusedJobId, reused: true };

  const createdJob = await supabase
    .from('jobs')
    .insert({ account_id: accountId, video_id: videoId, render_id: prep.renderId, type: 'pipeline', status: 'queued' })
    .select('id').single();
  if (createdJob.error || !createdJob.data) throw new Error(`job insert: ${createdJob.error?.message}`);
  const jobId = createdJob.data.id as string;
  await inngest.send({ name: 'pipeline/start', data: { jobId, videoId, accountId, renderId: prep.renderId } });
  return { renderId: prep.renderId, jobId, reused: false };
}
```

- [ ] **Step 3: Add `awaitingStoryboard` to `getRenderState`**

In `getRenderState`, after computing `awaitingPreview` (the job row is already read), add:

```ts
  const awaitingStoryboard = job?.status === 'paused' && job?.phase === GATE_PHASE.storyboard;
```

Add `awaitingStoryboard: boolean` to the return type and the returned object:

```ts
    awaitingPreview: Boolean(awaitingPreview),
    awaitingStoryboard: Boolean(awaitingStoryboard),
```

(`GATE_PHASE` is already imported in this file from Slice 4.)

- [ ] **Step 4: Typecheck, lint, build**

Run: `npm run typecheck` → no errors (the additive `awaitingStoryboard` field is safe for existing callers).
Run: `npm run lint` → no errors.
Run: `npm run build` → 17/17 routes.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/videos/[id]/render-actions.ts"
git commit -m "feat(v2): startPipelineRun + prepareRender extraction + awaitingStoryboard — Slice 6a Task 4"
```

---

## Task 5: Storyboard data — pure `storyboardLabel` + `loadStoryboard`

**Files:**
- Create: `src/lib/videos/storyboard.ts`
- Test: `src/lib/videos/storyboard.test.ts`
- Create: `src/app/(app)/videos/[id]/pipeline-actions.ts`

**Interfaces:**
- Produces: `storyboardLabel(brief: { entity_name?: string | null } | null, description: string): string`; `loadStoryboard(videoId: string): Promise<StoryboardFrame[]>` where `StoryboardFrame = { shotId: string; label: string; keyframeUrl: string }`.

**Context:** `storyboardLabel` is pure (its own module so a `'use server'` file can't host it, and so it's node:test-unit-testable). `loadStoryboard` is the server action the editor calls once when the storyboard gate opens — it signs each generative shot's `keyframe_first_key`.

- [ ] **Step 1: Write the failing test**

`src/lib/videos/storyboard.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { storyboardLabel } from './storyboard.ts';

test('storyboardLabel: entity_name wins when present', () => {
  assert.equal(storyboardLabel({ entity_name: 'Rivian R2' }, 'a white SUV'), 'Rivian R2');
});

test('storyboardLabel: falls back to description when no entity', () => {
  assert.equal(storyboardLabel({ entity_name: null }, 'a city skyline'), 'a city skyline');
  assert.equal(storyboardLabel(null, 'a city skyline'), 'a city skyline');
  assert.equal(storyboardLabel({ entity_name: '   ' }, 'a city skyline'), 'a city skyline');
});

test('storyboardLabel: final fallback is "Shot"', () => {
  assert.equal(storyboardLabel(null, ''), 'Shot');
  assert.equal(storyboardLabel({ entity_name: '' }, '   '), 'Shot');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --test-name-pattern="storyboardLabel"`
Expected: FAIL (`Cannot find module './storyboard.ts'`).

- [ ] **Step 3: Create `src/lib/videos/storyboard.ts`**

```ts
// Pure label for a storyboard thumbnail (V2 Slice 6a). No react/server/network — unit-tested
// and shared by the loadStoryboard action. A named entity reads best; else the shot
// description; else a generic fallback. Mirrors formatShotHint's label preference.
export function storyboardLabel(brief: { entity_name?: string | null } | null, description: string): string {
  const entity = brief?.entity_name?.trim();
  if (entity) return entity;
  const desc = (description ?? '').trim();
  return desc.length > 0 ? desc : 'Shot';
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- --test-name-pattern="storyboardLabel"`
Expected: PASS.

- [ ] **Step 5: Create `src/app/(app)/videos/[id]/pipeline-actions.ts`**

```ts
'use server';

import { createClient } from '@/lib/supabase/server';
import { signedGetUrl } from '@/lib/r2';
import { parseVisualBrief } from '@/lib/videos/visual-brief';
import { storyboardLabel } from '@/lib/videos/storyboard';

export interface StoryboardFrame {
  shotId: string;
  label: string;
  keyframeUrl: string;
}

// Load the generative shots' keyframe stills for the G1 storyboard review (V2 Slice 6a).
// Called once by the editor when the pipeline job pauses at the storyboard gate. RLS-scoped.
export async function loadStoryboard(videoId: string): Promise<StoryboardFrame[]> {
  const supabase = await createClient();
  const { data: scenes } = await supabase.from('scenes').select('id').eq('video_id', videoId);
  const sceneIds = (scenes ?? []).map((s) => s.id as string);
  if (sceneIds.length === 0) return [];

  const { data: shots } = await supabase
    .from('shots')
    .select('id, description, visual_brief, keyframe_first_key')
    .in('scene_id', sceneIds)
    .eq('kind', 'generative')
    .not('keyframe_first_key', 'is', null)
    .order('position');

  const frames: StoryboardFrame[] = [];
  for (const sh of shots ?? []) {
    const url = await signedGetUrl(sh.keyframe_first_key as string, 60 * 60);
    const brief = parseVisualBrief(sh.visual_brief);
    frames.push({
      shotId: sh.id as string,
      label: storyboardLabel(brief, (sh.description as string) ?? ''),
      keyframeUrl: url,
    });
  }
  return frames;
}
```

(Confirm `parseVisualBrief`'s return type exposes `entity_name` — it does (Slice C1's `VisualBrief`). If its property is named differently, pass `{ entity_name: brief.entity_name }` accordingly. `storyboardLabel` only reads `entity_name`.)

- [ ] **Step 6: Full suite, typecheck, lint, build**

Run: `npm test` → `# fail 0`.
Run: `npm run typecheck` → no errors.
Run: `npm run lint` → no errors.
Run: `npm run build` → 17/17 routes.

- [ ] **Step 7: Commit**

```bash
git add src/lib/videos/storyboard.ts src/lib/videos/storyboard.test.ts "src/app/(app)/videos/[id]/pipeline-actions.ts"
git commit -m "feat(v2): storyboardLabel + loadStoryboard for the G1 gate — Slice 6a Task 5"
```

---

## Task 6: Editor — "Auto-produce" button + storyboard banner

**Files:**
- Modify: `src/app/(app)/videos/[id]/Editor.tsx`

**Interfaces:**
- Consumes: `startPipelineRun` from `./render-actions` (Task 4); `loadStoryboard`/`StoryboardFrame` from `./pipeline-actions` (Task 5); `getRenderState.awaitingStoryboard` (Task 4); the existing `resolveGate`, `begin`, `previewJobId` (Slice 4 — `previewJobId` holds the job id returned by `getRenderState`, used by both gates).

**Context:** Mirror the Slice-4 G2 banner. The editor's render poll already sets `previewJobId` from `s.jobId` and drives `awaitingPreview`; add `awaitingStoryboard` the same way, fetch the storyboard frames once when it flips true, render a thumbnail-grid banner with Approve/Reject (`resolveGate(previewJobId, …)`), and add an "Auto-produce" button beside "Generate Video".

- [ ] **Step 1: Add imports**

After the existing `./render-actions`/`./gate-actions` imports:

```ts
import { startPipelineRun } from './render-actions';
import { loadStoryboard, type StoryboardFrame } from './pipeline-actions';
```

(`startVideoRender`/`getRenderState` are already imported from `./render-actions` — add `startPipelineRun` to that existing import line instead of duplicating, if present.)

- [ ] **Step 2: Add state slots**

Next to the Slice-4 gate state (`awaitingPreview`/`previewUrl`/`previewJobId`/`gateBusy`):

```ts
  const [awaitingStoryboard, setAwaitingStoryboard] = useState(false);
  const [storyboardFrames, setStoryboardFrames] = useState<StoryboardFrame[]>([]);
```

- [ ] **Step 3: Set `awaitingStoryboard` in the poll tick**

In the render poll `tick`, next to `setAwaitingPreview(s.awaitingPreview)`:

```ts
        setAwaitingStoryboard(s.awaitingStoryboard);
```

- [ ] **Step 4: Fetch the storyboard once when the gate opens**

Add a `useEffect`:

```ts
  useEffect(() => {
    if (!awaitingStoryboard) return;
    let active = true;
    void loadStoryboard(videoId).then((frames) => { if (active) setStoryboardFrames(frames); });
    return () => { active = false; };
  }, [awaitingStoryboard, videoId]);
```

- [ ] **Step 5: Generalize the gate-resolve handler to clear both gates**

In the existing `onResolveGate` (Slice 4), on success clear both flags:

```ts
      if (res.ok) { setAwaitingPreview(false); setAwaitingStoryboard(false); }
```

- [ ] **Step 6: Add the "Auto-produce" button**

In the render-status card, next to the "Generate Video" button, add (same `disabled={!canRender}` gate, same classes):

```tsx
            <button
              type="button"
              disabled={!canRender}
              onClick={async () => {
                const res = await startPipelineRun(videoId, false);
                if (!('blocked' in res)) begin(res.renderId);
              }}
              className="rounded-md border border-black/15 px-2.5 py-1 font-medium enabled:hover:bg-black/[0.04] disabled:opacity-40 dark:border-white/20 dark:enabled:hover:bg-white/[0.06]"
            >
              Auto-produce
            </button>
```

- [ ] **Step 7: Add the storyboard banner**

In the render-status card, immediately after the Slice-4 preview banner (`{awaitingPreview && previewUrl && (…)}`), add:

```tsx
          {awaitingStoryboard && (
            <div className="space-y-2 rounded-md border border-violet-500/40 bg-violet-500/10 p-2 text-xs">
              <p className="font-medium">Storyboard ready — approve to render, or reject to discard this run.</p>
              <div className="grid grid-cols-3 gap-2">
                {storyboardFrames.map((f) => (
                  <figure key={f.shotId} className="space-y-1">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={f.keyframeUrl} alt={f.label} className="w-full rounded border border-black/10 dark:border-white/10" />
                    <figcaption className="truncate opacity-70">{f.label}</figcaption>
                  </figure>
                ))}
              </div>
              <div className="flex items-center justify-end gap-2">
                <button type="button" disabled={gateBusy} onClick={() => onResolveGate('reject')}
                  className="rounded-md border border-red-500/40 px-2.5 py-1 font-medium text-red-600 enabled:hover:bg-red-500/10 disabled:opacity-40">
                  {gateBusy ? 'Working…' : 'Reject'}
                </button>
                <button type="button" disabled={gateBusy} onClick={() => onResolveGate('approve')}
                  className="rounded-md border border-black/15 px-2.5 py-1 font-medium enabled:hover:bg-black/[0.04] disabled:opacity-40 dark:border-white/20 dark:enabled:hover:bg-white/[0.06]">
                  {gateBusy ? 'Working…' : 'Approve'}
                </button>
              </div>
            </div>
          )}
```

(If the project's lint forbids `<img>`, the `eslint-disable` comment above handles it; if it instead mandates `next/image`, follow the existing pattern used elsewhere in the editor for signed R2 images — check how the render `<video>`/any `<img>` is done and match it.)

- [ ] **Step 8: Typecheck, lint, build**

Run: `npm run typecheck` → no errors.
Run: `npm run lint` → no errors.
Run: `npm run build` → 17/17 routes.

- [ ] **Step 9: Commit**

```bash
git add "src/app/(app)/videos/[id]/Editor.tsx"
git commit -m "feat(v2): editor Auto-produce button + storyboard review banner — Slice 6a Task 6"
```

---

## Task 7: `/jobs` — `isAwaitingStoryboard` + Review link at either gate

**Files:**
- Modify: `src/lib/jobs/monitor.ts`
- Modify: `src/lib/jobs/monitor.test.ts`
- Modify: `src/app/(app)/jobs/JobsList.tsx`

**Interfaces:**
- Consumes: `GATE_PHASE` (already imported relative in `monitor.ts` from Slice 4).
- Produces: `isAwaitingStoryboard(job: { status: string; phase: string | null }): boolean`.

**Context:** Slice 4 added `isAwaitingPreview` + the `gatePhaseLabel` (which already labels `awaiting_storyboard_review`). Add the storyboard predicate and show the existing Review link for a pipeline job at EITHER gate.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/jobs/monitor.test.ts`:

```ts
import { isAwaitingStoryboard } from './monitor.ts';

test('isAwaitingStoryboard: true only for paused + storyboard phase', () => {
  assert.equal(isAwaitingStoryboard({ status: 'paused', phase: 'awaiting_storyboard_review' }), true);
  assert.equal(isAwaitingStoryboard({ status: 'running', phase: 'awaiting_storyboard_review' }), false);
  assert.equal(isAwaitingStoryboard({ status: 'paused', phase: 'awaiting_preview_review' }), false);
  assert.equal(isAwaitingStoryboard({ status: 'paused', phase: null }), false);
});
```

(Add `isAwaitingStoryboard` to the existing top-of-file `./monitor.ts` import.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --test-name-pattern="isAwaitingStoryboard"`
Expected: FAIL (not exported).

- [ ] **Step 3: Add the helper to `src/lib/jobs/monitor.ts`**

Next to `isAwaitingPreview`:

```ts
// A pipeline job suspended at the G1 storyboard gate (V2 Slice 6a).
export function isAwaitingStoryboard(job: { status: string; phase: string | null }): boolean {
  return job.status === 'paused' && job.phase === GATE_PHASE.storyboard;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- --test-name-pattern="isAwaitingStoryboard"`
Expected: PASS.

- [ ] **Step 5: Show the Review link at either gate in `JobsList.tsx`**

Add `isAwaitingStoryboard` to the existing `@/lib/jobs/monitor` import. Change the Review-link condition from `isAwaitingPreview(job) && job.videoId` to:

```tsx
        {(isAwaitingPreview(job) || isAwaitingStoryboard(job)) && job.videoId && (
```

(The link target + classes are unchanged.)

- [ ] **Step 6: Full suite, typecheck, lint, build**

Run: `npm test` → `# fail 0`.
Run: `npm run typecheck` → no errors.
Run: `npm run lint` → no errors.
Run: `npm run build` → 17/17 routes.

- [ ] **Step 7: Commit**

```bash
git add src/lib/jobs/monitor.ts src/lib/jobs/monitor.test.ts "src/app/(app)/jobs/JobsList.tsx"
git commit -m "feat(v2): /jobs isAwaitingStoryboard + Review link at either gate — Slice 6a Task 7"
```

---

## Task 8: Operator proof — `drive:pipeline`

**Files:**
- Create: `scripts/drive-pipeline.ts`
- Modify: `package.json` (add the `drive:pipeline` script)

**Interfaces:**
- Consumes: `createAdminClient`, `inngest`. Mirrors `scripts/drive-generation.ts`.

**Context:** A headless proof of the whole spine against the FAKE generation provider: trigger the pipeline on a voiced video with ≥1 generative shot, auto-approve the G1 gate when it opens, and confirm the job completes. The fake fixtures (`GEN_FAKE_STILL_URL`/`GEN_FAKE_CLIP_URL`) must live in the DEV-SERVER `.env.local` (the function runs in the dev-server process), exactly as `drive:generation` documents. This is the FIRST exercise of `step.invoke` + the gate cascade.

- [ ] **Step 1: Create `scripts/drive-pipeline.ts`**

```ts
// Headless master-pipeline driver (V2 Slice 6a verification). Triggers reelscript.pipeline
// against the FAKE generation provider, AUTO-APPROVES the G1 storyboard gate when it opens,
// and confirms the job completes — proving step.invoke fan-out/fan-in + the gate cascade
// end-to-end without Higgsfield creds. Mirrors drive-generation.ts.
//
// PREREQUISITE — the fake's fixture URLs must be in the DEV-SERVER .env.local (the function
// runs in the dev-server process, not this script's): see scripts/drive-generation.ts header
// for GEN_FAKE_STILL_URL / GEN_FAKE_CLIP_URL. The video must have synthesized voice (the
// pipeline's completeness gate requires it) and ≥1 kind='generative' shot.
//
// Run: npm run drive:pipeline -- <videoId>
import { createAdminClient } from '../src/lib/supabase/admin';
import { inngest } from '../src/lib/inngest/client';

async function main(): Promise<void> {
  const videoId = process.argv[2];
  if (!videoId) throw new Error('Usage: npm run drive:pipeline -- <videoId>');
  const admin = createAdminClient();

  const { data: video, error: vErr } = await admin.from('videos').select('account_id, title').eq('id', videoId).single();
  if (vErr || !video) throw new Error(`load video: ${vErr?.message ?? 'not found'}`);
  const accountId = video.account_id as string;
  console.log(`Video: "${video.title}" (${videoId})`);

  // Completeness: no not_synthesized scenes (the pipeline requires voice done).
  const { data: scenes } = await admin.from('scenes').select('id, audio_status').eq('video_id', videoId);
  const sceneRows = scenes ?? [];
  if (sceneRows.length === 0) throw new Error('No scenes. Run script-gen first.');
  if (sceneRows.some((s) => s.audio_status === 'not_synthesized')) {
    throw new Error('Some scenes are not synthesized. Synthesize voice before driving the pipeline.');
  }
  const sceneIds = sceneRows.map((s) => s.id as string);
  const { count: genCount } = await admin.from('shots').select('id', { count: 'exact', head: true })
    .in('scene_id', sceneIds).eq('kind', 'generative');
  console.log(`  ${genCount ?? 0} generative shot(s) — G1 storyboard ${(genCount ?? 0) > 0 ? 'WILL' : 'will NOT'} pause.`);

  // Create the render row + the pipeline job, then fire pipeline/start.
  const rev = await admin.from('script_revisions')
    .insert({ account_id: accountId, video_id: videoId, content: { scenes: [] }, edit_summary: 'drive:pipeline' })
    .select('id').single();
  if (rev.error || !rev.data) throw new Error(`revision: ${rev.error?.message}`);
  const render = await admin.from('renders')
    .insert({ account_id: accountId, video_id: videoId, script_revision_id: rev.data.id, status: 'queued', idempotency_key: `drive-pipeline-${rev.data.id}` })
    .select('id').single();
  if (render.error || !render.data) throw new Error(`render: ${render.error?.message}`);
  const renderId = render.data.id as string;
  const job = await admin.from('jobs')
    .insert({ account_id: accountId, video_id: videoId, render_id: renderId, type: 'pipeline', status: 'queued' })
    .select('id').single();
  if (job.error || !job.data) throw new Error(`job: ${job.error?.message}`);
  const jobId = job.data.id as string;

  await inngest.send({ name: 'pipeline/start', data: { jobId, videoId, accountId, renderId } });
  console.log(`  Sent pipeline/start (job ${jobId}). Polling …`);

  let approved = false;
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const { data: j } = await admin.from('jobs').select('status, phase').eq('id', jobId).single();
    const { data: r } = await admin.from('renders').select('status').eq('id', renderId).single();
    console.log(`  [${i}] job=${j?.status}/${j?.phase} render=${r?.status}`);
    if (!approved && j?.status === 'paused' && j?.phase === 'awaiting_storyboard_review') {
      await inngest.send({ name: 'pipeline/gate.resolved', data: { jobId, accountId, decision: 'approve' } });
      console.log('  → auto-approved the G1 storyboard gate.');
      approved = true;
    }
    if (j?.status === 'complete' || r?.status === 'complete') { console.log('✓ Pipeline complete.'); return; }
    if (j?.status === 'failed' || j?.status === 'cancelled') throw new Error(`Pipeline ${j?.status} at phase ${j?.phase}.`);
  }
  throw new Error('Timed out (6 min). Check the Inngest dev server + .env.local fixtures.');
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Add the `package.json` script**

Mirror the other drive scripts (use the same `register-smoke-loader.mjs` + `--env-file=.env.local`):

```json
    "drive:pipeline": "node --env-file=.env.local --experimental-strip-types --import ./scripts/register-smoke-loader.mjs scripts/drive-pipeline.ts",
```

- [ ] **Step 3: Typecheck + build (the script compiles; the run is operator-only)**

Run: `npm run typecheck` → no errors.
Run: `npm run build` → 17/17 routes.

- [ ] **Step 4: Commit**

```bash
git add scripts/drive-pipeline.ts package.json
git commit -m "feat(v2): drive:pipeline operator proof (step.invoke + G1 auto-approve) — Slice 6a Task 8"
```

---

## Done criteria

- `reelscriptPipeline` fans out generation + ingest via `step.invoke`, runs the G1 storyboard gate (only when there are generative shots), then invokes the render; one `type='pipeline'` job owns the run and a `jobs/cancel` cascades to the children.
- The pure `storyboardLabel` + `isAwaitingStoryboard` are unit-tested and green.
- "Auto-produce" triggers `startPipelineRun`; the editor shows the storyboard grid + Approve/Reject; `/jobs` shows the Review link at either gate. The manual `Generate Video` path is byte-identical (`prepareRender` is a pure extraction).
- `npm test`, `npm run typecheck`, `npm run lint`, `npm run build` all green. One additive migration (`job_type += 'pipeline'`), applied.
- **Operator follow-up (not a code task):** `npm run drive:pipeline -- <videoId>` on a voiced video with ≥1 generative shot (fake fixtures in the dev-server `.env.local`) → job pauses at storyboard → auto-approves → render runs → complete; then exercise reject + Cancel-on-paused from the editor/`/jobs`. The `step.invoke`/gate/render path is not unit-tested (Inngest/AWS), matching every prior pipeline slice. **Watch the dev-server/Inngest-port-drift class of issue** (it has bitten the drive scripts before).
