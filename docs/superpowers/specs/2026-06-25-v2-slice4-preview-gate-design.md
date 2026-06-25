# Reelscript V2 — Slice 4: Human gates (G2 preview, + reusable G1 primitive) — Design

> **Reelscript V2 program, Slice 4 (in-app human gates).**
> The program lists Slice 4 as "gates G1 (storyboard) + G2 (preview), in-app via Inngest
> `waitForEvent`." This slice builds the **reusable human-gate mechanism** and proves it
> end-to-end by wiring the **G2 preview gate** into the existing `renderVideo` (opt-in). The
> **G1 storyboard gate** reuses the same primitive but its *wiring* (and the storyboard
> thumbnail view) defers to **Slice 6**, where the generative pipeline it reviews actually
> runs. The master `reelscript.pipeline` orchestration that chains both gates is Slice 6.

## 0. Context & locked decisions

- **Program runtime/data** locked in the V2 program (Next.js + Supabase + RLS + Inngest +
  Remotion Lambda + R2). See `2026-06-24-v2-slice0-shot-model-contract-design.md` §0.
- **Scope (Option A).** Build the gate mechanism as a reusable unit; demonstrate it
  end-to-end via **G2 preview** wired into `renderVideo` (the one place an
  assembled/graded base MP4 exists today). G1 storyboard is built as the same primitive,
  wired later (Slice 6). Rationale: `step.waitForEvent` + pausing/resuming a job for human
  input is the riskiest, never-done-before part — derisk it now on a flow that runs today.
- **Naming collision (important).** `renderVideo` already has **automated** steps named
  `gate1`/`gate2` (compose-validation in `composition/gate1.ts`; smoke-frame vision QA in
  `composition/gate2.ts` via `runGate2`). Those are machine checks, NOT human gates. This
  slice uses distinct names everywhere: `human-gate-preview`, `runGate`, the event
  `pipeline/gate.resolved`, the phase `awaiting_preview_review`.
- **Representation = on the job (Approach A).** Gate state lives on the existing `jobs` row:
  `status='paused'` (the `job_status` enum already has `paused`, written by nothing today —
  the natural slot) + `phase='awaiting_preview_review'`. The preview artifact is **derived**
  from `renders.base_output_r2_key` (already set by `finalize-base`/`grade-base`). **No new
  columns, no new enum values, no migration.** The existing jobs Realtime (editor + `/jobs`)
  surfaces the pause automatically.
- **Opt-in, default off.** `preview_gate: boolean` joins the `VideoSettings` contract, so a
  render with it off is **byte-identical to today** (no pause). It rides the same
  `channels.defaults` ⊕ `video.settings` machinery as captions/music/`color_look` — no
  migration, free UI inheritance.
- **Resume by `jobId`.** The approve/reject UI sends `pipeline/gate.resolved {jobId,
  decision}`; the suspended function's `waitForEvent` matches on
  `async.data.jobId == event.data.jobId` (the same correlation key the Cancel action uses).
- **Reject terminates this render** (recoverable via edit + re-render) — **not** an
  auto-revise loop (that's Slice 6). **Timeout 7 days → auto-reject** (recoverable). Both are
  deliberate simplicity calls for the single-operator V1.
- **Preview is pre-music.** G2 previews the **graded base MP4** (voiceover, no music yet);
  music is a deterministic, non-visual post-pass (its own Inngest function) applied on
  approve and re-tunable via the music panel. The gate is a *visual/assembly* approval, so
  reviewing the graded base before the music handoff is correct and far simpler than
  restructuring the async music remux. Deliberate call.
- **Cancel still works during a pause** — `jobs/cancel` + the functions' existing `cancelOn`
  cancel a run suspended at `waitForEvent` with zero new code. A paused gate row keeps its
  `/jobs` Cancel affordance.

## 1. Goal & non-goals

**Goal.** An opt-in **preview gate**: when enabled, a render pauses after the graded base
MP4 is produced and waits for the operator to **Approve** (→ music + finalize as today) or
**Reject** (→ render terminates cleanly, recoverable) in-app — the pause surfaced through
the existing jobs Realtime, the decision delivered by an Inngest event. Plus a **reusable
`runGate` primitive** (parameterized by gate kind) that Slice 6 will reuse for the G1
storyboard gate.

**Non-goals (deferred).** No G1 storyboard *wiring* and no storyboard thumbnail view (Slice
6 — no production pipeline feeds it yet). No master `reelscript.pipeline` orchestration
(Slice 6). No auto-revise loop on reject (Slice 6). No Slack/external review (in-app only).
No new migration. No change to composition, captions, voice, generation (1b), ingest (2b),
assembly (3a), color (3b), or the automated `gate1`/`gate2` checks. No change to the music
remux. When `preview_gate` is off, the render path is unchanged.

## 2. Current state (anchors)

- `src/lib/inngest/functions/render.ts` — `renderVideo`. After `finalize-base` (writes
  `renders/<id>.base.mp4` + `base_output_r2_key`) and the Slice-3b `grade-base` step, it
  branches: music on ⇒ `emit-remux` sends `music/remux`; music off ⇒ `finalize` sets
  `output_r2_key`. **Slice 4 inserts the preview gate between `grade-base` and that branch.**
  `composed` (the big compose `step.run`) surfaces per-render flags; `loadBrief` reads
  `video.settings`. The function already uses `cancelOn:[{event:'jobs/cancel', if:'…jobId…'}]`.
- `src/lib/videos/settings.ts` — `VideoSettings`/`VideoSettingsPatch`/`SETTINGS_DEFAULTS` +
  `sanitizeSettingsPatch`/`parseVideoSettings`. **3b's `color_look` is the exact template for
  adding `preview_gate`** (a new key on the contract, inherited everywhere via
  `create-settings.ts`, no migration).
- `src/lib/jobs/monitor.ts` — pure `isCancellable`/`jobStatusLabel`/`partitionJobs`,
  `ACTIVE_JOB_STATUSES` (already includes `'paused'`). **Slice 4 adds `isAwaitingPreview` +
  a phase label here.**
- `src/app/(app)/jobs/actions.ts` — `cancelJob` (account-scoped, `inngest.send({name:
  'jobs/cancel'…})` then marks the row). **`resolveGate` mirrors this** (send the event;
  the suspended function does the transition).
- `src/app/(app)/jobs/` (page + `JobsList`) and `src/app/(app)/videos/[id]/Editor.tsx` —
  both subscribe to `postgres_changes` on `jobs`. A `phase`/`status` update on the paused
  job surfaces to both automatically.
- `job_status` enum: `queued | running | paused | failed | complete | cancelled`
  (`20260604184050_init_schema.sql` + `20260621170000_job_status_cancelled.sql`). `paused`
  exists, written by nothing today.
- `src/app/api/inngest/route.ts` — `serve({functions:[…]})`. No `step.waitForEvent` exists
  anywhere yet; Inngest `^4.5.0`. `cancelOn` uses the non-deprecated `if`-expression form.
- Tests: `npm test` = `node --experimental-strip-types --import ./scripts/register-loader.mjs
  --test "src/**/*.test.ts"`. Test files use `node:test` + import the module with `.ts`.

## 3. The gate primitive — `src/lib/gates/gate.ts` (+ test)

Pure (no react/server/network), unit-tested. The single source of the gate vocabulary.

```ts
export type GateKind = 'storyboard' | 'preview';
export type GateDecision = 'approve' | 'reject';

export const GATE_EVENT = 'pipeline/gate.resolved';
export const GATE_TIMEOUT = '7d'; // Inngest duration string; on expiry → reject

export const GATE_PHASE: Record<GateKind, string> = {
  storyboard: 'awaiting_storyboard_review',
  preview: 'awaiting_preview_review',
};

// Never-throws. Validates an incoming event's decision field.
export function parseGateDecision(raw: unknown): GateDecision | null;

// Maps a waitForEvent result to a decision. null event (timeout / no match) → 'reject'
// (safe default: an unreviewed render does not silently ship). A malformed decision → 'reject'.
export function gateResolution(event: { data?: { decision?: unknown } } | null): GateDecision;
```

- `parseGateDecision`: returns `'approve'`/`'reject'` for those exact strings, else `null`.
- `gateResolution(null)` → `'reject'`; `gateResolution({data:{decision:'approve'}})` →
  `'approve'`; `gateResolution({data:{decision:'bogus'}})` → `'reject'`.

Tested: `parseGateDecision` valid/invalid/non-string → null; `gateResolution` null→reject,
approve→approve, reject→reject, malformed→reject; `GATE_PHASE` covers both kinds.

## 4. The Inngest helper — `runGate(step, admin, {jobId, kind})`

Lives in `src/lib/inngest/functions/render.ts` (or a small `src/lib/inngest/gates.ts`
imported by it). Not unit-tested (Inngest/DB I/O, matching the pipeline precedent); its pure
core (`gateResolution`/`GATE_PHASE`) IS tested.

```ts
async function runGate(step, admin, opts: { jobId: string; kind: GateKind }): Promise<GateDecision> {
  await step.run(`enter-gate-${opts.kind}`, async () => {
    await admin.from('jobs')
      .update({ status: 'paused', phase: GATE_PHASE[opts.kind] })
      .eq('id', opts.jobId);
  });
  const ev = await step.waitForEvent(`human-gate-${opts.kind}`, {
    event: GATE_EVENT,
    timeout: GATE_TIMEOUT,
    if: 'async.data.jobId == event.data.jobId',
  });
  return gateResolution(ev);
}
```

- The `step.run` makes the pause durable; `waitForEvent` suspends the run.
- The caller owns the next transition (approve → set running + continue; reject → terminate).
- `jobs/cancel` + the function's existing `cancelOn` cancels a run suspended here (Cancel
  during a pause needs no new code).

## 5. Settings — `src/lib/videos/settings.ts` (+ test)

Additive, mirrors `color_look` (Slice 3b) and `music_on`.

- `VideoSettingsPatch` += `preview_gate?: boolean`; `VideoSettings` += `preview_gate: boolean`.
- `SETTINGS_DEFAULTS.preview_gate = false`.
- `sanitizeSettingsPatch`: `if (typeof p.preview_gate === 'boolean') out.preview_gate = …`
  (next to the existing `captions_on`/`music_on` boolean checks).
- `parseVideoSettings` picks it up via `sanitizeSettingsPatch` (no extra code).
- `create-settings.ts` inherits it (channel default ⊕ override) with no change (DRY).

Tested: valid boolean survives sanitize; non-boolean dropped; default `false`; round-trip.
**Note (lesson from 3b):** adding a settings key can break `create-settings.test.ts` /
`brand.test.ts` full-shape `deepEqual` assertions — the plan must update those expected
literals, and the implementer must run the FULL `npm test`, not a scoped pattern.

## 6. Render integration — the preview gate in `renderVideo`

`loadBrief` reads `settings.preview_gate` (boolean, default false); `composed` surfaces it
as `previewGate`. Insert the gate after `finalize-base` and the 3b `grade-base` step, before
the music/finalize branch:

```ts
if (composed.previewGate) {
  const decision = await runGate(step, admin, { jobId, kind: 'preview' });
  if (decision === 'reject') {
    await step.run('reject-preview', async () => {
      const error = { phase: 'preview_gate', message: 'Preview rejected by operator' };
      await admin.from('renders').update({ status: 'failed', error }).eq('id', renderId);
      await admin.from('jobs').update({ status: 'failed', phase: 'failed', error }).eq('id', jobId);
    });
    return { renderId, failed: 'preview_gate' as const };
  }
  // approve: clear the paused state (the rendering is already done) before the normal
  // pipeline takes over — the music branch sets phase='encoding', the no-music finalize
  // sets phase='done'. A non-terminal 'encoding' holding label, no new enum value.
  await step.run('resume-after-preview', async () => {
    await admin.from('jobs').update({ status: 'running', phase: 'encoding' }).eq('id', jobId);
  });
}
// unchanged: music on ⇒ emit-remux; music off ⇒ finalize (uses effectiveBaseKey from 3b)
```

- The `reject` `error` shape (`{phase, message}`) is the structured form Slice A's
  `parseRenderError`/`RenderErrorCard` already render. Recoverable: the operator edits scenes
  and re-renders (a rejected render is `failed`, not in-flight).
- `previewGate` false ⇒ the whole block is skipped ⇒ byte-identical to today.
- The preview the operator sees is the **graded base** (`base_output_r2_key`), pre-music.

## 7. UI

### 7.1 Server action — `resolveGate(jobId, decision)`
`src/app/(app)/videos/[id]/gate-actions.ts` (or `jobs/actions.ts`). Mirrors `cancelJob`:
account-scoped ownership check (load the job's `account_id` under RLS), then
`inngest.send({ name: GATE_EVENT, data: { jobId, accountId, decision } })`. No optimistic row
write — the suspended function performs the status transition on resume. Returns `{ok}` /
`{ok:false, reason}`.

### 7.2 Pure detection — `src/lib/jobs/monitor.ts`
- `isAwaitingPreview(job): boolean` = `job.status === 'paused' && job.phase ===
  GATE_PHASE.preview` (import the constant from `gates/gate.ts` — pure→pure).
- A label for the phase (e.g. `gatePhaseLabel(phase)` → "Awaiting preview review") for `/jobs`.
- Unit-tested.

### 7.3 Editor — preview-review banner
`src/app/(app)/videos/[id]/` — when the editor's live job shows `isAwaitingPreview(job)`,
render a banner: the graded base `<video>` (signed URL of `base_output_r2_key` — reuse the
existing render-state load that already signs the latest render) + **Approve** /
**Reject** buttons calling `resolveGate(jobId, 'approve'|'reject')`. After a click the job
realtime transitions the banner away (approve → render continues; reject → the Slice-A
render-error card shows). Busy/disabled handling + try/catch per the existing action patterns.

### 7.4 /jobs — paused state + review link
`JobsList` renders an awaiting-preview job with the `gatePhaseLabel` and a **Review** link to
`/videos/<videoId>` (the video plays in the editor, where Approve/Reject live). The existing
account-wide jobs Realtime drives it — no new subscription. (Approve/Reject inline on `/jobs`
is intentionally omitted — the decision needs the video, which lives in the editor.)

## 8. Testing

- **Unit (node:test):** `gate.ts` (`parseGateDecision` valid/invalid/non-string;
  `gateResolution` null→reject / approve / reject / malformed→reject; `GATE_PHASE` both
  kinds). `settings.ts` (`preview_gate` sanitize valid/invalid + default false + round-trip).
  `monitor.ts` (`isAwaitingPreview` true only for paused+preview-phase; false otherwise).
  `create-settings`/`brand` full-shape assertions updated for the new key (run the FULL
  suite).
- **Gate flow (operator):** `drive:render` on a video with `preview_gate` on → confirm the
  job pauses (`status=paused`, `phase=awaiting_preview_review`) → call `resolveGate(jobId,
  'approve')` (or a small helper / the editor button) → render completes; repeat with
  `'reject'` → render `failed` with the preview-gate error; confirm Cancel on a paused job
  still terminates it. The `waitForEvent`/render-wiring/UI are not unit-tested (Inngest/AWS),
  matching the remux/gate2 precedent.
- **Gates:** `npm test`, `npm run typecheck`, `npm run lint`, `npm run build` all green.
- **No migration.**

## 9. Backward compatibility

Additive. `preview_gate` defaults `false` ⇒ existing and unconfigured videos render with no
pause, byte-identical to today. The gate state reuses the existing `jobs.status='paused'`
enum value (previously unused) + a phase string — no schema change. The automated
`gate1`/`gate2` checks, music remux, composition, captions, voice, and assembly paths are
untouched. `paused` already counts as an active status (`ACTIVE_JOB_STATUSES`) so the navbar
badge + `/jobs` Active group include a gated job with no change.

## 10. File structure (drives the plan)

| File | Responsibility |
| --- | --- |
| `src/lib/gates/gate.ts` (+ test) (create) | `GateKind`/`GateDecision`/`GATE_PHASE`/`GATE_EVENT`/`GATE_TIMEOUT`, `parseGateDecision`, `gateResolution` |
| `src/lib/videos/settings.ts` (modify) (+ test) | add `preview_gate` to the settings contract |
| `src/lib/videos/create-settings.test.ts` + `src/lib/channels/brand.test.ts` (modify) | update full-shape assertions for the new key |
| `src/lib/inngest/functions/render.ts` (modify) | `runGate` helper + preview-gate branch (loadBrief reads `preview_gate`, composed surfaces `previewGate`) |
| `src/lib/jobs/monitor.ts` (modify) (+ test) | `isAwaitingPreview` + `gatePhaseLabel` |
| `src/app/(app)/videos/[id]/gate-actions.ts` (create) | `resolveGate(jobId, decision)` server action |
| `src/app/(app)/videos/[id]/` editor (modify) | preview-review banner (video + Approve/Reject) |
| `src/app/(app)/videos/[id]/VideoSettingsPanel.tsx` (modify) | `preview_gate` toggle (per-video) |
| `src/app/(app)/channels/[id]/BrandEditor.tsx` + `brand.ts` (modify) | `preview_gate` channel default |
| `src/app/(app)/jobs/JobsList.tsx` (modify) | paused-gate label + Review link |

## 11. Open items (resolved-by-default; flagged for the plan)

- **Reject cleanup:** a rejected render's `base_output_r2_key` object is left in place
  (harmless; cleaned on video delete). No best-effort delete needed.
- **Phase label on resume:** approve sets `phase='encoding'` as a non-terminal holding label
  before the music/finalize branch overwrites it — no new render-phase/enum value.
- **Settings UI for `preview_gate`:** a per-video toggle (`VideoSettingsPanel`) + a channel
  default (`BrandEditor`/`brand.ts`), both reusing the captions/music toggle pattern — same
  pure-core + no-phantom-save discipline as 3b's `color_look`.
- **G1 storyboard:** `runGate` + `GateKind='storyboard'` + `GATE_PHASE.storyboard` ship as
  the reusable primitive; the storyboard thumbnail view (per-shot `keyframe_first_key`) and
  the wiring into the generative pipeline are Slice 6. No storyboard UI this slice (YAGNI —
  nothing feeds it).
- **Idempotency/re-render after reject** is the existing `startVideoRender` behavior (a
  failed render is not in-flight) — unchanged by this slice.
