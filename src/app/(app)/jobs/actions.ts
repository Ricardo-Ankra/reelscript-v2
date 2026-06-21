'use server';

import { createClient } from '@/lib/supabase/server';
import { inngest } from '@/lib/inngest/client';
import { ACTIVE_JOB_STATUSES, isCancellable, type JobRow } from '@/lib/jobs/monitor';

// Active jobs (any age) + terminal jobs updated in the last 24h, newest first,
// each joined to its video title. RLS scopes to the session account.
export async function loadJobs(): Promise<JobRow[]> {
  const supabase = await createClient();
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data } = await supabase
    .from('jobs')
    .select('id, type, status, phase, video_id, error, created_at, updated_at, videos(title)')
    .or(`status.in.(${ACTIVE_JOB_STATUSES.join(',')}),updated_at.gte.${cutoff}`)
    .order('created_at', { ascending: false });
  return (data ?? []).map((r) => {
    const v = r.videos as { title?: string } | { title?: string }[] | null;
    const videoTitle = Array.isArray(v) ? (v[0]?.title ?? null) : (v?.title ?? null);
    return {
      id: r.id as string,
      type: r.type as string,
      status: r.status as string,
      phase: (r.phase as string | null) ?? null,
      videoId: (r.video_id as string | null) ?? null,
      videoTitle,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
      error: r.error ?? null,
    };
  });
}

// Count of in-flight jobs for the navbar badge.
export async function countActiveJobs(): Promise<number> {
  const supabase = await createClient();
  const { count } = await supabase
    .from('jobs')
    .select('id', { count: 'exact', head: true })
    .in('status', [...ACTIVE_JOB_STATUSES]);
  return count ?? 0;
}

// Cancel a running job: send the cancel event (Inngest cancels the real run), then
// mark the row cancelled. A render job's render row is marked failed+{cancelled} so
// the editor frees up and a fresh render starts clean. Guards ownership + active.
export async function cancelJob(
  jobId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const supabase = await createClient();
  const { data: account } = await supabase.from('accounts').select('id').maybeSingle();
  if (!account) return { ok: false, reason: 'No account found.' };
  const accountId = account.id as string;

  const { data: job } = await supabase
    .from('jobs')
    .select('id, type, status, render_id')
    .eq('id', jobId)
    .eq('account_id', accountId)
    .maybeSingle();
  if (!job) return { ok: false, reason: 'Job not found.' };
  if (!isCancellable(job.status as string)) return { ok: false, reason: 'Job is not running.' };

  try {
    await inngest.send({ name: 'jobs/cancel', data: { jobId, accountId } });
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : 'Could not request cancellation.' };
  }

  const { data: updated, error } = await supabase
    .from('jobs')
    .update({ status: 'cancelled' })
    .eq('id', jobId)
    .eq('account_id', accountId)
    .select('id');
  if (error) return { ok: false, reason: error.message };
  if (!updated || updated.length === 0) return { ok: false, reason: 'Job not found.' };

  if ((job.type as string) === 'render' && job.render_id) {
    await supabase
      .from('renders')
      .update({ status: 'failed', error: { cancelled: true } })
      .eq('id', job.render_id as string)
      .eq('account_id', accountId);
  }

  return { ok: true };
}
