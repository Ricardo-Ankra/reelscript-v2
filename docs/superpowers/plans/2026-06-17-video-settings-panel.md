# Video Settings Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-video settings panel in the editor that writes `video.settings` (captions, emphasis density, music, aspect ratio, fps), so the operator controls renders from the UI instead of editing the database.

**Architecture:** A pure validator (`sanitizeSettingsPatch`) + a settings parser (`parseVideoSettings`) in `src/lib/videos/settings.ts`; a server action that validates a patch then applies it via an **atomic** Postgres `jsonb` merge RPC (`merge_video_settings`) returning the written settings; a client `VideoSettingsPanel` that autosaves per control and reconciles its state to what the server returns. The render pipeline already reads `video.settings`, so there is no render-side change.

**Tech Stack:** Next.js App Router (server components + server actions), React client components, Tailwind, Supabase (Postgres + RLS), `node:test` for pure units.

## Global Constraints

- **Render-time settings only.** This slice writes `captions_on`, `caption_emphasis_density`, `music_on`, `aspect_ratio`, `fps`. `target_length` is **read-only** (regenerate-in-place is the next slice). No code path writes `target_length` here.
- **Atomic merge, no read-modify-write.** Settings are written via `settings = settings || patch` in one Postgres statement (the `merge_video_settings` RPC), never load-then-write in app code.
- **Return the written settings.** `updateVideoSettings` returns `{ ok: true; settings }`; the panel reconciles to it (never assumes its patch took).
- **Allowed sets:** `caption_emphasis_density ∈ {off, sparing, liberal}`, `aspect_ratio ∈ {9:16, 1:1, 16:9}`, `fps ∈ {24, 30}` (literal union), booleans from booleans only. Invalid values are dropped, not written.
- **Defaults** (match `DEFAULT_VIDEO_CONFIG`): captions on, music off, aspect `9:16`, fps `30`, density `sparing`, target_length `30`.
- **RLS:** all DB access goes through the RLS-scoped server client (`@/lib/supabase/server`); the RPC is `SECURITY INVOKER`.
- **Tests:** pure logic via `node --test` using the repo's loader: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test <file>`.
- **Density persists across a captions toggle:** turning captions off must not clear a stored `caption_emphasis_density`.

## File Structure

- **Create** `src/lib/videos/settings.ts` — pure types + `sanitizeSettingsPatch` + `parseVideoSettings` + `SETTINGS_DEFAULTS`. One responsibility: the settings contract.
- **Create** `src/lib/videos/settings.test.ts` — unit tests for the pure core.
- **Create** `supabase/migrations/20260617120000_merge_video_settings.sql` — the atomic-merge RPC + grant.
- **Create** `src/app/(app)/videos/[id]/settings-actions.ts` — `updateVideoSettings` server action.
- **Create** `src/app/(app)/videos/[id]/VideoSettingsPanel.tsx` — the client panel.
- **Modify** `src/app/(app)/videos/[id]/page.tsx` — add `settings` to the videos select; pass `initialSettings` to `Editor`.
- **Modify** `src/app/(app)/videos/[id]/Editor.tsx` — accept `initialSettings`; mount `<VideoSettingsPanel>` above `MusicPanel`.

---

### Task 1: Pure settings contract (types, sanitize, parse)

**Files:**
- Create: `src/lib/videos/settings.ts`
- Test: `src/lib/videos/settings.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type CaptionEmphasisDensity = 'off' | 'sparing' | 'liberal'`
  - `type AspectRatio = '9:16' | '1:1' | '16:9'`
  - `type Fps = 24 | 30`
  - `interface VideoSettingsPatch { captions_on?: boolean; caption_emphasis_density?: CaptionEmphasisDensity; music_on?: boolean; aspect_ratio?: AspectRatio; fps?: Fps }`
  - `interface VideoSettings { captions_on: boolean; caption_emphasis_density: CaptionEmphasisDensity; music_on: boolean; aspect_ratio: AspectRatio; fps: Fps; target_length: number }`
  - `const SETTINGS_DEFAULTS: VideoSettings`
  - `function sanitizeSettingsPatch(patch: unknown): VideoSettingsPatch`
  - `function parseVideoSettings(raw: unknown): VideoSettings`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/videos/settings.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeSettingsPatch,
  parseVideoSettings,
  SETTINGS_DEFAULTS,
} from './settings.ts';

test('sanitizeSettingsPatch: keeps valid keys, normalises nothing extra', () => {
  const out = sanitizeSettingsPatch({
    captions_on: false,
    caption_emphasis_density: 'liberal',
    music_on: true,
    aspect_ratio: '16:9',
    fps: 24,
  });
  assert.deepEqual(out, {
    captions_on: false,
    caption_emphasis_density: 'liberal',
    music_on: true,
    aspect_ratio: '16:9',
    fps: 24,
  });
});

test('sanitizeSettingsPatch: drops invalid enum / fps / non-boolean / unknown keys', () => {
  const out = sanitizeSettingsPatch({
    caption_emphasis_density: 'huge', // invalid
    aspect_ratio: '4:3', // invalid
    fps: 60, // invalid
    captions_on: 'yes', // not a boolean
    bogus: 1, // unknown
  });
  assert.deepEqual(out, {});
});

test('sanitizeSettingsPatch: non-object input → empty patch', () => {
  assert.deepEqual(sanitizeSettingsPatch(null), {});
  assert.deepEqual(sanitizeSettingsPatch('x'), {});
});

test('sanitizeSettingsPatch: toggling captions off does NOT include density (item 4)', () => {
  const out = sanitizeSettingsPatch({ captions_on: false });
  assert.deepEqual(out, { captions_on: false });
  assert.ok(!('caption_emphasis_density' in out), 'density key absent → merge cannot clear a stored value');
});

test('parseVideoSettings: empty → defaults', () => {
  assert.deepEqual(parseVideoSettings({}), SETTINGS_DEFAULTS);
  assert.deepEqual(parseVideoSettings(null), SETTINGS_DEFAULTS);
});

test('parseVideoSettings: partial raw merges over defaults; invalid values fall back', () => {
  const s = parseVideoSettings({ captions_on: false, aspect_ratio: '1:1', fps: 99, target_length: 45 });
  assert.equal(s.captions_on, false);
  assert.equal(s.aspect_ratio, '1:1');
  assert.equal(s.fps, SETTINGS_DEFAULTS.fps); // 99 invalid → default
  assert.equal(s.target_length, 45);
  assert.equal(s.caption_emphasis_density, SETTINGS_DEFAULTS.caption_emphasis_density);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/videos/settings.test.ts`
Expected: FAIL — `Cannot find module './settings.ts'`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/videos/settings.ts`:

```ts
// Pure video-settings contract (Phase 8 — video settings panel). Validates a patch
// from the UI and parses the stored settings JSON into typed values with defaults.
// No react / server-only / network — unit-tested, shared by the panel + the action.

export type CaptionEmphasisDensity = 'off' | 'sparing' | 'liberal';
export type AspectRatio = '9:16' | '1:1' | '16:9';
export type Fps = 24 | 30; // literal union — 24 (cinematic) / 30 (standard social)

export interface VideoSettingsPatch {
  captions_on?: boolean;
  caption_emphasis_density?: CaptionEmphasisDensity;
  music_on?: boolean;
  aspect_ratio?: AspectRatio;
  fps?: Fps;
  // target_length intentionally not patchable in this slice
}

export interface VideoSettings {
  captions_on: boolean;
  caption_emphasis_density: CaptionEmphasisDensity;
  music_on: boolean;
  aspect_ratio: AspectRatio;
  fps: Fps;
  target_length: number; // read-only in this slice
}

export const SETTINGS_DEFAULTS: VideoSettings = {
  captions_on: true,
  caption_emphasis_density: 'sparing',
  music_on: false,
  aspect_ratio: '9:16',
  fps: 30,
  target_length: 30,
};

const DENSITIES: readonly CaptionEmphasisDensity[] = ['off', 'sparing', 'liberal'];
const ASPECTS: readonly AspectRatio[] = ['9:16', '1:1', '16:9'];
const FPSES: readonly Fps[] = [24, 30];

// Keep only known keys whose values are in the allowed set; drop everything else.
export function sanitizeSettingsPatch(patch: unknown): VideoSettingsPatch {
  const out: VideoSettingsPatch = {};
  if (!patch || typeof patch !== 'object') return out;
  const p = patch as Record<string, unknown>;
  if (typeof p.captions_on === 'boolean') out.captions_on = p.captions_on;
  if (typeof p.music_on === 'boolean') out.music_on = p.music_on;
  if (DENSITIES.includes(p.caption_emphasis_density as CaptionEmphasisDensity)) {
    out.caption_emphasis_density = p.caption_emphasis_density as CaptionEmphasisDensity;
  }
  if (ASPECTS.includes(p.aspect_ratio as AspectRatio)) {
    out.aspect_ratio = p.aspect_ratio as AspectRatio;
  }
  if (FPSES.includes(p.fps as Fps)) out.fps = p.fps as Fps;
  return out;
}

// Parse stored settings JSON into typed values, backfilling defaults for missing or
// invalid keys. Reuses sanitizeSettingsPatch for the patchable keys (DRY).
export function parseVideoSettings(raw: unknown): VideoSettings {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const clean = sanitizeSettingsPatch(p);
  const target_length =
    typeof p.target_length === 'number' && p.target_length > 0
      ? p.target_length
      : SETTINGS_DEFAULTS.target_length;
  return { ...SETTINGS_DEFAULTS, ...clean, target_length };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/videos/settings.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/videos/settings.ts src/lib/videos/settings.test.ts
git commit -m "feat(settings): pure video-settings contract (sanitize + parse)"
```

---

### Task 2: Atomic-merge RPC migration

**Files:**
- Create: `supabase/migrations/20260617120000_merge_video_settings.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: SQL function `merge_video_settings(p_video_id uuid, p_patch jsonb) returns jsonb`, callable by the `authenticated` role; returns the row's new `settings` (or NULL if no row matched under RLS).

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260617120000_merge_video_settings.sql`:

```sql
-- Phase 8 — video settings panel: atomic JSONB merge for video.settings.
-- A single-statement shallow merge (settings || patch) so concurrent per-key
-- toggles can't lose each other to a stale read-modify-write. SECURITY INVOKER, so
-- the caller's RLS on `videos` applies (only the owner's row updates). Returns the
-- new settings (NULL if no row matched), which the server action reconciles to.
create or replace function merge_video_settings(p_video_id uuid, p_patch jsonb)
returns jsonb
language sql
security invoker
as $$
  update videos
  set settings = settings || p_patch
  where id = p_video_id
  returning settings;
$$;

grant execute on function merge_video_settings(uuid, jsonb) to authenticated;
```

- [ ] **Step 2: Apply the migration**

Run: `npm run db:apply -- supabase/migrations/20260617120000_merge_video_settings.sql`
Expected: `Recorded migration 20260617120000 ...` + `Applied ...`.

- [ ] **Step 3: Smoke-test the function from psql/SQL (manual)**

In the Supabase SQL editor (or `npm run db:apply` of an ad-hoc throwaway not needed), confirm shape with a known video id you own:
`select merge_video_settings('<your-video-id>'::uuid, '{"captions_on": true}'::jsonb);`
Expected: returns the row's full `settings` JSON including `"captions_on": true`, other keys preserved.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260617120000_merge_video_settings.sql
git commit -m "feat(settings): merge_video_settings atomic jsonb merge RPC"
```

---

### Task 3: `updateVideoSettings` server action

**Files:**
- Create: `src/app/(app)/videos/[id]/settings-actions.ts`

**Interfaces:**
- Consumes: `sanitizeSettingsPatch`, `VideoSettingsPatch` (Task 1); the `merge_video_settings` RPC (Task 2); `@/lib/supabase/server`.
- Produces: `async function updateVideoSettings(videoId: string, patch: VideoSettingsPatch): Promise<{ ok: true; settings: Record<string, unknown> } | { ok: false; reason: string }>`.

- [ ] **Step 1: Write the implementation**

Create `src/app/(app)/videos/[id]/settings-actions.ts`:

```ts
'use server';

import { createClient } from '@/lib/supabase/server';
import { sanitizeSettingsPatch, type VideoSettingsPatch } from '@/lib/videos/settings';

// Update a video's render settings via the atomic merge RPC (settings || patch) and
// return the WRITTEN settings so the panel reconciles to the truth. RLS-scoped
// server client; the SECURITY INVOKER RPC enforces ownership. Matches music-actions.ts.
export async function updateVideoSettings(
  videoId: string,
  patch: VideoSettingsPatch,
): Promise<{ ok: true; settings: Record<string, unknown> } | { ok: false; reason: string }> {
  const clean = sanitizeSettingsPatch(patch);
  const supabase = await createClient();

  // Nothing valid to write → return current settings unchanged (still honest).
  if (Object.keys(clean).length === 0) {
    const { data } = await supabase.from('videos').select('settings').eq('id', videoId).maybeSingle();
    if (!data) return { ok: false, reason: 'video not found' };
    return { ok: true, settings: (data.settings as Record<string, unknown>) ?? {} };
  }

  const { data, error } = await supabase.rpc('merge_video_settings', {
    p_video_id: videoId,
    p_patch: clean,
  });
  if (error) return { ok: false, reason: error.message };
  if (data == null) return { ok: false, reason: 'video not found' };
  return { ok: true, settings: data as Record<string, unknown> };
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors mentioning `settings-actions.ts`.

(No unit test: this is a thin Supabase RPC wrapper, like `music-actions.ts` which has none; its logic is `sanitizeSettingsPatch`, tested in Task 1. End-to-end verification is Task 7.)

- [ ] **Step 3: Commit**

```bash
git add "src/app/(app)/videos/[id]/settings-actions.ts"
git commit -m "feat(settings): updateVideoSettings server action (atomic merge, returns written settings)"
```

---

### Task 4: `VideoSettingsPanel` client component

**Files:**
- Create: `src/app/(app)/videos/[id]/VideoSettingsPanel.tsx`

**Interfaces:**
- Consumes: `parseVideoSettings`, `VideoSettings`, `VideoSettingsPatch` (Task 1); `updateVideoSettings` (Task 3).
- Produces: `function VideoSettingsPanel({ videoId, initialSettings }: { videoId: string; initialSettings: Record<string, unknown> }): JSX.Element`.

- [ ] **Step 1: Write the component**

Create `src/app/(app)/videos/[id]/VideoSettingsPanel.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { updateVideoSettings } from './settings-actions';
import {
  parseVideoSettings,
  type VideoSettings,
  type VideoSettingsPatch,
} from '@/lib/videos/settings';

type SaveState = 'idle' | 'saving' | 'saved' | 'failed';
const saveLabel: Record<SaveState, string> = { idle: '', saving: 'saving…', saved: 'saved ✓', failed: 'save failed' };

// Per-video render settings (Phase 8). Autosaves each control to video.settings via
// the atomic merge action, then reconciles to the returned settings. Changes apply on
// the next render — the panel never auto-renders. target_length is read-only here
// (regenerate-in-place is the next slice).
export function VideoSettingsPanel({
  videoId,
  initialSettings,
}: {
  videoId: string;
  initialSettings: Record<string, unknown>;
}) {
  const [settings, setSettings] = useState<VideoSettings>(() => parseVideoSettings(initialSettings));
  const [saveState, setSaveState] = useState<SaveState>('idle');

  async function save(patch: VideoSettingsPatch) {
    const prev = settings;
    setSettings((s) => ({ ...s, ...patch })); // optimistic
    setSaveState('saving');
    const res = await updateVideoSettings(videoId, patch);
    if (res.ok) {
      setSettings(parseVideoSettings(res.settings)); // reconcile to what was written
      setSaveState('saved');
    } else {
      setSettings(prev); // revert
      setSaveState('failed');
    }
  }

  const rowClass = 'flex items-center justify-between gap-3';
  const ctrlClass =
    'rounded-md border border-black/15 bg-transparent px-2 py-1 text-xs outline-none focus:border-black/30 dark:border-white/20 dark:focus:border-white/30';

  return (
    <div className="space-y-2 rounded-lg border border-black/10 bg-black/[0.015] px-3 py-2 text-xs dark:border-white/10 dark:bg-white/[0.02]">
      <div className="flex items-center justify-between">
        <span className="font-medium opacity-80">Settings</span>
        <span className="opacity-50">{saveLabel[saveState]}</span>
      </div>

      <label className={rowClass}>
        <span className="opacity-80">Captions</span>
        <input
          type="checkbox"
          checked={settings.captions_on}
          onChange={(e) => save({ captions_on: e.target.checked })}
        />
      </label>

      <label className={rowClass}>
        <span className="opacity-80">Emphasis</span>
        <select
          className={ctrlClass}
          value={settings.caption_emphasis_density}
          disabled={!settings.captions_on}
          onChange={(e) => save({ caption_emphasis_density: e.target.value as VideoSettings['caption_emphasis_density'] })}
        >
          <option value="off">off</option>
          <option value="sparing">sparing</option>
          <option value="liberal">liberal</option>
        </select>
      </label>

      <label className={rowClass}>
        <span className="opacity-80">Music</span>
        <input
          type="checkbox"
          checked={settings.music_on}
          onChange={(e) => save({ music_on: e.target.checked })}
        />
      </label>

      <label className={rowClass}>
        <span className="opacity-80">Aspect ratio</span>
        <select
          className={ctrlClass}
          value={settings.aspect_ratio}
          onChange={(e) => save({ aspect_ratio: e.target.value as VideoSettings['aspect_ratio'] })}
        >
          <option value="9:16">9:16</option>
          <option value="1:1">1:1</option>
          <option value="16:9">16:9</option>
        </select>
      </label>

      <label className={rowClass}>
        <span className="opacity-80">Frame rate</span>
        <select
          className={ctrlClass}
          value={settings.fps}
          onChange={(e) => save({ fps: Number(e.target.value) as VideoSettings['fps'] })}
        >
          <option value={24}>24</option>
          <option value={30}>30</option>
        </select>
      </label>

      <div className={rowClass}>
        <span className="opacity-80">Length</span>
        <span className="opacity-60">{settings.target_length}s · regenerates — coming next</span>
      </div>

      <p className="opacity-50">Settings apply on the next render.</p>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors mentioning `VideoSettingsPanel.tsx`.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(app)/videos/[id]/VideoSettingsPanel.tsx"
git commit -m "feat(settings): VideoSettingsPanel client component (autosave + reconcile)"
```

---

### Task 5: Load settings in the editor page

**Files:**
- Modify: `src/app/(app)/videos/[id]/page.tsx:17-21` (videos select) and `:73-80` (Editor props)

**Interfaces:**
- Consumes: nothing new.
- Produces: passes `initialSettings={(video.settings as Record<string, unknown>) ?? {}}` to `<Editor>`.

- [ ] **Step 1: Add `settings` to the videos select**

In `src/app/(app)/videos/[id]/page.tsx`, change the select (currently `.select('id, title')`):

```tsx
  const { data: video } = await supabase
    .from('videos')
    .select('id, title, settings')
    .eq('id', id)
    .maybeSingle();
  if (!video) notFound();
```

- [ ] **Step 2: Pass `initialSettings` to `Editor`**

Change the `<Editor>` render at the bottom of the file:

```tsx
  return (
    <Editor
      videoId={id}
      title={video.title as string}
      initialScenes={scenes}
      initialStatus={(job?.status as string | null) ?? null}
      initialSettings={(video.settings as Record<string, unknown>) ?? {}}
    />
  );
```

- [ ] **Step 3: Typecheck (expected to fail until Task 6 adds the prop)**

Run: `npx tsc --noEmit`
Expected: an error that `Editor` has no `initialSettings` prop — resolved in Task 6. (If running tasks out of order, do Task 6 first.)

- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/videos/[id]/page.tsx"
git commit -m "feat(settings): load video.settings in the editor page"
```

---

### Task 6: Mount the panel in the editor

**Files:**
- Modify: `src/app/(app)/videos/[id]/Editor.tsx:26-36` (props) and `:355` (mount above the render card)

**Interfaces:**
- Consumes: `VideoSettingsPanel` (Task 4); `initialSettings` from `page.tsx` (Task 5).
- Produces: `Editor` accepts `initialSettings: Record<string, unknown>` and renders the panel.

- [ ] **Step 1: Import the panel**

At the top of `src/app/(app)/videos/[id]/Editor.tsx`, add to the imports (near the `MusicPanel` import):

```tsx
import { VideoSettingsPanel } from './VideoSettingsPanel';
```

- [ ] **Step 2: Add the prop to the Editor signature**

Change the destructured props + type:

```tsx
export function Editor({
  videoId,
  title,
  initialScenes,
  initialStatus,
  initialSettings,
}: {
  videoId: string;
  title: string;
  initialScenes: SceneWithShots[];
  initialStatus: string | null;
  initialSettings: Record<string, unknown>;
}) {
```

- [ ] **Step 3: Mount the panel above the render card**

In the render area, immediately BEFORE the render-panel block `{ordered.length > 0 && (` at line ~355, add a sibling settings card:

```tsx
      {ordered.length > 0 && (
        <VideoSettingsPanel videoId={videoId} initialSettings={initialSettings} />
      )}

      {ordered.length > 0 && (
        <div className="space-y-2 rounded-lg border border-black/10 bg-black/[0.015] px-3 py-2 dark:border-white/10 dark:bg-white/[0.02]">
          {/* existing render panel — unchanged */}
```

(Leave the existing render-panel block exactly as-is; only insert the new `VideoSettingsPanel` block above it.)

- [ ] **Step 4: Typecheck + lint**

Run: `npx tsc --noEmit`
Expected: no errors (Task 5's prop is now satisfied).
Run: `npx eslint "src/app/(app)/videos/[id]/Editor.tsx" "src/app/(app)/videos/[id]/VideoSettingsPanel.tsx" "src/app/(app)/videos/[id]/settings-actions.ts" src/lib/videos/settings.ts`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/videos/[id]/Editor.tsx"
git commit -m "feat(settings): mount VideoSettingsPanel in the editor"
```

---

### Task 7: End-to-end verification (manual)

**Files:** none (verification only).

- [ ] **Step 1: Full pure suite + typecheck + lint**

Run: `npm test`  → expected: all pass (includes the new `settings.test.ts`).
Run: `npx tsc --noEmit`  → expected: clean.

- [ ] **Step 2: Run the app and exercise the panel**

Run the dev server (`npm run dev`), open a video editor page with scenes, and:
- Toggle **Captions** off → the **Emphasis** select disables; the indicator shows `saving… → saved ✓`.
- Set **Emphasis** to `liberal`, toggle Captions off then on → it still reads `liberal` (density survived the toggle — the atomic merge never cleared it).
- Change **Aspect ratio** and **Frame rate**; reload the page → values persist (read back from `video.settings`).
- Confirm **Length** shows read-only with "regenerates — coming next".

- [ ] **Step 3: Confirm it reaches the render**

Click **Generate Video** after enabling captions + setting density, let it complete, and confirm the output reflects the settings (captions present at the chosen density). This exercises `caption_emphasis_density` end-to-end through the UI for the first time.

- [ ] **Step 4: Final commit (if any docs/notes changed)**

```bash
git add -A
git commit -m "chore(settings): verify video settings panel end-to-end" --allow-empty
```

---

## Notes for the implementer

- **Settings only affect the NEXT render.** The panel never triggers a render; the operator clicks Generate Video. This is intentional and stated in the panel copy.
- **`mood` and `target_length` are not written here.** `mood` stays with the Music panel; `target_length` is read-only until the regenerate-in-place slice.
- **RLS is automatic** via the server Supabase client; the RPC is `SECURITY INVOKER`, so an attempt to merge a video you don't own matches no row and returns NULL → `{ ok: false, reason: 'video not found' }`.
