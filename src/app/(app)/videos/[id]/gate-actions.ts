'use server';

import { createClient } from '@/lib/supabase/server';
import { inngest } from '@/lib/inngest/client';
import { GATE_EVENT, type GateDecision } from '@/lib/gates/gate';

// Resolve a human gate: send the resume event (the suspended render function wakes and
// transitions the job/render). Account-scoped; only a paused job can be resolved. Mirrors
// cancelJob (send-then-let-the-function-transition; no optimistic row write here because
// the function is actively waiting and owns the transition).
export async function resolveGate(
  jobId: string,
  decision: GateDecision,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const supabase = await createClient();
  const { data: account } = await supabase.from('accounts').select('id').maybeSingle();
  if (!account) return { ok: false, reason: 'No account found.' };
  const accountId = account.id as string;

  const { data: job } = await supabase
    .from('jobs')
    .select('id, status')
    .eq('id', jobId)
    .eq('account_id', accountId)
    .maybeSingle();
  if (!job) return { ok: false, reason: 'Job not found.' };
  if (job.status !== 'paused') return { ok: false, reason: 'Job is not awaiting review.' };

  try {
    await inngest.send({ name: GATE_EVENT, data: { jobId, accountId, decision } });
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : 'Could not submit decision.' };
  }
  return { ok: true };
}
