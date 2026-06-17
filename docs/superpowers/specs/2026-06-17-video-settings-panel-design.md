# Video settings panel — design

**Date:** 2026-06-17
**Phase:** 8 (Full surfaces) — first slice.
**Status:** Design approved; spec under review before implementation.

## Summary

A per-video settings panel in the editor that exposes the config the render
already honors, so the operator stops poking `video.settings` in the database
(the friction hit while verifying the caption work — `captions_on` had to be
flipped by hand). It writes `video.settings` (JSONB); the render pipeline already
reads that column at render time, so no render-side change is needed.

This is the first Phase-8 surface. It is deliberately scoped to the settings that
apply **on the next render**. `target_length` (which reshapes the script/scenes
and therefore needs a destructive regenerate) is shown read-only here and wired up
in the next slice.

## Settings exposed

All are render-time: the render pipeline recomputes from them every render, so a
change applies on the next "Generate Video".

| Setting | `video.settings` key | Control | Values |
|---|---|---|---|
| Captions | `captions_on` | toggle | on / off |
| Emphasis density | `caption_emphasis_density` | select | off / sparing / liberal (disabled when captions off) |
| Music | `music_on` | toggle | on / off |
| Aspect ratio | `aspect_ratio` | select | 9:16 / 1:1 / 16:9 |
| Frame rate | `fps` | select | 24 / 30 |
| Length | `target_length` | **read-only** (this slice) | shows the value + "regenerates — coming next" |

- **Music** is on/off only. Track selection + master volume stay in the existing
  `MusicPanel` (post-render re-mux). `mood` is not exposed (it is the Music panel's
  reselection seed).
- **Emphasis density** is only meaningful when captions are on; the control is
  disabled (greyed) when `captions_on` is false.

## Why these are render-time (and length is not)

The render pipeline composes + builds captions + selects music **every render**
from `video.settings`. So `captions_on`, `caption_emphasis_density`, `music_on`,
`aspect_ratio` (compose re-resolves stock orientation at the new dimensions), and
`fps` all take effect on the next render with no other change.

`target_length` shapes script generation — how many scenes and their pacing — and
the scenes' frame durations come from the already-synthesized audio. Changing it
on an existing video does nothing unless the script is regenerated (destructive:
it replaces the current scenes). That regenerate-in-place flow does not exist yet
and is the next slice; here `target_length` is read-only.

## Components & data flow

```
page.tsx (server) ── adds `settings` to the videos select
        │ initialSettings
        ▼
Editor.tsx (client) ── mounts <VideoSettingsPanel> in the render area, above MusicPanel
        │ onChange(patch)
        ▼
updateVideoSettings(videoId, patch)  ── server action (settings-actions.ts)
        │ 1. sanitizeSettingsPatch(patch) → validated subset (invalid keys dropped)
        │ 2. ATOMIC jsonb merge — no app-side read-modify-write
        ▼
rpc merge_video_settings(video_id, validatedPatch)
        │  update videos set settings = settings || p_patch
        │  where id = p_video_id returning settings        (RLS: SECURITY INVOKER)
        ▼
returns the NEW full settings  ──►  { ok: true; settings } back to the panel
```

- **`VideoSettingsPanel.tsx`** (client): renders the controls from the initial
  settings; on each control change it optimistically updates local state, calls the
  server action, and shows a small `saving… / saved ✓ / save failed` indicator
  (the `SceneCard` save-state pattern). On `{ ok: true; settings }` it **reconciles
  local state to the returned `settings`** — it does not assume its patch took, so a
  value the server normalised or dropped shows the truth. On `{ ok: false }` it
  reverts to the last-saved settings and shows `save failed`. A static line —
  "Settings apply on the next render." — sets expectations; the panel never
  auto-renders.
- **`settings-actions.ts`**: `updateVideoSettings(videoId, patch)` = sanitize the
  patch → call the atomic-merge RPC → return `{ ok: true; settings } | { ok: false;
  reason: string }`. No load-then-write in app code, so two rapid toggles cannot
  lose each other to a stale read (the merge is one Postgres statement; last write
  wins per key, not per whole object).
- **Pure core** (`src/lib/videos/settings.ts`): `sanitizeSettingsPatch(patch)` —
  validates/normalises each key (enum/bounds/type), keeps only known keys with
  allowed values, drops the rest. Unit-tested. The server action is a thin wrapper
  around it + the RPC call.
- **Migration**: a `merge_video_settings(p_video_id uuid, p_patch jsonb) returns
  jsonb` SQL function — `SECURITY INVOKER` so the caller's RLS on `videos` applies —
  doing the atomic `settings = settings || p_patch ... returning settings`. The
  validated patch is passed as `jsonb`; Postgres `||` shallow-merges it over the
  stored object, so unrelated keys (`mood`, `music_params`, `target_length`, …) are
  preserved untouched.

## Settings shape

```ts
// src/lib/videos/settings.ts (pure)
export type CaptionEmphasisDensity = 'off' | 'sparing' | 'liberal';
export type AspectRatio = '9:16' | '1:1' | '16:9';
export type Fps = 24 | 30; // literal union — same compile-time guarantee as the enums

export interface VideoSettingsPatch {
  captions_on?: boolean;
  caption_emphasis_density?: CaptionEmphasisDensity;
  music_on?: boolean;
  aspect_ratio?: AspectRatio;
  fps?: Fps;
  // target_length intentionally not patchable in this slice
}

// Validate + normalise a patch from the UI: keep only known keys whose values are
// in the allowed set; drop the rest (defensive — the UI only sends valid values).
// The atomic merge (settings || patch, in the merge_video_settings RPC) applies the
// returned subset, so dropped keys are simply never written.
export function sanitizeSettingsPatch(patch: unknown): VideoSettingsPatch;
```

Allowed sets: `caption_emphasis_density ∈ {off,sparing,liberal}`, `aspect_ratio ∈
{9:16,1:1,16:9}`, `fps ∈ {24,30}`, booleans accepted from booleans only.

**Why `fps ∈ {24, 30}`:** 24 fps (a cinematic cadence) and 30 fps (standard for
short-form social) are the two the render path + Lambda are exercised with. More can
be added later behind the same literal union; the renderer already reads `fps` from
settings, so adding a value is a one-line change here.

## Error handling

- The action returns the **actually-written settings** (`{ ok: true; settings }`),
  and the panel reconciles its local state to them. So if the server normalises or
  drops a value, the panel reflects the truth instead of showing a value as "saved"
  that was never written — closing the gap where a silently-dropped key would read
  as success.
- Invalid patch values are dropped by `sanitizeSettingsPatch` (defensive; the UI only
  sends valid values). A dropped key is simply absent from the merge and therefore
  unchanged in the returned settings.
- An RPC / write failure, or video-not-found / not-owned (RLS), returns
  `{ ok: false, reason }`; the panel reverts the optimistic change to the last-saved
  settings and shows `save failed` inline.

## Testing

- **Pure (`node --test`)** on `sanitizeSettingsPatch`: a valid patch passes through
  (normalised); an invalid enum / fps / non-boolean is dropped; unknown keys are
  dropped; a partial patch returns only its own keys (so the atomic `||` leaves
  everything else — `mood`, `music_params`, `target_length` — untouched).
- **Emphasis-density round-trip (item 4, explicit intended behavior):** turning
  captions off must NOT clear a stored `caption_emphasis_density`. Asserted by
  `sanitizeSettingsPatch({ captions_on: false })` returning a patch with **no**
  `caption_emphasis_density` key — so the merge can't overwrite it, and
  liberal → captions off → captions on restores liberal. The UI only disables the
  density control while captions are off; it never sends a density change for the
  toggle, and the stored value persists.
- **Manual / app run**: toggle captions and emphasis density in the panel, confirm
  the saved indicator, re-render, and confirm the output reflects the change — this
  also exercises the `caption_emphasis_density` control end-to-end through the UI for
  the first time.

## Out of scope (this slice)

- `target_length` editing + regenerate-in-place (the next slice: delete current
  scenes/shots/audio → re-run generation for this video → Realtime streams the new
  scenes).
- `mood` selection (lives with the Music panel's reroll).
- Channel-level defaults UI (a later Phase-8 slice — channel settings).
- Realtime reflection of settings across sessions (single-operator; optimistic
  local state is sufficient).

**`target_length` honesty (item 5):** confirmed `target_length` is written by no
code path in the interim — it is only seeded at video creation
(`SEED_VIDEO_SETTINGS`) and never updated until the regenerate slice lands. So the
read-only display always matches the value that shaped the current scenes; it cannot
drift. The next slice introduces the only writer, paired with the regenerate action.
