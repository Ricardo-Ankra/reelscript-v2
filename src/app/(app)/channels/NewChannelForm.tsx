'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createChannel } from './actions';

// Inline create: a name → createChannel → route to the new channel's detail
// page on success. On failure, keep the form open and show the reason. The
// redirect lives here (not in the action), so the action's return survives.
export function NewChannelForm() {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function onCreate() {
    setBusy(true);
    setError(null);
    try {
      const res = await createChannel(name);
      if (res.ok) {
        router.push(`/channels/${res.channelId}`);
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
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={busy}
          placeholder="New channel name"
          className="flex-1 rounded-md border border-black/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-black/40 disabled:opacity-50 dark:border-white/15 dark:focus:border-white/40"
        />
        <button
          onClick={onCreate}
          disabled={busy || !name.trim()}
          className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background disabled:opacity-50"
        >
          {busy ? 'Creating…' : 'Create channel'}
        </button>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
