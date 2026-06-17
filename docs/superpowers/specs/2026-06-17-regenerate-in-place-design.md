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

## Schema change

Add `prompt text` (nullable) to `videos`. Migration only; RLS unchanged (the
existing `videos` account-isolation policy covers it). `startScriptGeneration` is
extended to write `prompt` into the insert it already builds.

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

## Server action

New `src/app/(app)/videos/[id]/regenerate-actions.ts`:

```ts
export async function regenerateVideo(
  videoId: string,
  input: { prompt: string; targetLengthSeconds: number },
): Promise<{ ok: true } | { ok: false; reason: string }>;
```

Steps (RLS-scoped server client throughout):

1. **Guard.** Reject if any `jobs` row for this video has
   `type ∈ {script_generation, voice_synthesis, render}` and
   `status ∈ {queued, running}` → `{ ok:false, reason: 'A job is already in progress for this video.' }`.
   Never wipe mid-render or double-generate.
2. **Validate input.** `prompt` non-empty (trimmed); `targetLengthSeconds` a
   positive number within sane bounds (e.g. 5–180). Reject otherwise.
3. **Load context.** Fetch the video (`account_id`, `channel_id`, `settings`) and
   its channel (name + `brand_voice.tone`). Not found / not owned (RLS) →
   `{ ok:false, reason }`.
4. **Persist.** Write `videos.prompt = prompt`; merge `target_length` into
   `videos.settings` via the existing `merge_video_settings` RPC.
5. **Wipe.** Read current scene ids; best-effort delete their R2 audio
   (`audio/{sceneId}.mp3`) — failures logged, never block; then
   `DELETE FROM scenes WHERE video_id = …` (shots cascade via FK).
6. **Re-run.** Insert a fresh `jobs` row (`type='script_generation'`,
   `status='queued'`) and emit `script/generate` with
   `{ jobId, videoId, accountId, prompt, config, brand }`, where:
   - `config` = `buildGenerateConfig(settings, targetLengthSeconds)` — the
     `VideoConfig` rebuilt from the video's settings with the new length.
   - `brand` = `buildBrandContext(channel)` — `{ channelName, tone? }`.
   This payload matches `startScriptGeneration`'s exactly, so the worker is
   unchanged.
7. Return `{ ok:true }`.

The script worker (`generate-script.ts`) and its `upsert_scene_with_shots` RPC are
unchanged: after the wipe there are no existing scenes, so the new run inserts a
clean set (and is still idempotent on `(video_id, position)` if Inngest retries).

## What is wiped vs kept

| State | Regenerate |
|---|---|
| `scenes` (+ word_alignments, audio fields) | **deleted** (re-created by the new run) |
| `shots` | **deleted** (cascade) |
| R2 scene audio `audio/{sceneId}.mp3` | **deleted** (best-effort) |
| `renders`, `script_revisions` | **kept** (history; tied to prior revisions) |
| `cost_events` | **kept** (append-only ledger) |
| last render preview in the editor | stays visible (stale vs new scenes) until re-render — acceptable |

## Data flow

```
VideoSettingsPanel (Regenerate form)
        │ regenerateVideo(videoId, { prompt, targetLengthSeconds })
        ▼
regenerate-actions.ts
  guard → validate → persist (prompt + settings RPC) → wipe (R2 + scenes) → emit script/generate
        ▼
generate-script.ts worker  →  upsert_scene_with_shots (new scenes)
        ▼
editor Realtime: DELETE(old scenes) + INSERT(new) + jobs 'Generating…' pill
```

No changes to the editor's Realtime or the worker. `page.tsx` adds `prompt` to its
videos select and threads it (`initialPrompt`) to `Editor` → `VideoSettingsPanel`.

## Pure, testable core

`src/lib/videos/regenerate.ts` (pure, no react/server/network):
- `buildGenerateConfig(settings: unknown, targetLengthSeconds: number): VideoConfig`
  — rebuilds the config from stored settings with the new length, applying the same
  defaults as `parseVideoSettings`.
- `buildBrandContext(channel: { name?: unknown; brand_voice?: unknown }): BrandContext`
  — `{ channelName, tone? }` from the channel row.
- `validateRegenerateInput(input): { ok: true; value } | { ok: false; reason }`
  — trims/validates prompt + length bounds.

The server action is thin orchestration over these + DB/R2/Inngest, verified by the
app run (not unit-tested, matching `music-actions.ts` / `render-actions.ts`).

## Testing

- **Pure (`node --test`)** on `regenerate.ts`: `buildGenerateConfig` (new length +
  defaults from partial/empty settings), `buildBrandContext` (name + tone present /
  absent), `validateRegenerateInput` (empty prompt rejected, length bounds, valid
  passes).
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
