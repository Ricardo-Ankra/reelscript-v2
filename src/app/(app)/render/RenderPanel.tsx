'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { startSampleRender, getRenderState } from './actions';

const TERMINAL = new Set(['complete', 'failed']);

export function RenderPanel() {
  const [renderId, setRenderId] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (timer.current) {
      clearInterval(timer.current);
      timer.current = null;
    }
  }, []);

  useEffect(() => {
    if (!renderId || (status && TERMINAL.has(status))) {
      stopPolling();
      return;
    }
    timer.current = setInterval(async () => {
      try {
        const s = await getRenderState(renderId);
        setStatus(s.status);
        if (s.url) setUrl(s.url);
        if (s.error) setError(s.error);
        if (TERMINAL.has(s.status)) stopPolling();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        stopPolling();
      }
    }, 2000);
    return stopPolling;
  }, [renderId, status, stopPolling]);

  async function onStart() {
    setBusy(true);
    setError(null);
    setUrl(null);
    setStatus(null);
    try {
      const r = await startSampleRender();
      setRenderId(r.renderId);
      setStatus('queued');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <button
        onClick={onStart}
        disabled={busy}
        className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background disabled:opacity-50"
      >
        {busy ? 'Starting…' : 'Render sample video'}
      </button>

      {status && (
        <p className="text-sm">
          <span className="opacity-60">Status:</span>{' '}
          <span className="font-mono">{status}</span>
          {renderId && <span className="opacity-40"> · {renderId.slice(0, 8)}</span>}
        </p>
      )}

      {error && (
        <pre className="overflow-auto rounded-md border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-600">
          {error}
        </pre>
      )}

      {url && (
        <video
          src={url}
          controls
          className="w-full max-w-[320px] rounded-lg border border-black/10 dark:border-white/10"
        />
      )}
    </div>
  );
}
