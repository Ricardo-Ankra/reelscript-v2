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
{
  account_id,                 // from session
  name,                       // validated input
  brand_kit: {},              // bakeTheme → DEFAULT_THEME
  brand_voice: {},            // no tone yet; generation falls back gracefully
  voice_tts: { voice_id: DEFAULT_VOICE_ID, model: 'eleven_multilingual_v2' },
  defaults: {},               // render falls back to per-video / code defaults
}
```

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
→ return `{ ok: true; channelId } | { ok: false; reason }`. The caller
redirects to `/channels/[channelId]`. Mirrors the existing action style
(`@/lib/supabase/server`, discriminated-union return).

**`/channels` page** — server component: RLS read of the account's channels
(`id, name, status, created_at`, ordered by `created_at` desc), renders a list
(name → link to detail) plus a small client `NewChannelForm` that calls
`createChannel` and routes to the new detail page on success, keeping the form
open and showing `reason` on failure.

**`/channels/[id]` page** — server component: RLS read of the one channel by id
(`maybeSingle`); 404 (Next `notFound()`) if not found / not owned. Renders the
channel name and a "Brand settings — coming next" placeholder. A back link to
`/channels`.

**Channel picker (dashboard)** — `dashboard/page.tsx` (server) reads the
account's channels and passes them to `PromptBox`. `PromptBox` (client):
- If `channels.length === 0`: render the gate — "Create a channel first →"
  linking to `/channels`; no prompt box.
- Else: a `<select>` of channels (value = id, default = first/most-recent)
  above the existing prompt textarea; `onGenerate` calls
  `startScriptGeneration(prompt, selectedChannelId)`.

**`startScriptGeneration(prompt, channelId)`** — replace the seed block
(actions.ts:52–72) with: read the chosen channel
(`id, name, brand_voice` filtered by id, RLS-scoped) via `maybeSingle`; if
missing → throw `'Channel not found.'` (RLS already scopes to the account, so a
miss covers both not-found and not-owned). Use `channel.name` as
`BrandContext.channelName` and `brand_voice.tone` as the tone. Everything
downstream (video insert with `channel_id`, job, event emit) is unchanged.
Delete `SEED_CHANNEL`/`SEED_BRAND`.

### Data flow

```
/channels (server)        → list channels (RLS)
NewChannelForm (client)   → createChannel(name) → insert (RLS) → redirect /channels/[id]
/channels/[id] (server)   → read channel (RLS) → shell
dashboard (server)        → list channels (RLS) → PromptBox
PromptBox (client)        → pick channel → startScriptGeneration(prompt, channelId)
startScriptGeneration     → verify channel (RLS) → create video (channel_id) + job → emit
```

## Error handling

- `validateChannelName` rejects empty / over-long with friendly reasons; the
  `NewChannelForm` shows the reason and keeps the form open.
- `createChannel` returns `{ ok: false, reason }` on no-account / insert error;
  the form surfaces it without navigating.
- `/channels/[id]` calls `notFound()` for a missing/unowned id.
- `startScriptGeneration` throws `'Channel not found.'` if the chosen channel
  isn't visible under RLS (existing `PromptBox` catch renders the message).
- Zero-channels create flow shows the gate, never an error.

## Back-compatibility

- Existing `"Studio"` channels (already created by prior video creation) simply
  appear in the new list; nothing migrates them.
- Existing videos keep their `channel_id` (immutable); their renders are
  unaffected.
- The seed lookup is removed, so **every new video now requires a chosen
  channel**. Existing accounts already have at least one channel, so the gate
  only triggers for genuinely empty accounts.

## Testing

- **Unit:** `validateChannelName` — trims, rejects empty, rejects > 60, accepts
  a normal name (returns trimmed value). `node --test` via the project loader.
- **Manual / app-run e2e** (no automated coverage for CRUD + UI, consistent
  with prior slices): create a channel from `/channels` → it appears in the
  list → open its detail shell → return to the dashboard → it appears in the
  picker → generate a video → the video uses the chosen channel (verify
  `videos.channel_id`). Separately: an account with no channels shows the gate;
  the picker selection drives `BrandContext.channelName`.

## Open questions

None. Schema, defaults, the create-flow gate, and the seed removal are all
settled.
