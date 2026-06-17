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
        │ merge + validate
        ▼
Supabase videos.update({ settings })  ── RLS-scoped server client (Tier 1)
```

- **`VideoSettingsPanel.tsx`** (client): renders the controls from the initial
  settings; on each control change it optimistically updates local state, calls the
  server action, and shows a small `saving… / saved ✓ / save failed` indicator
  (the `SceneCard` save-state pattern). A static line — "Settings apply on the next
  render." — sets expectations; the panel never auto-renders.
- **`settings-actions.ts`**: `updateVideoSettings(videoId, patch)` loads the video,
  merges the patch into `settings`, writes it, and returns
  `{ ok: true } | { ok: false; reason: string }`. RLS via the server Supabase
  client (no manual auth checks), matching `music-actions.ts`.
- **Pure core** (`src/lib/videos/settings.ts`): `mergeVideoSettings(current, patch)`
  — validates each key (enum/bounds), drops invalid keys rather than writing them,
  and returns the merged settings object. Unit-tested; the server action is a thin
  wrapper around it + the Supabase write.

## Settings shape

```ts
// src/lib/videos/settings.ts (pure)
export type CaptionEmphasisDensity = 'off' | 'sparing' | 'liberal';
export type AspectRatio = '9:16' | '1:1' | '16:9';

export interface VideoSettingsPatch {
  captions_on?: boolean;
  caption_emphasis_density?: CaptionEmphasisDensity;
  music_on?: boolean;
  aspect_ratio?: AspectRatio;
  fps?: number; // 24 | 30
  // target_length intentionally not patchable in this slice
}

// Merge a validated patch into the stored settings JSON. Unknown/invalid values
// in the patch are ignored (never written); other existing keys are preserved.
export function mergeVideoSettings(
  current: Record<string, unknown>,
  patch: VideoSettingsPatch,
): Record<string, unknown>;
```

Allowed sets: `caption_emphasis_density ∈ {off,sparing,liberal}`, `aspect_ratio ∈
{9:16,1:1,16:9}`, `fps ∈ {24,30}`, booleans coerced from booleans only.

## Error handling

- Invalid patch values are dropped by `mergeVideoSettings` (defensive; the UI only
  ever sends valid values). The action never throws on a bad enum — it writes the
  valid subset.
- A Supabase write failure returns `{ ok: false, reason }`; the panel shows
  `save failed` inline and reverts the optimistic change to the last-saved value.
- No video found / not owned (RLS) → `{ ok: false, reason }`, surfaced inline.

## Testing

- **Pure (`node --test`)** on `mergeVideoSettings`: a valid patch merges; an invalid
  enum/fps is dropped (not written); a partial patch preserves unrelated keys
  (e.g. `mood`, `music_params`); booleans only accept booleans.
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
