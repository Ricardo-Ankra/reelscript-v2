'use client';

import { useState } from 'react';
import { updateVideoSettings } from './settings-actions';
import {
  parseVideoSettings,
  type VideoSettings,
  type VideoSettingsPatch,
} from '@/lib/videos/settings';

type SaveState = 'idle' | 'saving' | 'saved' | 'failed';
const saveLabel: Record<SaveState, string> = { idle: '', saving: 'saving…', saved: 'saved ✓', failed: 'save failed' };

// Per-video render settings (Phase 8). Autosaves each control to video.settings via
// the atomic merge action, then reconciles to the returned settings. Changes apply on
// the next render — the panel never auto-renders. target_length is read-only here
// (regenerate-in-place is the next slice).
export function VideoSettingsPanel({
  videoId,
  initialSettings,
}: {
  videoId: string;
  initialSettings: Record<string, unknown>;
}) {
  const [settings, setSettings] = useState<VideoSettings>(() => parseVideoSettings(initialSettings));
  const [saveState, setSaveState] = useState<SaveState>('idle');

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
          onChange={(e) => save({ captions_on: e.target.checked })}
        />
      </label>

      <label className={rowClass}>
        <span className="opacity-80">Emphasis</span>
        <select
          className={ctrlClass}
          value={settings.caption_emphasis_density}
          disabled={!settings.captions_on}
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
          onChange={(e) => save({ music_on: e.target.checked })}
        />
      </label>

      <label className={rowClass}>
        <span className="opacity-80">Aspect ratio</span>
        <select
          className={ctrlClass}
          value={settings.aspect_ratio}
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
          onChange={(e) => save({ fps: Number(e.target.value) as VideoSettings['fps'] })}
        >
          <option value={24}>24</option>
          <option value={30}>30</option>
        </select>
      </label>

      <div className={rowClass}>
        <span className="opacity-80">Length</span>
        <span className="opacity-60">{settings.target_length}s · regenerates — coming next</span>
      </div>

      <p className="opacity-50">Settings apply on the next render.</p>
    </div>
  );
}
