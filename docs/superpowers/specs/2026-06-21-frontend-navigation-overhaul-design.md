# Frontend navigation & creation-flow overhaul — design

**Date:** 2026-06-21
**Phase:** 8 (Full surfaces) — navigation & UX
**Status:** design approved, ready for implementation plan

## Context

The app's surfaces work but the navigation around them does not match how an
operator actually moves through the product. Two concrete pain points, plus a
general "tidy the workflow" ask:

1. **Videos are hard to reach from a channel.** `/channels/[id]` renders only
   the six channel-settings editors (Brand, Caption emphasis, Logos, Resources,
   Voice, Video defaults). There is **no list of the channel's videos** — the
   only place to find a video is `/costs`.
2. **Video options can only be set *after* generation.** Creating a video and
   starting script generation are a single step: `PromptBox` (on the Phase-0
   stub `/dashboard`) collects a channel + a prompt and immediately calls
   `startScriptGeneration(prompt, channelId)`, which snapshots the channel's
   format defaults and fires the `script/generate` event. Aspect ratio, fps,
   target length, captions, caption density, and music are only editable later,
   in the editor's `VideoSettingsPanel` ("applies on next render"). Because
   `target_length` (and the rest of the config) is passed *into* script
   generation, these options genuinely belong **before** it.
3. **The landing page is a debug stub.** `/dashboard` still shows Phase-0
   "Session" and "Account (RLS-scoped read)" panels and a "Go to the render
   spine →" link beside the prompt box.

This slice restructures navigation and the creation flow. It is a frontend/UX
overhaul: no DB migration, no render-pipeline change, no editor-internals
change beyond threading one new argument.

### Current state (verified)

- **Nav shell** (`src/app/(app)/layout.tsx`): top bar — logo→`/dashboard`,
  then `Primitives · Channels · Costs · Settings`, plus email + Sign out.
- **`/dashboard`** (`src/app/(app)/dashboard/page.tsx` + `PromptBox.tsx`):
  channel select + prompt + "Generate script" → `startScriptGeneration` →
  `router.push('/videos/<id>')`. Also renders debug Session/Account panels and
  a render-spine link.
- **`/channels`** (`src/app/(app)/channels/page.tsx`): channel list (RLS) +
  inline `NewChannelForm`; rows link to `/channels/[id]`.
- **`/channels/[id]`** (`src/app/(app)/channels/[id]/page.tsx`): six editors in
  a vertical scroll. No videos query.
- **Creation action** (`src/app/(app)/videos/actions.ts`):
  `startScriptGeneration(prompt, channelId)` — reads `channel.defaults` via
  `parseVideoDefaults`, seeds `videos.settings` as
  `{ aspect_ratio, target_length, fps, captions_on: DEFAULT_VIDEO_CONFIG.captions,
  music_on: DEFAULT_VIDEO_CONFIG.music }`, inserts the video + a
  `script_generation` job, sends `script/generate`.
- **Settings shapes**: `src/lib/videos/settings.ts`
  (`VideoSettings`, `sanitizeSettingsPatch`, `parseVideoSettings`,
  `SETTINGS_DEFAULTS`); `src/lib/channels/video-defaults.ts`
  (`VideoDefaultsForm`, `parseVideoDefaults`, `validateVideoDefaultsForm`,
  `VIDEO_DEFAULTS_FALLBACK`). `caption_emphasis_density` already lives in
  `channels.defaults` (written by the Brand editor); only `captions_on` and
  `music_on` are not yet channel-level.

## Goal

An operator navigates: **Home (channels) → a channel → its Videos tab →
"New video" → set every option → Generate → editor**, and can return to any
channel to see and reopen its videos. Settings move one tab away; the debug
stub is gone.

## Scope

**In scope:**

- A **Home** page (`/`) that is the channels surface (cards + "New channel").
- Top-nav restructure (drop "Channels"; add "Home"; reorder).
- A **tabbed channel page**: Videos (default) | Settings.
- A **Videos list** on the channel page with a derived per-video status and a
  "New video" button (the sole creation entry point).
- A **New Video setup screen** (`/videos/new?channel=<id>`) collecting prompt +
  all options before generation.
- Extending **channel video-defaults** to include `captions_on`,
  `caption_emphasis_density` (already present — surfaced here), `music_on`.
- Reworking `startScriptGeneration` to accept a validated settings object.
- Redirects: `/dashboard` → `/`, `/channels` → `/`.

**Out of scope (unchanged / deferred):**

- Thumbnails (separate deferred Phase-8 item; the list is text-based).
- Video editor internals (scenes, synthesis, render, Music panel, costs panel)
  beyond threading the new settings argument.
- Projects/versioning, show structures.
- Any DB migration (derived status + existing `channels.defaults` /
  `videos.settings` JSONB carry everything).
- The render pipeline and `script/generate` event payload shape (it already
  carries the full `VideoConfig`).

## Architecture

### 1. Navigation shell (`src/app/(app)/layout.tsx`)

- Logo → `/`.
- Links: **Home (`/`) · Costs (`/costs`) · Settings (`/settings`) ·
  Primitives (`/primitives`)**. "Channels" is removed (Home is the channels
  surface). Primitives moves to the end (authoring tool, not a daily surface).
- Email + Sign out unchanged.

### 2. Home (`/`) — the channels surface

New route `src/app/(app)/page.tsx` (server component):

- Reads the account's channels (RLS-scoped, `created_at desc, id desc` — same
  ordering as today's `/channels`).
- Renders the inline **"New channel"** form (reuse the existing
  `NewChannelForm` component, moved/imported from the channels route).
- Renders channel **cards**, each linking to `/channels/<id>` (its Videos tab).
  A card shows the channel name and a lightweight video count (a single grouped
  count query over `videos` by `channel_id`, RLS-scoped). Empty state: "No
  channels yet — create your first."
- **No "New video" button here** — video creation starts from inside a channel.

`/dashboard` and `/channels` become redirects to `/`
(`src/app/(app)/dashboard/page.tsx` and `src/app/(app)/channels/page.tsx`
each `redirect('/')`). The debug Session/Account panels, the render-spine link,
and `PromptBox` are removed. (`PromptBox.tsx` is deleted; its role is replaced
by the setup screen.) `NewChannelForm` is relocated so Home owns it; the old
`/channels/page.tsx` no longer references it.

### 3. Channel page — tabbed (`/channels/[id]`)

The page becomes tabbed via a server-readable `?tab=` query param (no client
router needed for the initial paint; the tab strip is `<Link>`s):

- `?tab` absent or `videos` → **Videos** tab (default).
- `?tab=settings` → **Settings** tab.

A small presentational tab strip (two `<Link>`s with an active style) sits under
the channel title. The page server-loads only the data the active tab needs.

**Videos tab:**

- Server query: the channel's videos (RLS-scoped, `created_at desc`) — `id,
  title, created_at, settings`.
- For status, additionally load, scoped to those video ids:
  - the latest `renders` row per video (`video_id, status, created_at`),
  - the latest `jobs` row of `type='script_generation'` per video
    (`video_id, status, created_at`),
  - whether any `scenes` exist per video (presence flag).
  These are reduced in code (group-by-video-id) to avoid N+1; exact query shape
  is an implementation detail for the plan.
- Optional secondary column: per-video estimated cost via
  `src/lib/costs/aggregate.ts` `sumByVideo` over RLS-scoped `cost_events`
  (reuse — already built for the cost ledger). Labeled "Estimated".
- Each row: **title · status badge · created date · (cost)** → links to
  `/videos/<id>`.
- **"+ New video"** button → `/videos/new?channel=<id>`.
- Empty state: "No videos yet — create your first."

**Settings tab:** the six existing editors, rendered verbatim (Brand, Caption
emphasis, Logos, Resources, Voice, Video defaults). The page only does the
logo/resource signed-URL + parse work when the Settings tab is active (it is
heavier), so the default Videos tab stays cheap.

### 4. Derived video status (`src/lib/videos/status.ts`, pure, unit-tested)

A pure helper turns the loaded relation rows into a small status enum + label:

```ts
export type VideoStatus =
  | 'generating'   // script_generation job queued/running, no scenes yet
  | 'draft'        // scenes exist, no render yet (or only failed render is older than scenes)
  | 'rendering'    // a render is in progress (queued..encoding)
  | 'ready'        // latest render complete
  | 'script_failed'
  | 'render_failed';

export interface VideoStatusInputs {
  scriptJobStatus?: string | null;   // latest script_generation job status
  hasScenes: boolean;
  latestRenderStatus?: string | null; // latest render status, if any
}

export function deriveVideoStatus(i: VideoStatusInputs): { status: VideoStatus; label: string };
```

Precedence (first match wins):
1. latest render complete → `ready`
2. latest render in a live phase (queued/composing/resolving_assets/validating/
   rendering/encoding) → `rendering`
3. latest render failed → `render_failed`
4. script job failed (and no render) → `script_failed`
5. script job queued/running and no scenes → `generating`
6. scenes exist → `draft`
7. otherwise → `generating`

The exact render-phase and job-status string sets are copied verbatim from the
existing render/job status vocabulary (see `render-actions.ts` /
`getRenderState` / `jobs.status`); the plan lists them.

### 5. New Video setup screen (`/videos/new`)

New route `src/app/(app)/videos/new/page.tsx` (server) + `NewVideoForm.tsx`
(client):

- The page reads `?channel=<id>`, resolves the channel (RLS). Missing/invalid →
  `redirect('/')`.
- It parses the channel's full defaults (Section 6) and passes them as the
  form's initial values.
- The channel is shown as a **read-only heading** ("New video · <channel
  name>") — no channel select; the channel is fixed by where the operator
  launched from.
- `NewVideoForm` fields, all prefilled, all editable:
  - **Prompt** (textarea, required).
  - **Aspect ratio** (9:16 / 1:1 / 16:9).
  - **Frame rate** (24 / 30).
  - **Target length** (number, `MIN_TARGET_LENGTH`–`MAX_TARGET_LENGTH` s).
  - **Captions** (on/off).
  - **Caption density** (off / sparing / liberal) — disabled when captions off.
  - **Music** (on/off).
- One **"Generate script"** button → calls the reworked `startScriptGeneration`
  → `router.push('/videos/<id>')` (same redirect-on-success pattern as today's
  `PromptBox`). Error surfaced inline.

### 6. Channel video-defaults extension (`src/lib/channels/video-defaults.ts`)

Extend the form to the full option set. `caption_emphasis_density` already
exists in `channels.defaults` (Brand editor writes it); it is **surfaced** in
this editor reading the same key — no second storage location. `captions_on`
and `music_on` are new keys in `channels.defaults`.

```ts
export interface VideoDefaultsForm {
  aspectRatio: AspectRatio;
  fps: Fps;
  targetLength: number;
  captionsOn: boolean;
  captionEmphasisDensity: CaptionEmphasisDensity;
  musicOn: boolean;
}
```

- `VIDEO_DEFAULTS_FALLBACK` extends with `captionsOn: true`,
  `captionEmphasisDensity: 'sparing'`, `musicOn: false` (mirrors
  `SETTINGS_DEFAULTS` / `DEFAULT_VIDEO_CONFIG`).
- `parseVideoDefaults` backfills the three new fields per key
  (`captions_on`, `caption_emphasis_density`, `music_on`), reusing the density
  validity check from `settings.ts`.
- `validateVideoDefaultsForm` validates and returns the snake_case object to
  merge into `channels.defaults`, now including the three new keys.
- `VideoDefaultsEditor.tsx` gains the three controls (captions checkbox +
  density select disabled when off + music checkbox), same dirty-tracked single
  Save. The Brand editor's existing `caption_emphasis_density` control is left
  as-is (same stored key); both read/write the one key. (A note in the plan
  flags the shared key so the two editors don't diverge.)

### 7. Reworked creation action (`src/app/(app)/videos/actions.ts`)

```ts
export async function startScriptGeneration(
  prompt: string,
  channelId: string,
  settings?: VideoSettingsInput, // new, optional → back-compatible
): Promise<{ videoId: string; jobId: string }>;
```

`VideoSettingsInput` is the six option fields the setup form submits —
`aspect_ratio`, `fps`, `target_length`, `captions_on`,
`caption_emphasis_density`, `music_on` — typed loosely (`unknown`-tolerant) and
**fully re-validated server-side** (never trusted): the five non-length keys via
`sanitizeSettingsPatch`, `target_length` via the `MIN/MAX_TARGET_LENGTH` bounds.

- Resolve the channel and parse its full defaults as the **fallback/base**.
- Build the seed by overlaying the (sanitized) `settings` arg on the channel
  defaults: aspect/fps/captions/density/music via `sanitizeSettingsPatch`
  (extended is unnecessary — it already covers all five non-length keys),
  `target_length` validated against `MIN/MAX_TARGET_LENGTH` and otherwise
  falling back to the channel default. Never client-trusted: anything invalid
  falls back to the channel default for that key.
- The rest is unchanged: insert video with `settings`, insert
  `script_generation` job, build `VideoConfig` from the seed, send
  `script/generate`.
- Called with two args (no `settings`) it is **byte-identical to today** (uses
  channel defaults wholesale), so nothing else that might call it breaks.

## Data flow

```
/ (Home)  → channels cards → /channels/<id>?tab=videos (default)
           → New channel (inline) → channel created
/channels/<id> [Videos]  → list videos (status derived) → /videos/<id>
                         → "New video" → /videos/new?channel=<id>
/channels/<id>?tab=settings → six editors (Video defaults now full set)
/videos/new?channel=<id>  → prefill from channel defaults
   → set prompt + options → Generate
   → startScriptGeneration(prompt, channelId, settings)
       seed = channelDefaults ⊕ sanitized(settings)
       insert video(settings=seed) + job + send script/generate
   → /videos/<id>  (existing editor; VideoSettingsPanel still does post-gen tweaks)
```

## Error handling

- `/videos/new` with missing/unknown/not-owned `?channel=` → `redirect('/')`.
- `startScriptGeneration`: empty prompt → "Enter a prompt."; bad/absent channel
  → "Pick a channel…" (today's messages preserved); any invalid setting →
  silent per-key fallback to the channel default (no crash, no rejection).
- Channel Videos tab with no videos / Home with no channels → friendly empty
  states.
- Status derivation is total (always returns a status; unknown inputs →
  `generating`/`draft` per precedence), so a missing job/render row never throws.
- `/dashboard` and `/channels` always redirect; no orphaned UI.

## Back-compatibility

- Additive + relocation. `startScriptGeneration`'s third arg is optional; the
  two-arg call is unchanged behavior.
- No schema change. `channels.defaults` gains two optional keys; channels
  without them parse to the fallback (captions on, music off) — identical to
  today's hardcoded seed.
- `videos.settings` shape is unchanged (the setup screen writes the same five
  keys + `target_length` the editor already reads).
- Old `/dashboard` / `/channels` URLs keep working via redirect.

## Testing

- **Unit (node:test):**
  - `src/lib/channels/video-defaults.test.ts` (extend): parse backfills the
    three new keys; validate accepts/rejects them; fallback values.
  - `src/lib/videos/status.test.ts` (new): each precedence branch of
    `deriveVideoStatus`.
  - `src/lib/videos/settings` or an action-level pure helper: the
    `channelDefaults ⊕ sanitized(settings)` merge clamps/falls back per key
    (extract the merge into a pure, tested helper so the action stays thin).
- **Regression:** `npm test` green; `npx tsc --noEmit` + `npm run lint` clean;
  `npm run build` succeeds (new routes, redirects, deleted `PromptBox`).
- **Manual / app-run e2e:** Home shows channels → open a channel → Videos tab
  lists videos with correct status → "New video" → options prefilled from
  channel defaults → change them → Generate → land in editor with those
  settings applied → return to the channel and see the new video listed →
  Settings tab still saves all six editors, with the extended Video defaults
  persisting captions/density/music.

## Open questions

None. The four structural decisions are settled: New Video setup screen
(channel-scoped, sole creation entry from the Videos tab), tabbed channel page
(Videos default | Settings), Home as the channels surface (no "New video" on
Home, no "Channels" nav link), and channel video-defaults extended to the full
option set.
