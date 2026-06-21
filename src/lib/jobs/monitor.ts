// Pure helpers for the jobs monitor (Phase 8). No react/server/network. Shared by
// the /jobs page, the cancel action, and the navbar badge.

export type JobStatus = 'queued' | 'running' | 'paused' | 'failed' | 'complete' | 'cancelled';

// The statuses that mean "in flight" — the ones that can be cancelled and that
// drive the navbar's active count.
export const ACTIVE_JOB_STATUSES = ['queued', 'running', 'paused'] as const;

export function isCancellable(status: string): boolean {
  return (ACTIVE_JOB_STATUSES as readonly string[]).includes(status);
}

const LABELS: Record<string, string> = {
  queued: 'Queued',
  running: 'Running',
  paused: 'Paused',
  complete: 'Complete',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export function jobStatusLabel(status: string): string {
  return LABELS[status] ?? status;
}

export interface JobRow {
  id: string;
  type: string;
  status: string;
  phase: string | null;
  videoId: string | null;
  videoTitle: string | null;
  createdAt: string;
  updatedAt: string;
  error: unknown;
}

// Active first (newest-created first); recent = terminal rows (most recently
// updated first). The 24h window for "recent" is applied at the query, not here.
export function partitionJobs(rows: JobRow[]): { active: JobRow[]; recent: JobRow[] } {
  const active = rows
    .filter((r) => isCancellable(r.status))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const recent = rows
    .filter((r) => !isCancellable(r.status))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { active, recent };
}
