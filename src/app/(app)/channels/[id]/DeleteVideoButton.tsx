'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { deleteVideo } from '@/app/(app)/videos/[id]/delete-actions';

// Per-row delete on the channel Videos list. Confirms, calls deleteVideo, and
// refreshes the server-rendered list on success.
export function DeleteVideoButton({ videoId }: { videoId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function onClick() {
    if (!confirm('Delete this video? This permanently removes its scenes, audio, and renders.')) return;
    setBusy(true);
    setError(null);
    const res = await deleteVideo(videoId);
    if (res.ok) {
      router.refresh();
      return;
    }
    setError(res.reason);
    setBusy(false);
  }

  return (
    <span className="flex shrink-0 items-center gap-2">
      {error && <span className="text-xs text-red-600">{error}</span>}
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        className="rounded-md border border-red-500/40 px-2 py-0.5 text-xs font-medium text-red-600 enabled:hover:bg-red-500/10 disabled:opacity-40"
      >
        {busy ? 'Deleting…' : 'Delete'}
      </button>
    </span>
  );
}
