# Multi-channel foundation — design

**Date:** 2026-06-17
**Phase:** 8 (Full surfaces) — channel settings, sub-slice 1 of 5
**Status:** design approved, ready for implementation plan

## Context

Channels carry a channel's brand (the `brand_kit` baked into every render's
theme snapshot, the `brand_voice` tone fed to script generation, the
`voice_tts` profile, and per-video `defaults`). Today a single channel named
`"Studio"` is **seeded** lazily inside `startScriptGeneration` (idempotent by
name) with hardcoded brand values; there is no UI to create, list, pick, or
edit channels.

This is the first of five stacked sub-slices that together deliver the full
channel-settings surface the build plan calls for. The decomposition:

1. **Multi-channel foundation** *(this spec)* — list + create channels, a
   per-channel detail page **shell**, a **channel picker** in the video-create
   flow, and `startScriptGeneration` taking a chosen `channelId`. Everything
   else hangs off the detail page and the picker.
2. Lean-core brand editor (name, colors, font, motion, brand-voice tone,
   defaults) — fills the detail page.
3. Caption-emphasis tables editor (`brand_kit.caption_emphasis`).
4. Logo uploads (`brand_kit.logos`, signed-upload flow + render wiring).
5. Voice params editor (`voice_tts`, live ElevenLabs model fetch).

Each sub-slice is independently shippable and leaves `main` green. Sub-slices
2–5 are independent of each other (any order) but all depend on this one.

## Goal

Make channels first-class and self-serve: an operator can create channels,
see them listed, open one, and **must pick a channel when creating a video**.
Remove the seeded-channel hardcode from the create path entirely — no channel
is ever auto-created.

## Scope

**In scope**

- `/channels` — list the account's channels; inline "New channel" (name → create).
- `/channels/[id]` — detail page **shell**: shows the channel name and a
  "Brand settings — coming next" placeholder. Sub-slice 2 fills it.
- `createChannel(name)` server action — inserts a `channels` row with safe
  defaults, returns the new id (caller redirects to the detail page).
- A **channel picker** in the video-create flow (dashboard `PromptBox`):
  a `<select>` of the account's channels, defaulting to the most recent.
- A **no-channels gate**: when the account has zero channels, the create UI
  shows "Create a channel first →" linking to `/channels` instead of the
  prompt box.
- `startScriptGeneration(prompt, channelId)` — takes the chosen channel,
  verifies it belongs to the account, reads its `name` + `brand_voice.tone`
  for the `BrandContext`. **No seed lookup, no auto-create.**
- A "Channels" link in the app nav (`(app)/layout.tsx`).
- `validateChannelName(name)` — pure, unit-tested.

**Out of scope (later sub-slices or explicitly deferred)**

- The brand-identity fields editor (colors/font/motion/tone/defaults) — slice 2.
- Caption-emphasis tables (slice 3), logos (slice 4), voice params (slice 5).
- Channel **rename** (the name field lands with the slice-2 editor; this slice
  sets the name only at create time), **archive**, and **delete**.
- Moving an existing video between channels (videos keep their `channel_id`).
- Multi-account / account switching (one account per session as today).
- `render/actions.ts` (the debug-only render-spine sandbox) keeps its own
  independent lazy seed of the `"Phase 1 Sandbox"` channel — **untouched** this
  slice (see Back-compatibility).
- No schema migration — the `channels` table already has every needed column
  with RLS.

## Architecture

Plain channel CRUD is **Tier 1** (direct Supabase under RLS): list/detail via
server components, create via a server action (so it can redirect). No secrets,
no long jobs. The only Tier-2/3 touch is the existing `startScriptGeneration`
server action, whose channel-resolution logic changes.

### Data model (no change)

`channels` already has: `id`, `account_id` (RLS boundary), `name`, `status`
(`active`/`archived`, default active), `brand_voice` jsonb, `brand_kit` jsonb,
`voice_tts` jsonb, `defaults` jsonb, `deleted_at`, timestamps.

**Create defaults** (so a new channel renders correctly before the slice-2
editor exists — `bakeTheme` backfills the full `DEFAULT_THEME` from an empty
`brand_kit`):

```ts
import { DEFAULT_VOICE_ID, ELEVENLABS_DEFAULT_MODEL } from '@/lib/voice/elevenlabs';

{
  account_id,                 // from session
  name,                       // validated input
  brand_kit: {},              // bakeTheme → DEFAULT_THEME
  brand_voice: {},            // no tone yet; generation falls back gracefully
  voice_tts: { voice_id: DEFAULT_VOICE_ID, model: ELEVENLABS_DEFAULT_MODEL },
  defaults: {},               // render falls back to per-video / code defaults
}
```

**Voice model — single source of truth.** The model must come from
`ELEVENLABS_DEFAULT_MODEL` (`src/lib/voice/elevenlabs.ts`, currently
`'eleven_multilingual_v2'`), **not** a re-typed literal. That constant is what
synthesis uses live today, so it is current; and slice 5 (the voice-params
editor with the live ElevenLabs model fetch) will reuse the same constant — one
place to update if ElevenLabs deprecates the id, no drift between this default
and the live list.

Channel **names are not unique** — `name` is a display label. The old
idempotent-by-name lookup is removed; identity is the `channelId`.

### Components

**`validateChannelName(name: string)`** — pure (`src/lib/channels/validate.ts`):

```ts
export const MAX_CHANNEL_NAME = 60;
export function validateChannelName(name: unknown):
  | { ok: true; value: string }
  | { ok: false; reason: string };
// trims; rejects empty ('Enter a channel name.') and > MAX_CHANNEL_NAME
// ('Channel name is too long.'); returns the trimmed value on success.
```

**`createChannel(name: string)`** — server action
(`src/app/(app)/channels/actions.ts`, `'use server'`):
validate → resolve session account → insert with the create defaults under RLS
→ return `{ ok: true; channelId } | { ok: false; reason }`. Mirrors the existing
action style (`@/lib/supabase/server`, discriminated-union return).

**The action MUST NOT call `redirect()` itself.** Next's `redirect()` works by
throwing a special `NEXT_REDIRECT` error; calling it inside the action would
short-circuit the function before (or instead of) returning the discriminated
union, and a `try/catch` around the insert could even swallow it. Redirect is
the **client's** job: `NewChannelForm` calls `router.push('/channels/<id>')`
only on `{ ok: true }`. The action only ever returns a value.

**`/channels` page** — server component: RLS read of the account's channels
(`id, name, status, created_at`, ordered by `created_at desc, id desc` — see
"List ordering" below), renders a list (name → link to detail) plus a small
client `NewChannelForm` that calls `createChannel` and routes to the new detail
page on success, keeping the form open and showing `reason` on failure.

**`/channels/[id]` page** — server component: RLS read of the one channel by id
(`maybeSingle`); 404 (Next `notFound()`) if not found / not owned. Renders the
channel name and a "Brand settings — coming next" placeholder. A back link to
`/channels`.

**Channel picker (dashboard)** — `dashboard/page.tsx` (server) reads the
account's channels (`id, name`, ordered `created_at desc, id desc`) and passes
the array to `PromptBox`. `PromptBox` (client):
- If `channels.length === 0`: render the gate — "Create a channel first →"
  linking to `/channels`; no prompt box, no select. **The "default to first"
  logic below never runs in this branch**, so no `channels[0]` is dereferenced
  on an empty list.
- Else: a `<select>` of channels (value = id, default = `channels[0]` = the
  most recent, safe because this branch is `length > 0`) above the existing
  prompt textarea; `onGenerate` calls
  `startScriptGeneration(prompt, selectedChannelId)`.

**`startScriptGeneration(prompt, channelId)`** — the `channelId` is a **required
second parameter** (no default). Behavior:

- **`channelId` missing / `undefined` / empty / not a string** → throw a
  friendly `'Pick a channel to generate a video.'` as the **first** check
  (before any DB work). This is the explicit contract for a stale client (see
  "Deploy ordering" below). The existing `PromptBox` `catch` renders the thrown
  message; it is never an unhandled crash and never silently auto-seeds.
- **Valid `channelId`** → read the chosen channel (`id, name, brand_voice`
  filtered by `id`, RLS-scoped) via `maybeSingle`; if missing → throw
  `'Channel not found.'` (RLS already scopes to the account, so a miss covers
  both not-found and not-owned). Use `channel.name` as
  `BrandContext.channelName` and `brand_voice.tone` as the tone.

Everything downstream (video insert with `channel_id`, job, event emit) is
unchanged. Delete `SEED_CHANNEL`/`SEED_BRAND` and the seed block
(actions.ts:52–72).

### Data flow

```
/channels (server)        → list channels (RLS)
NewChannelForm (client)   → createChannel(name) → insert (RLS) → redirect /channels/[id]
/channels/[id] (server)   → read channel (RLS) → shell
dashboard (server)        → list channels (RLS) → PromptBox
PromptBox (client)        → pick channel → startScriptGeneration(prompt, channelId)
startScriptGeneration     → verify channel (RLS) → create video (channel_id) + job → emit
```

## List ordering

Both the `/channels` list and the dashboard picker read order by
`created_at desc, id desc`. The `id` tiebreaker makes "most recent" (the
picker's default selection, which is load-bearing for the create flow)
**deterministic** when two channels share a `created_at` to the second —
otherwise their order could flip between reads and the default would feel
random. `id` is a UUID (a stable, arbitrary-but-fixed tiebreaker); the goal is
stability, not a meaningful secondary sort.

## Deploy ordering (seed-removal rollout hazard)

Removing the lazy seed changes both the action signature
(`startScriptGeneration` now requires `channelId`) and its only caller
(`PromptBox`). The risk window: a user with the **old** `PromptBox` loaded in a
tab calls the **new** action with no `channelId`.

- **Mitigation 1 — atomic deploy.** Action and client ship in the **same**
  Vercel deploy (one build, one atomic swap), so a fresh load never has a
  version mismatch.
- **Mitigation 2 — defensive contract.** Even so, a *stale* tab can hit the new
  action. The explicit `channelId`-missing check makes that a clean, friendly
  `'Pick a channel to generate a video.'` (rendered by the old `PromptBox`'s
  error `<pre>`), **not** an unhandled throw and **not** a silent off-brand
  auto-seed. A reload picks up the new picker.

Single-operator use lowers the stakes, but the stale-tab case is exactly what
produced "a confusing failure" in the review, so the contract is stated, not
assumed.

## Error handling

- `validateChannelName` rejects empty / over-long with friendly reasons; the
  `NewChannelForm` shows the reason and keeps the form open.
- `createChannel` returns `{ ok: false, reason }` on no-account / insert error;
  the form surfaces it without navigating. The action never throws `redirect()`.
- `/channels/[id]` calls `notFound()` for a missing/unowned id.
- `startScriptGeneration` throws `'Pick a channel to generate a video.'` for a
  missing/empty `channelId`, and `'Channel not found.'` if the chosen channel
  isn't visible under RLS. Both are caught + rendered by `PromptBox`.
- Zero-channels create flow shows the gate, never an error.

## Back-compatibility (assumptions verified, not asserted)

- Existing seeded channels (`"Studio"` from video creation, `"Phase 1 Sandbox"`
  from the render spine) simply appear in the new list; nothing migrates them.
- Existing videos keep their `channel_id` (immutable); their renders are
  unaffected.
- The seed lookup is removed, so **every new video now requires a chosen
  channel.**
- **The "existing accounts have a channel" claim is not universally true, and
  the design does not depend on it.** The old seed was created *lazily on first
  video generation*, so an account that signed up but never generated has **no**
  channel. After this slice that account correctly hits the zero-channels gate
  (the intended behavior) — it is guided to create one, never crashed.
- **No other code path assumes a channel exists / reads `channels[0]`
  unguarded:**
  - The dashboard server read returns a possibly-empty array and hands it to
    `PromptBox`, where the gate handles `length === 0` *before* any
    default-to-first; the `<select>` default only runs in the `length > 0`
    branch.
  - `render/actions.ts` (the **debug-only** render-spine sandbox behind
    `/render`) has its **own independent** lazy seed of a *different* channel
    (`"Phase 1 Sandbox"`). It is **intentionally left untouched** by this slice
    (separate concern, throwaway scaffolding). It seeds-if-missing, so it never
    assumes a channel exists; the channel it creates is valid and simply shows
    up in the list. The "no auto-create" principle applies to the **production
    video-create path**, which this slice fixes.
  - Dev scripts (`scripts/drive-primitive.ts`, `scripts/seed-music.ts`) read
    the first channel via `.order('created_at').limit(1).single()` and already
    throw a clear `'no channel'` error when none exists. They are dev-only,
    admin-client helpers, unaffected by this slice.

## Testing

- **Unit:** `validateChannelName` — trims, rejects empty, rejects > 60, accepts
  a normal name (returns trimmed value). `node --test` via the project loader.
- **Manual / app-run e2e** (no automated coverage for CRUD + UI, consistent
  with prior slices): create a channel from `/channels` → it appears in the
  list → open its detail shell → return to the dashboard → it appears in the
  picker → generate a video → the video uses the chosen channel (verify
  `videos.channel_id`). The picker selection drives `BrandContext.channelName`.
- **Zero-channels path:** confirm an account with no channels shows the gate
  (not an error, not a crash). Since existing accounts already have channels,
  verify this by reading the live `channels` table for the operator's account
  (it has ≥1, so the gate won't show in normal use) and by reasoning through the
  empty-array render path; a brand-new account would exercise it directly.
- **Stale-client contract:** confirm `startScriptGeneration('prompt')` with no
  `channelId` throws `'Pick a channel to generate a video.'` (the deploy-window
  contract), surfaced cleanly by `PromptBox`.

## Open questions

None. Schema, defaults, the create-flow gate, the seed removal, the
missing-`channelId` contract, the deploy ordering, and the untouched render
sandbox are all settled.
