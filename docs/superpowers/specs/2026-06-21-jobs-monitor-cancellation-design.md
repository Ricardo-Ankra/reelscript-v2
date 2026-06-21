# Jobs monitor + real Inngest cancellation — design

**Date:** 2026-06-21
**Phase:** 8 (Full surfaces) — operability
**Status:** design approved, ready for implementation plan

## Context

Background work runs as Inngest functions, each tracked by a row in the `jobs`
table. There is **no frontend view of jobs and no way to stop one**. A recent
incident made the gap concrete: a `script_generation` job sat `queued` forever
(the local Inngest dev server wasn't pointed at the live app, so the function
never ran), and the only way to see it was a DB query from a script. The editor
showed "Generating…" indefinitely with no recourse.

The goal: **see all jobs live, and actually cancel a running Inngest run** so a
fresh run can be started cleanly — not merely flip a status in the DB.

### Current state (verified)

- **`jobs` table** (`supabase/migrations/20260604184050_init_schema.sql`):
  `id, account_id, video_id, render_id, type (job_type), status (job_status),
  phase text, checkpoint jsonb, failure_class, error jsonb, attempts,
  created_at, updated_at`. RLS: the uniform `acct_isolation`
  (`auth_owns_account(account_id)`).
- **`job_type` enum:** `script_generation, voice_synthesis, render,
  primitive_deploy`.
- **`job_status` enum:** `queued, running, paused, failed, complete` — **no
  `cancelled`.**
- **Functions** (`src/app/api/inngest/route.ts`): `generateScript`,
  `synthesizeVoice`, `renderVideo`, `renderSample`, `musicRemux`,
  `deployPrimitive`. Each cancellable function's triggering event carries a
  `jobId` (`ScriptGenerateData`, `RenderStartData`, `VoiceSynthesizeData`,
  `PrimitiveDeployData`). None declare `cancelOn`; no `runId` is captured.
- **Client** (`src/lib/inngest/client.ts`): `new Inngest({ id: 'reelscript' })`;
  event payload types live here.
- **Nav** (`src/app/(app)/layout.tsx`): Home · Costs · Settings · Primitives.
- **Realtime precedent:** the Editor subscribes to `postgres_changes` on
  `jobs`/`scenes` filtered by `video_id` (`src/app/(app)/videos/[id]/Editor.tsx`).

## Goal

An operator opens `/jobs` (or sees a live count badge in the navbar), watches
every job's status update in real time, and clicks **Cancel** on an active job
to **actually cancel its Inngest run**, after which the row reads `cancelled`
and a new run can be started from the existing UI.

## Scope

**In scope:**

- A `cancelled` value on the `job_status` enum.
- A `jobs/cancel` event + `cancelOn` on all four job functions, correlated by
  `jobId`.
- A `cancelJob` server action (true cancellation + row/render-row update).
- A `/jobs` page (server first paint + Realtime) listing Active + Recent jobs.
- A navbar **Jobs** link with a live active-count badge.
- A pure, unit-tested helper for cancellability + display labels + the
  active/recent partition.

**Out of scope (deferred / not needed):**

- **Retry / re-trigger** of a cancelled or failed job — a follow-up slice.
  After cancelling, the operator starts a new run via the existing Generate /
  Regenerate / Generate Video controls.
- Run-id capture and REST cancel-by-runId (the `cancelOn` event makes it
  unnecessary).
- `musicRemux` cancellation (short, audio-only; has no `job_type` of its own).
- Bulk cancellation; job filtering/search; pagination beyond a recent window.

## Architecture

### 1. Cancellation mechanism — `cancelOn` event, correlated by `jobId`

Inngest's declarative cancellation: when an event matching a function's
`cancelOn` rule arrives during a run's lifetime, Inngest cancels the run
(stopping it between steps; an in-flight step finishes, later steps do not run).

Each of the four job functions gains a `cancelOn` rule correlated on the shared
`jobId`. Inngest's same-field `match` shorthand expresses exactly this:

```ts
cancelOn: [{ event: 'jobs/cancel', match: 'data.jobId' }]
```

`match: 'data.jobId'` cancels the run whose original triggering event has the
same `data.jobId` as the incoming `jobs/cancel` event. (If the installed
`inngest` version needs the explicit form instead, it is equivalent to
`if: 'async.data.jobId == event.data.jobId'` — `event` = the original trigger,
`async` = the cancel event. The exact form is confirmed against the installed
version during implementation; the correlation key is `jobId` either way.)

**Why this approach** (vs. REST cancel-by-`runId`, which needs run-id capture +
an Inngest API key and differs between the dev server and cloud; vs. the bulk
cancel API, which is too coarse): `cancelOn` needs no run-id, no API key, is
declarative, and works identically in dev and cloud.

**Two cases, both handled:**

- **Genuinely running run** → `cancelOn` stops it.
- **Queued-but-never-started** (the incident case — no run exists) → `cancelOn`
  matches nothing, harmlessly; the action below still marks the row, which is
  what frees the operator to start anew.

### 2. Data model & events

- **Migration** (`supabase/migrations/<ts>_job_status_cancelled.sql`):
  `ALTER TYPE job_status ADD VALUE IF NOT EXISTS 'cancelled';` — as its own
  statement (Postgres forbids using a freshly-added enum value in the same
  transaction; the project applies migrations via `npm run db:apply`).
- **New event** in `client.ts`:
  `export type JobCancelData = { jobId: string; accountId: string };`
  (`'jobs/cancel'`).

### 3. Cancel action + function wiring

`src/app/(app)/jobs/actions.ts` (`'use server'`):

```ts
export async function cancelJob(
  jobId: string,
): Promise<{ ok: true } | { ok: false; reason: string }>;
```

- Resolve the session account; RLS-load the job by id.
- Guard: not found → "Job not found."; not active (status ∉
  `queued|running|paused`) → "Job is not running." (no phantom cancel).
- `inngest.send({ name: 'jobs/cancel', data: { jobId, accountId } })`.
- Update the job row → `status = 'cancelled'` (RLS, `.select('id')` no-row guard).
- If `type === 'render'` and `render_id` is set, also update that `renders` row
  → `status = 'failed'`, `error = { cancelled: true }`, so the editor's render
  state clears and a new render starts clean (render idempotency reuses only
  *in-flight* renders; a cancelled one is terminal, so the next render makes a
  fresh row).
- Returns `{ ok }` / `{ ok:false, reason }`. Never throws to the client.

`cancelOn` added to `generateScript`, `renderVideo`, `synthesizeVoice`,
`deployPrimitive` (all four job types). `renderSample` and `musicRemux` are
out of scope.

### 4. Pure helper — `src/lib/jobs/monitor.ts` (no react/server/network, tested)

```ts
export type JobStatus = 'queued' | 'running' | 'paused' | 'failed' | 'complete' | 'cancelled';

export const ACTIVE_JOB_STATUSES: readonly JobStatus[]; // queued, running, paused

export function isCancellable(status: string): boolean; // status ∈ ACTIVE_JOB_STATUSES

export function jobStatusLabel(status: string): string; // queued→Queued, running→Running,
//   paused→Paused, complete→Complete, failed→Failed, cancelled→Cancelled, else the raw string

// Split rows into the two display groups (Active first; Recent = terminal).
export interface JobRow {
  id: string; type: string; status: string; phase: string | null;
  videoId: string | null; videoTitle: string | null;
  createdAt: string; updatedAt: string; error: unknown;
}
export function partitionJobs(rows: JobRow[]): { active: JobRow[]; recent: JobRow[] };
```

`partitionJobs`: `active` = `isCancellable(status)`, ordered `created_at` desc;
`recent` = the rest, ordered `updated_at` desc. The 24h cutoff for "recent" is
applied at the query (Section 5), not here.

### 5. Jobs monitor UI

**`/jobs` page** `src/app/(app)/jobs/page.tsx` (server):

- RLS read of the account's jobs: active jobs (status ∈ active) regardless of
  age, plus terminal jobs from the last 24h, joined to `videos(title)` for the
  label. Mapped to `JobRow[]`; passed to a client `JobsList`.
- `JobsList` (client): seeds from the server rows, subscribes to
  `postgres_changes` on `jobs` (account-wide — no `video_id` filter; RLS scopes
  it) and reconciles on subscribe (same pattern as the Editor). Renders the
  `partitionJobs` groups. Each active row shows a **Cancel** button →
  `cancelJob(id)` (busy/disabled while pending; optimistic flip to `cancelled`
  on `{ ok }`, inert on failure with the reason). Row content: type ·
  video-title link (`/videos/<id>` when `videoId`) · `jobStatusLabel` + phase ·
  relative age · error (when present). Empty state: "No jobs yet."

**Navbar** (`layout.tsx`): a **Jobs** link with a live active-count badge. A
small client `JobsNavBadge` seeded with a server count (active jobs for the
account) and subscribed to the same `jobs` Realtime channel; renders `Jobs` with
a count chip when `> 0`. Added after Primitives.

### Data flow

```
/jobs (server) → read jobs (active + recent 24h) + video titles → JobsList
JobsList ── Realtime postgres_changes(jobs, account) ──▶ live status updates
Cancel ▶ cancelJob(jobId)
   guard active → inngest.send('jobs/cancel', {jobId, accountId})
   → Inngest cancelOn matches by jobId → run cancelled (if any)
   → job.status = 'cancelled' (+ render row failed{cancelled} for render jobs)
   → Realtime echoes the row → UI shows Cancelled
navbar JobsNavBadge ── same Realtime channel ──▶ live active count
```

## Error handling

- `cancelJob` on a missing/not-owned job → "Job not found." (RLS miss);
  on a terminal job → "Job is not running." No event sent, no phantom update.
- `inngest.send` failure → the action surfaces a reason; the row is **not**
  marked cancelled (so the UI doesn't claim a cancel that didn't dispatch).
- Cancelling a queued-but-never-started job: the event matches no run (harmless);
  the row is still marked `cancelled` so the operator can start fresh.
- A cancelled run never reaches its `mark-complete` step, so it cannot overwrite
  the `cancelled` status after the fact.
- Realtime drop → the page's initial server read is always correct on load/reload;
  the subscribe-time reconcile closes the gap (Editor pattern).

## Back-compatibility

- Additive. The enum gains a value; existing statuses and rows are unchanged.
- No change to how jobs are created or to existing function behavior beyond the
  added `cancelOn` rule (inert unless a `jobs/cancel` event arrives).
- New routes/nav only; no existing surface changes except one nav link added.

## Testing

- **Unit (`src/lib/jobs/monitor.test.ts`):** `isCancellable` for each status;
  `jobStatusLabel` mapping incl. `cancelled` and an unknown fallback;
  `partitionJobs` (active vs terminal grouping + ordering).
- **Regression:** `npm test` green; `npx tsc --noEmit` + `npm run lint` clean;
  `npm run build` succeeds (new routes + nav).
- **Manual / app-run e2e:** start a render → it appears in `/jobs` Active and the
  navbar badge increments → Cancel → the run shows cancelled in the Inngest
  dashboard, the job row reads `Cancelled`, the editor's render state clears, and
  a new render starts cleanly. Repeat for a `script_generation` job. Cancel a
  queued (never-started) job → row flips to `cancelled` and a new run can start.

## Open questions

None. Settled: `cancelOn`-by-`jobId` cancellation for all four job types; a
distinct `cancelled` status (enum migration); a render job's cancel also marks
its render row `failed`+`{cancelled}`; navbar badge + `/jobs` page; retry
deferred to a follow-up slice.
