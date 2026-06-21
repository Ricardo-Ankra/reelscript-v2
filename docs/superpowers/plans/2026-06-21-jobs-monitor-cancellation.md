# Jobs Monitor + Real Inngest Cancellation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** See all jobs live in the frontend and actually cancel a running Inngest run (so a fresh run can be started), via a `/jobs` page and a navbar badge.

**Architecture:** Inngest `cancelOn` keyed by `jobId` (a `jobs/cancel` event) cancels the real run on all four job functions; a `cancelJob` server action sends that event and marks the row `cancelled` (and a render job's `renders` row `failed`+`{cancelled}`). A `/jobs` page and a navbar count badge read the RLS-scoped `jobs` table and stay live over Supabase Realtime. A pure helper holds cancellability/label/partition logic.

**Tech Stack:** Next.js App Router (server + client components), Inngest, Supabase JS (RLS + Realtime), node:test.

## Global Constraints

- **Cancellation = real Inngest cancellation** via `cancelOn` on the event `jobs/cancel`, correlated by `jobId` (`match: 'data.jobId'`). Added to the four job functions ONLY: `generateScript` (`generate-script`), `renderVideo` (`render-video`), `synthesizeVoice` (`synthesize-voice`), `deployPrimitive` (`deploy-primitive`). NOT `renderSample`, NOT `musicRemux`.
- **New `job_status` enum value `cancelled`** (migration; its own statement). Existing values: `queued, running, paused, failed, complete`.
- **Active statuses** = `queued, running, paused`. **Recent** = terminal jobs (`failed, complete, cancelled`) updated within the last 24h.
- **`cancelJob`**: guard the job is owned + active (else friendly reason, no event/no update); send `jobs/cancel`; then mark the job row `cancelled`; for a `render` job also mark its `renders` row `status='failed', error={cancelled:true}`. RLS-scoped writes with `.select('id')` no-row guards (no phantom success). On `inngest.send` failure, do NOT mark the row.
- **Retry is OUT of scope** for this plan (a later slice). After cancelling, a new run starts from existing UI.
- **Realtime** subscribes to `postgres_changes` on table `jobs` account-wide (no `video_id` filter; RLS scopes rows). Mirrors the Editor's existing pattern (`src/app/(app)/videos/[id]/Editor.tsx`).
- **Tests** run with `node --experimental-strip-types --import ./scripts/register-loader.mjs --test <file>`. Test files import source with an explicit `.ts` extension; `import { test } from 'node:test'; import assert from 'node:assert/strict';`.
- **Server actions / routes / Inngest config are not unit-tested** (network/integration) — their pure logic lives in the tested helper; verification is `tsc` + `lint` + `build`.
- **Commit footer:** end every commit message with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- All Supabase reads/writes are RLS-scoped to the session account.

## File Structure

**Create:**
- `supabase/migrations/20260621170000_job_status_cancelled.sql` — add `cancelled` to `job_status`.
- `src/lib/jobs/monitor.ts` — pure: statuses, `isCancellable`, `jobStatusLabel`, `JobRow`, `partitionJobs`.
- `src/lib/jobs/monitor.test.ts` — node:test for the above.
- `src/app/(app)/jobs/actions.ts` — `loadJobs`, `countActiveJobs`, `cancelJob`.
- `src/app/(app)/jobs/page.tsx` — server page (first paint).
- `src/app/(app)/jobs/JobsList.tsx` — client list + Cancel + Realtime.
- `src/app/(app)/jobs/JobsNavBadge.tsx` — client navbar badge.

**Modify:**
- `src/lib/inngest/client.ts` — add `JobCancelData` type.
- `src/lib/inngest/functions/generate-script.ts` — add `cancelOn`.
- `src/lib/inngest/functions/render.ts` — add `cancelOn` to `renderVideo`.
- `src/lib/inngest/functions/synthesize-voice.ts` — add `cancelOn`.
- `src/lib/inngest/functions/deploy-primitive.ts` — add `cancelOn`.
- `src/app/(app)/layout.tsx` — add the Jobs nav link + badge.

---

### Task 1: Migration — `cancelled` job status

**Files:**
- Create: `supabase/migrations/20260621170000_job_status_cancelled.sql`

**Interfaces:**
- Produces: the `job_status` enum gains the value `cancelled` (used by Tasks 2, 4, 5).

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260621170000_job_status_cancelled.sql`:

```sql
-- Jobs monitor (Phase 8): a distinct terminal status for an operator-cancelled
-- run, so the UI reads honestly ("Cancelled" vs "Failed"). On Postgres 15 ADD
-- VALUE is allowed inside the apply script's transaction as long as the value is
-- not USED in the same transaction (it isn't here).
alter type job_status add value if not exists 'cancelled';
```

- [ ] **Step 2: Apply the migration**

Run: `npm run db:apply -- supabase/migrations/20260621170000_job_status_cancelled.sql`
Expected: `Applied supabase/migrations/20260621170000_job_status_cancelled.sql.`

(If it errors with "ALTER TYPE ... ADD cannot run inside a transaction block", that Postgres is <12; escalate — the fallback is to run the single `ALTER TYPE` statement over a non-transactional connection. On Supabase PG15 this should not occur.)

- [ ] **Step 3: Verify the value exists**

Run:
```bash
node --env-file=.env.local -e 'import("pg").then(async ({ default: pg }) => { const c = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL }); await c.connect(); const r = await c.query("select unnest(enum_range(null::job_status)) as v"); console.log(r.rows.map(x => x.v).join(", ")); await c.end(); });'
```
Expected: output includes `cancelled` (e.g. `queued, running, paused, failed, complete, cancelled`).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260621170000_job_status_cancelled.sql
git commit -m "feat(jobs): add 'cancelled' to job_status enum

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Pure monitor helpers

**Files:**
- Create: `src/lib/jobs/monitor.ts`
- Test: `src/lib/jobs/monitor.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type JobStatus = 'queued' | 'running' | 'paused' | 'failed' | 'complete' | 'cancelled'`
  - `const ACTIVE_JOB_STATUSES: readonly ['queued', 'running', 'paused']`
  - `function isCancellable(status: string): boolean`
  - `function jobStatusLabel(status: string): string`
  - `interface JobRow { id; type; status; phase: string|null; videoId: string|null; videoTitle: string|null; createdAt: string; updatedAt: string; error: unknown }`
  - `function partitionJobs(rows: JobRow[]): { active: JobRow[]; recent: JobRow[] }`

- [ ] **Step 1: Write the failing test**

Create `src/lib/jobs/monitor.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isCancellable,
  jobStatusLabel,
  partitionJobs,
  ACTIVE_JOB_STATUSES,
  type JobRow,
} from './monitor.ts';

test('isCancellable: true for active statuses only', () => {
  for (const s of ['queued', 'running', 'paused']) assert.equal(isCancellable(s), true);
  for (const s of ['failed', 'complete', 'cancelled', 'weird']) assert.equal(isCancellable(s), false);
});

test('ACTIVE_JOB_STATUSES is exactly the three active statuses', () => {
  assert.deepEqual([...ACTIVE_JOB_STATUSES], ['queued', 'running', 'paused']);
});

test('jobStatusLabel: known statuses + unknown fallback', () => {
  assert.equal(jobStatusLabel('queued'), 'Queued');
  assert.equal(jobStatusLabel('running'), 'Running');
  assert.equal(jobStatusLabel('paused'), 'Paused');
  assert.equal(jobStatusLabel('complete'), 'Complete');
  assert.equal(jobStatusLabel('failed'), 'Failed');
  assert.equal(jobStatusLabel('cancelled'), 'Cancelled');
  assert.equal(jobStatusLabel('mystery'), 'mystery');
});

function row(id: string, status: string, createdAt: string, updatedAt: string): JobRow {
  return { id, type: 'render', status, phase: null, videoId: null, videoTitle: null, createdAt, updatedAt, error: null };
}

test('partitionJobs: active (by created desc) vs recent (by updated desc)', () => {
  const rows = [
    row('a', 'running', '2026-06-21T10:00:00Z', '2026-06-21T10:05:00Z'),
    row('b', 'complete', '2026-06-21T09:00:00Z', '2026-06-21T09:30:00Z'),
    row('c', 'queued', '2026-06-21T11:00:00Z', '2026-06-21T11:00:00Z'),
    row('d', 'cancelled', '2026-06-21T08:00:00Z', '2026-06-21T12:00:00Z'),
  ];
  const { active, recent } = partitionJobs(rows);
  assert.deepEqual(active.map((r) => r.id), ['c', 'a']); // created desc
  assert.deepEqual(recent.map((r) => r.id), ['d', 'b']); // updated desc
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/jobs/monitor.test.ts`
Expected: FAIL — cannot resolve `./monitor.ts`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/jobs/monitor.ts`:

```ts
// Pure helpers for the jobs monitor (Phase 8). No react/server/network. Shared by
// the /jobs page, the cancel action, and the navbar badge.

export type JobStatus = 'queued' | 'running' | 'paused' | 'failed' | 'complete' | 'cancelled';

// The statuses that mean "in flight" — the ones that can be cancelled and that
// drive the navbar's active count.
export const ACTIVE_JOB_STATUSES = ['queued', 'running', 'paused'] as const;

export function isCancellable(status: string): boolean {
  return (ACTIVE_JOB_STATUSES as readonly string[]).includes(status);
}

const LABELS: Record<string, string> = {
  queued: 'Queued',
  running: 'Running',
  paused: 'Paused',
  complete: 'Complete',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export function jobStatusLabel(status: string): string {
  return LABELS[status] ?? status;
}

export interface JobRow {
  id: string;
  type: string;
  status: string;
  phase: string | null;
  videoId: string | null;
  videoTitle: string | null;
  createdAt: string;
  updatedAt: string;
  error: unknown;
}

// Active first (newest-created first); recent = terminal rows (most recently
// updated first). The 24h window for "recent" is applied at the query, not here.
export function partitionJobs(rows: JobRow[]): { active: JobRow[]; recent: JobRow[] } {
  const active = rows
    .filter((r) => isCancellable(r.status))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const recent = rows
    .filter((r) => !isCancellable(r.status))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { active, recent };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/jobs/monitor.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/jobs/monitor.ts src/lib/jobs/monitor.test.ts
git commit -m "feat(jobs): pure monitor helpers (cancellability, labels, partition)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: `jobs/cancel` event + `cancelOn` on the four functions

**Files:**
- Modify: `src/lib/inngest/client.ts`
- Modify: `src/lib/inngest/functions/generate-script.ts`
- Modify: `src/lib/inngest/functions/render.ts`
- Modify: `src/lib/inngest/functions/synthesize-voice.ts`
- Modify: `src/lib/inngest/functions/deploy-primitive.ts`

**Interfaces:**
- Produces: the `jobs/cancel` event (`JobCancelData = { jobId: string; accountId: string }`) consumed by Task 4; each of the four functions cancels its run when a matching `jobs/cancel` (same `data.jobId`) arrives.

No unit test (Inngest config); verify with `tsc` + `build` (the `serve()` registration in `src/app/api/inngest/route.ts` must still compile).

- [ ] **Step 1: Add the event type to the client**

In `src/lib/inngest/client.ts`, add this export (next to the other `*Data` types, e.g. after `PrimitiveDeployData`):

```ts
// jobs/cancel requests cancellation of an in-flight run by jobId. Each cancellable
// function declares cancelOn matching this event on data.jobId; the cancel action
// also marks the job row cancelled. accountId is carried for logging/parity (the
// match is on jobId).
export type JobCancelData = { jobId: string; accountId: string };
```

- [ ] **Step 2: Add `cancelOn` to `generateScript`**

In `src/lib/inngest/functions/generate-script.ts`, in the function config object, add the `cancelOn` line after `triggers` (before `onFailure`):

```ts
    id: 'generate-script',
    retries: 1,
    triggers: [{ event: 'script/generate' }],
    cancelOn: [{ event: 'jobs/cancel', match: 'data.jobId' }],
    // After retries are exhausted, mark the job failed so the editor stops
```

- [ ] **Step 3: Add `cancelOn` to `renderVideo`**

In `src/lib/inngest/functions/render.ts`, in the `renderVideo` config (around line 64–68), add after `triggers`:

```ts
    id: 'render-video',
    retries: 2,
    triggers: [{ event: 'render/start' }],
    cancelOn: [{ event: 'jobs/cancel', match: 'data.jobId' }],
```

(Do NOT touch `renderSample`.)

- [ ] **Step 4: Add `cancelOn` to `synthesizeVoice`**

In `src/lib/inngest/functions/synthesize-voice.ts`, in the config (around line 27–34), add after `triggers`:

```ts
    id: 'synthesize-voice',
    retries: 2,
    triggers: [{ event: 'voice/synthesize' }],
    cancelOn: [{ event: 'jobs/cancel', match: 'data.jobId' }],
    // After retries are exhausted, mark the job failed so the editor stops showing
```

- [ ] **Step 5: Add `cancelOn` to `deployPrimitive`**

In `src/lib/inngest/functions/deploy-primitive.ts`, in the config (around line 12–14), add after `triggers`:

```ts
    id: 'deploy-primitive',
    retries: 1,
    triggers: [{ event: 'primitive/deploy' }],
    cancelOn: [{ event: 'jobs/cancel', match: 'data.jobId' }],
```

- [ ] **Step 6: Typecheck + build**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npm run build`
Expected: succeeds. (If the installed `inngest` version rejects `match` in `cancelOn`, use the equivalent expression form `if: 'async.data.jobId == event.data.jobId'` on each of the four functions and re-run — the correlation key is `jobId` either way. Confirm the accepted shape from the `inngest` package types.)

- [ ] **Step 7: Commit**

```bash
git add src/lib/inngest/client.ts src/lib/inngest/functions/generate-script.ts src/lib/inngest/functions/render.ts src/lib/inngest/functions/synthesize-voice.ts src/lib/inngest/functions/deploy-primitive.ts
git commit -m "feat(jobs): jobs/cancel event + cancelOn on the four job functions

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Server actions — `loadJobs`, `countActiveJobs`, `cancelJob`

**Files:**
- Create: `src/app/(app)/jobs/actions.ts`

**Interfaces:**
- Consumes: `ACTIVE_JOB_STATUSES`, `isCancellable`, `JobRow` from `@/lib/jobs/monitor` (Task 2); `inngest` from `@/lib/inngest/client`; the `jobs/cancel` event (Task 3).
- Produces:
  - `loadJobs(): Promise<JobRow[]>` — active jobs (any age) + terminal jobs (last 24h), each with `videoTitle`.
  - `countActiveJobs(): Promise<number>`
  - `cancelJob(jobId: string): Promise<{ ok: true } | { ok: false; reason: string }>`

No unit test (server/network). Verify with `tsc` + `lint`.

- [ ] **Step 1: Write the actions**

Create `src/app/(app)/jobs/actions.ts`:

```ts
'use server';

import { createClient } from '@/lib/supabase/server';
import { inngest } from '@/lib/inngest/client';
import { ACTIVE_JOB_STATUSES, isCancellable, type JobRow } from '@/lib/jobs/monitor';

// Active jobs (any age) + terminal jobs updated in the last 24h, newest first,
// each joined to its video title. RLS scopes to the session account.
export async function loadJobs(): Promise<JobRow[]> {
  const supabase = await createClient();
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data } = await supabase
    .from('jobs')
    .select('id, type, status, phase, video_id, error, created_at, updated_at, videos(title)')
    .or(`status.in.(queued,running,paused),updated_at.gte.${cutoff}`)
    .order('created_at', { ascending: false });
  return (data ?? []).map((r) => {
    const v = r.videos as { title?: string } | { title?: string }[] | null;
    const videoTitle = Array.isArray(v) ? (v[0]?.title ?? null) : (v?.title ?? null);
    return {
      id: r.id as string,
      type: r.type as string,
      status: r.status as string,
      phase: (r.phase as string | null) ?? null,
      videoId: (r.video_id as string | null) ?? null,
      videoTitle,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
      error: r.error ?? null,
    };
  });
}

// Count of in-flight jobs for the navbar badge.
export async function countActiveJobs(): Promise<number> {
  const supabase = await createClient();
  const { count } = await supabase
    .from('jobs')
    .select('id', { count: 'exact', head: true })
    .in('status', [...ACTIVE_JOB_STATUSES]);
  return count ?? 0;
}

// Cancel a running job: send the cancel event (Inngest cancels the real run), then
// mark the row cancelled. A render job's render row is marked failed+{cancelled} so
// the editor frees up and a fresh render starts clean. Guards ownership + active.
export async function cancelJob(
  jobId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const supabase = await createClient();
  const { data: account } = await supabase.from('accounts').select('id').maybeSingle();
  if (!account) return { ok: false, reason: 'No account found.' };
  const accountId = account.id as string;

  const { data: job } = await supabase
    .from('jobs')
    .select('id, type, status, render_id')
    .eq('id', jobId)
    .maybeSingle();
  if (!job) return { ok: false, reason: 'Job not found.' };
  if (!isCancellable(job.status as string)) return { ok: false, reason: 'Job is not running.' };

  try {
    await inngest.send({ name: 'jobs/cancel', data: { jobId, accountId } });
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : 'Could not request cancellation.' };
  }

  const { data: updated, error } = await supabase
    .from('jobs')
    .update({ status: 'cancelled' })
    .eq('id', jobId)
    .eq('account_id', accountId)
    .select('id');
  if (error) return { ok: false, reason: error.message };
  if (!updated || updated.length === 0) return { ok: false, reason: 'Job not found.' };

  if ((job.type as string) === 'render' && job.render_id) {
    await supabase
      .from('renders')
      .update({ status: 'failed', error: { cancelled: true } })
      .eq('id', job.render_id as string)
      .eq('account_id', accountId);
  }

  return { ok: true };
}
```

- [ ] **Step 2: Typecheck + lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors. (If the `videos(title)` join trips the inferred type, the `Array.isArray` branch already handles both shapes; keep the explicit cast.)

- [ ] **Step 3: Commit**

```bash
git add "src/app/(app)/jobs/actions.ts"
git commit -m "feat(jobs): cancelJob (real cancel + row update) + loadJobs + countActiveJobs

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: `/jobs` page + live list with Cancel

**Files:**
- Create: `src/app/(app)/jobs/page.tsx`
- Create: `src/app/(app)/jobs/JobsList.tsx`

**Interfaces:**
- Consumes: `loadJobs`, `cancelJob` from `./actions` (Task 4); `partitionJobs`, `jobStatusLabel`, `isCancellable`, `JobRow` from `@/lib/jobs/monitor` (Task 2).
- Produces: the route `GET /jobs`.

No unit test (route + client). Verify with `tsc` + `lint`.

- [ ] **Step 1: Create the server page**

Create `src/app/(app)/jobs/page.tsx`:

```tsx
import { loadJobs } from './actions';
import { JobsList } from './JobsList';

// Jobs monitor: live view of background work (script generation, voice, render,
// primitive deploy) with the ability to cancel a running job. RLS scopes the read.
export default async function JobsPage() {
  const jobs = await loadJobs();
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Jobs</h1>
        <p className="text-sm opacity-70">
          Background work across your account. Cancel a running job to stop it and start fresh.
        </p>
      </div>
      <JobsList initial={jobs} />
    </div>
  );
}
```

- [ ] **Step 2: Create the client list**

Create `src/app/(app)/jobs/JobsList.tsx`:

```tsx
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import { partitionJobs, jobStatusLabel, isCancellable, type JobRow } from '@/lib/jobs/monitor';
import { cancelJob, loadJobs } from './actions';

export function JobsList({ initial }: { initial: JobRow[] }) {
  const supabase = useMemo(() => createClient(), []);
  const [jobs, setJobs] = useState<JobRow[]>(initial);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setJobs(await loadJobs());
  }, []);

  // Live updates: any change to a job row (insert/update/delete) re-reads the list
  // (so video titles + partitioning stay correct). RLS scopes the rows. Reconcile
  // on subscribe to close the initial-fetch gap (Editor pattern).
  useEffect(() => {
    const channel = supabase
      .channel('jobs-monitor')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'jobs' }, () => {
        void refresh();
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') void refresh();
      });
    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase, refresh]);

  const onCancel = useCallback(async (id: string) => {
    setBusy((p) => new Set(p).add(id));
    setError(null);
    const res = await cancelJob(id);
    if (res.ok) {
      setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, status: 'cancelled' } : j)));
    } else {
      setError(res.reason);
    }
    setBusy((p) => {
      const n = new Set(p);
      n.delete(id);
      return n;
    });
  }, []);

  const { active, recent } = partitionJobs(jobs);

  return (
    <div className="space-y-6">
      {error && <p className="text-sm text-red-600">{error}</p>}

      <section className="space-y-2">
        <h2 className="text-sm font-medium opacity-70">Active ({active.length})</h2>
        {active.length === 0 ? (
          <p className="text-sm opacity-60">No jobs running.</p>
        ) : (
          <ul className="divide-y divide-black/10 rounded-lg border border-black/10 dark:divide-white/10 dark:border-white/10">
            {active.map((j) => (
              <JobItem key={j.id} job={j} busy={busy.has(j.id)} onCancel={() => onCancel(j.id)} />
            ))}
          </ul>
        )}
      </section>

      {recent.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-medium opacity-70">Recent</h2>
          <ul className="divide-y divide-black/10 rounded-lg border border-black/10 dark:divide-white/10 dark:border-white/10">
            {recent.map((j) => (
              <JobItem key={j.id} job={j} busy={false} onCancel={undefined} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function JobItem({
  job,
  busy,
  onCancel,
}: {
  job: JobRow;
  busy: boolean;
  onCancel?: () => void;
}) {
  const phase = job.phase ? ` · ${job.phase}` : '';
  return (
    <li className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-medium">{job.type}</span>
          {job.videoId && job.videoTitle && (
            <Link href={`/videos/${job.videoId}`} className="truncate underline opacity-70 hover:opacity-100">
              {job.videoTitle}
            </Link>
          )}
        </div>
        <div className="text-xs opacity-60">
          {jobStatusLabel(job.status)}
          {phase} · {relativeAge(job.createdAt)}
        </div>
      </div>
      {onCancel && isCancellable(job.status) && (
        <button
          type="button"
          disabled={busy}
          onClick={onCancel}
          className="shrink-0 rounded-md border border-red-500/40 px-2.5 py-1 text-xs font-medium text-red-600 enabled:hover:bg-red-500/10 disabled:opacity-40"
        >
          {busy ? 'Cancelling…' : 'Cancel'}
        </button>
      )}
    </li>
  );
}

function relativeAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
```

- [ ] **Step 3: Typecheck + lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/jobs/page.tsx" "src/app/(app)/jobs/JobsList.tsx"
git commit -m "feat(jobs): /jobs page + live list with Cancel

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Navbar Jobs link + live badge

**Files:**
- Create: `src/app/(app)/jobs/JobsNavBadge.tsx`
- Modify: `src/app/(app)/layout.tsx`

**Interfaces:**
- Consumes: `countActiveJobs` from `./actions` (Task 4).
- Produces: a navbar **Jobs** link with a live active-count badge.

No unit test (nav + client). This task runs the FULL gate.

- [ ] **Step 1: Create the badge**

Create `src/app/(app)/jobs/JobsNavBadge.tsx`:

```tsx
'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import { countActiveJobs } from './actions';

// Navbar "Jobs" link with a live count of in-flight jobs. Seeded server-side, then
// refreshed on any jobs change over Realtime (RLS scopes the rows).
export function JobsNavBadge({ initialCount }: { initialCount: number }) {
  const supabase = useMemo(() => createClient(), []);
  const [count, setCount] = useState(initialCount);

  useEffect(() => {
    const channel = supabase
      .channel('jobs-nav-badge')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'jobs' }, () => {
        void countActiveJobs().then(setCount);
      })
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase]);

  return (
    <Link href="/jobs" className="text-sm opacity-70 hover:opacity-100">
      Jobs
      {count > 0 && (
        <span className="ml-1 rounded-full bg-foreground px-1.5 py-0.5 text-xs text-background">
          {count}
        </span>
      )}
    </Link>
  );
}
```

- [ ] **Step 2: Wire the badge into the layout**

In `src/app/(app)/layout.tsx`:

Add the imports near the top (with the other imports):

```tsx
import { JobsNavBadge } from './jobs/JobsNavBadge';
import { countActiveJobs } from './jobs/actions';
```

After the existing `const { data: { user } } = await supabase.auth.getUser();` / auth-gate block, compute the count (only meaningful when signed in, which the gate guarantees):

```tsx
  const activeJobs = await countActiveJobs();
```

In the `<nav>` block, add the badge after the Primitives link:

```tsx
          <Link href="/primitives" className="text-sm opacity-70 hover:opacity-100">
            Primitives
          </Link>
          <JobsNavBadge initialCount={activeJobs} />
```

- [ ] **Step 3: Typecheck, lint, build**

Run: `npx tsc --noEmit && npm run lint && npm run build`
Expected: all succeed; `/jobs` appears in the route manifest.

- [ ] **Step 4: Run the full unit suite**

Run: `npm test`
Expected: PASS (including `src/lib/jobs/monitor.test.ts`).

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/jobs/JobsNavBadge.tsx" "src/app/(app)/layout.tsx"
git commit -m "feat(jobs): navbar Jobs link with live active-count badge

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage:**
- `cancelled` enum value → Task 1. ✓
- `jobs/cancel` event + `cancelOn` on all four job functions → Task 3. ✓
- Real cancellation mechanism (cancelOn by jobId) → Task 3 + Task 4 (send event). ✓
- `cancelJob` (guard active, send, mark row, render-row failed{cancelled}) → Task 4. ✓
- `/jobs` page (server + Realtime, Active/Recent) → Task 5. ✓
- Navbar link + live badge → Task 6. ✓
- Pure helper (isCancellable, jobStatusLabel, partitionJobs) → Task 2. ✓
- Retry deferred → not in any task (correct). ✓
- Both cases (never-started vs running) → handled by Task 4's send + mark (no code branch needed; cancelOn no-ops on a non-existent run). ✓

**2. Placeholder scan:** No TBD/TODO/"handle errors"/"similar to". Every code step has complete code. The two `if`-fallback notes (enum txn caveat in Task 1, `cancelOn` shape in Task 3) are explicit, bounded contingencies with the exact alternative given — not placeholders. ✓

**3. Type consistency:** `JobRow` (Task 2) is produced by `loadJobs` (Task 4) and consumed by `JobsList`/`page` (Task 5) with identical field names (`videoId`, `videoTitle`, `createdAt`, `updatedAt`). `ACTIVE_JOB_STATUSES`/`isCancellable` (Task 2) used by `cancelJob`/`countActiveJobs` (Task 4) and `JobItem` (Task 5). `cancelJob` return shape `{ ok } | { ok:false, reason }` matches the Task 5 call site. `jobs/cancel` + `JobCancelData` (Task 3) matches the `inngest.send` payload in Task 4. ✓
