'use client';

import { useState } from 'react';
import { updateVideoSettings } from './settings-actions';
import { regenerateVideo } from './regenerate-actions';
import {
  parseVideoSettings,
  type VideoSettings,
  type VideoSettingsPatch,
} from '@/lib/videos/settings';
import { COLOR_LOOKS, LOOK_LABELS } from '@/lib/color/looks';

type SaveState = 'idle' | 'saving' | 'saved' | 'failed';
const saveLabel: Record<SaveState, string> = { idle: '', saving: 'saving…', saved: 'saved ✓', failed: 'save failed' };

// Per-video render settings (Phase 8). Autosaves each control to video.settings via
// the atomic merge action, then reconciles to the returned settings. Changes apply on
// the next render — the panel never auto-renders.
export function VideoSettingsPanel({
  videoId,
  initialSettings,
  initialPrompt,
}: {
  videoId: string;
  initialSettings: Record<string, unknown>;
  initialPrompt: string;
}) {
  const [settings, setSettings] = useState<VideoSettings>(() => parseVideoSettings(initialSettings));
  const [saveState, setSaveState] = useState<SaveState>('idle');

  const [regenOpen, setRegenOpen] = useState(false);
  const [prompt, setPrompt] = useState(initialPrompt);
  // settings.target_length is always a number: `settings` is parseVideoSettings(...),
  // which backfills a numeric default (30) for any missing/invalid value. So the
  // number input is never seeded undefined → no empty-input edge case, for new and
  // pre-settings-panel videos alike.
  const [length, setLength] = useState(settings.target_length);
  const [regenBusy, setRegenBusy] = useState(false);
  const [regenError, setRegenError] = useState<string | null>(null);

  async function regenerate() {
    setRegenBusy(true);
    setRegenError(null);
    try {
      const res = await regenerateVideo(videoId, { prompt: prompt.trim(), targetLengthSeconds: Number(length) });
      if (res.ok) {
        setRegenOpen(false); // success: collapse; the editor's Realtime + status pill take over
      } else {
        setRegenError(res.reason); // failure (pre-check OR 23505): keep open, show why
      }
    } catch {
      setRegenError('Something went wrong. Please try again.');
    } finally {
      setRegenBusy(false);
    }
  }

  async function save(patch: VideoSettingsPatch) {
    const prev = settings;
    setSettings((s) => ({ ...s, ...patch })); // optimistic
    setSaveState('saving');
    const res = await updateVideoSettings(videoId, patch);
    if (res.ok) {
      setSettings(parseVideoSettings(res.settings)); // reconcile to what was written
      setSaveState('saved');
    } else {
      setSettings(prev); // revert
      setSaveState('failed');
    }
  }

  const busy = saveState === 'saving';
  const rowClass = 'flex items-center justify-between gap-3';
  const ctrlClass =
    'rounded-md border border-black/15 bg-transparent px-2 py-1 text-xs outline-none focus:border-black/30 dark:border-white/20 dark:focus:border-white/30';

  return (
    <div className="space-y-2 rounded-lg border border-black/10 bg-black/[0.015] px-3 py-2 text-xs dark:border-white/10 dark:bg-white/[0.02]">
      <div className="flex items-center justify-between">
        <span className="font-medium opacity-80">Settings</span>
        <span className="opacity-50">{saveLabel[saveState]}</span>
      </div>

      <label className={rowClass}>
        <span className="opacity-80">Captions</span>
        <input
          type="checkbox"
          checked={settings.captions_on}
          disabled={busy}
          onChange={(e) => save({ captions_on: e.target.checked })}
        />
      </label>

      <label className={rowClass}>
        <span className="opacity-80">Emphasis</span>
        <select
          className={ctrlClass}
          value={settings.caption_emphasis_density}
          disabled={!settings.captions_on || busy}
          onChange={(e) => save({ caption_emphasis_density: e.target.value as VideoSettings['caption_emphasis_density'] })}
        >
          <option value="off">off</option>
          <option value="sparing">sparing</option>
          <option value="liberal">liberal</option>
        </select>
      </label>

      <label className={rowClass}>
        <span className="opacity-80">Music</span>
        <input
          type="checkbox"
          checked={settings.music_on}
          disabled={busy}
          onChange={(e) => save({ music_on: e.target.checked })}
        />
      </label>

      <label className={rowClass}>
        <span className="opacity-80">Aspect ratio</span>
        <select
          className={ctrlClass}
          value={settings.aspect_ratio}
          disabled={busy}
          onChange={(e) => save({ aspect_ratio: e.target.value as VideoSettings['aspect_ratio'] })}
        >
          <option value="9:16">9:16</option>
          <option value="1:1">1:1</option>
          <option value="16:9">16:9</option>
        </select>
      </label>

      <label className={rowClass}>
        <span className="opacity-80">Frame rate</span>
        <select
          className={ctrlClass}
          value={settings.fps}
          disabled={busy}
          onChange={(e) => save({ fps: Number(e.target.value) as VideoSettings['fps'] })}
        >
          <option value={24}>24</option>
          <option value={30}>30</option>
        </select>
      </label>

      <label className={rowClass}>
        <span className="opacity-80">Look</span>
        <select
          className={ctrlClass}
          value={settings.color_look}
          disabled={busy}
          onChange={(e) => save({ color_look: e.target.value as VideoSettings['color_look'] })}
        >
          {COLOR_LOOKS.map((l) => (
            <option key={l} value={l}>
              {LOOK_LABELS[l]}
            </option>
          ))}
        </select>
      </label>

      <div className={rowClass}>
        <span className="opacity-80">Length</span>
        <span className="flex items-center gap-2">
          <span className="opacity-60">{settings.target_length}s</span>
          <button
            type="button"
            className={ctrlClass}
            disabled={busy}
            onClick={() => setRegenOpen((o) => !o)}
          >
            Regenerate…
          </button>
        </span>
      </div>

      {regenOpen && (
        <div className="space-y-2 rounded-md border border-black/15 p-2 dark:border-white/20">
          <div className="font-medium opacity-80">Regenerate video</div>
          <textarea
            className="w-full resize-y rounded-md border border-black/15 bg-transparent p-2 outline-none focus:border-black/30 dark:border-white/20 dark:focus:border-white/30"
            rows={3}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Describe the video…"
            disabled={regenBusy}
          />
          <label className={rowClass}>
            <span className="opacity-80">Length (s)</span>
            <input
              type="number"
              min={5}
              max={180}
              className={ctrlClass}
              value={length}
              disabled={regenBusy}
              onChange={(e) => setLength(Number(e.target.value))}
            />
          </label>
          <p className="text-amber-600">⚠ Replaces the current scenes &amp; audio.</p>
          {regenError && <p className="text-red-600">{regenError}</p>}
          <div className="flex items-center justify-end gap-2">
            <button type="button" className={ctrlClass} disabled={regenBusy} onClick={() => setRegenOpen(false)}>
              Cancel
            </button>
            <button type="button" className={ctrlClass} disabled={regenBusy} onClick={regenerate}>
              {regenBusy ? 'Regenerating…' : 'Regenerate'}
            </button>
          </div>
        </div>
      )}

      <p className="opacity-50">Settings apply on the next render.</p>
    </div>
  );
}
