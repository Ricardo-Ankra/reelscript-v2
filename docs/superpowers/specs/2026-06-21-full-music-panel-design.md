# Full music panel — design

**Date:** 2026-06-21
**Phase:** 8 (Full surfaces) — creative controls
**Status:** design approved, ready for implementation plan

## Context

The music mix is parameterized by six values (`src/lib/music/params.ts`):

```ts
export interface MusicParams {
  masterVolume: number;   // 0..1 — bed level under the voiceover
  duckingDepth: number;   // 0..1 — how hard music ducks under speech
  loop: boolean;          // loop the bed to the video length if shorter
  cropStartSec: number;   // in-point into the source track
  fadeInSec: number;
  fadeOutSec: number;
}
```

`canonicalizeMusicParams` clamps/defaults/rounds them (unit-tested);
`renders.music_params` (JSONB) stores them; the ffmpeg remux
(`src/lib/music/ffmpeg.ts` `buildRemuxArgs`) applies **all six** end-to-end; the
base/final MP4 split + the `music/remux` Lambda trigger already work. The render
path seeds a render's params from `videos.settings.music_params`
(`render.ts`). The **Phase-6 Music panel is minimal**: it shows reroll + a master
volume slider only — the other five params sit at their code defaults with no UI.

This slice adds the UI for the five hidden params and the action plumbing to carry
the full set. It is **UI + action plumbing only — no new pure logic** (the
validation, storage, and ffmpeg application already exist).

## Goal

Let the operator tune all six music mix params per render from the Music panel,
re-mux to hear the result, and have the tuning persist to the video so a future
re-render inherits it.

## Scope

**In scope:**

- Six controls in `MusicPanel`: **volume** (slider 0–0.6, existing), **ducking
  depth** (slider 0–1), **loop** (toggle), **crop start** (number input, seconds,
  0–track duration), **fade in** / **fade out** (sliders 0–5s). The selected
  track's duration is shown for crop context.
- One **Save** collects the whole param set and triggers a single remux (the
  expensive op stays one-per-Save, not per-control). **Reroll** (track) is kept,
  unchanged.
- Save persists to **both** `renders.music_params` (drives the immediate remux)
  **and** `videos.settings.music_params` (so a future re-render inherits the
  tuning, matching how the render path seeds params).

**Out of scope:**

- Music upload UI; per-scene music; AI mood selection (selection stays
  deterministic mood-match); regenerating beds (reroll is reselection-only);
  param presets / reset buttons. No change to ffmpeg, the remux Lambda, the
  selection logic, or the base/final split.

## Architecture

No schema change, no new pure module. Two files change.

### `src/app/(app)/videos/[id]/music-actions.ts`

- **`getMusicPanel(videoId)`** — extend `MusicPanelState` to carry the full
  canonicalized `MusicParams` (today it returns only `masterVolume`) and the
  selected track's `durationSeconds`:

  ```ts
  export interface MusicPanelState {
    available: boolean;
    renderId?: string;
    trackId?: string | null;
    trackTitle?: string | null;
    params?: MusicParams;          // was: masterVolume?: number
    trackDurationSec?: number | null;
    tracks?: { id: string; title: string }[];
    status?: string;
  }
  ```

  Build `params` via `canonicalizeMusicParams(render.music_params)`; read
  `trackDurationSec` from the selected `music_tracks.duration_seconds`.

- **`applyMusic(renderId, opts)`** — widen `opts`:

  ```ts
  export async function applyMusic(
    renderId: string,
    opts: { reroll?: boolean; params?: Partial<MusicParams> },
  ): Promise<{ ok: true } | { ok: false; reason: string }>;
  ```

  - **Reroll path:** unchanged (`rerollMusicTrack` → next track id).
  - **Params path:** `const params = canonicalizeMusicParams({ ...current, ...opts.params })`
    (merge the patch over the render's existing params). Persist:
    1. `UPDATE renders SET music_track_id, music_params=params, status='encoding'`
       (as today, but the full `params`).
    2. `supabase.rpc('merge_video_settings', { p_video_id: videoId, p_patch: {
       music_params: params } })` — so the video's seed params track the tuning.
       Resolve `videoId` from the render row (`renders.video_id`).
  - Emit `music/remux` (unchanged).

  The `merge_video_settings` write is best-effort relative to the remux: if it
  errors, log/return the reason but the render-level write + remux already define
  the immediate result. (Implementation: do the settings merge before emitting
  remux; on its error return `{ ok:false, reason }` so the operator retries — the
  render-level update is idempotent under canonicalized params.)

### `src/app/(app)/videos/[id]/MusicPanel.tsx`

Local state holds the six params (seeded from `panel.params`). Each control binds
to a field; editing marks the panel dirty (the existing busy/error/poll machinery
is unchanged). **Save** calls `applyMusic(renderId, { params: <all six> })` and
runs the existing poll-until-complete loop. The crop input is bounded by
`trackDurationSec` (when known) and shows the track length (e.g. "of 18s").

Controls + ranges (UI ranges within the canonicalize clamps):

| Param | Control | UI range | Canonicalize clamp |
|-------|---------|----------|--------------------|
| masterVolume | slider | 0–0.6, step 0.01 | 0–1 |
| duckingDepth | slider | 0–1, step 0.05 | 0–1 |
| loop | checkbox | — | boolean |
| cropStartSec | number | 0–trackDuration, step 0.5 | 0–3600 |
| fadeInSec | slider | 0–5, step 0.1 | 0–30 |
| fadeOutSec | slider | 0–5, step 0.1 | 0–30 |

## Data flow

```
getMusicPanel(videoId) → canonicalize(render.music_params) + track duration → panel state
panel edits (local) → Save → applyMusic(renderId, { params })
applyMusic → canonicalize(current ⊕ patch)
           → write renders.music_params (status 'encoding')
           → merge_video_settings(videoId, { music_params })
           → emit music/remux
remux Lambda → buildRemuxArgs applies all six → final MP4 → poll → done
reroll → applyMusic(renderId, { reroll:true }) → next track → remux (unchanged)
```

## Error handling

- `canonicalizeMusicParams` clamps every value into range, so no invalid param can
  reach ffmpeg (a crop beyond the track length is clamped, not rejected — `loop`
  also covers short beds).
- `applyMusic` returns `{ ok:false, reason }` on a render/settings/RPC error; the
  panel shows it (existing error display) and keeps the edits.
- The remux-failure path (poll loop sees `status==='failed'`) is unchanged.

## Back-compatibility

- A render with `music_params: {}` → canonicalize yields today's defaults
  (volume 0.18, ducking 0.6, loop on, crop 0, fades 0.5/1.0); the panel shows
  them. A `masterVolume`-only stored value still parses (other fields default).
- `videos.settings.music_params` absent → render seeds defaults exactly as today;
  saving from the panel begins populating it.
- No change to ffmpeg, the remux Lambda, selection, or the schema. Old renders
  are unaffected (their `music_params` already canonicalize).

## Testing

- **Unit:** `canonicalizeMusicParams` is already unit-tested (clamp/default/round
  for every field) — no new pure unit is required. If `music-actions` gains any
  pure helper, test it; otherwise rely on the existing coverage.
- **Regression:** the full suite stays green (`npm test`); `npx tsc --noEmit`
  clean (the `MusicPanelState` shape change + `applyMusic` signature change
  type-check across the panel + any caller).
- **Manual / app-run e2e:** open a completed render's Music panel → adjust
  ducking, loop, crop, fade-in, fade-out, and volume → Save → the remux runs and
  the final MP4 reflects the changes (audibly: harder duck, looped bed, cropped
  in-point, fades) → reload shows the saved params → re-render the video and
  confirm it inherits the tuned params (read from `videos.settings.music_params`)
  → reroll still cycles the track. No render-output gate beyond the remux that the
  panel already triggers.

## Open questions

None. Six always-visible controls (no advanced expander), Save persists to both
`renders.music_params` and `videos.settings.music_params`, one remux per Save, and
the UI ranges above are all settled.
