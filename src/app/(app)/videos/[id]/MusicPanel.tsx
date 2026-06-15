'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { getMusicPanel, applyMusic, type MusicPanelState } from './music-actions';
import { getRenderState } from './render-actions';

// Minimal Music panel (Phase 6, spec 6.6): on a completed render, reroll the track or
// nudge master volume → Save kicks an audio-only re-mux (seconds, no re-render). The
// full panel (ducking depth, loop, crop, fade) is Phase 8; the re-mux already accepts
// those params. Mounted under the render preview; renders nothing until there's a
// completed render with a base + a seeded library.
export function MusicPanel({ videoId, onUpdated }: { videoId: string; onUpdated?: (url: string) => void }) {
  const [panel, setPanel] = useState<MusicPanelState | null>(null);
  const [volume, setVolume] = useState(0.18);
  const [busy, setBusy] = useState<string | null>(null); // 'reroll' | 'save' | 'mixing'
  const [error, setError] = useState<string | null>(null);
  const cancelled = useRef(false);

  const load = useCallback(async () => {
    const s = await getMusicPanel(videoId);
    setPanel(s);
    if (s.available && typeof s.masterVolume === 'number') setVolume(s.masterVolume);
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
      const res = await applyMusic(panel.renderId, which === 'reroll' ? { reroll: true } : { masterVolume: volume });
      if (!res.ok) {
        setError(res.reason);
        setBusy(null);
        return;
      }
      await awaitRemux(panel.renderId);
    },
    [panel, volume, awaitRemux],
  );

  if (!panel?.available) return null;
  const disabled = busy !== null;

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
        <label className="flex flex-1 items-center gap-2 opacity-80">
          Volume
          <input
            type="range"
            min={0}
            max={0.6}
            step={0.01}
            value={volume}
            disabled={disabled}
            onChange={(e) => setVolume(Number(e.target.value))}
            className="flex-1"
          />
        </label>
        <button
          type="button"
          disabled={disabled}
          onClick={() => apply('save')}
          className="rounded-md border border-black/15 px-2.5 py-1 font-medium enabled:hover:bg-black/[0.04] disabled:opacity-40 dark:border-white/20 dark:enabled:hover:bg-white/[0.06]"
        >
          {busy === 'save' ? 'Saving…' : 'Save'}
        </button>
      </div>
      {error && <p className="text-red-600">{error}</p>}
    </div>
  );
}
