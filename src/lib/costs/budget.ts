// Pure cost-budget core (V2 Slice 6b). Zero imports: the estimate constants,
// the allow/block decision, the cap-input validator, and a UTC month-start
// helper. The pipeline's budget-check step and the /costs cap control consume
// these. Mirrors the pure style of src/lib/costs/aggregate.ts.

// Rough, documented constants — a stop-gate estimate, NOT precise accounting.
// The pipeline's upcoming spend after the budget check is: generation (per
// generative clip) + compose (Sonnet) + render (Lambda) + ingest (ffmpeg,
// negligible). Voice already ran (entry is post-voice). Tunable here;
// GEN_RATE_USD is a PLACEHOLDER until the real Higgsfield adapter meters
// generation.
export const GEN_RATE_USD = 0.5; // per generative clip (placeholder)
export const PIPELINE_BASELINE_USD = 0.5; // compose + render + ingest baseline, per run

export function estimatePipelineCostUsd(input: { generativeShotCount: number }): number {
  const n = Math.max(0, Math.floor(input.generativeShotCount));
  return PIPELINE_BASELINE_USD + n * GEN_RATE_USD;
}

export interface BudgetInput {
  alertOn: boolean;
  capUsd: number | null; // accounts.monthly_cost_alert_usd
  currentSpendUsd: number; // this account's current-calendar-month cost_events sum
  estimateUsd: number; // estimatePipelineCostUsd(...)
}

export interface BudgetDecision {
  allow: boolean;
  projectedUsd: number; // currentSpendUsd + estimateUsd
  reason?: string; // set only when blocked
}

// Block only when enforcement is on AND a cap is set AND the projection exceeds
// it (strict >). Off / no cap ⇒ allow (byte-identical to pre-6b).
export function budgetDecision(input: BudgetInput): BudgetDecision {
  const projectedUsd = input.currentSpendUsd + input.estimateUsd;
  if (!input.alertOn || input.capUsd == null) {
    return { allow: true, projectedUsd };
  }
  if (projectedUsd > input.capUsd) {
    return {
      allow: false,
      projectedUsd,
      reason: `Projected monthly spend $${projectedUsd.toFixed(2)} would exceed the $${input.capUsd.toFixed(2)} cap.`,
    };
  }
  return { allow: true, projectedUsd };
}

// Validate the cap-control form input. capUsd: a non-negative number, or null /
// '' to clear the cap. enabled: coerced to boolean.
export function parseCostBudgetInput(
  raw: unknown,
): { capUsd: number | null; enabled: boolean } | { error: string } {
  if (typeof raw !== 'object' || raw === null) {
    return { error: 'Invalid input.' };
  }
  const obj = raw as { capUsd?: unknown; enabled?: unknown };
  const enabled = Boolean(obj.enabled);

  if (obj.capUsd == null || obj.capUsd === '') {
    return { capUsd: null, enabled };
  }
  const cap = typeof obj.capUsd === 'number' ? obj.capUsd : Number(obj.capUsd);
  if (!Number.isFinite(cap)) {
    return { error: 'Budget must be a number.' };
  }
  if (cap < 0) {
    return { error: 'Budget cannot be negative.' };
  }
  return { capUsd: cap, enabled };
}

// First-of-month 00:00:00 UTC as an ISO string, for the current-calendar-month
// cost sum. Takes `now` for testability; the caller (inside a step.run body, not
// a workflow script) passes `new Date()`.
export function startOfUtcMonthIso(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}
