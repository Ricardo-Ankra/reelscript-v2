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
