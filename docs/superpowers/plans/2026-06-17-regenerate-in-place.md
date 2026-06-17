# Regenerate Video In Place — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the operator re-run script generation for an existing video (new length and/or refined prompt) without creating a new one — destructive, script-only, with the new scenes streaming back into the editor.

**Architecture:** A pure helper module assembles the generation payload (`buildGenerateConfig`/`buildBrandContext`/`validateRegenerateInput`). A thin `regenerateVideo` server action guards, persists the prompt + new length, enqueues a `script/generate` job with `replace: true`, and does NO destructive op itself. The destructive wipe lives in the script worker's clear-first (inside the existing `stream-and-insert` step, so it re-runs on retry). The settings panel grows a Regenerate form.

**Tech Stack:** Next.js App Router (server actions), React client components, Tailwind, Supabase (Postgres + RLS), Inngest, `@aws-sdk/client-s3` (R2), `node:test` for pure units.

## Global Constraints

- **Script-only.** Regenerate re-runs script generation only; the operator then Synthesizes + Renders via the existing steps. No auto-synth/render.
- **Destructive wipe lives in the worker**, as the FIRST operations INSIDE the existing `stream-and-insert` `step.run` (NOT a separate `step.run`), guarded by `replace === true`. This guarantees it re-runs on every Inngest retry of that step (Inngest memoizes a step only on success), so a partial stream is always re-wiped before re-streaming. The action performs no destructive op.
- **`replace: true` is set ONLY by `regenerateVideo`.** `startScriptGeneration` never sets it. The worker logs the scene count before deleting, so an errant wipe is observable.
- **Concurrency:** the partial unique index on `jobs (video_id) where type='script_generation' and status in ('queued','running')` enforces exactly the narrow case it can — two concurrent `script_generation` enqueues (double-click / two tabs) — at the DB; the second insert fails with `23505`. It does NOT cover the cross-type case (regenerate while a `render`/`voice_synthesis` is in flight); that is handled by the action's friendly pre-read + single-operator usage, not the DB. The action maps `23505` to the same reason string as the friendly read.
- **`target_length` is in SECONDS** end-to-end; regenerate length bounds are **integer 5–180**.
- **`videos.prompt`** is `text` nullable, no backfill; `startScriptGeneration` is extended to persist it **in this slice**.
- **Panel:** only `{ ok: true }` collapses the Regenerate form; `{ ok: false, reason }` (friendly pre-check OR `23505`) keeps it open and shows `reason`. Branch solely on `res.ok`.
- **Orphaned R2 audio:** best-effort delete only; no reaper this slice.
- **RLS** via the `@/lib/supabase/server` client; the setting is written via the existing `merge_video_settings` RPC.
- **Type shapes** (verbatim): `VideoConfig = { aspectRatio: string; targetLengthSeconds: number; fps: number; captions: boolean; music: boolean }`; `BrandContext = { channelName: string; tone?: string }`.
- **Test command:** `node --experimental-strip-types --import ./scripts/register-loader.mjs --test <file>`.

## File Structure

- **Create** `src/lib/videos/regenerate.ts` (+ `.test.ts`) — pure payload assembly + input validation.
- **Create** `supabase/migrations/20260617130000_regenerate_in_place.sql` — `videos.prompt` column + `jobs` partial unique index.
- **Modify** `src/lib/inngest/client.ts` — add `replace?: boolean` to `ScriptGenerateData`.
- **Modify** `src/app/(app)/videos/actions.ts` — persist `prompt` in the video insert.
- **Create** `src/app/(app)/videos/[id]/regenerate-actions.ts` — `regenerateVideo` server action.
- **Modify** `src/lib/r2.ts` — add `deleteObject(key)`.
- **Modify** `src/lib/inngest/functions/generate-script.ts` — clear-first inside `stream-and-insert` when `replace`.
- **Modify** `src/app/(app)/videos/[id]/page.tsx` — select `prompt`, thread `initialPrompt`.
- **Modify** `src/app/(app)/videos/[id]/Editor.tsx` — accept + pass `initialPrompt`.
- **Modify** `src/app/(app)/videos/[id]/VideoSettingsPanel.tsx` — Regenerate form replacing the Length row.

---

### Task 1: Pure regenerate helpers

**Files:**
- Create: `src/lib/videos/regenerate.ts`
- Test: `src/lib/videos/regenerate.test.ts`

**Interfaces:**
- Consumes: `parseVideoSettings` from `./settings` (Task already shipped on main); `VideoConfig`, `BrandContext` types from `../ai/script-generation`.
- Produces:
  - `const MIN_TARGET_LENGTH = 5`, `const MAX_TARGET_LENGTH = 180`
  - `buildGenerateConfig(settings: unknown, targetLengthSeconds: number): VideoConfig`
  - `buildBrandContext(channel: { name: string; brand_voice?: unknown }): BrandContext` — name is REQUIRED (the action guarantees a loaded channel with a string name); no fabricated fallback.
  - `validateRegenerateInput(input: { prompt?: unknown; targetLengthSeconds?: unknown }): { ok: true; value: { prompt: string; targetLengthSeconds: number } } | { ok: false; reason: string }`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/videos/regenerate.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGenerateConfig,
  buildBrandContext,
  validateRegenerateInput,
  MIN_TARGET_LENGTH,
  MAX_TARGET_LENGTH,
} from './regenerate.ts';

test('buildGenerateConfig: uses the new length (seconds) + fields from settings', () => {
  const cfg = buildGenerateConfig(
    { aspect_ratio: '1:1', fps: 24, captions_on: false, music_on: true, target_length: 45 },
    60,
  );
  assert.equal(cfg.targetLengthSeconds, 60); // new length wins, in seconds
  assert.equal(cfg.aspectRatio, '1:1');
  assert.equal(cfg.fps, 24);
  assert.equal(cfg.captions, false);
  assert.equal(cfg.music, true);
});

test('buildGenerateConfig: empty settings fall back to defaults, new length applied', () => {
  const cfg = buildGenerateConfig({}, 30);
  assert.equal(cfg.targetLengthSeconds, 30);
  assert.equal(cfg.aspectRatio, '9:16');
  assert.equal(cfg.fps, 30);
  assert.equal(cfg.captions, true);
  assert.equal(cfg.music, false);
});

test('buildGenerateConfig: unit agreement — reads the same seconds the panel shows', () => {
  // panel renders settings.target_length as "45s"; regenerate supplies the new value
  // in the SAME unit (seconds). No minutes/label drift.
  assert.equal(buildGenerateConfig({ target_length: 45 }, 60).targetLengthSeconds, 60);
});

test('buildBrandContext: name + tone present', () => {
  assert.deepEqual(buildBrandContext({ name: 'Studio', brand_voice: { tone: 'punchy' } }), {
    channelName: 'Studio',
    tone: 'punchy',
  });
});

test('buildBrandContext: missing/blank tone is omitted (name always used as given)', () => {
  assert.deepEqual(buildBrandContext({ name: 'Studio', brand_voice: null }), { channelName: 'Studio' });
  assert.deepEqual(buildBrandContext({ name: 'Studio' }), { channelName: 'Studio' });
});

test('validateRegenerateInput: empty/whitespace prompt rejected', () => {
  assert.equal(validateRegenerateInput({ prompt: '   ', targetLengthSeconds: 30 }).ok, false);
  assert.equal(validateRegenerateInput({ targetLengthSeconds: 30 }).ok, false);
});

test('validateRegenerateInput: length bounds + integer', () => {
  assert.equal(validateRegenerateInput({ prompt: 'x', targetLengthSeconds: MIN_TARGET_LENGTH - 1 }).ok, false);
  assert.equal(validateRegenerateInput({ prompt: 'x', targetLengthSeconds: MAX_TARGET_LENGTH + 1 }).ok, false);
  assert.equal(validateRegenerateInput({ prompt: 'x', targetLengthSeconds: 30.5 }).ok, false);
});

test('validateRegenerateInput: valid trims prompt and returns value', () => {
  const r = validateRegenerateInput({ prompt: '  make it about cats ', targetLengthSeconds: 30 });
  assert.deepEqual(r, { ok: true, value: { prompt: 'make it about cats', targetLengthSeconds: 30 } });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/videos/regenerate.test.ts`
Expected: FAIL — `Cannot find module './regenerate.ts'`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/videos/regenerate.ts`:

```ts
// Pure payload assembly + input validation for regenerate-in-place (Phase 8). No
// react / server-only / network. The server action (regenerate-actions.ts) is a thin
// wrapper around these + DB/R2/Inngest.
import { parseVideoSettings } from './settings';
import type { VideoConfig, BrandContext } from '../ai/script-generation';

export const MIN_TARGET_LENGTH = 5; // seconds
export const MAX_TARGET_LENGTH = 180; // seconds

// Rebuild the generation config from the video's stored settings, overriding the
// length with the new value (in seconds — the same unit the panel displays).
export function buildGenerateConfig(settings: unknown, targetLengthSeconds: number): VideoConfig {
  const s = parseVideoSettings(settings);
  return {
    aspectRatio: s.aspect_ratio,
    targetLengthSeconds,
    fps: s.fps,
    captions: s.captions_on,
    music: s.music_on,
  };
}

// Brand context from the video's channel row. The channel + its name are REQUIRED;
// the action guarantees a loaded channel with a string name before calling, so there
// is NO fabricated fallback name (a wrong-but-plausible name would silently generate
// off-brand). Only the tone is optional.
export function buildBrandContext(channel: { name: string; brand_voice?: unknown }): BrandContext {
  const tone = (channel.brand_voice as { tone?: unknown } | null)?.tone;
  return typeof tone === 'string' && tone
    ? { channelName: channel.name, tone }
    : { channelName: channel.name };
}

export function validateRegenerateInput(input: {
  prompt?: unknown;
  targetLengthSeconds?: unknown;
}): { ok: true; value: { prompt: string; targetLengthSeconds: number } } | { ok: false; reason: string } {
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  if (!prompt) return { ok: false, reason: 'Enter a prompt.' };
  const n = input.targetLengthSeconds;
  if (
    typeof n !== 'number' ||
    !Number.isInteger(n) ||
    n < MIN_TARGET_LENGTH ||
    n > MAX_TARGET_LENGTH
  ) {
    return { ok: false, reason: `Length must be ${MIN_TARGET_LENGTH}–${MAX_TARGET_LENGTH} seconds.` };
  }
  return { ok: true, value: { prompt, targetLengthSeconds: n } };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/videos/regenerate.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/videos/regenerate.ts src/lib/videos/regenerate.test.ts
git commit -m "feat(regenerate): pure payload assembly + input validation"
```

---

### Task 2: Schema migration (prompt column + jobs unique index)

**Files:**
- Create: `supabase/migrations/20260617130000_regenerate_in_place.sql`

**Interfaces:**
- Produces: `videos.prompt text` (nullable); a partial unique index `jobs_one_inflight_generation` enforcing one in-flight `script_generation` job per video.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260617130000_regenerate_in_place.sql`:

```sql
-- Phase 8 — regenerate video in place.
--
-- 1) Persist the user prompt so an existing video can be regenerated. Nullable,
--    NO backfill: videos created before this column have prompt = null, and the
--    regenerate form starts empty for them. startScriptGeneration is extended in the
--    same slice to write this going forward.
alter table videos add column if not exists prompt text;

-- 2) Authoritative concurrency stop: at most one in-flight script_generation job per
--    video. Partial (only queued/running rows), scoped to script_generation so it does
--    not constrain coexisting voice_synthesis/render jobs. Two racing regenerateVideo
--    calls can't both enqueue — the second insert fails with unique_violation (23505).
create unique index if not exists jobs_one_inflight_generation
  on jobs (video_id)
  where type = 'script_generation' and status in ('queued', 'running');
```

- [ ] **Step 2: Apply the migration**

Run: `npm run db:apply -- supabase/migrations/20260617130000_regenerate_in_place.sql`
Expected: `Recorded migration 20260617130000 ...` + `Applied ...`.
(If the index creation fails on a pre-existing duplicate in-flight job — unlikely in dev — resolve by failing/cancelling the stale job, then re-apply.)
**Production note:** `create unique index` (non-`CONCURRENTLY`) takes a brief write lock on `jobs`, a hot table. Fine in dev; for a production apply, run it during low traffic (or switch to `create unique index concurrently` outside a txn). Flagged here so it's a deliberate choice, not a surprise.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260617130000_regenerate_in_place.sql
git commit -m "feat(regenerate): videos.prompt column + jobs one-inflight-generation index"
```

---

### Task 3: `replace` flag + persist prompt at creation

**Files:**
- Modify: `src/lib/inngest/client.ts:29-36`
- Modify: `src/app/(app)/videos/actions.ts:76-89`

**Interfaces:**
- Produces: `ScriptGenerateData` gains `replace?: boolean`; new videos persist `prompt`.
- Consumes: the `videos.prompt` column (Task 2).

- [ ] **Step 1: Add `replace?` to the event type**

In `src/lib/inngest/client.ts`, change the `ScriptGenerateData` type:

```ts
export type ScriptGenerateData = {
  jobId: string;
  videoId: string;
  accountId: string;
  prompt: string;
  config: VideoConfig;
  brand: BrandContext;
  // When true, the worker WIPES the video's existing scenes before streaming the new
  // ones (regenerate-in-place). Set ONLY by regenerateVideo; absent for initial gen.
  replace?: boolean;
};
```

- [ ] **Step 2: Persist the prompt at creation**

In `src/app/(app)/videos/actions.ts`, add `prompt: trimmed` to the video insert (the `.insert({ ... })` at lines 78-83):

```ts
  const createdVideo = await supabase
    .from('videos')
    .insert({
      account_id: accountId,
      channel_id: channelId,
      title,
      prompt: trimmed,
      settings: SEED_VIDEO_SETTINGS,
    })
    .select('id')
    .single();
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors in `client.ts` / `actions.ts`.

- [ ] **Step 4: Commit**

```bash
git add src/lib/inngest/client.ts "src/app/(app)/videos/actions.ts"
git commit -m "feat(regenerate): script/generate replace flag + persist prompt at creation"
```

---

### Task 4: `regenerateVideo` server action

**Files:**
- Create: `src/app/(app)/videos/[id]/regenerate-actions.ts`

**Interfaces:**
- Consumes: `buildGenerateConfig`, `buildBrandContext`, `validateRegenerateInput` (Task 1); the `replace` field (Task 3); the `merge_video_settings` RPC (already on main); `inngest`.
- Produces: `async function regenerateVideo(videoId: string, input: { prompt: string; targetLengthSeconds: number }): Promise<{ ok: true } | { ok: false; reason: string }>`.

- [ ] **Step 1: Write the implementation**

Create `src/app/(app)/videos/[id]/regenerate-actions.ts`:

```ts
'use server';

import { createClient } from '@/lib/supabase/server';
import { inngest } from '@/lib/inngest/client';
import {
  buildGenerateConfig,
  buildBrandContext,
  validateRegenerateInput,
} from '@/lib/videos/regenerate';

const IN_PROGRESS = 'A job is already in progress for this video.';

// Re-run script generation for an existing video (regenerate-in-place). Performs NO
// destructive op — it persists the prompt + new length, then enqueues a
// script/generate job with replace:true; the worker does the wipe (so a crash before
// enqueue destroys nothing). Script-only: the operator then synthesizes + renders.
export async function regenerateVideo(
  videoId: string,
  input: { prompt: string; targetLengthSeconds: number },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const valid = validateRegenerateInput(input);
  if (!valid.ok) return valid;
  const { prompt, targetLengthSeconds } = valid.value;

  const supabase = await createClient();

  // Friendly guard (the DB unique index is the authoritative stop).
  const { data: inflight } = await supabase
    .from('jobs')
    .select('id')
    .eq('video_id', videoId)
    .in('type', ['script_generation', 'voice_synthesis', 'render'])
    .in('status', ['queued', 'running'])
    .limit(1);
  if (inflight && inflight.length > 0) return { ok: false, reason: IN_PROGRESS };

  const { data: video } = await supabase
    .from('videos')
    .select('account_id, channel_id, settings')
    .eq('id', videoId)
    .maybeSingle();
  if (!video) return { ok: false, reason: 'video not found' };
  const accountId = video.account_id as string;

  const { data: channel } = await supabase
    .from('channels')
    .select('name, brand_voice')
    .eq('id', video.channel_id as string)
    .maybeSingle();
  // Channel is REQUIRED — never fabricate a brand name (would generate off-brand
  // silently). A missing channel/name is a surfaced error, not a default.
  if (!channel || typeof channel.name !== 'string') return { ok: false, reason: 'channel not found' };

  // Persist (non-destructive): prompt + new length. Settings via the atomic RPC.
  // NOTE: this persists BEFORE the enqueue. If the enqueue then fails with a non-23505
  // error, the stored prompt/target_length are "ahead" of the still-current old scenes
  // until the operator retries successfully. Non-destructive and self-correcting on a
  // successful regenerate — named here so it isn't surprising in testing.
  const { error: promptErr } = await supabase.from('videos').update({ prompt }).eq('id', videoId);
  if (promptErr) return { ok: false, reason: promptErr.message };
  const { error: mergeErr } = await supabase.rpc('merge_video_settings', {
    p_video_id: videoId,
    p_patch: { target_length: targetLengthSeconds },
  });
  if (mergeErr) return { ok: false, reason: mergeErr.message };

  // Enqueue (DB index enforces single in-flight) — the last action step.
  const { data: job, error: jobErr } = await supabase
    .from('jobs')
    .insert({ account_id: accountId, video_id: videoId, type: 'script_generation', status: 'queued' })
    .select('id')
    .single();
  if (jobErr || !job) {
    if (jobErr?.code === '23505') return { ok: false, reason: IN_PROGRESS };
    return { ok: false, reason: jobErr?.message ?? 'could not queue generation' };
  }

  const config = buildGenerateConfig(video.settings, targetLengthSeconds);
  const brand = buildBrandContext(channel as { name: string; brand_voice?: unknown });

  await inngest.send({
    name: 'script/generate',
    data: { jobId: job.id as string, videoId, accountId, prompt, config, brand, replace: true },
  });

  return { ok: true };
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors mentioning `regenerate-actions.ts`.

(No unit test: thin orchestration over the Task-1 helpers (tested) + DB/RPC/Inngest, matching `music-actions.ts`/`settings-actions.ts`. End-to-end coverage is Task 7.)

- [ ] **Step 3: Commit**

```bash
git add "src/app/(app)/videos/[id]/regenerate-actions.ts"
git commit -m "feat(regenerate): regenerateVideo server action (guard, persist, enqueue replace job)"
```

---

### Task 5: Worker clear-first on `replace`

**Files:**
- Modify: `src/lib/r2.ts:1-23` (add `deleteObject`)
- Modify: `src/lib/inngest/functions/generate-script.ts:37-87`

**Interfaces:**
- Consumes: the `replace` field on `event.data` (Task 3).
- Produces: `deleteObject(key: string): Promise<void>` in `r2.ts`; the worker wipes scenes when `replace`.

- [ ] **Step 1: Add `deleteObject` to r2.ts**

In `src/lib/r2.ts`, add `DeleteObjectCommand` to the import and a `deleteObject` function:

```ts
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
```

```ts
/** Delete one R2 object. Used by regenerate's clear-first to remove a wiped scene's
 *  audio; callers treat failures as best-effort. */
export async function deleteObject(key: string): Promise<void> {
  await client().send(new DeleteObjectCommand({ Bucket: serverEnv.r2.bucket, Key: key }));
}
```

- [ ] **Step 2: Add clear-first INSIDE the `stream-and-insert` step**

In `src/lib/inngest/functions/generate-script.ts`:

(a) import `deleteObject`:
```ts
import { deleteObject } from '@/lib/r2';
```

(b) destructure `replace` from the event data:
```ts
    const { jobId, videoId, accountId, prompt, config, brand, replace } =
      event.data as ScriptGenerateData;
```

(c) at the TOP of the `step.run('stream-and-insert', ...)` callback — before the accumulator/stream — add the guarded clear-first. The block must be the first thing inside this SAME step (never a separate `step.run`), so it re-runs whenever the step retries:

```ts
    const counts = await step.run('stream-and-insert', async () => {
      // Clear-first (regenerate-in-place): wipe the video's existing scenes before
      // streaming new ones. INSIDE this step (not its own step.run) so an Inngest
      // retry of a partial stream re-deletes the partial scenes first. Guarded by
      // replace — initial generation skips this entirely.
      if (replace) {
        const { data: existing } = await admin.from('scenes').select('id').eq('video_id', videoId);
        const ids = (existing ?? []).map((r) => r.id as string);
        console.log(`[regenerate] clearing ${ids.length} scenes for video ${videoId}`);
        for (const id of ids) {
          try {
            await deleteObject(`audio/${id}.mp3`);
          } catch (e) {
            console.warn(`[regenerate] audio delete failed for ${id}: ${(e as Error).message}`);
          }
        }
        const { error: delErr } = await admin.from('scenes').delete().eq('video_id', videoId);
        if (delErr) throw new Error(`clear scenes: ${delErr.message}`);
      }

      let written = 0;
      let skipped = 0;
      const acc = createNdjsonAccumulator();
      // ...rest of the existing step body unchanged...
```

Leave the rest of `stream-and-insert` (the `handle`, the stream loop, the `return { written, skipped }`) and the `mark-running` / `mark-complete` steps exactly as they are.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors in `r2.ts` / `generate-script.ts`.

- [ ] **Step 4: Commit**

```bash
git add src/lib/r2.ts src/lib/inngest/functions/generate-script.ts
git commit -m "feat(regenerate): worker clear-first wipes scenes on replace (inside stream step, retry-safe)"
```

---

### Task 6: Editor UI — page + Editor + Regenerate form

**Files:**
- Modify: `src/app/(app)/videos/[id]/page.tsx:17-21, 73-80`
- Modify: `src/app/(app)/videos/[id]/Editor.tsx` (props + panel mount)
- Modify: `src/app/(app)/videos/[id]/VideoSettingsPanel.tsx`

**Interfaces:**
- Consumes: `regenerateVideo` (Task 4); `videos.prompt` (Task 2).
- Produces: the Regenerate form in the settings panel; `initialPrompt` threaded page → Editor → panel.

These three files change together (a prop added in one is consumed in the next), so implement and verify them as one unit.

- [ ] **Step 1: page.tsx — select `prompt`, pass `initialPrompt`**

Change the videos select (`.select('id, title, settings')`) to include `prompt`:
```ts
    .select('id, title, settings, prompt')
```
And pass it to `<Editor>`:
```tsx
    <Editor
      videoId={id}
      title={video.title as string}
      initialScenes={scenes}
      initialStatus={(job?.status as string | null) ?? null}
      initialSettings={(video.settings as Record<string, unknown>) ?? {}}
      initialPrompt={(video.prompt as string | null) ?? ''}
    />
```

- [ ] **Step 2: Editor.tsx — accept + forward `initialPrompt`**

Add `initialPrompt` to the props destructure and type (alongside `initialSettings`):
```tsx
  initialSettings,
  initialPrompt,
}: {
  // ...existing...
  initialSettings: Record<string, unknown>;
  initialPrompt: string;
}) {
```
And pass it to the panel where `<VideoSettingsPanel>` is mounted:
```tsx
        <VideoSettingsPanel videoId={videoId} initialSettings={initialSettings} initialPrompt={initialPrompt} />
```

- [ ] **Step 3: VideoSettingsPanel.tsx — add the Regenerate form**

(a) Imports + prop. Add the action import and `initialPrompt` to the props:
```tsx
import { updateVideoSettings } from './settings-actions';
import { regenerateVideo } from './regenerate-actions';
```
```tsx
export function VideoSettingsPanel({
  videoId,
  initialSettings,
  initialPrompt,
}: {
  videoId: string;
  initialSettings: Record<string, unknown>;
  initialPrompt: string;
}) {
```

(b) Regenerate state (add after the existing `saveState` state):
```tsx
  const [regenOpen, setRegenOpen] = useState(false);
  const [prompt, setPrompt] = useState(initialPrompt);
  // settings.target_length is always a number: `settings` is parseVideoSettings(...),
  // which backfills a numeric default (30) for any missing/invalid value. So the
  // number input is never seeded undefined → no empty-input edge case, for new and
  // pre-settings-panel videos alike.
  const [length, setLength] = useState(settings.target_length);
  const [regenBusy, setRegenBusy] = useState(false);
  const [regenError, setRegenError] = useState<string | null>(null);

  async function regenerate() {
    setRegenBusy(true);
    setRegenError(null);
    const res = await regenerateVideo(videoId, { prompt: prompt.trim(), targetLengthSeconds: Number(length) });
    setRegenBusy(false);
    if (res.ok) {
      setRegenOpen(false); // success: collapse; the editor's Realtime + status pill take over
    } else {
      setRegenError(res.reason); // failure (pre-check OR 23505): keep open, show why
    }
  }
```

(c) Replace the read-only Length row (the `<div className={rowClass}>` showing `{settings.target_length}s · regenerates — coming next`) with:
```tsx
      <div className={rowClass}>
        <span className="opacity-80">Length</span>
        <span className="flex items-center gap-2">
          <span className="opacity-60">{settings.target_length}s</span>
          <button
            type="button"
            className={ctrlClass}
            disabled={busy}
            onClick={() => setRegenOpen((o) => !o)}
          >
            Regenerate…
          </button>
        </span>
      </div>

      {regenOpen && (
        <div className="space-y-2 rounded-md border border-black/15 p-2 dark:border-white/20">
          <div className="font-medium opacity-80">Regenerate video</div>
          <textarea
            className="w-full resize-y rounded-md border border-black/15 bg-transparent p-2 outline-none focus:border-black/30 dark:border-white/20 dark:focus:border-white/30"
            rows={3}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Describe the video…"
            disabled={regenBusy}
          />
          <label className={rowClass}>
            <span className="opacity-80">Length (s)</span>
            <input
              type="number"
              min={5}
              max={180}
              className={ctrlClass}
              value={length}
              disabled={regenBusy}
              onChange={(e) => setLength(Number(e.target.value))}
            />
          </label>
          <p className="text-amber-600">⚠ Replaces the current scenes &amp; audio.</p>
          {regenError && <p className="text-red-600">{regenError}</p>}
          <div className="flex items-center justify-end gap-2">
            <button type="button" className={ctrlClass} disabled={regenBusy} onClick={() => setRegenOpen(false)}>
              Cancel
            </button>
            <button type="button" className={ctrlClass} disabled={regenBusy} onClick={() => regenerate()}>
              {regenBusy ? 'Regenerating…' : 'Regenerate'}
            </button>
          </div>
        </div>
      )}
```

Also update the panel's top comment to drop the "target_length is read-only (regenerate is the next slice)" note.

- [ ] **Step 4: Typecheck + lint**

Run: `npx tsc --noEmit`
Expected: clean (the `initialPrompt` prop is now satisfied page → Editor → panel).
Run: `npx eslint "src/app/(app)/videos/[id]/page.tsx" "src/app/(app)/videos/[id]/Editor.tsx" "src/app/(app)/videos/[id]/VideoSettingsPanel.tsx"`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/videos/[id]/page.tsx" "src/app/(app)/videos/[id]/Editor.tsx" "src/app/(app)/videos/[id]/VideoSettingsPanel.tsx"
git commit -m "feat(regenerate): Regenerate form in the settings panel (prompt + length, destructive)"
```

---

### Task 7: End-to-end verification (manual)

**Files:** none (verification only).

- [ ] **Step 1: Full pure suite + typecheck + lint**

Run: `npm test` → all pass (incl. `regenerate.test.ts`).
Run: `npx tsc --noEmit` → clean.

- [ ] **Step 2: Run the app and exercise regenerate**

With the dev server + Inngest dev server running, open a video with scenes and:
- Expand **Regenerate…** in the settings panel. The prompt prefills from `videos.prompt` (empty for pre-column videos).
- Change the length (and/or prompt) → **Regenerate** → confirm the old scenes clear and new scenes stream in with a different count/pacing, and the "Generating…" pill shows.
- Verify the worker log shows `[regenerate] clearing N scenes for video …`.
- While a render is mid-flight, the Regenerate button returns "A job is already in progress for this video." (friendly guard).
- Double-click Regenerate / two tabs → only one generation runs (the 23505 path returns the same message, the form stays open).
- A brand-new video (created after this slice) persists its prompt — its Regenerate form prefills it.
- After regenerate, Synthesize + Generate Video work normally on the new scenes.

- [ ] **Step 3: Final commit (empty if nothing changed)**

```bash
git commit --allow-empty -m "chore(regenerate): verify regenerate-in-place end-to-end"
```

---

## Notes for the implementer

- **The wipe is the worker's job, not the action's.** Do not add a scene delete to `regenerateVideo`. The only destructive op is the clear-first inside `generate-script.ts`'s `stream-and-insert` step.
- **Keep clear-first in the SAME step** as the stream. A separate `step.run('clear-first')` would memoize on success and NOT re-run on a stream retry — leaving partial/duplicate scenes.
- **`replace: true` only from `regenerateVideo`.** `startScriptGeneration` must not set it.
- **target_length is seconds** everywhere; the form's number input is seconds, bounds 5–180.
