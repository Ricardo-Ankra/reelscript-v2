'use client';

import { useState } from 'react';
import { saveChannelVideoDefaults } from './video-defaults-actions';
import type { VideoDefaultsForm } from '@/lib/channels/video-defaults';

// Channel video-format defaults editor (Phase 8 follow-on). Aspect ratio, frame
// rate, and target length stored in channels.defaults; new videos snapshot these
// at creation. Single dirty-tracked Save. Mirrors the prior channel editors.
export function VideoDefaultsEditor({
  channelId,
  initial,
}: {
  channelId: string;
  initial: VideoDefaultsForm;
}) {
  const [form, setForm] = useState<VideoDefaultsForm>(initial);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function patch(p: Partial<VideoDefaultsForm>) {
    setForm((f) => ({ ...f, ...p }));
    setDirty(true);
    setSaved(false);
  }

  async function onSave() {
    setBusy(true);
    setError(null);
    try {
      const res = await saveChannelVideoDefaults(channelId, form);
      if (res.ok) {
        setDirty(false);
        setSaved(true);
      } else {
        setError(res.reason);
      }
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Video defaults</h2>
        <p className="text-sm opacity-70">
          The format new videos in this channel start from. You can still override per video.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <label className="space-y-1">
          <span className="text-sm font-medium">Aspect ratio</span>
          <select
            value={form.aspectRatio}
            onChange={(e) => patch({ aspectRatio: e.target.value as VideoDefaultsForm['aspectRatio'] })}
            className="block w-full rounded border border-black/15 bg-transparent px-2 py-1.5 text-sm dark:border-white/15"
          >
            <option value="9:16">9:16</option>
            <option value="1:1">1:1</option>
            <option value="16:9">16:9</option>
          </select>
        </label>

        <label className="space-y-1">
          <span className="text-sm font-medium">Frame rate</span>
          <select
            value={form.fps}
            onChange={(e) => patch({ fps: Number(e.target.value) as VideoDefaultsForm['fps'] })}
            className="block w-full rounded border border-black/15 bg-transparent px-2 py-1.5 text-sm dark:border-white/15"
          >
            <option value={24}>24</option>
            <option value={30}>30</option>
          </select>
        </label>

        <label className="space-y-1">
          <span className="text-sm font-medium">Target length (s)</span>
          <input
            type="number"
            min={5}
            max={180}
            step={1}
            value={form.targetLength}
            onChange={(e) => patch({ targetLength: Number(e.target.value) })}
            className="block w-full rounded border border-black/15 bg-transparent px-2 py-1.5 text-sm dark:border-white/15"
          />
        </label>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onSave}
          disabled={busy || !dirty}
          className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
        {saved && !dirty && <span className="text-sm text-green-600">Saved</span>}
        {error && <span className="text-sm text-red-600">{error}</span>}
      </div>
    </div>
  );
}
