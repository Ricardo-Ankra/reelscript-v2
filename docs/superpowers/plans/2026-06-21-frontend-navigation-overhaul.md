# Frontend Navigation & Creation-Flow Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make videos reachable from each channel and let an operator set every video option *before* generation, on a clean navigation spine.

**Architecture:** Home (`/`) becomes the channels surface; the channel page becomes tabbed (Videos default | Settings); a new channel-scoped New Video setup screen (`/videos/new?channel=<id>`) collects prompt + options and calls a reworked `startScriptGeneration` that reads the channel's full stored defaults and overlays per-video overrides. Two new pure, unit-tested helpers (creation-seed merge, video-status derivation) hold the logic; the rest is route/UI wiring. No DB migration.

**Tech Stack:** Next.js App Router (server + client components), TypeScript, Supabase JS (RLS), node:test.

## Global Constraints

- **No DB migration. No new `channels.defaults` keys** — `captions_on`, `caption_emphasis_density`, `music_on` already live there (written by the Brand editor, `src/lib/channels/brand.ts`); the format keys `aspect_ratio`, `fps`, `target_length` are written by the Video-defaults editor.
- **`videos.settings` keys** (snake_case): `captions_on`, `caption_emphasis_density`, `music_on`, `aspect_ratio`, `fps`, `target_length`. Value domains: `AspectRatio` = `'9:16'|'1:1'|'16:9'`; `Fps` = `24|30`; `CaptionEmphasisDensity` = `'off'|'sparing'|'liberal'`; `target_length` integer `5`–`180` (`MIN_TARGET_LENGTH`/`MAX_TARGET_LENGTH` in `src/lib/videos/regenerate.ts`).
- **`startScriptGeneration` keeps a back-compatible signature**: the third `settings` arg is optional; a two-arg call must still work (and now correctly reads the channel's captions/density/music defaults instead of code constants).
- **No `VideoDefaultsEditor` / Brand-editor change.** Do NOT add duplicate captions/density/music controls anywhere.
- **Render in-flight phases** (verbatim, from `render-actions.ts`): `queued`, `composing`, `resolving_assets`, `validating`, `rendering`, `encoding`. Render terminal: `complete`, `failed`. **Job statuses** (verbatim): `queued`, `running`, `complete`, `failed`.
- **Tests:** run with `node --experimental-strip-types --import ./scripts/register-loader.mjs --test <file>` (the `npm test` harness). Test files import source with an explicit `.ts` extension and use `import { test } from 'node:test'; import assert from 'node:assert/strict';`.
- **Server actions are not unit-tested** (network/DB) — their pure logic is extracted into tested helpers; verification is `tsc` + `lint` + `build`.
- **Commit footer:** end every commit message with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- All Supabase reads/writes are RLS-scoped to the session account (no `account_id` filter needed on reads; RLS enforces it).

## File Structure

**Create:**
- `src/lib/videos/create-settings.ts` — pure: read full channel defaults + merge per-video override into the creation seed.
- `src/lib/videos/create-settings.test.ts` — node:test for the above.
- `src/lib/videos/status.ts` — pure: derive a video's display status from latest job/render rows.
- `src/lib/videos/status.test.ts` — node:test for the above.
- `src/app/(app)/page.tsx` — Home (channels surface).
- `src/app/(app)/videos/new/page.tsx` — New Video setup screen (server).
- `src/app/(app)/videos/new/NewVideoForm.tsx` — setup form (client).
- `src/app/(app)/channels/[id]/ChannelTabs.tsx` — Videos|Settings tab strip (presentational).

**Modify:**
- `src/app/(app)/videos/actions.ts` — `startScriptGeneration` gains optional `settings`; seed via the new helpers.
- `src/app/(app)/channels/[id]/page.tsx` — tabbed; Videos list (default) + Settings (existing editors).
- `src/app/(app)/layout.tsx` — nav links (drop Channels, add Home, reorder; logo → `/`).
- `src/app/(app)/dashboard/page.tsx` — replace with `redirect('/')`.
- `src/app/(app)/channels/page.tsx` — replace with `redirect('/')`.

**Delete:**
- `src/app/(app)/dashboard/PromptBox.tsx` — superseded by the setup screen.

`NewChannelForm.tsx` and `channels/actions.ts` stay where they are (imported by Home and the form).

---

### Task 1: Creation-seed helpers (pure)

**Files:**
- Create: `src/lib/videos/create-settings.ts`
- Test: `src/lib/videos/create-settings.test.ts`

**Interfaces:**
- Consumes: `parseVideoSettings`, `sanitizeSettingsPatch`, `SETTINGS_DEFAULTS`, `VideoSettings` from `./settings.ts`; `MIN_TARGET_LENGTH`, `MAX_TARGET_LENGTH` from `./regenerate.ts`.
- Produces:
  - `type CreateOptions = VideoSettings` (the six snake_case keys).
  - `parseChannelCreateOptions(defaults: unknown): CreateOptions` — full option set from `channels.defaults`, per-key fallback to `SETTINGS_DEFAULTS`.
  - `mergeCreateSettings(base: CreateOptions, override: unknown): CreateOptions` — `base` overlaid with a re-validated override; per-key fallback to `base`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/videos/create-settings.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseChannelCreateOptions, mergeCreateSettings } from './create-settings.ts';
import { SETTINGS_DEFAULTS } from './settings.ts';

test('parseChannelCreateOptions: empty/invalid → SETTINGS_DEFAULTS', () => {
  assert.deepEqual(parseChannelCreateOptions(null), SETTINGS_DEFAULTS);
  assert.deepEqual(parseChannelCreateOptions({}), SETTINGS_DEFAULTS);
});

test('parseChannelCreateOptions: reads the channel-stored full option set', () => {
  const out = parseChannelCreateOptions({
    aspect_ratio: '16:9',
    fps: 24,
    target_length: 45,
    captions_on: false,
    caption_emphasis_density: 'liberal',
    music_on: true,
  });
  assert.deepEqual(out, {
    aspect_ratio: '16:9',
    fps: 24,
    target_length: 45,
    captions_on: false,
    caption_emphasis_density: 'liberal',
    music_on: true,
  });
});

test('parseChannelCreateOptions: invalid single key falls back to its default', () => {
  const out = parseChannelCreateOptions({ aspect_ratio: '4:3', fps: 60, target_length: 0 });
  assert.equal(out.aspect_ratio, SETTINGS_DEFAULTS.aspect_ratio);
  assert.equal(out.fps, SETTINGS_DEFAULTS.fps);
  assert.equal(out.target_length, SETTINGS_DEFAULTS.target_length);
});

test('mergeCreateSettings: valid override wins per key', () => {
  const base = { ...SETTINGS_DEFAULTS };
  const out = mergeCreateSettings(base, {
    aspect_ratio: '1:1',
    fps: 24,
    target_length: 60,
    captions_on: false,
    caption_emphasis_density: 'off',
    music_on: true,
  });
  assert.deepEqual(out, {
    aspect_ratio: '1:1',
    fps: 24,
    target_length: 60,
    captions_on: false,
    caption_emphasis_density: 'off',
    music_on: true,
  });
});

test('mergeCreateSettings: empty/invalid override → base unchanged', () => {
  const base = { ...SETTINGS_DEFAULTS, aspect_ratio: '16:9' as const, music_on: true };
  assert.deepEqual(mergeCreateSettings(base, {}), base);
  assert.deepEqual(mergeCreateSettings(base, null), base);
  assert.deepEqual(mergeCreateSettings(base, { aspect_ratio: '4:3', fps: 99 }), base);
});

test('mergeCreateSettings: out-of-bounds / non-integer target_length → base', () => {
  const base = { ...SETTINGS_DEFAULTS, target_length: 30 };
  assert.equal(mergeCreateSettings(base, { target_length: 4 }).target_length, 30);
  assert.equal(mergeCreateSettings(base, { target_length: 181 }).target_length, 30);
  assert.equal(mergeCreateSettings(base, { target_length: 12.5 }).target_length, 30);
  assert.equal(mergeCreateSettings(base, { target_length: 90 }).target_length, 90);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/videos/create-settings.test.ts`
Expected: FAIL — cannot resolve `./create-settings.ts` (module not found).

- [ ] **Step 3: Write the implementation**

Create `src/lib/videos/create-settings.ts`:

```ts
// Pure helpers for the video creation seed (Phase 8 — navigation/creation overhaul).
// No react/server/network. The channel ALREADY stores the full option set in
// channels.defaults (format keys via the video-defaults editor; captions/density/
// music via the brand editor), under the same snake_case keys videos.settings uses —
// so parseVideoSettings reads them directly. We add a documented read for prefill and
// a per-video override merge for creation. Unit-tested.
import {
  parseVideoSettings,
  sanitizeSettingsPatch,
  type VideoSettings,
} from './settings';
import { MIN_TARGET_LENGTH, MAX_TARGET_LENGTH } from './regenerate';

// The six creation options == the stored videos.settings shape.
export type CreateOptions = VideoSettings;

// Read the full option set from channels.defaults, backfilling SETTINGS_DEFAULTS per
// missing/invalid key. channels.defaults uses the identical snake_case keys, so this
// reuses parseVideoSettings (DRY).
export function parseChannelCreateOptions(defaults: unknown): CreateOptions {
  return parseVideoSettings(defaults);
}

// Overlay a loosely-typed per-video override onto a base, re-validating every key:
// the five non-length keys via sanitizeSettingsPatch, target_length via the bounds.
// Missing/invalid keys fall back to the base value. Returns the seed.
export function mergeCreateSettings(base: CreateOptions, override: unknown): CreateOptions {
  const patch = sanitizeSettingsPatch(override);
  const o = override && typeof override === 'object' ? (override as Record<string, unknown>) : {};
  const tl = o.target_length;
  const target_length =
    typeof tl === 'number' && Number.isInteger(tl) && tl >= MIN_TARGET_LENGTH && tl <= MAX_TARGET_LENGTH
      ? tl
      : base.target_length;
  return { ...base, ...patch, target_length };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/videos/create-settings.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/videos/create-settings.ts src/lib/videos/create-settings.test.ts
git commit -m "feat(videos): pure creation-seed helpers (parse channel defaults + per-video override merge)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Video status derivation (pure)

**Files:**
- Create: `src/lib/videos/status.ts`
- Test: `src/lib/videos/status.test.ts`

**Interfaces:**
- Consumes: nothing (self-contained).
- Produces:
  - `type VideoStatus = 'generating' | 'draft' | 'rendering' | 'ready' | 'script_failed' | 'render_failed'`.
  - `interface VideoStatusInputs { scriptJobStatus?: string | null; hasScenes: boolean; latestRenderStatus?: string | null }`.
  - `deriveVideoStatus(i: VideoStatusInputs): { status: VideoStatus; label: string }`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/videos/status.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveVideoStatus } from './status.ts';

test('ready: latest render complete', () => {
  assert.equal(deriveVideoStatus({ hasScenes: true, latestRenderStatus: 'complete' }).status, 'ready');
});

test('rendering: latest render in a live phase', () => {
  for (const s of ['queued', 'composing', 'resolving_assets', 'validating', 'rendering', 'encoding']) {
    assert.equal(deriveVideoStatus({ hasScenes: true, latestRenderStatus: s }).status, 'rendering');
  }
});

test('render_failed: latest render failed', () => {
  assert.equal(deriveVideoStatus({ hasScenes: true, latestRenderStatus: 'failed' }).status, 'render_failed');
});

test('script_failed: script job failed, no render', () => {
  assert.equal(deriveVideoStatus({ scriptJobStatus: 'failed', hasScenes: false }).status, 'script_failed');
});

test('generating: script job running, no scenes yet', () => {
  assert.equal(deriveVideoStatus({ scriptJobStatus: 'running', hasScenes: false }).status, 'generating');
  assert.equal(deriveVideoStatus({ scriptJobStatus: 'queued', hasScenes: false }).status, 'generating');
});

test('draft: scenes exist, no render', () => {
  assert.equal(deriveVideoStatus({ scriptJobStatus: 'complete', hasScenes: true }).status, 'draft');
});

test('render takes precedence over script job', () => {
  assert.equal(
    deriveVideoStatus({ scriptJobStatus: 'failed', hasScenes: true, latestRenderStatus: 'complete' }).status,
    'ready',
  );
});

test('fallback: nothing known → generating', () => {
  assert.equal(deriveVideoStatus({ hasScenes: false }).status, 'generating');
});

test('returns a human label', () => {
  assert.equal(deriveVideoStatus({ hasScenes: true, latestRenderStatus: 'complete' }).label, 'Ready');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/videos/status.test.ts`
Expected: FAIL — cannot resolve `./status.ts`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/videos/status.ts`:

```ts
// Pure derivation of a video's display status from its latest job/render rows
// (Phase 8 — navigation overhaul). No react/server/network. The string sets are
// copied verbatim from the render/job vocabulary (render-actions.ts in-flight phases;
// jobs.status = queued|running|complete|failed). Total: always returns a status.

export type VideoStatus =
  | 'generating'
  | 'draft'
  | 'rendering'
  | 'ready'
  | 'script_failed'
  | 'render_failed';

export interface VideoStatusInputs {
  scriptJobStatus?: string | null; // latest script_generation job status
  hasScenes: boolean;
  latestRenderStatus?: string | null; // latest render status, if any
}

const RENDER_IN_FLIGHT = ['queued', 'composing', 'resolving_assets', 'validating', 'rendering', 'encoding'];

const LABELS: Record<VideoStatus, string> = {
  generating: 'Generating script',
  draft: 'Draft',
  rendering: 'Rendering',
  ready: 'Ready',
  script_failed: 'Script failed',
  render_failed: 'Render failed',
};

export function deriveVideoStatus(i: VideoStatusInputs): { status: VideoStatus; label: string } {
  const render = i.latestRenderStatus ?? null;
  let status: VideoStatus;
  if (render === 'complete') status = 'ready';
  else if (render && RENDER_IN_FLIGHT.includes(render)) status = 'rendering';
  else if (render === 'failed') status = 'render_failed';
  else if (i.scriptJobStatus === 'failed') status = 'script_failed';
  else if ((i.scriptJobStatus === 'queued' || i.scriptJobStatus === 'running') && !i.hasScenes) status = 'generating';
  else if (i.hasScenes) status = 'draft';
  else status = 'generating';
  return { status, label: LABELS[status] };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/videos/status.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/videos/status.ts src/lib/videos/status.test.ts
git commit -m "feat(videos): pure deriveVideoStatus from latest job/render rows

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Rework `startScriptGeneration` to accept settings

**Files:**
- Modify: `src/app/(app)/videos/actions.ts`

**Interfaces:**
- Consumes: `parseChannelCreateOptions`, `mergeCreateSettings` from `@/lib/videos/create-settings` (Task 1).
- Produces: `startScriptGeneration(prompt: string, channelId: string, settings?: unknown): Promise<{ videoId: string; jobId: string }>` — third arg optional; seed = channel defaults overlaid with the override.

This is a server action (no unit test; its pure logic is covered by Task 1). Verification is `tsc` + `lint` + `build`.

- [ ] **Step 1: Replace the imports and the seed block**

In `src/app/(app)/videos/actions.ts`, change the imports at the top — remove the `parseVideoDefaults` import and the `DEFAULT_VIDEO_CONFIG` usage for the seed; keep the `VideoConfig`/`BrandContext` types; add the Task 1 helpers:

```ts
'use server';

import { createClient } from '@/lib/supabase/server';
import { inngest } from '@/lib/inngest/client';
import type { VideoConfig, BrandContext } from '@/lib/ai/script-generation';
import { parseChannelCreateOptions, mergeCreateSettings } from '@/lib/videos/create-settings';
```

Change the function signature to add the optional third arg:

```ts
export async function startScriptGeneration(
  prompt: string,
  channelId: string,
  settings?: unknown,
): Promise<{ videoId: string; jobId: string }> {
```

Replace the existing seed block (the `const fmt = parseVideoDefaults(channel.defaults);` … `const seedSettings = { … }` section) with:

```ts
  // Seed = the channel's full stored defaults (format keys + captions/density/music)
  // overlaid with this video's per-key overrides. Reading the channel defaults fixes
  // the prior bug where captions/music were hardcoded and density was omitted.
  const base = parseChannelCreateOptions(channel.defaults);
  const seed = mergeCreateSettings(base, settings);
  const seedSettings = {
    aspect_ratio: seed.aspect_ratio,
    target_length: seed.target_length,
    fps: seed.fps,
    captions_on: seed.captions_on,
    caption_emphasis_density: seed.caption_emphasis_density,
    music_on: seed.music_on,
  };
```

Replace the `const config: VideoConfig = { … }` block with:

```ts
  const config: VideoConfig = {
    aspectRatio: seed.aspect_ratio,
    targetLengthSeconds: seed.target_length,
    fps: seed.fps,
    captions: seed.captions_on,
    music: seed.music_on,
  };
```

(The `videos` insert keeps `settings: seedSettings`; everything else — account/channel resolution, job insert, `inngest.send`, return — is unchanged.)

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. (If `parseVideoDefaults`/`DEFAULT_VIDEO_CONFIG` are reported as unused elsewhere, they were only used here — confirm the imports were removed.)

- [ ] **Step 3: Run the full unit suite (no regressions)**

Run: `npm test`
Expected: PASS — including the new Task 1/2 suites.

- [ ] **Step 4: Commit**

```bash
git add src/app/(app)/videos/actions.ts
git commit -m "feat(videos): startScriptGeneration takes optional per-video settings; seed reads full channel defaults

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: New Video setup screen (`/videos/new`)

**Files:**
- Create: `src/app/(app)/videos/new/page.tsx`
- Create: `src/app/(app)/videos/new/NewVideoForm.tsx`

**Interfaces:**
- Consumes: `parseChannelCreateOptions`, `CreateOptions` from `@/lib/videos/create-settings` (Task 1); `startScriptGeneration` from `../actions` (Task 3).
- Produces: the route `GET /videos/new?channel=<id>`.

No unit test (route + client form). Verification: `tsc` + `lint` + `build`, then manual.

- [ ] **Step 1: Create the server page**

Create `src/app/(app)/videos/new/page.tsx`:

```tsx
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { parseChannelCreateOptions } from '@/lib/videos/create-settings';
import { NewVideoForm } from './NewVideoForm';

// Channel-scoped New Video setup screen. The channel is fixed by ?channel=; a
// missing/unknown/not-owned id (RLS miss) redirects Home. Options prefill from the
// channel's full stored defaults; every option is overridable per video before
// generation.
export default async function NewVideoPage({
  searchParams,
}: {
  searchParams: Promise<{ channel?: string }>;
}) {
  const { channel: channelId } = await searchParams;
  if (!channelId) redirect('/');

  const supabase = await createClient();
  const { data: channel } = await supabase
    .from('channels')
    .select('id, name, defaults')
    .eq('id', channelId)
    .maybeSingle();
  if (!channel) redirect('/');

  const initial = parseChannelCreateOptions(channel.defaults);

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">New video</h1>
        <p className="text-sm opacity-70">{channel.name as string}</p>
      </div>
      <NewVideoForm channelId={channel.id as string} initial={initial} />
    </div>
  );
}
```

- [ ] **Step 2: Create the client form**

Create `src/app/(app)/videos/new/NewVideoForm.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { startScriptGeneration } from '../actions';
import type { CreateOptions } from '@/lib/videos/create-settings';

// Prompt + all options, prefilled from the channel defaults and overridable. One
// Generate button → startScriptGeneration(prompt, channelId, opts) → open the editor.
export function NewVideoForm({
  channelId,
  initial,
}: {
  channelId: string;
  initial: CreateOptions;
}) {
  const [prompt, setPrompt] = useState('');
  const [opts, setOpts] = useState<CreateOptions>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  function patch(p: Partial<CreateOptions>) {
    setOpts((o) => ({ ...o, ...p }));
  }

  async function onGenerate() {
    setBusy(true);
    setError(null);
    try {
      const { videoId } = await startScriptGeneration(prompt, channelId, opts);
      router.push(`/videos/${videoId}`); // leaves this page; keep busy=true
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  const field = 'block w-full rounded border border-black/15 bg-transparent px-2 py-1.5 text-sm dark:border-white/15';

  return (
    <div className="space-y-4">
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        disabled={busy}
        rows={3}
        placeholder={'Describe the video you want — e.g. “Why your coffee goes cold so fast”'}
        className="w-full resize-y rounded-md border border-black/15 bg-transparent p-3 text-sm outline-none focus:border-black/40 disabled:opacity-50 dark:border-white/15 dark:focus:border-white/40"
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <label className="space-y-1">
          <span className="text-sm font-medium">Aspect ratio</span>
          <select
            value={opts.aspect_ratio}
            onChange={(e) => patch({ aspect_ratio: e.target.value as CreateOptions['aspect_ratio'] })}
            disabled={busy}
            className={field}
          >
            <option value="9:16">9:16</option>
            <option value="1:1">1:1</option>
            <option value="16:9">16:9</option>
          </select>
        </label>

        <label className="space-y-1">
          <span className="text-sm font-medium">Frame rate</span>
          <select
            value={opts.fps}
            onChange={(e) => patch({ fps: Number(e.target.value) as CreateOptions['fps'] })}
            disabled={busy}
            className={field}
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
            value={opts.target_length}
            onChange={(e) => patch({ target_length: Number(e.target.value) })}
            disabled={busy}
            className={field}
          />
        </label>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={opts.captions_on}
            onChange={(e) => patch({ captions_on: e.target.checked })}
            disabled={busy}
          />
          <span className="font-medium">Captions</span>
        </label>

        <label className="space-y-1">
          <span className="text-sm font-medium">Caption density</span>
          <select
            value={opts.caption_emphasis_density}
            onChange={(e) =>
              patch({ caption_emphasis_density: e.target.value as CreateOptions['caption_emphasis_density'] })
            }
            disabled={busy || !opts.captions_on}
            className={field}
          >
            <option value="off">off</option>
            <option value="sparing">sparing</option>
            <option value="liberal">liberal</option>
          </select>
        </label>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={opts.music_on}
            onChange={(e) => patch({ music_on: e.target.checked })}
            disabled={busy}
          />
          <span className="font-medium">Music</span>
        </label>
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={onGenerate}
          disabled={busy || !prompt.trim()}
          className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background disabled:opacity-50"
        >
          {busy ? 'Generating…' : 'Generate script'}
        </button>
        {busy && <span className="text-sm opacity-60">Creating your video…</span>}
      </div>
      {error && (
        <pre className="overflow-auto rounded-md border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-600">
          {error}
        </pre>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Typecheck + lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/videos/new/page.tsx" "src/app/(app)/videos/new/NewVideoForm.tsx"
git commit -m "feat(videos): channel-scoped New Video setup screen (prompt + all options before generation)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Channel page — tabs + Videos list

**Files:**
- Create: `src/app/(app)/channels/[id]/ChannelTabs.tsx`
- Modify: `src/app/(app)/channels/[id]/page.tsx`

**Interfaces:**
- Consumes: `deriveVideoStatus` from `@/lib/videos/status` (Task 2).
- Produces: the tabbed channel page (`?tab=videos` default | `?tab=settings`) with a Videos list and a "New video" button (the sole creation entry point).

No unit test (route). Verification: `tsc` + `lint` + `build`, then manual.

- [ ] **Step 1: Create the tab strip**

Create `src/app/(app)/channels/[id]/ChannelTabs.tsx`:

```tsx
import Link from 'next/link';

// Presentational Videos|Settings tab strip. Server <Link>s drive the ?tab= query so
// the initial paint needs no client router. 'videos' is the default (no query).
export function ChannelTabs({
  channelId,
  active,
}: {
  channelId: string;
  active: 'videos' | 'settings';
}) {
  const base = `/channels/${channelId}`;
  const cls = (on: boolean) =>
    on
      ? 'border-b-2 border-foreground pb-2 text-sm font-medium'
      : 'border-b-2 border-transparent pb-2 text-sm opacity-60 hover:opacity-100';
  return (
    <div className="flex gap-6 border-b border-black/10 dark:border-white/10">
      <Link href={base} className={cls(active === 'videos')}>
        Videos
      </Link>
      <Link href={`${base}?tab=settings`} className={cls(active === 'settings')}>
        Settings
      </Link>
    </div>
  );
}
```

- [ ] **Step 2: Rewrite the channel page as tabbed**

Replace the entire contents of `src/app/(app)/channels/[id]/page.tsx` with:

```tsx
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { parseChannelBrand } from '@/lib/channels/brand';
import { parseCaptionEmphasis, defaultToneColors } from '@/lib/channels/caption-emphasis';
import { parseVoiceTts } from '@/lib/channels/voice';
import { VoiceEditor } from './VoiceEditor';
import { parseVideoDefaults } from '@/lib/channels/video-defaults';
import { VideoDefaultsEditor } from './VideoDefaultsEditor';
import { bakeTheme } from '@/lib/composition/theme';
import { BrandEditor } from './BrandEditor';
import { CaptionEmphasisEditor } from './CaptionEmphasisEditor';
import { signedGetUrl } from '@/lib/r2';
import { sanitizeLogos, type LogoSlot } from '@/lib/channels/logos';
import { LogosEditor } from './LogosEditor';
import { ResourcesEditor, type ResourceItem } from './ResourcesEditor';
import { ChannelTabs } from './ChannelTabs';
import { deriveVideoStatus } from '@/lib/videos/status';

// Tabbed channel page. Videos (default) lists this channel's videos with a derived
// status + the sole "New video" entry; Settings holds the six brand/format editors.
// RLS scopes every read; a miss (not found OR not owned) → 404.
export default async function ChannelDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { id } = await params;
  const { tab } = await searchParams;
  const active: 'videos' | 'settings' = tab === 'settings' ? 'settings' : 'videos';

  const supabase = await createClient();
  const { data: channel } = await supabase
    .from('channels')
    .select('id, name, brand_kit, brand_voice, defaults, voice_tts')
    .eq('id', id)
    .maybeSingle();

  if (!channel) notFound();

  return (
    <div className="space-y-8">
      <Link href="/" className="text-sm underline opacity-70 hover:opacity-100">
        ← Home
      </Link>
      <div>
        <h1 className="text-2xl font-semibold">{channel.name as string}</h1>
        <p className="text-sm opacity-70">
          Brand identity — colours, font, motion, voice, and video defaults.
        </p>
      </div>

      <ChannelTabs channelId={channel.id as string} active={active} />

      {active === 'videos' ? (
        <VideosTab channelId={channel.id as string} supabase={supabase} />
      ) : (
        <SettingsTab channel={channel} />
      )}
    </div>
  );
}

// --- Videos tab -------------------------------------------------------------

async function VideosTab({
  channelId,
  supabase,
}: {
  channelId: string;
  supabase: Awaited<ReturnType<typeof createClient>>;
}) {
  const { data: videoRows } = await supabase
    .from('videos')
    .select('id, title, created_at')
    .eq('channel_id', channelId)
    .order('created_at', { ascending: false });
  const videos = videoRows ?? [];
  const ids = videos.map((v) => v.id as string);

  // Latest script_generation job + latest render + scene presence per video (rows are
  // ordered desc; first seen per video_id is the latest). All RLS-scoped.
  const latestJob = new Map<string, string>();
  const latestRender = new Map<string, string>();
  const hasScenes = new Set<string>();
  if (ids.length) {
    const { data: jobRows } = await supabase
      .from('jobs')
      .select('video_id, status, created_at')
      .in('video_id', ids)
      .eq('type', 'script_generation')
      .order('created_at', { ascending: false });
    for (const j of jobRows ?? []) {
      const v = j.video_id as string;
      if (!latestJob.has(v)) latestJob.set(v, j.status as string);
    }
    const { data: renderRows } = await supabase
      .from('renders')
      .select('video_id, status, created_at')
      .in('video_id', ids)
      .order('created_at', { ascending: false });
    for (const r of renderRows ?? []) {
      const v = r.video_id as string;
      if (!latestRender.has(v)) latestRender.set(v, r.status as string);
    }
    const { data: sceneRows } = await supabase
      .from('scenes')
      .select('video_id')
      .in('video_id', ids);
    for (const s of sceneRows ?? []) hasScenes.add(s.video_id as string);
  }

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Videos</h2>
        <Link
          href={`/videos/new?channel=${channelId}`}
          className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background"
        >
          + New video
        </Link>
      </div>

      {videos.length === 0 ? (
        <p className="text-sm opacity-70">No videos yet — create your first.</p>
      ) : (
        <ul className="divide-y divide-black/10 rounded-lg border border-black/10 dark:divide-white/10 dark:border-white/10">
          {videos.map((v) => {
            const vid = v.id as string;
            const { label } = deriveVideoStatus({
              scriptJobStatus: latestJob.get(vid) ?? null,
              hasScenes: hasScenes.has(vid),
              latestRenderStatus: latestRender.get(vid) ?? null,
            });
            const created = new Date(v.created_at as string).toLocaleDateString();
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
          })}
        </ul>
      )}
    </section>
  );
}

// --- Settings tab (the existing six editors, unchanged) ---------------------

async function SettingsTab({
  channel,
}: {
  channel: { id: string; name: string; brand_kit: unknown; brand_voice: unknown; defaults: unknown; voice_tts: unknown };
}) {
  const id = channel.id as string;
  const supabase = await createClient();

  const initial = parseChannelBrand({
    name: channel.name as string,
    brand_kit: channel.brand_kit,
    brand_voice: channel.brand_voice,
    defaults: channel.defaults,
  });

  const theme = bakeTheme(channel.brand_kit as never);
  const emphasisInitial = parseCaptionEmphasis(channel.brand_kit, theme);

  const logos = sanitizeLogos((channel.brand_kit as { logos?: unknown } | null)?.logos);
  const logoPreviewUrls: Partial<Record<LogoSlot, string>> = {};
  for (const [slot, key] of Object.entries(logos)) {
    logoPreviewUrls[slot as LogoSlot] = await signedGetUrl(key, 60 * 60);
  }

  const voiceInitial = parseVoiceTts(channel.voice_tts);
  const videoDefaultsInitial = parseVideoDefaults(channel.defaults);

  const { data: resourceRows } = await supabase
    .from('channel_resources')
    .select('id, kind, r2_key, original_filename, description, tags, created_at')
    .eq('channel_id', id)
    .order('created_at', { ascending: false });
  const resources: ResourceItem[] = await Promise.all(
    (resourceRows ?? []).map(async (r) => ({
      id: r.id as string,
      kind: (r.kind as string) === 'video' ? ('video' as const) : ('image' as const),
      description: (r.description as string | null) ?? '',
      tags: (r.tags as string[] | null) ?? [],
      filename: (r.original_filename as string | null) ?? '',
      previewUrl: r.r2_key ? await signedGetUrl(r.r2_key as string, 60 * 60) : null,
    })),
  );

  return (
    <div className="space-y-8">
      <BrandEditor channelId={id} initial={initial} />
      <hr className="border-black/10 dark:border-white/10" />
      <CaptionEmphasisEditor
        channelId={id}
        initial={emphasisInitial}
        fonts={theme.fonts}
        followColors={defaultToneColors(theme)}
      />
      <hr className="border-black/10 dark:border-white/10" />
      <LogosEditor channelId={id} initial={logos} initialPreviewUrls={logoPreviewUrls} />
      <hr className="border-black/10 dark:border-white/10" />
      <ResourcesEditor channelId={id} initial={resources} />
      <hr className="border-black/10 dark:border-white/10" />
      <VoiceEditor channelId={id} initial={voiceInitial} />
      <hr className="border-black/10 dark:border-white/10" />
      <VideoDefaultsEditor channelId={id} initial={videoDefaultsInitial} />
    </div>
  );
}
```

Note: the `SettingsTab` body is the verbatim editor set + data loading from today's page — only relocated into the `tab==='settings'` branch so the Videos tab stays cheap (no signed-URL work). The six editors and their parsers are unchanged.

- [ ] **Step 3: Typecheck + lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors. (If the `SupabaseClient` type for the `supabase` prop is awkward, the `Awaited<ReturnType<typeof createClient>>` alias used above resolves it without a new import.)

- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/channels/[id]/ChannelTabs.tsx" "src/app/(app)/channels/[id]/page.tsx"
git commit -m "feat(channels): tabbed channel page — Videos (default, with status) | Settings; New video entry

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Home page, nav, and redirects

**Files:**
- Create: `src/app/(app)/page.tsx`
- Modify: `src/app/(app)/layout.tsx`
- Modify: `src/app/(app)/dashboard/page.tsx`
- Modify: `src/app/(app)/channels/page.tsx`
- Delete: `src/app/(app)/dashboard/PromptBox.tsx`

**Interfaces:**
- Consumes: `NewChannelForm` from `./channels/NewChannelForm` (unchanged; it routes to `/channels/<id>` on create, which now lands on the Videos tab).
- Produces: Home at `/`; `/dashboard` and `/channels` redirect to `/`.

No unit test (routes). Verification: `tsc` + `lint` + `build`, then manual.

- [ ] **Step 1: Create Home**

Create `src/app/(app)/page.tsx`:

```tsx
import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { NewChannelForm } from './channels/NewChannelForm';

// Home = the channels surface. Channel cards (each → its Videos tab) + inline create.
// Video creation starts from inside a channel (its Videos tab), not here.
export default async function HomePage() {
  const supabase = await createClient();
  const { data: channels } = await supabase
    .from('channels')
    .select('id, name')
    .order('created_at', { ascending: false })
    .order('id', { ascending: false });
  const list = channels ?? [];

  const ids = list.map((c) => c.id as string);
  const counts = new Map<string, number>();
  if (ids.length) {
    const { data: vids } = await supabase.from('videos').select('channel_id').in('channel_id', ids);
    for (const v of vids ?? []) {
      const c = v.channel_id as string;
      counts.set(c, (counts.get(c) ?? 0) + 1);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Channels</h1>
        <p className="text-sm opacity-70">
          Each channel carries its own brand. Open one to see its videos.
        </p>
      </div>

      <section className="rounded-lg border border-black/10 p-4 dark:border-white/10">
        <NewChannelForm />
      </section>

      {list.length === 0 ? (
        <p className="text-sm opacity-70">No channels yet. Create your first one above.</p>
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {list.map((c) => {
            const n = counts.get(c.id as string) ?? 0;
            return (
              <li key={c.id as string}>
                <Link
                  href={`/channels/${c.id}`}
                  className="block rounded-lg border border-black/10 p-4 hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/5"
                >
                  <div className="font-medium">{c.name as string}</div>
                  <div className="text-sm opacity-60">
                    {n} video{n === 1 ? '' : 's'}
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Update the nav shell**

In `src/app/(app)/layout.tsx`, replace the `<nav>` block (the logo + the four links) with logo → `/` and the reordered link set (no "Channels"):

```tsx
        <nav className="flex items-center gap-4">
          <Link href="/" className="font-semibold">
            Reelscript
          </Link>
          <Link href="/" className="text-sm opacity-70 hover:opacity-100">
            Home
          </Link>
          <Link href="/costs" className="text-sm opacity-70 hover:opacity-100">
            Costs
          </Link>
          <Link href="/settings" className="text-sm opacity-70 hover:opacity-100">
            Settings
          </Link>
          <Link href="/primitives" className="text-sm opacity-70 hover:opacity-100">
            Primitives
          </Link>
        </nav>
```

- [ ] **Step 3: Redirect the old dashboard and delete PromptBox**

Replace the entire contents of `src/app/(app)/dashboard/page.tsx` with:

```tsx
import { redirect } from 'next/navigation';

// The dashboard is superseded by Home (/). Keep the route as a redirect so old
// links/bookmarks (and the prior logo target) still resolve.
export default function DashboardPage() {
  redirect('/');
}
```

Delete the file `src/app/(app)/dashboard/PromptBox.tsx` (superseded by the setup screen):

```bash
git rm "src/app/(app)/dashboard/PromptBox.tsx"
```

- [ ] **Step 4: Redirect the old channels list**

Replace the entire contents of `src/app/(app)/channels/page.tsx` with:

```tsx
import { redirect } from 'next/navigation';

// The channel list now lives on Home (/). Redirect so old links resolve.
export default function ChannelsPage() {
  redirect('/');
}
```

(`NewChannelForm.tsx` and `actions.ts` in this folder stay — Home and the form import them.)

- [ ] **Step 5: Typecheck, lint, build**

Run: `npx tsc --noEmit && npm run lint && npm run build`
Expected: all succeed. `build` confirms the new routes, the redirects, and that nothing still imports the deleted `PromptBox`.

- [ ] **Step 6: Run the full unit suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add "src/app/(app)/page.tsx" "src/app/(app)/layout.tsx" "src/app/(app)/dashboard/page.tsx" "src/app/(app)/channels/page.tsx"
git commit -m "feat(nav): Home as channels surface; drop Channels nav link; redirect /dashboard + /channels; remove PromptBox

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage:**
- Nav shell (drop Channels, add Home, logo→/) → Task 6. ✓
- Home as channels surface (cards + New channel, no New video) → Task 6. ✓
- Tabbed channel page (Videos default | Settings) → Task 5. ✓
- Videos list with derived status + sole New video button → Task 5 (status: Task 2). ✓
- Derived status helper → Task 2. ✓
- New Video setup screen (channel-scoped, redirect on bad channel, all options) → Task 4. ✓
- Full channel-defaults read + per-video override merge → Task 1. ✓
- Reworked `startScriptGeneration` (optional settings, reads channel defaults) → Task 3. ✓
- Redirects `/dashboard`, `/channels` → Task 6. ✓
- No editor/Brand change, no migration → honored across all tasks. ✓
- Cost column: spec marked it optional/secondary; intentionally omitted to keep the Videos query lean (no `cost_events` read). Noted here as a deliberate scope trim, not a gap.

**2. Placeholder scan:** No TBD/TODO/"handle errors"/"similar to". Every code step shows complete code. ✓

**3. Type consistency:** `CreateOptions` (Task 1) = `VideoSettings` (six snake_case keys) is consumed unchanged by Tasks 3 and 4. `VideoStatusInputs` (Task 2) field names (`scriptJobStatus`/`hasScenes`/`latestRenderStatus`) match the call site in Task 5. `startScriptGeneration(prompt, channelId, settings?)` signature (Task 3) matches the Task 4 call. Render in-flight / job-status strings match the Global Constraints (verbatim from `render-actions.ts`). ✓
