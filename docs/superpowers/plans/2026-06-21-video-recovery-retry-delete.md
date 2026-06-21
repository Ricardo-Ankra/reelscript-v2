# Video Recovery — Retry Generation + Delete Video Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator recover a video whose generation was cancelled/failed — retry the generation in place, or delete the video — from the editor, with Retry also on `/jobs` and Delete also on the channel's Videos list.

**Architecture:** `retryGeneration(videoId)` reuses the existing `regenerateVideo` (re-runs script generation with the video's stored prompt + length, `replace:true`). `deleteVideo(videoId)` does best-effort R2 cleanup then deletes the row (FK cascade removes the rest; `cost_events` preserved via SET NULL), guarded against an in-flight job. A pure `isRetryable` helper drives the Retry affordances.

**Tech Stack:** Next.js App Router (server actions + client components), Supabase JS (RLS), Cloudflare R2 (`deleteObject`), node:test.

## Global Constraints

- **No schema change** — the `cancelled` `job_status` value and the `videos` FK cascade already exist.
- **Retry** = `retryGeneration(videoId)` reads the video's stored `prompt` + `settings.target_length` and delegates to the existing `regenerateVideo(videoId, { prompt, targetLengthSeconds })` (which guards in-flight, persists, inserts a `script_generation` job, emits `script/generate` with `replace:true`). Empty stored prompt → friendly error, never fabricate.
- **`isRetryable(type, status)`** = `type === 'script_generation' && (status === 'failed' || status === 'cancelled')`.
- **Delete** = `deleteVideo(videoId)`: refuse while any `jobs` row for the video is `queued`/`running` ("Cancel the running job before deleting."); then best-effort `deleteObject` for scene audio (`audio/<sceneId>.mp3`) and per-render `output_r2_key`, `base_output_r2_key`, `composition_spec_r2_key` (**NOT `music_remux_key`** — it's a cache hash, not an R2 key); then `delete from videos where id+account_id` with `.select('id')` no-row guard. Cascade removes scenes/shots/renders/jobs/script_revisions; `cost_events.video_id` → NULL. R2 failures are caught + logged, never fatal. Never throws to the client.
- **Retry placement:** editor recovery banner (when latest generation job is `failed`/`cancelled`) + `/jobs` rows where `isRetryable`. **Delete placement:** editor header + channel Videos list per-row.
- The editor gains a `channelId` prop (already selected in `page.tsx`) for the post-delete redirect to `/channels/<channelId>`.
- **Tests** run with `node --experimental-strip-types --import ./scripts/register-loader.mjs --test <file>`; test files import source with an explicit `.ts` extension; `import { test } from 'node:test'; import assert from 'node:assert/strict';`.
- **Server actions / routes / client components are not unit-tested** (network/integration) — pure logic is in the tested helper; verification is `tsc` + `lint` + `build`.
- **Commit footer:** end every commit message with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- All Supabase reads/writes are RLS-scoped to the session account.

## File Structure

**Create:**
- `src/app/(app)/videos/[id]/delete-actions.ts` — `deleteVideo`.
- `src/app/(app)/channels/[id]/DeleteVideoButton.tsx` — per-row delete (client).

**Modify:**
- `src/lib/jobs/monitor.ts` — add `isRetryable`.
- `src/lib/jobs/monitor.test.ts` — test `isRetryable`.
- `src/app/(app)/videos/[id]/regenerate-actions.ts` — add `retryGeneration`.
- `src/app/(app)/videos/[id]/page.tsx` — pass `channelId` to `Editor`.
- `src/app/(app)/videos/[id]/Editor.tsx` — `channelId` prop, `cancelled` label, recovery banner (Retry), header Delete.
- `src/app/(app)/jobs/JobsList.tsx` — Retry button on retryable rows.
- `src/app/(app)/channels/[id]/page.tsx` — embed `DeleteVideoButton` in `VideosTab` rows.

---

### Task 1: `isRetryable` helper

**Files:**
- Modify: `src/lib/jobs/monitor.ts`
- Test: `src/lib/jobs/monitor.test.ts`

**Interfaces:**
- Produces: `isRetryable(type: string, status: string): boolean` (consumed by Tasks 5 and the editor in Task 4 indirectly via the same rule).

- [ ] **Step 1: Add the failing test**

Append to `src/lib/jobs/monitor.test.ts`:

```ts
import { isRetryable } from './monitor.ts'; // add to the existing import if preferred

test('isRetryable: only failed/cancelled script_generation', () => {
  assert.equal(isRetryable('script_generation', 'failed'), true);
  assert.equal(isRetryable('script_generation', 'cancelled'), true);
  for (const s of ['queued', 'running', 'complete', 'paused']) {
    assert.equal(isRetryable('script_generation', s), false);
  }
  for (const t of ['render', 'voice_synthesis', 'primitive_deploy']) {
    assert.equal(isRetryable(t, 'failed'), false);
    assert.equal(isRetryable(t, 'cancelled'), false);
  }
});
```

(If `monitor.test.ts` already imports from `./monitor.ts`, add `isRetryable` to that import list rather than adding a second import line.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/jobs/monitor.test.ts`
Expected: FAIL — `isRetryable` is not exported.

- [ ] **Step 3: Add the implementation**

In `src/lib/jobs/monitor.ts`, add (e.g. after `isCancellable`):

```ts
// A failed or cancelled script-generation job can be re-run in place. (Render
// "retry" is the editor's Generate Video; voice/deploy retry is out of scope.)
export function isRetryable(type: string, status: string): boolean {
  return type === 'script_generation' && (status === 'failed' || status === 'cancelled');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/jobs/monitor.test.ts`
Expected: PASS (existing tests + the new one).

- [ ] **Step 5: Commit**

```bash
git add src/lib/jobs/monitor.ts src/lib/jobs/monitor.test.ts
git commit -m "feat(jobs): isRetryable helper (failed/cancelled script_generation)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `retryGeneration` action

**Files:**
- Modify: `src/app/(app)/videos/[id]/regenerate-actions.ts`

**Interfaces:**
- Consumes: `regenerateVideo` (same file); `parseVideoSettings` from `@/lib/videos/settings`.
- Produces: `retryGeneration(videoId: string): Promise<{ ok: true } | { ok: false; reason: string }>`.

No unit test (server action; delegates to the already-working regenerate). Verify `tsc` + `lint`.

- [ ] **Step 1: Add the import**

In `src/app/(app)/videos/[id]/regenerate-actions.ts`, add to the imports:

```ts
import { parseVideoSettings } from '@/lib/videos/settings';
```

- [ ] **Step 2: Add the action**

Append to the same file:

```ts
// One-click retry of a failed/cancelled generation: re-run script generation with
// the video's STORED prompt + length (no operator input). Delegates to
// regenerateVideo (replace:true), which guards an in-flight job and wipes any
// partial scenes from the cancelled run.
export async function retryGeneration(
  videoId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const supabase = await createClient();
  const { data: video } = await supabase
    .from('videos')
    .select('prompt, settings')
    .eq('id', videoId)
    .maybeSingle();
  if (!video) return { ok: false, reason: 'Video not found.' };

  const prompt = typeof video.prompt === 'string' ? video.prompt.trim() : '';
  if (!prompt) return { ok: false, reason: 'This video has no prompt to retry.' };

  const targetLengthSeconds = parseVideoSettings(video.settings).target_length;
  return regenerateVideo(videoId, { prompt, targetLengthSeconds });
}
```

- [ ] **Step 3: Typecheck + lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/videos/[id]/regenerate-actions.ts"
git commit -m "feat(videos): retryGeneration — re-run script gen with stored prompt/length

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: `deleteVideo` action

**Files:**
- Create: `src/app/(app)/videos/[id]/delete-actions.ts`

**Interfaces:**
- Consumes: `createClient` (`@/lib/supabase/server`), `deleteObject` (`@/lib/r2`).
- Produces: `deleteVideo(videoId: string): Promise<{ ok: true } | { ok: false; reason: string }>`.

No unit test (server/network/R2). Verify `tsc` + `lint`.

- [ ] **Step 1: Write the action**

Create `src/app/(app)/videos/[id]/delete-actions.ts`:

```ts
'use server';

import { createClient } from '@/lib/supabase/server';
import { deleteObject } from '@/lib/r2';

// Hard-delete a video: best-effort R2 cleanup (the FK cascade removes DB rows but
// not R2 objects), then delete the row. Cascade removes scenes/shots/renders/jobs/
// script_revisions; cost_events.video_id → NULL (ledger preserved). Refuses while a
// job is in flight (cancel first). Never throws to the client.
export async function deleteVideo(
  videoId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const supabase = await createClient();
  const { data: account } = await supabase.from('accounts').select('id').maybeSingle();
  if (!account) return { ok: false, reason: 'No account found.' };
  const accountId = account.id as string;

  const { data: video } = await supabase
    .from('videos')
    .select('id')
    .eq('id', videoId)
    .eq('account_id', accountId)
    .maybeSingle();
  if (!video) return { ok: false, reason: 'Video not found.' };

  // In-flight guard: do not delete out from under a running function.
  const { data: inflight } = await supabase
    .from('jobs')
    .select('id')
    .eq('video_id', videoId)
    .in('status', ['queued', 'running'])
    .limit(1);
  if (inflight && inflight.length > 0) {
    return { ok: false, reason: 'Cancel the running job before deleting.' };
  }

  // Best-effort R2 cleanup. Scene audio first.
  const { data: scenes } = await supabase.from('scenes').select('id').eq('video_id', videoId);
  for (const s of scenes ?? []) {
    try {
      await deleteObject(`audio/${s.id as string}.mp3`);
    } catch (e) {
      console.warn(`[deleteVideo] audio delete failed for ${s.id}: ${(e as Error).message}`);
    }
  }
  // Render outputs (output / voiceover-only base / composition spec). NOT
  // music_remux_key — that column is a cache-guard hash, not an R2 object key.
  const { data: renders } = await supabase
    .from('renders')
    .select('output_r2_key, base_output_r2_key, composition_spec_r2_key')
    .eq('video_id', videoId);
  for (const r of renders ?? []) {
    for (const key of [r.output_r2_key, r.base_output_r2_key, r.composition_spec_r2_key]) {
      if (typeof key === 'string' && key) {
        try {
          await deleteObject(key);
        } catch (e) {
          console.warn(`[deleteVideo] r2 delete failed for ${key}: ${(e as Error).message}`);
        }
      }
    }
  }

  // Delete the row; the cascade does the rest.
  const { data: deleted, error } = await supabase
    .from('videos')
    .delete()
    .eq('id', videoId)
    .eq('account_id', accountId)
    .select('id');
  if (error) return { ok: false, reason: error.message };
  if (!deleted || deleted.length === 0) return { ok: false, reason: 'Video not found.' };
  return { ok: true };
}
```

- [ ] **Step 2: Typecheck + lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(app)/videos/[id]/delete-actions.ts"
git commit -m "feat(videos): deleteVideo — R2 cleanup + cascade delete, in-flight guarded

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Editor recovery UI (channelId, cancelled label, banner, header Delete)

**Files:**
- Modify: `src/app/(app)/videos/[id]/page.tsx`
- Modify: `src/app/(app)/videos/[id]/Editor.tsx`

**Interfaces:**
- Consumes: `retryGeneration` (`./regenerate-actions`, Task 2), `deleteVideo` (`./delete-actions`, Task 3).
- Produces: editor recovery affordances.

No unit test (client + route). Verify `tsc` + `lint`.

- [ ] **Step 1: Pass `channelId` from the page**

In `src/app/(app)/videos/[id]/page.tsx`, the `<Editor ... />` invocation already passes several props (`videoId`, `title`, `initialScenes`, … `initialRenderUrl`). Add one prop:

```tsx
        channelId={video.channel_id as string}
```

(`video.channel_id` is already in the `videos` select. Place it among the other `Editor` props.)

- [ ] **Step 2: Add the `channelId` prop + imports to the Editor**

In `src/app/(app)/videos/[id]/Editor.tsx`:

Add imports near the top:

```ts
import { useRouter } from 'next/navigation';
import { retryGeneration } from './regenerate-actions';
import { deleteVideo } from './delete-actions';
```

Add `channelId` to the props destructuring and type (alongside the existing props):

```ts
  channelId,
```

and in the prop type object:

```ts
  channelId: string;
```

- [ ] **Step 3: Add router + recovery state + handlers**

Inside the `Editor` component body (e.g. after the existing `const [renderError, ...]` / other `useState` hooks), add:

```ts
  const router = useRouter();
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);

  const onRetry = useCallback(async () => {
    setRecoveryBusy(true);
    setRecoveryError(null);
    const res = await retryGeneration(videoId);
    if (!res.ok) setRecoveryError(res.reason);
    // On success the jobs Realtime flips status to queued/running and the banner clears.
    setRecoveryBusy(false);
  }, [videoId]);

  const onDelete = useCallback(async () => {
    if (!confirm('Delete this video? This permanently removes its scenes, audio, and renders.')) return;
    setRecoveryBusy(true);
    setRecoveryError(null);
    const res = await deleteVideo(videoId);
    if (res.ok) {
      router.push(`/channels/${channelId}`); // leaves this route; keep busy
      return;
    }
    setRecoveryError(res.reason);
    setRecoveryBusy(false);
  }, [videoId, channelId, router]);
```

(`useCallback` is already imported in this file.)

- [ ] **Step 4: Header — add the Delete button**

Replace the header block:

```tsx
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">{title}</h1>
        <StatusPill status={status} />
      </div>
```

with:

```tsx
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">{title}</h1>
        <div className="flex items-center gap-3">
          <StatusPill status={status} />
          <button
            type="button"
            onClick={onDelete}
            disabled={recoveryBusy}
            className="rounded-md border border-red-500/40 px-2.5 py-1 text-xs font-medium text-red-600 enabled:hover:bg-red-500/10 disabled:opacity-40"
          >
            Delete video
          </button>
        </div>
      </div>
```

- [ ] **Step 5: Recovery banner — Retry when failed/cancelled**

Immediately after the header `</div>` (before the synthesize/settings sections), add:

```tsx
      {(status === 'failed' || status === 'cancelled') && (
        <div className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
          <p>
            {status === 'cancelled' ? 'Generation was cancelled.' : 'Generation failed.'} Retry to run
            it again with the same prompt, or delete the video.
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onRetry}
              disabled={recoveryBusy}
              className="rounded-md border border-black/15 px-2.5 py-1 text-xs font-medium enabled:hover:bg-black/[0.04] disabled:opacity-40 dark:border-white/20 dark:enabled:hover:bg-white/[0.06]"
            >
              {recoveryBusy ? 'Working…' : 'Retry generation'}
            </button>
          </div>
          {recoveryError && <p className="text-xs text-red-600">{recoveryError}</p>}
        </div>
      )}
```

- [ ] **Step 6: `StatusPill` — handle `cancelled`**

Replace the `label` and `tone` assignments in `StatusPill`:

```tsx
  const label =
    status === 'complete'
      ? 'Generated'
      : status === 'failed'
        ? 'Generation failed'
        : status === 'cancelled'
          ? 'Cancelled'
          : ACTIVE.has(status)
            ? 'Generating…'
            : status;
  const tone =
    status === 'failed'
      ? 'border-red-500/40 bg-red-500/10 text-red-600'
      : status === 'cancelled'
        ? 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400'
        : status === 'complete'
          ? 'border-green-500/40 bg-green-500/10 text-green-700 dark:text-green-400'
          : 'border-black/15 bg-black/[0.03] opacity-70 dark:border-white/15 dark:bg-white/[0.03]';
```

- [ ] **Step 7: Typecheck + lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add "src/app/(app)/videos/[id]/page.tsx" "src/app/(app)/videos/[id]/Editor.tsx"
git commit -m "feat(videos): editor recovery — cancelled status, retry/delete banner + header delete

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: `/jobs` Retry button

**Files:**
- Modify: `src/app/(app)/jobs/JobsList.tsx`

**Interfaces:**
- Consumes: `isRetryable` (`@/lib/jobs/monitor`, Task 1), `retryGeneration` (`../videos/[id]/regenerate-actions`, Task 2).
- Produces: a Retry action on retryable job rows.

No unit test (client). Verify `tsc` + `lint`.

- [ ] **Step 1: Add imports**

In `src/app/(app)/jobs/JobsList.tsx`:

- Add `isRetryable` to the existing `@/lib/jobs/monitor` import.
- Add: `import { retryGeneration } from '../videos/[id]/regenerate-actions';`

- [ ] **Step 2: Add an `onRetry` handler**

In `JobsList`, alongside `onCancel`, add:

```ts
  const onRetry = useCallback(async (id: string, videoId: string) => {
    setBusy((p) => new Set(p).add(id));
    setError(null);
    const res = await retryGeneration(videoId);
    if (!res.ok) setError(res.reason);
    // Realtime refresh reconciles the row's new status.
    setBusy((p) => {
      const n = new Set(p);
      n.delete(id);
      return n;
    });
  }, []);
```

- [ ] **Step 3: Pass `onRetry` to `JobItem` and render the button**

In the **Recent** list's `JobItem` usage (the terminal rows), pass an `onRetry` prop:

```tsx
            {recent.map((j) => (
              <JobItem
                key={j.id}
                job={j}
                busy={busy.has(j.id)}
                onCancel={undefined}
                onRetry={j.videoId ? () => onRetry(j.id, j.videoId as string) : undefined}
              />
            ))}
```

(Active rows keep `onCancel` and need no `onRetry` — active is never retryable.)

Update `JobItem`'s signature and body. Add `onRetry?: () => void` to its props type, and render a Retry button when retryable, next to where Cancel renders:

```tsx
function JobItem({
  job,
  busy,
  onCancel,
  onRetry,
}: {
  job: JobRow;
  busy: boolean;
  onCancel?: () => void;
  onRetry?: () => void;
}) {
```

and in the JSX, after the existing Cancel button block:

```tsx
      {onRetry && isRetryable(job.type, job.status) && (
        <button
          type="button"
          disabled={busy}
          onClick={onRetry}
          className="shrink-0 rounded-md border border-black/15 px-2.5 py-1 text-xs font-medium enabled:hover:bg-black/[0.04] disabled:opacity-40 dark:border-white/20 dark:enabled:hover:bg-white/[0.06]"
        >
          {busy ? 'Retrying…' : 'Retry'}
        </button>
      )}
```

- [ ] **Step 4: Typecheck + lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/jobs/JobsList.tsx"
git commit -m "feat(jobs): Retry button on failed/cancelled script_generation rows

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Channel Videos list — per-row Delete

**Files:**
- Create: `src/app/(app)/channels/[id]/DeleteVideoButton.tsx`
- Modify: `src/app/(app)/channels/[id]/page.tsx`

**Interfaces:**
- Consumes: `deleteVideo` (`@/app/(app)/videos/[id]/delete-actions`, Task 3).
- Produces: a per-row Delete on the channel Videos tab.

No unit test (client + route). This task runs the FULL gate.

- [ ] **Step 1: Create the delete button**

Create `src/app/(app)/channels/[id]/DeleteVideoButton.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { deleteVideo } from '@/app/(app)/videos/[id]/delete-actions';

// Per-row delete on the channel Videos list. Confirms, calls deleteVideo, and
// refreshes the server-rendered list on success.
export function DeleteVideoButton({ videoId }: { videoId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function onClick() {
    if (!confirm('Delete this video? This permanently removes its scenes, audio, and renders.')) return;
    setBusy(true);
    setError(null);
    const res = await deleteVideo(videoId);
    if (res.ok) {
      router.refresh();
      return;
    }
    setError(res.reason);
    setBusy(false);
  }

  return (
    <span className="flex shrink-0 items-center gap-2">
      {error && <span className="text-xs text-red-600">{error}</span>}
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        className="rounded-md border border-red-500/40 px-2 py-0.5 text-xs font-medium text-red-600 enabled:hover:bg-red-500/10 disabled:opacity-40"
      >
        {busy ? 'Deleting…' : 'Delete'}
      </button>
    </span>
  );
}
```

- [ ] **Step 2: Embed it in the Videos list row**

In `src/app/(app)/channels/[id]/page.tsx`, add the import:

```tsx
import { DeleteVideoButton } from './DeleteVideoButton';
```

In `VideosTab`, the current row wraps everything in a single `<Link>`. A `<button>` may not be nested inside an `<a>`, so restructure the `<li>` so the Link and the Delete button are siblings. Replace the row markup:

```tsx
            return (
              <li key={vid}>
                <Link
                  href={`/videos/${vid}`}
                  className="flex items-center justify-between gap-3 px-4 py-3 text-sm hover:bg-black/5 dark:hover:bg-white/5"
                >
                  <span className="min-w-0 flex-1 truncate font-medium">{v.title as string}</span>
                  <span className="shrink-0 rounded-full border border-black/15 px-2 py-0.5 text-xs opacity-70 dark:border-white/15">
                    {label}
                  </span>
                  <span className="shrink-0 opacity-50">{created}</span>
                </Link>
              </li>
            );
```

with:

```tsx
            return (
              <li
                key={vid}
                className="flex items-center justify-between gap-3 px-4 py-3 text-sm hover:bg-black/5 dark:hover:bg-white/5"
              >
                <Link href={`/videos/${vid}`} className="flex min-w-0 flex-1 items-center justify-between gap-3">
                  <span className="min-w-0 flex-1 truncate font-medium">{v.title as string}</span>
                  <span className="shrink-0 rounded-full border border-black/15 px-2 py-0.5 text-xs opacity-70 dark:border-white/15">
                    {label}
                  </span>
                  <span className="shrink-0 opacity-50">{created}</span>
                </Link>
                <DeleteVideoButton videoId={vid} />
              </li>
            );
```

(Match the surrounding variable names — `vid`, `label`, `created`, `v.title` — exactly as they appear in the current `VideosTab`. Only the row's element structure changes; the data is unchanged.)

- [ ] **Step 3: Typecheck, lint, build**

Run: `npx tsc --noEmit && npm run lint && npm run build`
Expected: all succeed.

- [ ] **Step 4: Run the full unit suite**

Run: `npm test`
Expected: PASS (including `src/lib/jobs/monitor.test.ts` with the new `isRetryable` test).

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/channels/[id]/DeleteVideoButton.tsx" "src/app/(app)/channels/[id]/page.tsx"
git commit -m "feat(channels): per-row Delete on the Videos tab

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage:**
- `isRetryable` helper → Task 1. ✓
- `retryGeneration` (stored prompt/length, delegate to regenerateVideo, replace:true) → Task 2. ✓
- `deleteVideo` (in-flight guard, R2 cleanup excl. music_remux_key, cascade) → Task 3. ✓
- Editor: `cancelled` label + recovery banner (Retry) + header Delete + `channelId` prop → Task 4. ✓
- `/jobs` Retry on retryable script_generation rows → Task 5. ✓
- Channel Videos list per-row Delete → Task 6. ✓
- Retry placements (editor + /jobs); Delete placements (editor + list) → Tasks 4/5/6. ✓
- Render-job retry excluded; bulk/soft-delete excluded; cost_events SET NULL unchanged → honored (no task touches them). ✓

**2. Placeholder scan:** No TBD/TODO/"handle errors"/"similar to". Every code step shows complete code; the only "match the surrounding names" note (Task 6 Step 2) names the exact identifiers (`vid`, `label`, `created`, `v.title`) and shows the full before/after markup. ✓

**3. Type consistency:** `isRetryable(type, status)` (Task 1) is called with `(job.type, job.status)` in Task 5. `retryGeneration(videoId)` / `deleteVideo(videoId)` return `{ ok } | { ok:false, reason }`, matching every call site (Tasks 4, 5, 6). `channelId: string` prop (Task 4 Step 2) is supplied by `page.tsx` (Task 4 Step 1). `JobRow.videoId` (existing) is used by Task 5's `onRetry`. `DeleteVideoButton({ videoId })` (Task 6) matches its usage. ✓
