# Full Music Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose all six music mix params in the Music panel (today only volume), and persist tuning to both the current render and the video so re-renders inherit it.

**Architecture:** UI + action plumbing only. `canonicalizeMusicParams` (validation), `renders.music_params` (storage), and the ffmpeg remux (application of all six) already exist. Widen `getMusicPanel`/`applyMusic` to carry the full `MusicParams`, dual-write on Save (`renders.music_params` + `videos.settings.music_params` via `merge_video_settings`), and render the five missing controls.

**Tech Stack:** Next.js App Router (server actions, client component), Supabase RPC (`merge_video_settings`), Inngest (`music/remux`).

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-06-21-full-music-panel-design.md`.
- **No new pure logic / no schema change.** `MusicParams` + `canonicalizeMusicParams` + `DEFAULT_MUSIC_PARAMS` live in `src/lib/music/params.ts` (already tested).
- **Six params:** `masterVolume` (0–1), `duckingDepth` (0–1), `loop` (bool), `cropStartSec` (0–3600), `fadeInSec` (0–30), `fadeOutSec` (0–30) — all clamped by `canonicalizeMusicParams`.
- **Save = one remux.** One `music/remux` per Save (not per control); reroll unchanged.
- **Dual-write order (safe):** merge `videos.settings.music_params` FIRST (abort cleanly on failure — render untouched), THEN update `renders.music_params` + `status='encoding'`, THEN emit `music/remux`. Avoids a render stuck in `encoding` if the settings write fails.
- **Resolve `videoId` from `renders.video_id`** (NOT NULL); `merge_video_settings(p_video_id uuid, p_patch jsonb)`.
- **No-regression:** `npx tsc --noEmit` clean + `npm test` green + `npm run lint` clean (no new unit needed — canonicalize is covered).
- **Commit footer:** `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## File Structure

- `src/app/(app)/videos/[id]/music-actions.ts` (modify) — `MusicPanelState` shape, `getMusicPanel`, `applyMusic`.
- `src/app/(app)/videos/[id]/MusicPanel.tsx` (modify) — six controls + Save.

> **One task:** the two files are interdependent (the action signature change breaks the panel until the panel is updated), so they ship together to keep the tree type-clean.

---

### Task 1: Full music panel (actions + UI)

**Files:**
- Modify: `src/app/(app)/videos/[id]/music-actions.ts`
- Modify: `src/app/(app)/videos/[id]/MusicPanel.tsx`

**Interfaces:**
- Consumes: `canonicalizeMusicParams`, `DEFAULT_MUSIC_PARAMS`, `type MusicParams` from `@/lib/music/params`; `merge_video_settings` RPC; `rerollMusicTrack`/`selectMusicTrack` (unchanged); `getRenderState` (unchanged).
- Produces: `MusicPanelState` with `params?: MusicParams` (replaces `masterVolume?`) + `trackDurationSec?: number | null`; `applyMusic(renderId, { reroll?: boolean; params?: Partial<MusicParams> })`.

- [ ] **Step 1: `music-actions.ts` — update `MusicPanelState`**

Replace the `masterVolume?: number;` field so the interface reads:

```ts
export interface MusicPanelState {
  available: boolean; // false ⇒ no completed render with a base, or empty library
  renderId?: string;
  trackId?: string | null;
  trackTitle?: string | null;
  params?: MusicParams;
  trackDurationSec?: number | null;
  tracks?: { id: string; title: string }[];
  status?: string;
}
```

- [ ] **Step 2: `music-actions.ts` — `getMusicPanel` returns full params + track duration**

Replace the track query + return block (the part from `const { data: trackRows }` to the end of the return) with:

```ts
  const { data: trackRows } = await supabase
    .from('music_tracks')
    .select('id, title, duration_seconds')
    .eq('channel_id', channelId)
    .order('created_at');
  const tracks = (trackRows ?? []).map((t) => ({ id: t.id as string, title: (t.title as string) ?? 'Untitled' }));
  if (tracks.length === 0) return { available: false };

  const params = canonicalizeMusicParams((render.music_params as Partial<MusicParams>) ?? {});
  const currentId = (render.music_track_id as string | null) ?? null;
  const currentRow = (trackRows ?? []).find((t) => (t.id as string) === currentId);
  const trackDurationSec =
    currentRow && currentRow.duration_seconds != null ? Number(currentRow.duration_seconds) : null;
  return {
    available: true,
    renderId,
    trackId: currentId,
    trackTitle: tracks.find((t) => t.id === currentId)?.title ?? null,
    params,
    trackDurationSec,
    tracks,
    status: render.status as string,
  };
```

- [ ] **Step 3: `music-actions.ts` — `applyMusic` signature + params handling + dual-write**

Replace the whole `applyMusic` function (from its `export async function` line to its closing brace) with:

```ts
// Apply a music change to the current render and kick the audio-only re-mux.
export async function applyMusic(
  renderId: string,
  opts: { reroll?: boolean; params?: Partial<MusicParams> },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const supabase = await createClient();

  const { data: render, error } = await supabase
    .from('renders')
    .select('account_id, video_id, music_track_id, music_params')
    .eq('id', renderId)
    .single();
  if (error || !render) return { ok: false, reason: 'render not found' };
  const accountId = render.account_id as string;
  const videoId = render.video_id as string;

  const { data: video } = await supabase
    .from('videos')
    .select('channel_id, settings')
    .eq('id', videoId)
    .single();
  const channelId = video?.channel_id as string | undefined;
  const mood = ((video?.settings as Record<string, unknown>)?.mood as string) ?? 'neutral';
  if (!channelId) return { ok: false, reason: 'no channel' };

  const { data: trackRows } = await supabase.from('music_tracks').select('id, mood_tags').eq('channel_id', channelId);
  const tracks: MusicTrack[] = (trackRows ?? []).map((t) => ({ id: t.id as string, moodTags: (t.mood_tags as string[]) ?? [] }));
  if (tracks.length === 0) return { ok: false, reason: 'no music in library' };

  const currentId = (render.music_track_id as string | null) ?? null;
  const trackId = opts.reroll
    ? (rerollMusicTrack(mood, tracks, currentId)?.id ?? currentId)
    : (currentId ?? selectMusicTrack(mood, tracks)?.id ?? null);
  if (!trackId) return { ok: false, reason: 'no track to apply' };

  const params = canonicalizeMusicParams({
    ...((render.music_params as Partial<MusicParams>) ?? {}),
    ...(opts.params ?? {}),
  });

  // Persist the tuning to the video FIRST (so a future re-render inherits it). Do
  // this before flipping the render to 'encoding' so a settings-write failure can't
  // strand the render mid-encode — the operator just retries.
  const { error: sErr } = await supabase.rpc('merge_video_settings', {
    p_video_id: videoId,
    p_patch: { music_params: params },
  });
  if (sErr) return { ok: false, reason: sErr.message };

  const { error: upErr } = await supabase
    .from('renders')
    .update({ music_track_id: trackId, music_params: params, status: 'encoding' })
    .eq('id', renderId);
  if (upErr) return { ok: false, reason: upErr.message };

  await inngest.send({ name: 'music/remux', data: { renderId, accountId, videoId } });
  return { ok: true };
}
```

- [ ] **Step 4: `MusicPanel.tsx` — replace the component**

Replace the entire file with:

```tsx
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { getMusicPanel, applyMusic, type MusicPanelState } from './music-actions';
import { getRenderState } from './render-actions';
import { DEFAULT_MUSIC_PARAMS, type MusicParams } from '@/lib/music/params';

// Full Music panel (Phase 8, spec 6.6): on a completed render, reroll the track or
// tune the six mix params (volume, ducking, loop, crop, fades) → Save kicks an
// audio-only re-mux (seconds, no re-render) and persists the tuning to the video so
// a re-render inherits it. Reselection only — never generates (spec 4.2.3). Renders
// nothing until there's a completed render with a base + a seeded library.
export function MusicPanel({ videoId, onUpdated }: { videoId: string; onUpdated?: (url: string) => void }) {
  const [panel, setPanel] = useState<MusicPanelState | null>(null);
  const [params, setParams] = useState<MusicParams>(DEFAULT_MUSIC_PARAMS);
  const [busy, setBusy] = useState<string | null>(null); // 'reroll' | 'save' | 'mixing'
  const [error, setError] = useState<string | null>(null);
  const cancelled = useRef(false);

  const load = useCallback(async () => {
    const s = await getMusicPanel(videoId);
    setPanel(s);
    if (s.available && s.params) setParams(s.params);
  }, [videoId]);

  useEffect(() => {
    cancelled.current = false;
    void (async () => {
      await load();
    })();
    return () => {
      cancelled.current = true;
    };
  }, [load]);

  // After kicking a re-mux, poll the render until it leaves 'encoding'.
  const awaitRemux = useCallback(
    async (renderId: string) => {
      setBusy('mixing');
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        if (cancelled.current) return;
        const s = await getRenderState(renderId);
        if (s.status === 'complete') {
          if (s.url) onUpdated?.(s.url);
          await load();
          setBusy(null);
          return;
        }
        if (s.status === 'failed') {
          setError(s.error ?? 'Re-mux failed.');
          setBusy(null);
          return;
        }
      }
      setBusy(null);
      setError('Re-mux timed out.');
    },
    [load, onUpdated],
  );

  const apply = useCallback(
    async (which: 'reroll' | 'save') => {
      if (!panel?.renderId) return;
      setError(null);
      setBusy(which);
      const res = await applyMusic(panel.renderId, which === 'reroll' ? { reroll: true } : { params });
      if (!res.ok) {
        setError(res.reason);
        setBusy(null);
        return;
      }
      await awaitRemux(panel.renderId);
    },
    [panel, params, awaitRemux],
  );

  if (!panel?.available) return null;
  const disabled = busy !== null;
  const set = (patch: Partial<MusicParams>) => setParams((p) => ({ ...p, ...patch }));
  const cropMax = panel.trackDurationSec && panel.trackDurationSec > 0 ? panel.trackDurationSec : 3600;

  return (
    <div className="space-y-2 rounded-lg border border-black/10 bg-black/[0.015] px-3 py-2 text-xs dark:border-white/10 dark:bg-white/[0.02]">
      <div className="flex items-center justify-between">
        <span className="font-medium opacity-80">Music</span>
        <span className="opacity-60">
          {busy === 'mixing' ? 'Re-mixing…' : (panel.trackTitle ?? 'No track selected')}
        </span>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={disabled}
          onClick={() => apply('reroll')}
          className="rounded-md border border-black/15 px-2.5 py-1 font-medium enabled:hover:bg-black/[0.04] disabled:opacity-40 dark:border-white/20 dark:enabled:hover:bg-white/[0.06]"
        >
          {busy === 'reroll' ? 'Rerolling…' : 'Reroll track'}
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => apply('save')}
          className="ml-auto rounded-md border border-black/15 px-2.5 py-1 font-medium enabled:hover:bg-black/[0.04] disabled:opacity-40 dark:border-white/20 dark:enabled:hover:bg-white/[0.06]"
        >
          {busy === 'save' ? 'Saving…' : 'Save'}
        </button>
      </div>

      <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
        <label className="flex items-center gap-2 opacity-80">
          <span className="w-20 shrink-0">Volume {params.masterVolume.toFixed(2)}</span>
          <input
            type="range" min={0} max={0.6} step={0.01} value={params.masterVolume} disabled={disabled}
            onChange={(e) => set({ masterVolume: Number(e.target.value) })} className="flex-1"
          />
        </label>
        <label className="flex items-center gap-2 opacity-80">
          <span className="w-20 shrink-0">Ducking {params.duckingDepth.toFixed(2)}</span>
          <input
            type="range" min={0} max={1} step={0.05} value={params.duckingDepth} disabled={disabled}
            onChange={(e) => set({ duckingDepth: Number(e.target.value) })} className="flex-1"
          />
        </label>
        <label className="flex items-center gap-2 opacity-80">
          <span className="w-20 shrink-0">Fade in {params.fadeInSec.toFixed(1)}s</span>
          <input
            type="range" min={0} max={5} step={0.1} value={params.fadeInSec} disabled={disabled}
            onChange={(e) => set({ fadeInSec: Number(e.target.value) })} className="flex-1"
          />
        </label>
        <label className="flex items-center gap-2 opacity-80">
          <span className="w-20 shrink-0">Fade out {params.fadeOutSec.toFixed(1)}s</span>
          <input
            type="range" min={0} max={5} step={0.1} value={params.fadeOutSec} disabled={disabled}
            onChange={(e) => set({ fadeOutSec: Number(e.target.value) })} className="flex-1"
          />
        </label>
        <label className="flex items-center gap-2 opacity-80">
          <span className="w-20 shrink-0">Crop start</span>
          <input
            type="number" min={0} max={cropMax} step={0.5} value={params.cropStartSec} disabled={disabled}
            onChange={(e) => set({ cropStartSec: Number(e.target.value) })}
            className="w-20 rounded border border-black/15 bg-transparent px-1.5 py-0.5 dark:border-white/15"
          />
          {panel.trackDurationSec != null && <span className="opacity-60">of {panel.trackDurationSec.toFixed(0)}s</span>}
        </label>
        <label className="flex items-center gap-2 opacity-80">
          <input
            type="checkbox" checked={params.loop} disabled={disabled}
            onChange={(e) => set({ loop: e.target.checked })}
          />
          <span>Loop bed</span>
        </label>
      </div>

      {error && <p className="text-red-600">{error}</p>}
    </div>
  );
}
```

- [ ] **Step 5: Type-check, suite, lint**

Run: `npx tsc --noEmit`
Expected: clean (the action's `params`/`applyMusic({params})` and the panel's `panel.params` line up; no `masterVolume` field references remain).

Run: `npm test`
Expected: PASS (no test asserts these shapes).

Run: `npm run lint`
Expected: clean (the old `volume`/`setVolume` state is gone; no unused vars).

- [ ] **Step 6: Commit**

```bash
git add "src/app/(app)/videos/[id]/music-actions.ts" "src/app/(app)/videos/[id]/MusicPanel.tsx"
git commit -m "feat: full music panel (ducking, loop, crop, fades) + dual-write to video settings

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Manual / app-run e2e (operator, after Task 1)

Not an automated task:

1. Open a video with a completed render (base + seeded library) → the Music panel shows all six controls at the render's current params.
2. Adjust ducking, loop, crop start, fade in/out, and volume → Save → the panel polls; the final MP4 reflects the changes (audibly).
3. Reload → the saved params persist.
4. Re-render the video → confirm it inherits the tuned params (read from `videos.settings.music_params`, not reset to defaults).
5. Reroll → still cycles the track (and re-muxes).
6. A render with a track shorter than the crop start → clamped (`loop` covers a short bed); no error.

---

## Self-Review

**1. Spec coverage:**
- Six controls in the panel → Step 4. ✅
- `getMusicPanel` returns full params + track duration → Steps 1-2. ✅
- `applyMusic` accepts full params; dual-write (render + video settings) → Step 3. ✅
- One remux per Save; reroll unchanged → Step 4 (`apply`), Step 3 (reroll path intact). ✅
- Safe write order (settings first, then render, then remux) → Step 3. ✅
- Back-compat (empty `music_params` → defaults; `masterVolume`-only parses) → canonicalize (unchanged). ✅

**2. Placeholder scan:** none — every code step carries complete code; commands have expected output.

**3. Type consistency:** `MusicPanelState.params: MusicParams` + `trackDurationSec` consistent between the action (producer, Steps 1-2) and the panel (consumer, Step 4); `applyMusic(renderId, { reroll?; params? })` consistent between Step 3 (definition) and Step 4 (`apply`). The panel seeds `params` from `DEFAULT_MUSIC_PARAMS` then overwrites from `panel.params` on load — types match `MusicParams`. No `masterVolume` field/opt references remain in either file.
