// Pure helpers for the jobs monitor (Phase 8). No react/server/network. Shared by
// the /jobs page, the cancel action, and the navbar badge.

import { GATE_PHASE } from '../gates/gate';

export type JobStatus = 'queued' | 'running' | 'paused' | 'failed' | 'complete' | 'cancelled';

// The statuses that mean "in flight" — the ones that can be cancelled and that
// drive the navbar's active count.
export const ACTIVE_JOB_STATUSES = ['queued', 'running', 'paused'] as const;

export function isCancellable(status: string): boolean {
  return (ACTIVE_JOB_STATUSES as readonly string[]).includes(status);
}

// A failed or cancelled script-generation job can be re-run in place. (Render
// "retry" is the editor's Generate Video; voice/deploy retry is out of scope.)
export function isRetryable(type: string, status: string): boolean {
  return type === 'script_generation' && (status === 'failed' || status === 'cancelled');
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

// A render job suspended at the preview gate (state lives on the job — Slice 4).
export function isAwaitingPreview(job: { status: string; phase: string | null }): boolean {
  return job.status === 'paused' && job.phase === GATE_PHASE.preview;
}

// A pipeline job suspended at the G1 storyboard gate (V2 Slice 6a).
export function isAwaitingStoryboard(job: { status: string; phase: string | null }): boolean {
  return job.status === 'paused' && job.phase === GATE_PHASE.storyboard;
}

// Friendly label for a gate phase; falls through to the raw phase (or '' for null).
const GATE_PHASE_LABELS: Record<string, string> = {
  [GATE_PHASE.preview]: 'Awaiting preview review',
  [GATE_PHASE.storyboard]: 'Awaiting storyboard review',
};
export function gatePhaseLabel(phase: string | null): string {
  if (!phase) return '';
  return GATE_PHASE_LABELS[phase] ?? phase;
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
