import { createAdminClient } from '@/lib/supabase/admin';
import { GATE_EVENT, GATE_TIMEOUT, GATE_PHASE, gateResolution, type GateKind, type GateDecision } from '@/lib/gates/gate';

// Human gate (V2 Slice 4, extracted to share with the master pipeline in Slice 6a): pause
// the job durably, then suspend the run waiting for the in-app Approve/Reject event
// (correlated on jobId — the same key cancelOn uses, so a jobs/cancel still cancels a run
// suspended here). A timeout/malformed event → reject. `step` is `any` to match the other
// Inngest helpers (Inngest's step types are awkward to thread).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function runGate(step: any, admin: ReturnType<typeof createAdminClient>, opts: { jobId: string; kind: GateKind }): Promise<GateDecision> {
  await step.run(`enter-gate-${opts.kind}`, async () => {
    await admin.from('jobs').update({ status: 'paused', phase: GATE_PHASE[opts.kind] }).eq('id', opts.jobId);
  });
  const ev = await step.waitForEvent(`human-gate-${opts.kind}`, {
    event: GATE_EVENT,
    timeout: GATE_TIMEOUT,
    if: 'async.data.jobId == event.data.jobId',
  });
  return gateResolution(ev as { data?: { decision?: unknown } } | null);
}
