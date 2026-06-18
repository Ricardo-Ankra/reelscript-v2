# Channel Video Defaults Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Video defaults" section on `/channels/[id]` (aspect ratio / FPS / target length) stored in `channels.defaults`, inherited by new videos at creation.

**Architecture:** A pure core (`src/lib/channels/video-defaults.ts`) parses/validates the three format keys; a `set_channel_video_defaults` RPC key-merges them into `channels.defaults` while the brand RPC is switched wholesale→merge so the two sections own disjoint keys; `startScriptGeneration` snapshots the channel's format into the new video's settings + script-gen config; a `VideoDefaultsEditor` client section renders + saves. No render-path change.

**Tech Stack:** Next.js App Router (server actions), Supabase (Postgres RPC, RLS), `node:test` + `--experimental-strip-types`.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-06-18-channel-video-defaults-design.md`.
- **Pure-core rule:** `src/lib/channels/video-defaults.ts` imports only pure modules + type-only imports (no react/server/network). Reuse `type AspectRatio`, `type Fps` from `../videos/settings` and `MIN_TARGET_LENGTH` (5), `MAX_TARGET_LENGTH` (180) from `../videos/regenerate`.
- **Stored keys (snake_case, inside `channels.defaults`):** `aspect_ratio` (`'9:16'|'1:1'|'16:9'`), `fps` (`24|30`), `target_length` (integer 5–180). Code defaults: `9:16` / `30` / `30`.
- **Disjoint-keys invariant:** the brand editor owns `captions_on`/`caption_emphasis_density`/`music_on` in `channels.defaults`; this section owns `aspect_ratio`/`fps`/`target_length`. Both write via key-merge (`defaults || patch`) so neither clobbers the other.
- **No-phantom-save:** the write RPC is `security invoker`, returns `id`, NULL on zero rows → action returns `{ ok:false, reason:'Channel not found.' }`.
- **Snapshot-at-creation:** channel defaults reach a video only at `startScriptGeneration` time; existing videos and the render path are unchanged.
- **No `deploy:remotion` gate** (no render-path change).
- **Tests:** `npm test` (all) or single file `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/channels/video-defaults.test.ts`. Test imports use explicit `.ts` extensions.
- **Migrations:** `npm run db:apply -- supabase/migrations/<file>.sql`.
- **Commit footer:** `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## File Structure

- `src/lib/channels/video-defaults.ts` (create) — pure parse/validate.
- `src/lib/channels/video-defaults.test.ts` (create) — unit tests.
- `supabase/migrations/20260618160000_set_channel_video_defaults.sql` (create) — new RPC + brand RPC merge change.
- `src/app/(app)/channels/[id]/video-defaults-actions.ts` (create) — `saveChannelVideoDefaults`.
- `src/app/(app)/videos/actions.ts` (modify) — seed new video from channel defaults.
- `src/app/(app)/channels/[id]/VideoDefaultsEditor.tsx` (create) — client editor.
- `src/app/(app)/channels/[id]/page.tsx` (modify) — render the section.

---

### Task 1: Pure core `video-defaults.ts` + tests

**Files:**
- Create: `src/lib/channels/video-defaults.ts`
- Test: `src/lib/channels/video-defaults.test.ts`

**Interfaces:**
- Consumes: `type AspectRatio`, `type Fps` from `src/lib/videos/settings.ts`; `MIN_TARGET_LENGTH` (5), `MAX_TARGET_LENGTH` (180) from `src/lib/videos/regenerate.ts`.
- Produces:
  - `interface VideoDefaultsForm { aspectRatio: AspectRatio; fps: Fps; targetLength: number }`
  - `const VIDEO_DEFAULTS_FALLBACK: VideoDefaultsForm`
  - `parseVideoDefaults(defaults: unknown): VideoDefaultsForm`
  - `validateVideoDefaultsForm(input: unknown): { ok: true; value: { aspect_ratio: AspectRatio; fps: Fps; target_length: number } } | { ok: false; reason: string }`

- [ ] **Step 1: Write the failing test**

Create `src/lib/channels/video-defaults.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseVideoDefaults,
  validateVideoDefaultsForm,
  VIDEO_DEFAULTS_FALLBACK,
} from './video-defaults.ts';

test('VIDEO_DEFAULTS_FALLBACK is 9:16 / 30 / 30', () => {
  assert.deepEqual(VIDEO_DEFAULTS_FALLBACK, { aspectRatio: '9:16', fps: 30, targetLength: 30 });
});

test('parseVideoDefaults: empty → fallback', () => {
  assert.deepEqual(parseVideoDefaults({}), VIDEO_DEFAULTS_FALLBACK);
});

test('parseVideoDefaults: garbage / null → fallback', () => {
  assert.deepEqual(parseVideoDefaults(null), VIDEO_DEFAULTS_FALLBACK);
  assert.deepEqual(parseVideoDefaults('nope'), VIDEO_DEFAULTS_FALLBACK);
});

test('parseVideoDefaults: full stored object → those values', () => {
  const f = parseVideoDefaults({ aspect_ratio: '16:9', fps: 24, target_length: 60 });
  assert.deepEqual(f, { aspectRatio: '16:9', fps: 24, targetLength: 60 });
});

test('parseVideoDefaults: partial object backfills only missing keys', () => {
  const f = parseVideoDefaults({ aspect_ratio: '1:1' });
  assert.deepEqual(f, { aspectRatio: '1:1', fps: 30, targetLength: 30 });
});

test('parseVideoDefaults: wrong-typed values fall back per field', () => {
  const f = parseVideoDefaults({ aspect_ratio: 'banana', fps: 99, target_length: 4 });
  assert.deepEqual(f, VIDEO_DEFAULTS_FALLBACK);
});

test('parseVideoDefaults: ignores the brand editor sibling keys', () => {
  const f = parseVideoDefaults({ captions_on: false, music_on: true, caption_emphasis_density: 'liberal' });
  assert.deepEqual(f, VIDEO_DEFAULTS_FALLBACK);
});

test('validateVideoDefaultsForm: valid form → snake_case value', () => {
  const r = validateVideoDefaultsForm({ aspectRatio: '16:9', fps: 24, targetLength: 60 });
  assert.equal(r.ok, true);
  assert.ok(r.ok && r.value.aspect_ratio === '16:9');
  assert.ok(r.ok && r.value.fps === 24);
  assert.ok(r.ok && r.value.target_length === 60);
});

test('validateVideoDefaultsForm: rejects bad aspect ratio', () => {
  assert.equal(validateVideoDefaultsForm({ aspectRatio: '4:3', fps: 30, targetLength: 30 }).ok, false);
});

test('validateVideoDefaultsForm: rejects bad fps', () => {
  assert.equal(validateVideoDefaultsForm({ aspectRatio: '9:16', fps: 25, targetLength: 30 }).ok, false);
});

test('validateVideoDefaultsForm: rejects target_length out of range / non-integer', () => {
  const base = { aspectRatio: '9:16', fps: 30 };
  assert.equal(validateVideoDefaultsForm({ ...base, targetLength: 4 }).ok, false);
  assert.equal(validateVideoDefaultsForm({ ...base, targetLength: 181 }).ok, false);
  assert.equal(validateVideoDefaultsForm({ ...base, targetLength: 30.5 }).ok, false);
  assert.equal(validateVideoDefaultsForm({ ...base, targetLength: 'x' as unknown as number }).ok, false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/channels/video-defaults.test.ts`
Expected: FAIL — cannot find module `./video-defaults.ts`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/channels/video-defaults.ts`:

```ts
// Pure channel video-defaults parse + validation (Phase 8 — video defaults).
// No react/server/network: reuses the pure AspectRatio/Fps types and the
// target-length bounds. The three format keys live in channels.defaults beside
// the brand editor's keys (captions_on / caption_emphasis_density / music_on);
// this module only ever reads/writes its own three.
import type { AspectRatio, Fps } from '../videos/settings';
import { MIN_TARGET_LENGTH, MAX_TARGET_LENGTH } from '../videos/regenerate';

export interface VideoDefaultsForm {
  aspectRatio: AspectRatio;
  fps: Fps;
  targetLength: number;
}

// Mirror of DEFAULT_VIDEO_CONFIG (9:16 / 30 / 30) — the code defaults shown when
// channels.defaults has none of the three keys.
export const VIDEO_DEFAULTS_FALLBACK: VideoDefaultsForm = {
  aspectRatio: '9:16',
  fps: 30,
  targetLength: 30,
};

const ASPECTS: readonly AspectRatio[] = ['9:16', '1:1', '16:9'];
const FPSES: readonly Fps[] = [24, 30];

function isAspect(v: unknown): v is AspectRatio {
  return typeof v === 'string' && (ASPECTS as readonly string[]).includes(v);
}
function isFps(v: unknown): v is Fps {
  return v === 24 || v === 30;
}
function isTargetLength(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= MIN_TARGET_LENGTH && v <= MAX_TARGET_LENGTH;
}

// Build the form from channels.defaults, backfilling the fallback per field.
// Used by the editor and by the creation path (to seed a new video's format).
export function parseVideoDefaults(defaults: unknown): VideoDefaultsForm {
  const o = defaults && typeof defaults === 'object' ? (defaults as Record<string, unknown>) : {};
  return {
    aspectRatio: isAspect(o.aspect_ratio) ? o.aspect_ratio : VIDEO_DEFAULTS_FALLBACK.aspectRatio,
    fps: isFps(o.fps) ? o.fps : VIDEO_DEFAULTS_FALLBACK.fps,
    targetLength: isTargetLength(o.target_length) ? o.target_length : VIDEO_DEFAULTS_FALLBACK.targetLength,
  };
}

// Validate a form submission → the snake_case object to merge into
// channels.defaults.
export function validateVideoDefaultsForm(
  input: unknown,
):
  | { ok: true; value: { aspect_ratio: AspectRatio; fps: Fps; target_length: number } }
  | { ok: false; reason: string } {
  const o = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  if (!isAspect(o.aspectRatio)) return { ok: false, reason: 'Pick a valid aspect ratio.' };
  if (!isFps(o.fps)) return { ok: false, reason: 'Pick a valid frame rate.' };
  if (!isTargetLength(o.targetLength)) {
    return { ok: false, reason: `Target length must be a whole number of seconds, ${MIN_TARGET_LENGTH}–${MAX_TARGET_LENGTH}.` };
  }
  return {
    ok: true,
    value: { aspect_ratio: o.aspectRatio, fps: o.fps, target_length: o.targetLength },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/channels/video-defaults.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/channels/video-defaults.ts src/lib/channels/video-defaults.test.ts
git commit -m "feat: pure channel video-defaults core (parse/validate)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Migration — `set_channel_video_defaults` RPC + brand RPC merge change

**Files:**
- Create: `supabase/migrations/20260618160000_set_channel_video_defaults.sql`

**Interfaces:**
- Produces: `set_channel_video_defaults(p_channel_id uuid, p_value jsonb) returns uuid` (used by Task 3). Also redefines `update_channel_brand(...)` changing only `defaults = p_defaults` → `defaults = defaults || p_defaults`.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260618160000_set_channel_video_defaults.sql`:

```sql
-- Phase 8 — channel video defaults. Writes the three format keys (aspect_ratio,
-- fps, target_length) into channels.defaults via a key-merge, preserving the
-- brand editor's sibling keys (captions_on, caption_emphasis_density, music_on).
-- SECURITY INVOKER → caller RLS on channels applies. RETURNS the updated id
-- (NULL when no row matched) → no phantom save.
create or replace function set_channel_video_defaults(
  p_channel_id uuid,
  p_value      jsonb
) returns uuid
language sql
security invoker
as $$
  update channels
  set defaults   = defaults || p_value,
      updated_at = now()
  where id = p_channel_id
  returning id;
$$;

grant execute on function set_channel_video_defaults(uuid, jsonb) to authenticated;

-- Change the brand editor's defaults write from wholesale to a key-merge so the
-- video-defaults keys survive a brand save. Only the `defaults` line changes
-- (brand_kit was already merged; brand_voice stays wholesale).
create or replace function update_channel_brand(
  p_channel_id      uuid,
  p_name            text,
  p_brand_kit_patch jsonb,
  p_brand_voice     jsonb,
  p_defaults        jsonb
) returns uuid
language sql
security invoker
as $$
  update channels
  set name        = p_name,
      brand_kit   = brand_kit || p_brand_kit_patch,
      brand_voice = p_brand_voice,
      defaults    = defaults || p_defaults,
      updated_at  = now()
  where id = p_channel_id
  returning id;
$$;

grant execute on function update_channel_brand(uuid, text, jsonb, jsonb, jsonb) to authenticated;
```

- [ ] **Step 2: Apply the migration**

Run: `npm run db:apply -- supabase/migrations/20260618160000_set_channel_video_defaults.sql`
Expected: applies cleanly (both functions created/replaced); the script reports success.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260618160000_set_channel_video_defaults.sql
git commit -m "feat: set_channel_video_defaults RPC + brand defaults merge

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Server action `saveChannelVideoDefaults`

**Files:**
- Create: `src/app/(app)/channels/[id]/video-defaults-actions.ts`

**Interfaces:**
- Consumes: `validateVideoDefaultsForm` from `@/lib/channels/video-defaults` (Task 1); the `set_channel_video_defaults` RPC (Task 2); `createClient` from `@/lib/supabase/server`.
- Produces: `saveChannelVideoDefaults(channelId: string, input: unknown): Promise<{ ok: true } | { ok: false; reason: string }>`.

- [ ] **Step 1: Write the action**

Create `src/app/(app)/channels/[id]/video-defaults-actions.ts`:

```ts
'use server';

import { createClient } from '@/lib/supabase/server';
import { validateVideoDefaultsForm } from '@/lib/channels/video-defaults';

// Persist the channel's video-format defaults (aspect_ratio / fps / target_length)
// via set_channel_video_defaults, which key-merges them into channels.defaults
// (the brand editor's sibling keys survive). The RPC returns the id, or null when
// zero rows matched — a failure, not a phantom "Saved". Mirrors saveChannelVoiceTts.
export async function saveChannelVideoDefaults(
  channelId: string,
  input: unknown,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const valid = validateVideoDefaultsForm(input);
  if (!valid.ok) return valid;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc('set_channel_video_defaults', {
    p_channel_id: channelId,
    p_value: valid.value,
  });
  if (error) return { ok: false, reason: error.message };
  if (data == null) return { ok: false, reason: 'Channel not found.' };
  return { ok: true };
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no new type errors.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(app)/channels/[id]/video-defaults-actions.ts"
git commit -m "feat: saveChannelVideoDefaults server action

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Seed new videos from channel defaults

**Files:**
- Modify: `src/app/(app)/videos/actions.ts`

**Interfaces:**
- Consumes: `parseVideoDefaults` from `@/lib/channels/video-defaults` (Task 1); existing `DEFAULT_VIDEO_CONFIG` (for the captions/music code defaults that stay unchanged).
- Produces: a new video whose `settings` (and the script-gen `config`) carry the channel's `aspect_ratio` / `fps` / `target_length`.

**Context for the implementer:** `startScriptGeneration` currently (a) defines a module-level `SEED_VIDEO_SETTINGS` from `DEFAULT_VIDEO_CONFIG`, (b) selects `id, name, brand_voice` from the channel, (c) inserts the video with `settings: SEED_VIDEO_SETTINGS`, and (d) builds `config` from `SEED_VIDEO_SETTINGS`. Replace the module-level constant with a per-channel seed computed after the channel is resolved.

- [ ] **Step 1: Add the import**

In `src/app/(app)/videos/actions.ts`, add to the imports (after the `script-generation` import block):

```ts
import { parseVideoDefaults } from '@/lib/channels/video-defaults';
```

- [ ] **Step 2: Remove the module-level seed constant**

Delete the module-level `SEED_VIDEO_SETTINGS` block:

```ts
// video.settings is the single source of truth for config; the same values are
// copied into the generation event so the worker need not re-read the row.
const SEED_VIDEO_SETTINGS = {
  aspect_ratio: DEFAULT_VIDEO_CONFIG.aspectRatio,
  target_length: DEFAULT_VIDEO_CONFIG.targetLengthSeconds,
  fps: DEFAULT_VIDEO_CONFIG.fps,
  captions_on: DEFAULT_VIDEO_CONFIG.captions,
  music_on: DEFAULT_VIDEO_CONFIG.music,
};
```

- [ ] **Step 3: Select channel defaults**

Change the channel select to include `defaults`:

```ts
  const { data: channel } = await supabase
    .from('channels')
    .select('id, name, brand_voice, defaults')
    .eq('id', channelId)
    .maybeSingle();
```

- [ ] **Step 4: Compute the per-channel seed and use it**

After `const tone = (channel.brand_voice as { tone?: string } | null)?.tone;`, add the per-channel seed (the three format keys from the channel; captions/music stay on code defaults — out of scope this slice):

```ts
  // Snapshot the channel's video-format defaults into the new video; captions/music
  // stay on code defaults (channel inheritance for those is out of scope here).
  const fmt = parseVideoDefaults(channel.defaults);
  const seedSettings = {
    aspect_ratio: fmt.aspectRatio,
    target_length: fmt.targetLength,
    fps: fmt.fps,
    captions_on: DEFAULT_VIDEO_CONFIG.captions,
    music_on: DEFAULT_VIDEO_CONFIG.music,
  };
```

Then change the insert to use `seedSettings`:

```ts
      settings: seedSettings,
```

And change the `config` block to build from `seedSettings`:

```ts
  const config: VideoConfig = {
    aspectRatio: seedSettings.aspect_ratio,
    targetLengthSeconds: seedSettings.target_length,
    fps: seedSettings.fps,
    captions: seedSettings.captions_on,
    music: seedSettings.music_on,
  };
```

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no new type errors. (`seedSettings.aspect_ratio` is `AspectRatio`, `fps` is `Fps`, `target_length` is `number` — all assignable to `VideoConfig`'s `aspectRatio: string` / `fps: number` / `targetLengthSeconds: number`.)

- [ ] **Step 6: Run the full suite (no regressions)**

Run: `npm test`
Expected: PASS — no existing test asserts the old `SEED_VIDEO_SETTINGS` constant; this is behavior-preserving for a channel with empty `defaults` (parseVideoDefaults → code defaults).

- [ ] **Step 7: Commit**

```bash
git add "src/app/(app)/videos/actions.ts"
git commit -m "feat: seed new video format from channel defaults

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: `VideoDefaultsEditor` component + page wiring

**Files:**
- Create: `src/app/(app)/channels/[id]/VideoDefaultsEditor.tsx`
- Modify: `src/app/(app)/channels/[id]/page.tsx`

**Interfaces:**
- Consumes: `parseVideoDefaults`, `type VideoDefaultsForm` from `@/lib/channels/video-defaults`; `saveChannelVideoDefaults` from `./video-defaults-actions`.
- Produces: `<VideoDefaultsEditor channelId={string} initial={VideoDefaultsForm} />` rendered on the channel page.

- [ ] **Step 1: Write the component**

Create `src/app/(app)/channels/[id]/VideoDefaultsEditor.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { saveChannelVideoDefaults } from './video-defaults-actions';
import type { VideoDefaultsForm } from '@/lib/channels/video-defaults';

// Channel video-format defaults editor (Phase 8 follow-on). Aspect ratio, frame
// rate, and target length stored in channels.defaults; new videos snapshot these
// at creation. Single dirty-tracked Save. Mirrors the prior channel editors.
export function VideoDefaultsEditor({
  channelId,
  initial,
}: {
  channelId: string;
  initial: VideoDefaultsForm;
}) {
  const [form, setForm] = useState<VideoDefaultsForm>(initial);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function patch(p: Partial<VideoDefaultsForm>) {
    setForm((f) => ({ ...f, ...p }));
    setDirty(true);
    setSaved(false);
  }

  async function onSave() {
    setBusy(true);
    setError(null);
    try {
      const res = await saveChannelVideoDefaults(channelId, form);
      if (res.ok) {
        setDirty(false);
        setSaved(true);
      } else {
        setError(res.reason);
      }
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Video defaults</h2>
        <p className="text-sm opacity-70">
          The format new videos in this channel start from. You can still override per video.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <label className="space-y-1">
          <span className="text-sm font-medium">Aspect ratio</span>
          <select
            value={form.aspectRatio}
            onChange={(e) => patch({ aspectRatio: e.target.value as VideoDefaultsForm['aspectRatio'] })}
            className="block w-full rounded border border-black/15 bg-transparent px-2 py-1.5 text-sm dark:border-white/15"
          >
            <option value="9:16">9:16</option>
            <option value="1:1">1:1</option>
            <option value="16:9">16:9</option>
          </select>
        </label>

        <label className="space-y-1">
          <span className="text-sm font-medium">Frame rate</span>
          <select
            value={form.fps}
            onChange={(e) => patch({ fps: Number(e.target.value) as VideoDefaultsForm['fps'] })}
            className="block w-full rounded border border-black/15 bg-transparent px-2 py-1.5 text-sm dark:border-white/15"
          >
            <option value={24}>24</option>
            <option value={30}>30</option>
          </select>
        </label>

        <label className="space-y-1">
          <span className="text-sm font-medium">Target length (s)</span>
          <input
            type="number"
            min={5}
            max={180}
            step={1}
            value={form.targetLength}
            onChange={(e) => patch({ targetLength: Number(e.target.value) })}
            className="block w-full rounded border border-black/15 bg-transparent px-2 py-1.5 text-sm dark:border-white/15"
          />
        </label>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onSave}
          disabled={busy || !dirty}
          className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
        {saved && !dirty && <span className="text-sm text-green-600">Saved</span>}
        {error && <span className="text-sm text-red-600">{error}</span>}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire it into the page**

In `src/app/(app)/channels/[id]/page.tsx`:

(a) Add imports near the other channel imports:

```ts
import { parseVideoDefaults } from '@/lib/channels/video-defaults';
import { VideoDefaultsEditor } from './VideoDefaultsEditor';
```

(b) After the existing `const voiceInitial = parseVoiceTts(channel.voice_tts);` line (added in the voice slice), parse the video defaults from the already-selected `defaults` column:

```ts
  const videoDefaultsInitial = parseVideoDefaults(channel.defaults);
```

(c) Add the section at the end of the JSX, after the `<VoiceEditor ... />` block:

```tsx
      <hr className="border-black/10 dark:border-white/10" />

      <VideoDefaultsEditor channelId={channel.id as string} initial={videoDefaultsInitial} />
```

> Note: the page's channels select already includes `defaults` (used by `parseChannelBrand`), so no select change is needed here.

- [ ] **Step 3: Type-check + full suite**

Run: `npx tsc --noEmit`
Expected: no new type errors.

Run: `npm test`
Expected: PASS (the editor is exercised manually; nothing should break).

- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/channels/[id]/VideoDefaultsEditor.tsx" "src/app/(app)/channels/[id]/page.tsx"
git commit -m "feat: VideoDefaultsEditor section on the channel page

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Manual / app-run e2e (operator, after Task 5)

Not an automated task:

1. Open `/channels/[id]` → the Video defaults section shows code defaults (9:16 / 30 / 30).
2. Set `16:9` / `24` / `60` → Save → reload persists.
3. Create a new video in that channel → its `VideoSettingsPanel` shows `16:9` / `24` and length `60s` (inherited).
4. An existing video in the channel is unaffected (keeps its prior settings).
5. Save the brand editor → confirm the video defaults survive; change a video default → confirm the brand defaults (captions/density/music) survive.
6. An out-of-range target length shows the reason and doesn't save.

---

## Self-Review

**1. Spec coverage:**
- Channel video-defaults editor + store → Task 1 (core), Task 3 (action), Task 5 (UI). ✅
- Key-merge into `channels.defaults` + brand RPC wholesale→merge (disjoint keys) → Task 2. ✅
- Snapshot at creation → Task 4. ✅
- No-phantom-save → Task 2 (RPC returns id), Task 3 (null check). ✅
- Back-compat (empty defaults → code defaults) → Task 1 (`parseVideoDefaults`), Task 4 (seed). ✅
- No render-path change → confirmed (no task touches `render.ts`). ✅

**2. Placeholder scan:** none — every code step has complete code; commands have expected output.

**3. Type consistency:** `VideoDefaultsForm` keys (`aspectRatio`/`fps`/`targetLength`) consistent across Tasks 1 and 5; the stored snake_case object (`aspect_ratio`/`fps`/`target_length`) consistent across Task 1 (`validateVideoDefaultsForm`), Task 2 (merge), Task 4 (seed). RPC name `set_channel_video_defaults` consistent across Tasks 2 and 3. `parseVideoDefaults` signature consistent across Tasks 1, 4, 5.
