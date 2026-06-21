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
  `VIDEO_DEFAULTS_FALLBACK` — the three **format** keys only).
  **All three** of `captions_on`, `caption_emphasis_density`, `music_on`
  already live in `channels.defaults`, written by the **Brand editor**
  (`src/lib/channels/brand.ts` — `BrandForm` carries `captionsOn`/`density`/
  `musicOn`; `validateBrandForm` writes them into `defaults`). They are NOT
  missing as channel defaults. The real gap: `startScriptGeneration` ignores
  them — it hardcodes `captions_on`/`music_on` and omits
  `caption_emphasis_density` entirely.

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
- Reading the **full** channel defaults (format + captions/density/music) at
  video creation, with per-video **overrides** on the setup screen. **No new
  editor controls** — captions/density/music are already channel defaults owned
  by the Brand editor; duplicating them is explicitly rejected.
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
- It parses the channel's full defaults (Section 6 helper) and passes them as
  the form's initial values.
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

### 6. Full channel-defaults read + per-video override (`src/lib/videos/create-settings.ts`, pure, unit-tested)

The channel **already** stores the full option set in `channels.defaults`
(format keys via the Video-defaults editor; captions/density/music via the
Brand editor). This slice does **not** add or move any editor control — it adds
a single pure module that (a) reads the full set for prefill, and (b) merges
per-video overrides over it at creation. No `VideoDefaultsEditor`/Brand-editor
change; no migration.

```ts
import type {
  VideoSettings, CaptionEmphasisDensity, AspectRatio, Fps,
} from './settings';

// The six creation options, snake_case to match videos.settings storage.
export type CreateOptions = Omit<VideoSettings, never>; // = the 6 VideoSettings keys

// Read the full option set from channels.defaults, backfilling SETTINGS_DEFAULTS
// per key. Reuses parseVideoDefaults for aspect/fps/target_length and the same
// density/boolean validity checks for captions_on/caption_emphasis_density/music_on.
export function parseChannelCreateOptions(defaults: unknown): CreateOptions;

// Overlay a (loosely typed) per-video override onto a base CreateOptions,
// re-validating every key server-side: the five non-length keys via
// sanitizeSettingsPatch, target_length via MIN/MAX_TARGET_LENGTH. Any
// missing/invalid key falls back to the base value. Returns the seed object.
export function mergeCreateSettings(base: CreateOptions, override: unknown): CreateOptions;
```

- `parseChannelCreateOptions` is what the setup screen (Section 5) and the
  creation action (Section 7) both call — one place that reads the channel's
  full defaults.
- `mergeCreateSettings` is the seed builder: `base ⊕ sanitized(override)`,
  per-key fallback, never client-trusted.
- Existing `video-defaults.ts` / `brand.ts` / their editors are **untouched**.
  (Per-video override is provided by the setup screen, not a new editor.)

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

- Resolve the channel, then `base = parseChannelCreateOptions(channel.defaults)`
  (the full six-key set the channel already stores — Section 6).
- `seed = mergeCreateSettings(base, settings)` — per-key override with fallback
  to the channel default; never client-trusted.
- The rest is unchanged: insert video with `settings: seed`, insert
  `script_generation` job, build `VideoConfig` from the seed, send
  `script/generate`. The seed now includes `caption_emphasis_density` (today's
  code omits it), so it flows into the video from the start.
- Called with two args (no `settings`) the seed is exactly the channel's stored
  defaults — and because today's code instead hardcodes `captions_on`/`music_on`
  and omits density, this is also a **bug fix**: a two-arg call now honors the
  channel's captions/music/density defaults rather than the code constants.

## Data flow

```
/ (Home)  → channels cards → /channels/<id>?tab=videos (default)
           → New channel (inline) → channel created
/channels/<id> [Videos]  → list videos (status derived) → /videos/<id>
                         → "New video" → /videos/new?channel=<id>
/channels/<id>?tab=settings → six editors (unchanged)
/videos/new?channel=<id>  → prefill = parseChannelCreateOptions(channel.defaults)
   → set prompt + options → Generate
   → startScriptGeneration(prompt, channelId, settings)
       seed = mergeCreateSettings(base, settings)
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

- Additive + relocation. `startScriptGeneration`'s third arg is optional.
- No schema change, **no new `channels.defaults` keys** (captions/density/music
  already exist there via the Brand editor). The only behavioral change to the
  two-arg path is the intentional bug fix: the seed now reads the channel's
  stored captions/density/music instead of code constants.
- `videos.settings` shape is unchanged (the setup screen writes the same five
  keys + `target_length` the editor already reads — now also persisting
  `caption_emphasis_density` from creation).
- Old `/dashboard` / `/channels` URLs keep working via redirect.
- No `VideoDefaultsEditor` / Brand-editor change → those surfaces behave exactly
  as before.

## Testing

- **Unit (node:test):**
  - `src/lib/videos/create-settings.test.ts` (new): `parseChannelCreateOptions`
    backfills `SETTINGS_DEFAULTS` per missing/invalid key and reads stored
    values; `mergeCreateSettings` overrides valid keys, falls back per
    invalid/missing key, and clamps `target_length` to `MIN/MAX_TARGET_LENGTH`.
  - `src/lib/videos/status.test.ts` (new): each precedence branch of
    `deriveVideoStatus`.
- **Regression:** `npm test` green; `npx tsc --noEmit` + `npm run lint` clean;
  `npm run build` succeeds (new routes, redirects, deleted `PromptBox`).
- **Manual / app-run e2e:** Home shows channels → open a channel → Videos tab
  lists videos with correct status → "New video" → options prefilled from the
  channel's full defaults → change them → Generate → land in editor with those
  settings applied → return to the channel and see the new video listed →
  Settings tab still saves all six editors unchanged.

## Open questions

None. The structural decisions are settled: New Video setup screen
(channel-scoped, sole creation entry from the Videos tab), tabbed channel page
(Videos default | Settings), Home as the channels surface (no "New video" on
Home, no "Channels" nav link), and full channel-defaults inheritance at
creation with per-video override on the setup screen — **no duplicate editor
controls** (captions/density/music stay owned by the Brand editor; the creation
seed is fixed to read them).
