'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { startScriptGeneration } from '../actions';
import type { CreateOptions } from '@/lib/videos/create-settings';

// Prompt + all options, prefilled from the channel defaults and overridable. One
// Generate button → startScriptGeneration(prompt, channelId, opts) → open the editor.
export function NewVideoForm({
  channelId,
  initial,
}: {
  channelId: string;
  initial: CreateOptions;
}) {
  const [prompt, setPrompt] = useState('');
  const [opts, setOpts] = useState<CreateOptions>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  function patch(p: Partial<CreateOptions>) {
    setOpts((o) => ({ ...o, ...p }));
  }

  async function onGenerate() {
    setBusy(true);
    setError(null);
    try {
      const { videoId } = await startScriptGeneration(prompt, channelId, opts);
      router.push(`/videos/${videoId}`); // leaves this page; keep busy=true
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  const field = 'block w-full rounded border border-black/15 bg-transparent px-2 py-1.5 text-sm dark:border-white/15';

  return (
    <div className="space-y-4">
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        disabled={busy}
        rows={3}
        placeholder={'Describe the video you want — e.g. "Why your coffee goes cold so fast"'}
        className="w-full resize-y rounded-md border border-black/15 bg-transparent p-3 text-sm outline-none focus:border-black/40 disabled:opacity-50 dark:border-white/15 dark:focus:border-white/40"
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <label className="space-y-1">
          <span className="text-sm font-medium">Aspect ratio</span>
          <select
            value={opts.aspect_ratio}
            onChange={(e) => patch({ aspect_ratio: e.target.value as CreateOptions['aspect_ratio'] })}
            disabled={busy}
            className={field}
          >
            <option value="9:16">9:16</option>
            <option value="1:1">1:1</option>
            <option value="16:9">16:9</option>
          </select>
        </label>

        <label className="space-y-1">
          <span className="text-sm font-medium">Frame rate</span>
          <select
            value={opts.fps}
            onChange={(e) => patch({ fps: Number(e.target.value) as CreateOptions['fps'] })}
            disabled={busy}
            className={field}
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
            value={opts.target_length}
            onChange={(e) => patch({ target_length: Number(e.target.value) })}
            disabled={busy}
            className={field}
          />
        </label>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={opts.captions_on}
            onChange={(e) => patch({ captions_on: e.target.checked })}
            disabled={busy}
          />
          <span className="font-medium">Captions</span>
        </label>

        <label className="space-y-1">
          <span className="text-sm font-medium">Caption density</span>
          <select
            value={opts.caption_emphasis_density}
            onChange={(e) =>
              patch({ caption_emphasis_density: e.target.value as CreateOptions['caption_emphasis_density'] })
            }
            disabled={busy || !opts.captions_on}
            className={field}
          >
            <option value="off">off</option>
            <option value="sparing">sparing</option>
            <option value="liberal">liberal</option>
          </select>
        </label>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={opts.music_on}
            onChange={(e) => patch({ music_on: e.target.checked })}
            disabled={busy}
          />
          <span className="font-medium">Music</span>
        </label>
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={onGenerate}
          disabled={busy || !prompt.trim()}
          className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background disabled:opacity-50"
        >
          {busy ? 'Generating…' : 'Generate script'}
        </button>
        {busy && <span className="text-sm opacity-60">Creating your video…</span>}
      </div>
      {error && (
        <pre className="overflow-auto rounded-md border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-600">
          {error}
        </pre>
      )}
    </div>
  );
}
