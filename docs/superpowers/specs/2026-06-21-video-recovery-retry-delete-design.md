# Video recovery — retry generation + delete video — design

**Date:** 2026-06-21
**Phase:** 8 (Full surfaces) — operability
**Status:** design approved, ready for implementation plan

## Context

After the jobs-monitor/cancellation slice, an operator can cancel a generation
run — but is then stuck: a freshly-created video whose generation was cancelled
(or failed) has no scenes and no way forward. Two gaps:

1. **No retry.** Nothing re-runs a failed/cancelled script generation in place.
2. **No delete.** There is no way to delete a video at all — not from the editor,
   not from the channel's Videos list.

This slice adds both as **recovery actions on a video**, reusing existing
machinery wherever possible.

### Current state (verified)

- **Regenerate already exists:** `regenerateVideo(videoId, { prompt,
  targetLengthSeconds })` (`src/app/(app)/videos/[id]/regenerate-actions.ts`) —
  validates input, guards an in-flight job (`jobs` where type ∈
  script_generation/voice_synthesis/render and status ∈ queued/running; plus the
  authoritative unique index), persists `prompt` + merges `target_length`, inserts
  a `script_generation` job, and emits `script/generate` with **`replace: true`**
  (the worker wipes existing scenes). Pure helpers in `src/lib/videos/regenerate.ts`.
- **Editor** (`src/app/(app)/videos/[id]/Editor.tsx`): `StatusPill` renders the
  latest `script_generation` job status — handles `complete`/`failed`/active; does
  **not** yet handle `cancelled`. The editor subscribes to `jobs` Realtime, so a
  status change (incl. a cancel from `/jobs`) updates live. There is a Regenerate
  modal but no Retry/Delete.
- **Channel Videos tab** (`src/app/(app)/channels/[id]/page.tsx`, `VideosTab`):
  server-rendered list of the channel's videos; no per-row actions.
- **`/jobs`** (`src/app/(app)/jobs/JobsList.tsx`): rows carry `videoId`; active
  rows have Cancel. No Retry.
- **FK cascade on `videos` delete** (init_schema): `scenes`, `shots`, `renders`,
  `jobs`, `script_revisions` are `ON DELETE CASCADE`; `cost_events.video_id` is
  `ON DELETE SET NULL` (ledger preserved). **The cascade does NOT delete R2
  objects.**
- **R2 objects to clean on delete:** scene audio `audio/<sceneId>.mp3` (the key
  format `regenerateVideo`'s worker uses), and per-render `output_r2_key`,
  `base_output_r2_key`, `composition_spec_r2_key`. **`music_remux_key` is a
  cache-guard HASH, not an R2 object key — do not delete it.** `deleteObject`
  exists in `src/lib/r2.ts` (used by regenerate + resource delete).
- **`isCancellable` / `partitionJobs` / `jobStatusLabel`** live in pure
  `src/lib/jobs/monitor.ts`; `job_status` now includes `cancelled`.

## Goal

After a create→cancel (or a failure), the operator can **Retry** the generation
in one click or **Delete** the video — from the editor, with Retry also on
`/jobs` and Delete also on the channel's Videos list.

## Scope

**In scope:**

- `retryGeneration(videoId)` — re-run script generation with the video's stored
  prompt + length (delegates to `regenerateVideo`).
- `deleteVideo(videoId)` — best-effort R2 cleanup + row delete (cascade does the
  rest), guarded against an in-flight job.
- Pure `isRetryable(type, status)` helper (tested).
- Editor: a `cancelled` status label + a recovery banner (Retry + Delete) when
  the latest generation job is `failed`/`cancelled`; a Delete button in the header.
- `/jobs`: a Retry button on `failed`/`cancelled` **script_generation** rows.
- Channel Videos list: a per-row Delete.

**Out of scope:**

- Render-job retry on `/jobs` (re-render = the editor's Generate Video).
- Bulk delete; soft-delete/trash (this is a hard delete).
- Changing `cost_events` `SET NULL` (ledger preserved by design).
- Deleting caption sidecars / other incidental small R2 artifacts not tracked by
  a column (best-effort cleanup targets the known key columns + scene audio).

## Architecture

### 1. Pure helper — `src/lib/jobs/monitor.ts` (add `isRetryable`)

```ts
// A failed/cancelled script-generation job can be re-run. (Render retry is the
// editor's Generate Video; voice/deploy retry is out of scope.)
export function isRetryable(type: string, status: string): boolean {
  return type === 'script_generation' && (status === 'failed' || status === 'cancelled');
}
```

Tested across the matrix.

### 2. `retryGeneration` — `src/app/(app)/videos/[id]/regenerate-actions.ts`

```ts
export async function retryGeneration(
  videoId: string,
): Promise<{ ok: true } | { ok: false; reason: string }>;
```

- RLS-load the video's `prompt` + `settings`. Missing video → "Video not found.";
  empty stored prompt → "This video has no prompt to retry." (never fabricate).
- Derive `targetLengthSeconds` from `parseVideoSettings(settings).target_length`.
- Delegate to `regenerateVideo(videoId, { prompt, targetLengthSeconds })` and
  return its result. This reuses the in-flight guard, the persist, the job insert,
  and the `script/generate` emit with `replace: true` (so any partial scenes from
  the cancelled run are wiped). One-click; no operator input.

### 3. `deleteVideo` — `src/app/(app)/videos/[id]/delete-actions.ts` (new)

```ts
export async function deleteVideo(
  videoId: string,
): Promise<{ ok: true } | { ok: false; reason: string }>;
```

- Resolve the session account; RLS-load the video (not found → "Video not found.").
- **In-flight guard:** if any `jobs` row for this video has status ∈
  `queued`/`running`, refuse: "Cancel the running job before deleting." (cancel
  first — ties into the cancellation feature).
- **R2 cleanup (best-effort, each in try/catch, logged not fatal):**
  - scene audio: read `scenes(id)` for the video → `deleteObject('audio/<id>.mp3')`.
  - render outputs: read `renders(output_r2_key, base_output_r2_key,
    composition_spec_r2_key)` for the video → `deleteObject` each non-null key.
- **Row delete:** `delete from videos where id = ? and account_id = ?` with
  `.select('id')` no-row guard (no phantom success). The cascade removes
  scenes/shots/renders/jobs/script_revisions; `cost_events.video_id` → NULL.
- Returns `{ ok } | { ok:false, reason }`; never throws to the client.

### 4. Editor recovery UI — `src/app/(app)/videos/[id]/Editor.tsx`

- `StatusPill`: add `cancelled` → label "Cancelled", a neutral/warning tone.
- **Recovery banner:** when the latest generation `status` ∈ `failed`/`cancelled`,
  render a banner above the scenes area: a short message
  ("Generation was cancelled." / "Generation failed.") + **Retry generation**
  (→ `retryGeneration(videoId)`; busy state; on `{ok}` the Realtime status flip
  to queued/running clears the banner) + **Delete video**. This is the answer to
  the empty/stuck state after a cancel.
- **Delete (header):** a "Delete video" control available regardless of status
  (confirm dialog) → `deleteVideo(videoId)` → on `{ok}` `router.push` to the
  channel's Videos tab (`/channels/<channelId>`); the editor already has
  `channel_id` via the page (passed in as a prop — `page.tsx` selects it).
- Errors surface inline; nothing throws.

(`page.tsx` already selects `channel_id`; it is passed to `Editor` as a new
`channelId` prop so Delete knows where to return.)

### 5. `/jobs` Retry — `src/app/(app)/jobs/JobsList.tsx`

- For a row where `isRetryable(type, status)`, render a **Retry** button →
  `retryGeneration(row.videoId)`. Busy-disable; on failure show the reason; the
  Realtime refresh reconciles the row. (Active rows keep Cancel; the two are
  mutually exclusive — active is never retryable.)

### 6. Channel Videos list Delete — `src/app/(app)/channels/[id]/`

- A small client `DeleteVideoButton.tsx` (`'use client'`): a Delete button +
  confirm → `deleteVideo(videoId)` → on `{ok}` `router.refresh()` (re-renders the
  server list without the row); on failure show the reason inline. Embedded per
  row in `VideosTab`; the rest of the row stays server-rendered.

## Data flow

```
Retry:
  editor banner / /jobs row → retryGeneration(videoId)
    → read stored prompt + settings.target_length
    → regenerateVideo(videoId, {prompt, targetLengthSeconds})
        guard in-flight → persist → insert script_generation job
        → script/generate {replace:true} → worker wipes + regenerates
    → Realtime: status queued→running→complete; banner clears

Delete:
  editor header / channel Videos row → deleteVideo(videoId)
    guard in-flight (queued/running) → refuse if any
    → best-effort deleteObject(scene audio + render outputs)
    → delete videos row (cascade: scenes/shots/renders/jobs/revisions;
       cost_events.video_id → NULL)
    → editor: router.push(/channels/<channelId>);  list: router.refresh()
```

## Error handling

- `retryGeneration`: video not found / empty stored prompt → friendly reason;
  in-flight job → the regenerate guard's "A job is already in progress…"; never
  throws.
- `deleteVideo`: in-flight job → "Cancel the running job before deleting."; R2
  delete failures are caught + logged (the row delete still proceeds — an orphaned
  R2 object is preferable to a video that can't be deleted); no-row on the delete
  → "Video not found."; never throws.
- Confirm dialogs guard both Delete entry points (editor + list).
- After a successful editor Delete, navigation leaves the now-deleted route, so no
  stale editor state remains.

## Back-compatibility

- Additive. No schema change (the `cancelled` enum + cascade already exist).
- `regenerateVideo` is unchanged (retry delegates to it).
- The editor gains a `channelId` prop (already available in `page.tsx`); existing
  behavior is otherwise unchanged. `/jobs` and the channel Videos list gain one
  action each.

## Testing

- **Unit (`src/lib/jobs/monitor.test.ts`, extend):** `isRetryable` —
  script_generation×{failed,cancelled} → true; script_generation×{queued,running,
  complete} → false; other types × any status → false.
- **Regression:** `npm test` green; `npx tsc --noEmit` + `npm run lint` clean;
  `npm run build` succeeds.
- **Manual / app-run e2e:** create a video → cancel generation (status
  `cancelled`) → editor shows the recovery banner → **Retry** regenerates (scenes
  stream again). Separately: create → cancel → **Delete** from the editor → row +
  R2 gone, redirected to the channel Videos tab, `/costs` still loads (orphaned
  cost rows in the unattributed bucket). Delete a video from the channel Videos
  list → row disappears. Try to delete while a job is running → refused until
  cancelled. Retry a failed/cancelled script_generation row from `/jobs`.

## Open questions

None. Settled: retry delegates to `regenerateVideo` with stored prompt/length
(replace:true); delete is a hard delete guarded by the in-flight check, cleaning
R2 (scene audio + render output/base/spec keys, NOT the music_remux cache hash)
and relying on the FK cascade; `cost_events` preserved via SET NULL; Retry in the
editor + `/jobs` (script_generation only), Delete in the editor + channel Videos
list.
