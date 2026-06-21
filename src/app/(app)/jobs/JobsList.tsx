'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import { partitionJobs, jobStatusLabel, isCancellable, type JobRow } from '@/lib/jobs/monitor';
import { cancelJob, loadJobs } from './actions';

export function JobsList({ initial }: { initial: JobRow[] }) {
  const supabase = useMemo(() => createClient(), []);
  const [jobs, setJobs] = useState<JobRow[]>(initial);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setJobs(await loadJobs());
  }, []);

  // Live updates: any change to a job row (insert/update/delete) re-reads the list
  // (so video titles + partitioning stay correct). RLS scopes the rows. Reconcile
  // on subscribe to close the initial-fetch gap (Editor pattern).
  useEffect(() => {
    const channel = supabase
      .channel('jobs-monitor')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'jobs' }, () => {
        void refresh();
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') void refresh();
      });
    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase, refresh]);

  const onCancel = useCallback(async (id: string) => {
    setBusy((p) => new Set(p).add(id));
    setError(null);
    const res = await cancelJob(id);
    if (res.ok) {
      setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, status: 'cancelled' } : j)));
    } else {
      setError(res.reason);
    }
    setBusy((p) => {
      const n = new Set(p);
      n.delete(id);
      return n;
    });
  }, []);

  const { active, recent } = partitionJobs(jobs);

  return (
    <div className="space-y-6">
      {error && <p className="text-sm text-red-600">{error}</p>}

      <section className="space-y-2">
        <h2 className="text-sm font-medium opacity-70">Active ({active.length})</h2>
        {active.length === 0 ? (
          <p className="text-sm opacity-60">No jobs running.</p>
        ) : (
          <ul className="divide-y divide-black/10 rounded-lg border border-black/10 dark:divide-white/10 dark:border-white/10">
            {active.map((j) => (
              <JobItem key={j.id} job={j} busy={busy.has(j.id)} onCancel={() => onCancel(j.id)} />
            ))}
          </ul>
        )}
      </section>

      {recent.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-medium opacity-70">Recent</h2>
          <ul className="divide-y divide-black/10 rounded-lg border border-black/10 dark:divide-white/10 dark:border-white/10">
            {recent.map((j) => (
              <JobItem key={j.id} job={j} busy={false} onCancel={undefined} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function JobItem({
  job,
  busy,
  onCancel,
}: {
  job: JobRow;
  busy: boolean;
  onCancel?: () => void;
}) {
  const phase = job.phase ? ` · ${job.phase}` : '';
  return (
    <li className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-medium">{job.type}</span>
          {job.videoId && job.videoTitle && (
            <Link href={`/videos/${job.videoId}`} className="truncate underline opacity-70 hover:opacity-100">
              {job.videoTitle}
            </Link>
          )}
        </div>
        <div className="text-xs opacity-60">
          {jobStatusLabel(job.status)}
          {phase} · {relativeAge(job.createdAt)}
        </div>
      </div>
      {onCancel && isCancellable(job.status) && (
        <button
          type="button"
          disabled={busy}
          onClick={onCancel}
          className="shrink-0 rounded-md border border-red-500/40 px-2.5 py-1 text-xs font-medium text-red-600 enabled:hover:bg-red-500/10 disabled:opacity-40"
        >
          {busy ? 'Cancelling…' : 'Cancel'}
        </button>
      )}
    </li>
  );
}

function relativeAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
