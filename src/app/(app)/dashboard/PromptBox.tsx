'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { startScriptGeneration } from '../videos/actions';

// The Phase 2 entry point: a prompt creates a new video and opens its editor,
// where scenes stream in over Realtime.
export function PromptBox() {
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function onGenerate() {
    setBusy(true);
    setError(null);
    try {
      const { videoId } = await startScriptGeneration(prompt);
      router.push(`/videos/${videoId}`); // leaves this page; keep busy=true
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        disabled={busy}
        rows={3}
        placeholder="Describe the video you want — e.g. “Why your coffee goes cold so fast”"
        className="w-full resize-y rounded-md border border-black/15 bg-transparent p-3 text-sm outline-none focus:border-black/40 disabled:opacity-50 dark:border-white/15 dark:focus:border-white/40"
      />
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
