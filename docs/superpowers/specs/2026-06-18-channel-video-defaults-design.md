# Channel video defaults — design

**Date:** 2026-06-18
**Phase:** 8 (Full surfaces) — channel settings, follow-on slice
**Status:** design approved, ready for implementation plan

## Context

`channels.defaults` (JSONB, `not null default '{}'`) already holds three
content-behavior defaults — `captions_on`, `caption_emphasis_density`,
`music_on` — written by the slice-2 brand editor and consulted at render time as
a fallback. But the three **video-format** values — `aspect_ratio`, `fps`,
`target_length` — have no channel-level home: they exist only per-video
(`videos.settings`, edited on `VideoSettingsPanel`), and a new video is seeded
from hardcoded code defaults (`SEED_VIDEO_SETTINGS` in `videos/actions.ts`,
built from `DEFAULT_VIDEO_CONFIG`).

The per-video controls already ship (aspect/FPS selects + length-via-regenerate
on `VideoSettingsPanel`; the render path reads `videos.settings`). This slice
adds the **channel-level defaults** for those three so every new video in a
channel is born with the channel's chosen format, and the operator can still
override per video.

This finishes the channel-settings "defaults" story. It is a small follow-on to
the five-slice channel-settings stack (multi-channel, brand, caption-emphasis,
logos, voice).

## Goal

Let an operator set a channel's default aspect ratio, frame rate, and target
length on the channel page; have new videos in that channel inherit them at
creation.

## Scope

**In scope** — a "Video defaults" section on `/channels/[id]`, below the Voice
section, with its own Save:

- **Aspect ratio** (`9:16` / `1:1` / `16:9`), **frame rate** (`24` / `30`),
  **target length** (integer seconds, 5–180).
- Stored as `aspect_ratio` / `fps` / `target_length` keys inside
  `channels.defaults` (alongside the brand editor's keys).
- **Inheritance: snapshot at creation.** `startScriptGeneration` merges the
  channel's three values over the code defaults when seeding the new video's
  `settings` and the script-generation `config`. Existing videos are unaffected;
  the per-video panel still overrides per video.

**Out of scope**

- Captions / music inheritance *at creation*. Those are brand-editor channel
  defaults and the render path already falls back to them; leaving the creation
  seed unchanged for `captions_on` / `music_on` keeps this slice to the three
  format keys.
- Any render-path change (`render.ts` already reads the snapshotted
  `videos.settings`; with snapshot-at-creation it always carries the three
  values).
- Retroactive re-snapshot of existing videos when a channel default changes
  (snapshot semantics, like theme baking).
- A live render-time fallback to channel defaults for aspect/FPS (the rejected
  alternative — it would move existing videos and require the per-video panel to
  learn channel defaults).

## Architecture

`channels.defaults` becomes shared by two editor sections that own **disjoint
keys**: the brand editor owns `captions_on` / `caption_emphasis_density` /
`music_on`; this section owns `aspect_ratio` / `fps` / `target_length`. To make
that safe, the brand RPC's `defaults` write changes from **wholesale**
(`defaults = p_defaults`) to a **key-merge** (`defaults = defaults ||
p_defaults`) — exactly what it already does for `brand_kit`. The new section
writes via its own merge RPC. This mirrors the established slice pattern (each
section = a focused `security invoker` RPC, a pure core, a server action, a
dirty-tracked editor).

### Data model

No schema change. One **migration** with two statements:

```sql
-- Phase 8 — channel video defaults. Writes the three format keys into
-- channels.defaults via a key-merge, preserving the brand editor's sibling keys
-- (captions_on, caption_emphasis_density, music_on). SECURITY INVOKER → caller
-- RLS on channels applies. RETURNS the updated id (NULL when no row matched) →
-- no phantom save.
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
-- video-defaults keys (aspect_ratio, fps, target_length) survive a brand save.
-- Only the `defaults` line changes; brand_kit was already merged, brand_voice is
-- still wholesale (the brand editor owns all its keys).
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

## Components

### Pure core (`src/lib/channels/video-defaults.ts`, unit-tested)

Imports only pure modules + type-only: `AspectRatio`, `Fps` from
`../videos/settings` (type-only); `MIN_TARGET_LENGTH`, `MAX_TARGET_LENGTH` (= 5,
180) from `../videos/regenerate`. (Both are pure modules — no
react/server/network.)

```ts
export interface VideoDefaultsForm {
  aspectRatio: AspectRatio;   // '9:16' | '1:1' | '16:9'
  fps: Fps;                   // 24 | 30
  targetLength: number;       // integer seconds, 5–180
}

// Code defaults shown when channels.defaults has none of the three keys
// (mirror DEFAULT_VIDEO_CONFIG: 9:16 / 30 / 30).
export const VIDEO_DEFAULTS_FALLBACK: VideoDefaultsForm =
  { aspectRatio: '9:16', fps: 30, targetLength: 30 };

// Build the form from channels.defaults: read aspect_ratio / fps / target_length,
// backfilling VIDEO_DEFAULTS_FALLBACK for any missing / invalid value. Always
// returns a complete form. Also used by the creation path to resolve a channel's
// format for seeding.
export function parseVideoDefaults(defaults: unknown): VideoDefaultsForm;

// Validate a form submission → the snake_case object to merge into
// channels.defaults: { aspect_ratio, fps, target_length }. Rejects: aspect ∉
// {9:16,1:1,16:9}; fps ∉ {24,30}; target_length not an integer in [5,180].
export function validateVideoDefaultsForm(input: unknown):
  | { ok: true; value: { aspect_ratio: AspectRatio; fps: Fps; target_length: number } }
  | { ok: false; reason: string };
```

### Server action (`src/app/(app)/channels/[id]/video-defaults-actions.ts`, `'use server'`)

```ts
export async function saveChannelVideoDefaults(
  channelId: string,
  input: unknown,
): Promise<{ ok: true } | { ok: false; reason: string }>;
```

`validateVideoDefaultsForm(input)` (return its `reason` on failure) →
`supabase.rpc('set_channel_video_defaults', { p_channel_id: channelId, p_value })`
→ RPC error → `{ ok:false, reason }`; `data == null` → `{ ok:false,
reason:'Channel not found.' }`; else `{ ok:true }`. RLS-scoped client; mirrors
`saveChannelVoiceTts`.

### Creation wiring (`src/app/(app)/videos/actions.ts`)

`startScriptGeneration` already resolves the channel. Changes:

1. Add `defaults` to the channel select (currently `id, name, brand_voice`).
2. Compute `const fmt = parseVideoDefaults(channel.defaults);` and build the seed
   settings from it (the three format keys) plus the existing code defaults for
   the rest:

   ```ts
   const seedSettings = {
     aspect_ratio: fmt.aspectRatio,
     target_length: fmt.targetLength,
     fps: fmt.fps,
     captions_on: DEFAULT_VIDEO_CONFIG.captions,
     music_on: DEFAULT_VIDEO_CONFIG.music,
   };
   ```

   (Replaces the module-level `SEED_VIDEO_SETTINGS` constant with this
   per-channel value; `captions_on`/`music_on` stay on code defaults — out of
   scope for this slice.)
3. Build the script-gen `config` from `seedSettings` (as today, but from the
   per-channel seed): `aspectRatio`, `targetLengthSeconds`, `fps` now reflect the
   channel.

### UI

`/channels/[id]/page.tsx` already selects `defaults` (for `parseChannelBrand`).
Add `const videoDefaultsInitial = parseVideoDefaults(channel.defaults);` and
render `<VideoDefaultsEditor channelId initial={videoDefaultsInitial} />` below
the Voice section, preceded by an `<hr>` divider in the same style.

`VideoDefaultsEditor` (client): an aspect `<select>` (9:16 / 1:1 / 16:9), an FPS
`<select>` (24 / 30), and a target-length number input (`min=5 max=180 step=1`),
plus a single dirty-tracked **Save** → `saveChannelVideoDefaults(channelId,
form)` (try/catch/finally so the button never sticks; `{ ok:false }` keeps edits
+ shows the reason; `{ ok:true }` clears dirty + shows "Saved"). Mirrors the
prior editors' markup/Tailwind conventions.

## Data flow

```
channel page (server) → parseVideoDefaults(channel.defaults) → form
VideoDefaultsEditor (client) → edit → Save → saveChannelVideoDefaults(id, form)
saveChannelVideoDefaults → validateVideoDefaultsForm → set_channel_video_defaults RPC (defaults || patch) → { ok }
new video → startScriptGeneration → parseVideoDefaults(channel.defaults)
          → seeds video.settings {aspect_ratio, fps, target_length} + script-gen config
render → unchanged (reads the snapshotted video.settings)
brand editor save → update_channel_brand now merges defaults → video-default keys survive (and vice versa)
```

## Error handling

- `validateVideoDefaultsForm` → friendly `reason` for a bad aspect, bad fps, or
  an out-of-range / non-integer target length; the editor shows it and keeps
  edits.
- `saveChannelVideoDefaults` → `{ ok:false, reason }` on RPC error; `data ==
  null` → `'Channel not found.'` (no phantom save).
- The page `notFound()`s a missing/non-owned channel before the editor.
- Creation is resilient to a channel with no defaults — `parseVideoDefaults`
  backfills the code defaults, so seeding never throws.

## Back-compatibility

- A channel with no `defaults` (or none of the three keys) → code defaults
  (`9:16` / `30` / `30`) — identical to today's `SEED_VIDEO_SETTINGS`.
- The brand RPC wholesale→merge change is safe: the brand form's `defaults`
  object holds only its three keys, so the merge preserves the video-default
  keys; the video-defaults section's merge preserves the brand keys. Disjoint
  keys, independent saves.
- Old videos keep their snapshotted `videos.settings` — a later channel-default
  change applies to new videos only.
- Old renders unaffected (their settings were already snapshotted).

## Testing

- **Unit (`src/lib/channels/video-defaults.test.ts`):**
  - `parseVideoDefaults` — empty `{}` → `VIDEO_DEFAULTS_FALLBACK`; a full stored
    object (`{ aspect_ratio:'16:9', fps:24, target_length:60 }`) → those values;
    garbage / wrong-typed values → fallback per field; a partial object backfills
    only the missing keys.
  - `validateVideoDefaultsForm` — a valid form → `value` with snake_case keys
    `{ aspect_ratio, fps, target_length }`; rejects a bad aspect, fps 25,
    target_length 4 / 181 / 30.5 / non-number.
- **Migration:** `npm run db:apply` the migration; confirm recorded + applied;
  the brand RPC redefinition is `create or replace` (idempotent).
- **Manual / app-run e2e:** open `/channels/[id]` → Video defaults section shows
  the code defaults → set `16:9` / `24` / `60` → Save → reload persists → create
  a new video in that channel → its `VideoSettingsPanel` shows `16:9` / `24` and
  length `60s` (inherited) → an existing video is unaffected → save the brand
  editor and confirm the video defaults survive (and vice versa) → an
  out-of-range length shows the reason and doesn't save. **No render gate.**

## Open questions

None. Separate section (with the brand RPC switched to a `defaults` merge),
snapshot-at-creation inheritance, and the three format keys (aspect 9:16/1:1/16:9,
fps 24/30, target length 5–180) are all settled.
