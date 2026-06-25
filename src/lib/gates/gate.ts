// Human-gate vocabulary (V2 Slice 4). PURE — no react/server/network. The single source
// of the gate kinds, the resume-event name, the durable phase labels, and the decision
// parsing. The Inngest `runGate` helper (render.ts) and the resolveGate action consume
// these. Distinct from the AUTOMATED gate1/gate2 (compose-validation + smoke-frame QA) in
// render.ts — those are machine checks, these are human-in-the-loop.

export type GateKind = 'storyboard' | 'preview';
export type GateDecision = 'approve' | 'reject';

// The event the in-app Approve/Reject UI sends; the suspended function waits for it.
export const GATE_EVENT = 'pipeline/gate.resolved';
// Inngest duration string. On expiry the wait resolves to null → reject (never ship
// an unreviewed render).
export const GATE_TIMEOUT = '7d';

// The jobs.phase string written while a run is paused at each gate.
export const GATE_PHASE: Record<GateKind, string> = {
  storyboard: 'awaiting_storyboard_review',
  preview: 'awaiting_preview_review',
};

// Never-throws. Validates an incoming event's decision field.
export function parseGateDecision(raw: unknown): GateDecision | null {
  return raw === 'approve' || raw === 'reject' ? raw : null;
}

// Maps a waitForEvent result to a decision. null (timeout / no match) → 'reject';
// a malformed decision → 'reject' (safe default).
export function gateResolution(event: { data?: { decision?: unknown } } | null): GateDecision {
  if (!event) return 'reject';
  return parseGateDecision(event.data?.decision) ?? 'reject';
}
