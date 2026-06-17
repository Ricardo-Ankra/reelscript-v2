# Regenerate video in place — design

**Date:** 2026-06-17
**Phase:** 8 (Full surfaces) — second slice (follows the video settings panel).
**Status:** Design approved; spec under review before implementation.

## Summary

Let the operator re-run script generation for an EXISTING video — to change its
target length or refine the prompt — without creating a new video. This completes
the one control the video settings panel deferred (`target_length`, which reshapes
the script and so needs a regenerate, not just a re-render).

It is **destructive and script-only**: it wipes the current scenes/shots (and their
orphaned audio), re-runs generation against the same video, and the editor's
existing Realtime streams the new scenes back in. The operator then proceeds through
the normal Synthesize → Generate Video steps — mirroring the app's step-wise,
reviewable pipeline. Past renders, script revisions, and the cost ledger are kept as
history.

## The load-bearing constraint: the prompt isn't persisted

Today the prompt lives only in the `script/generate` event payload at creation
(`startScriptGeneration`); there is no `videos.prompt` column. Regenerate has
nothing to re-run from. So this slice **adds `videos.prompt`**, persists it at
creation going forward, and prefills it (editable) in the regenerate form. Videos
created before the column exists have `prompt = null` → the form starts empty and
the operator types it.

## Schema changes

Two migrations:

1. **`videos.prompt`** — add `prompt text` **nullable, with no backfill**. Pre-column
   videos have `prompt = null` → the regenerate form starts empty (as designed). RLS
   unchanged (the existing `videos` account-isolation policy covers it).
   `startScriptGeneration` is extended **in this same slice** to write `prompt` into
   the insert it already builds — this MUST ship with the column, or every
   newly-created video would also regenerate from an empty prompt (silently). The
   plan orders the action change with the migration.

2. **`jobs` partial unique index** (concurrency enforcement — see the guard below):
   `create unique index ... on jobs (video_id) where type = 'script_generation' and
   status in ('queued','running')`. This makes "at most one in-flight generation per
   video" a DB invariant, so two racing `regenerateVideo` calls (double-click, two
   tabs) can't both enqueue. Partial (only in-flight rows), so completed/failed jobs
   never conflict, and it is scoped to `script_generation` so it does not constrain
   coexisting `voice_synthesis`/`render` jobs.

## UI

In the existing `VideoSettingsPanel`, the read-only Length row becomes a
**Regenerate** affordance that expands an inline form:

```
Length        30s   [ Regenerate… ]
   ↓ (expands on click)
┌ Regenerate video ─────────────────────────────┐
│ Prompt   [ …prefilled, editable textarea… ]    │
│ Length   [ 30 ] s                              │
│ ⚠ Replaces the current scenes & audio.         │
│            [ Cancel ]  [ Regenerate ]          │
└────────────────────────────────────────────────┘
```

- Destructive, so it is gated behind the explicit expand + a `Regenerate` button
  (not a one-click). The warning line states the consequence.
- The prompt textarea is prefilled from `videos.prompt` (passed via the page →
  Editor → panel, like `initialSettings`); empty if null.
- `Regenerate` is disabled while a job is in flight (the panel already knows the
  generation status via the editor; the server action is the authoritative guard).
- On success the panel collapses the form; the editor's existing "Generating…"
  pill + Realtime scene stream take over (no extra panel state needed).
- **Failure keeps the form open.** Only `{ ok: true }` collapses the form. A
  `{ ok: false, reason }` — whether from the step-1 friendly pre-check OR the DB
  unique-index violation (`23505`), which both return the identical reason string —
  re-enables the Regenerate button and shows `reason` inline; it must NOT collapse as
  if it succeeded. The panel branches solely on `res.ok`, so both failure sources are
  handled identically by construction.

## Server action

New `src/app/(app)/videos/[id]/regenerate-actions.ts`:

```ts
export async function regenerateVideo(
  videoId: string,
  input: { prompt: string; targetLengthSeconds: number },
): Promise<{ ok: true } | { ok: false; reason: string }>;
```

**The action performs NO destructive operation.** The wipe lives in the worker (see
below), so the only thing the action can fail at is enqueuing — which leaves the
current scenes intact. Steps (RLS-scoped server client throughout):

1. **Guard (friendly message).** Reject if any `jobs` row for this video has
   `type ∈ {script_generation, voice_synthesis, render}` and
   `status ∈ {queued, running}` → `{ ok:false, reason: 'A job is already in progress for this video.' }`.
   This is the *friendly* check; the DB partial unique index (above) is the
   *authoritative* one against the read-then-insert TOCTOU.
2. **Validate input.** `prompt` non-empty (trimmed); `targetLengthSeconds` an
   integer within bounds **5–180** (seconds). Reject otherwise.
3. **Load context.** Fetch the video (`account_id`, `channel_id`, `settings`) and
   its channel (name + `brand_voice.tone`). Video not found / not owned (RLS), OR
   channel missing / without a string name → `{ ok:false, reason }`. The channel is
   required — `buildBrandContext` never fabricates a brand name.
4. **Persist.** Write `videos.prompt = prompt`; merge `target_length` into
   `videos.settings` via the existing `merge_video_settings` RPC. (Not destructive;
   the worker reads neither — they drive the panel display and future regenerates.)
5. **Enqueue + emit (the last action step).** Insert a fresh `jobs` row
   (`type='script_generation'`, `status='queued'`) then emit `script/generate` with
   `{ jobId, videoId, accountId, prompt, config, brand, replace: true }`, where:
   - `config` = `buildGenerateConfig(settings, targetLengthSeconds)` — the
     `VideoConfig` rebuilt from the video's settings with the new length.
   - `brand` = `buildBrandContext(channel)` — `{ channelName, tone? }`.
   The payload matches `startScriptGeneration`'s plus the new `replace` flag.
   If the `jobs` insert hits the partial unique index (Postgres `23505`), treat it as
   `{ ok:false, reason: 'A job is already in progress for this video.' }` — the
   authoritative concurrency stop.
6. Return `{ ok:true }`.

### Why the wipe is in the worker (and last)

The destructive `DELETE FROM scenes` is the worker's **first step**, not the action's
— for two reasons:

- **Crash-safety / no void state.** The only durable unit is the queued job. If the
  action crashes any time before the `script/generate` emit, nothing is destroyed
  (scenes intact, operator just retries). Once the job is enqueued, the worker
  runs — and re-runs on Inngest retry — performing wipe-then-generate as one unit.
  There is no window where scenes are gone but no job exists to recreate them.
- **No action↔worker race.** If the action deleted scenes *after* emitting, the
  worker (which Inngest may start within milliseconds) could insert new scenes that
  the action's `DELETE … WHERE video_id` then removes — flaky missing scenes. Making
  the worker the sole writer of both the delete and the inserts removes the race.

### Worker change: clear-first on `replace`

`generate-script.ts` today runs three Inngest steps: `mark-running`,
`stream-and-insert` (one durable `step.run` that streams the NDJSON and upserts every
scene), `mark-complete`. The guarded **clear-first** is added as the **first
operations inside the existing `stream-and-insert` step** — NOT a new `step.run` —
and runs only when the event's `replace === true`:

1. Read existing scene ids for `videoId`; **log the count about to be cleared**
   (`[regenerate] clearing N scenes for video <id>`) so an erroneous wipe is visible
   in the job logs, not silent; best-effort delete their R2 audio
   (`audio/{sceneId}.mp3`) — failures logged, never block.
2. `DELETE FROM scenes WHERE video_id = …` (shots cascade via FK).

Then it streams the new scenes exactly as today via `upsert_scene_with_shots`.

**Retry safety — why clear-first must live INSIDE `stream-and-insert`.** Inngest
memoizes a `step.run` only when it completes successfully. If the stream crashes
after inserting, say, 3 of 8 scenes, that step never completed → on retry Inngest
re-runs the whole step from the top → clear-first re-deletes the 3 partial scenes and
the stream re-inserts cleanly. A partial stream is therefore always wiped before
re-streaming; there are no duplicates or orphans. This guarantee depends on the step
boundary: clear-first must be in the SAME `step.run` as the stream. If it were a
separate `step.run('clear-first')`, a successful clear-first would memoize and a
retry of the stream alone would skip the re-delete — leaving a mix. So it is
deliberately not its own step. (`mark-running` memoizes separately and is irrelevant
to the wipe.)

After `retries` are exhausted the existing `onFailure` marks the job `failed`. Worst
case is then a video with few/no scenes and a **failed** job — observable and
recoverable by regenerating again, distinct from the original "scenes gone, no job"
void this design eliminates.

(For initial generation `replace` is false/absent, so clear-first is skipped and that
path is byte-for-byte unchanged.)

**`replace` is destructive — keep it coupled to regenerate.** The only emitter that
sets `replace: true` is `regenerateVideo`; `startScriptGeneration` (the sole other
emitter of `script/generate`) never sets it. There is no structural lock keeping the
flag and the destructive intent together, so this is enforced by convention + the
scene-count log above (an erroneous wipe is at least observable in the job logs). The
plan calls this out so a future `script/generate` emitter doesn't pass `replace: true`
without meaning to wipe.

## What is wiped vs kept

| State | Regenerate |
|---|---|
| `scenes` (+ word_alignments, audio fields) | **deleted** (re-created by the new run) |
| `shots` | **deleted** (cascade) |
| R2 scene audio `audio/{sceneId}.mp3` | **deleted** (best-effort) |
| `renders`, `script_revisions` | **kept** (history; tied to prior revisions) |
| `cost_events` | **kept** (append-only ledger) |
| last render preview in the editor | stays visible (stale vs new scenes) until re-render — acceptable |

The scene/shot/audio deletion is performed by the **worker's clear-first step** (see
above), not the action — so it happens only after the job is durably enqueued.

## Data flow

```
VideoSettingsPanel (Regenerate form)
        │ regenerateVideo(videoId, { prompt, targetLengthSeconds })
        ▼
regenerate-actions.ts  (NO destructive op)
  guard → validate → persist (prompt + settings RPC) → enqueue job → emit script/generate {replace:true}
        ▼
generate-script.ts worker
  clear-first (best-effort R2 audio delete → DELETE scenes)  →  stream new scenes (upsert_scene_with_shots)
        ▼
editor Realtime: DELETE(old scenes) + INSERT(new) + jobs 'Generating…' pill
```

The editor's Realtime is unchanged; the worker gains the guarded clear-first step.
`page.tsx` adds `prompt` to its videos select and threads it (`initialPrompt`) to
`Editor` → `VideoSettingsPanel`.

## target_length units (consistency)

`target_length` is stored and read **in seconds** everywhere: `SEED_VIDEO_SETTINGS`
seeds it from `DEFAULT_VIDEO_CONFIG.targetLengthSeconds`, the panel displays it as
`{target_length}s`, and `buildGenerateConfig` maps `settings.target_length` →
`config.targetLengthSeconds`. The regenerate form's `targetLengthSeconds` and step-4's
merge into `target_length` use the same unit, so the merge never writes a different
type/label into the key. A unit-agreement assertion is in the tests below.

## Pure, testable core

`src/lib/videos/regenerate.ts` (pure, no react/server/network):
- `buildGenerateConfig(settings: unknown, targetLengthSeconds: number): VideoConfig`
  — rebuilds the config from stored settings with the new length, applying the same
  defaults as `parseVideoSettings`.
- `buildBrandContext(channel: { name: string; brand_voice?: unknown }): BrandContext`
  — `{ channelName, tone? }` from the channel row. The channel + a string name are
  REQUIRED (the action surfaces a missing channel as `{ ok:false }` rather than
  fabricating one) — no plausible-but-wrong default name that would silently generate
  off-brand. Only `tone` is optional.
- `validateRegenerateInput(input): { ok: true; value } | { ok: false; reason }`
  — trims/validates prompt + length bounds.

The server action is thin orchestration over these + DB/R2/Inngest, verified by the
app run (not unit-tested, matching `music-actions.ts` / `render-actions.ts`).

## Testing

- **Pure (`node --test`)** on `regenerate.ts`: `buildGenerateConfig` (new length +
  defaults from partial/empty settings), `buildBrandContext` (name + tone present /
  absent), `validateRegenerateInput` (empty prompt rejected, length bounds 5–180,
  valid passes).
- **Unit-agreement assertion:** `buildGenerateConfig({ target_length: 45 }, 60)`
  yields `targetLengthSeconds === 60` (the new value, in seconds — the same unit the
  panel renders as `45s` and the new form supplies), confirming no minutes/label
  drift across the form, the merge, `buildGenerateConfig`, and the panel display.
- **Manual / app run:** open a video, expand Regenerate, change the length (and/or
  prompt), confirm → old scenes clear and new scenes stream in with a different
  count/pacing; the guard blocks while a render is mid-flight; then synthesize +
  render normally. Also: a brand-new video persists its prompt (regenerate form
  prefills it).

## Out of scope (this slice)

- Auto-synthesize / auto-render after regenerate (chosen: script-only).
- A revision/diff history of regenerations (script_revisions already snapshot at
  render time; no per-regenerate snapshot here).
- Editing the prompt from anywhere other than the regenerate form.
- Deleting old renders/costs on regenerate (kept as history).
- **Reaping orphaned R2 audio.** The worker's clear-first best-effort-deletes the
  prior scenes' `audio/{id}.mp3`, but anything it misses (delete failure, a crash
  between delete and re-generate) is left orphaned — there is no reaper this slice.
  Known debt, not a silent leak; a sweep job is a later operations task.
