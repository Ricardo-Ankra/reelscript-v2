# Reelscript V2 — Slice 6b: Budget guardrail — Design

> **Reelscript V2 program, Slice 6 (master orchestration), sub-slice 6b.**
> Slice 6a shipped the master `reelscript.pipeline` spine. 6b adds the **budget guardrail**:
> a pre-fan-out cost check in the pipeline that aborts the run before any spend when the
> account's projected monthly cost would exceed a set cap. It enforces the existing
> `accounts.monthly_cost_alert_usd` / `monthly_cost_alert_on` columns (read/written nowhere
> today) and adds a small cap-setting control on `/costs`.

## 0. Context & locked decisions

- **Program runtime/data** locked in the V2 program (Next.js + Supabase + RLS + Inngest +
  Remotion Lambda + R2). See `2026-06-24-v2-slice0-shot-model-contract-design.md` §0.
- **6b decisions (this doc):**
  1. **Hard-block the pipeline only** (operator choice). When enforcement is on and the
     projection exceeds the cap, the `reelscript.pipeline` run aborts **before any spend**.
     The manual `Generate Video` (`startVideoRender`) path stays **unguarded** (a deliberate,
     per-step operator action). Strongest safety on the big-spend auto path; smallest surface.
  2. **Monthly aggregate** — the existing column is `monthly_cost_alert_usd`. Current spend =
     `SUM(cost_events.cost_usd)` for the account in the **current calendar month**. (No
     per-video cap — YAGNI.)
  3. **Coarse pre-flight estimate, by design.** A precise projection is impossible pre-run:
     compose tokens, render frames, and generation are not known until they execute, and
     **generation cost is not metered yet** (the Higgsfield adapter is still the fake). The
     estimate is a documented, deliberately rough stop-gate from a few constants, tunable in
     one place; the per-generative-clip rate is a **placeholder until real metering lands**.
  4. **Off ⇒ byte-identical.** When `monthly_cost_alert_on` is false or no cap is set, the
     guardrail always allows — the pipeline behaves exactly as 6a.
  5. **Cap is operator-set on `/costs`** — the columns have no UI today; 6b adds a minimal
     control (set the monthly cap + toggle enforcement) on the existing cost rollup page.
- **No migration** — `accounts.monthly_cost_alert_usd` (`numeric(10,2)`, null = unset) and
  `monthly_cost_alert_on` (`boolean default false`) already exist
  (`20260604184050_init_schema.sql:97-98`).

## 1. Goal & non-goals

**Goal.** Before a `reelscript.pipeline` run fans out generation/ingest/render, check the
account's current-month spend plus a coarse estimate of this run against the operator-set
monthly cap; if enforcement is on and the projection exceeds the cap, abort the run cleanly
(structured `{phase:'budget'}` error, no spend) — and let the operator set/clear the cap on
`/costs`.

**Non-goals (deferred).** No enforcement on the manual `Generate Video` path. No per-video
cap. No precise cost projection (the estimate is coarse — compose/render/generation costs are
not known pre-run; generation isn't metered). No generation cost metering (lands with the
real Higgsfield adapter). No mid-run budget kill (the check is pre-flight only — once a run is
approved it completes; this is a start-gate, not a circuit-breaker). No email/alerting (the
"alert" column is repurposed as an enforcement toggle). No change to `cost_events` recording,
the cost rollup math, or any other pipeline step.

## 2. Current state (anchors)

- `src/lib/inngest/functions/pipeline.ts` — `reelscriptPipeline`. After `mark-running` (sets
  job `running`/`generating`) and **before** the `Promise.all([step.invoke(generateShots),
  step.invoke(ingestShots)])` fan-out. **6b inserts a `budget-check` step here.** `admin`,
  `jobId`, `videoId`, `accountId`, `renderId` are in scope.
- `src/lib/costs/aggregate.ts` — pure cost helpers (`totalCost`, `sumByVideo`, `formatUsd`).
  **6b adds a sibling pure module `src/lib/costs/budget.ts`** (estimate + decision).
- `accounts.monthly_cost_alert_usd` (`numeric(10,2)`, null = unset) + `monthly_cost_alert_on`
  (`boolean default false`) — exist, **read/written nowhere in `src/`**.
- `cost_events(account_id, video_id, render_id, operation, provider, units, cost_usd,
  created_at)` — the spend ledger. The month sum is `SUM(cost_usd) WHERE account_id = … AND
  created_at >= <first of this month, UTC>`.
- Cost rates already in code (for reference, not reused directly): `SONNET_USD_PER_1M_IN=3`,
  `SONNET_USD_PER_1M_OUT=15` (`render.ts:68-69`); render Lambda cost is the actual
  `outputUrl.costUsd`; voice is `estimateUsd(text.length)`. **Generation writes NO cost_event
  yet** (fake provider) — the guardrail's generation estimate is a placeholder.
- `src/app/(app)/costs/page.tsx` — the account cost rollup (server component, RLS reads).
  **6b adds a cap-setting control here** + a `setCostBudget` action.
- `src/components/RenderErrorCard.tsx` + `parseRenderError` — render the structured
  `{phase, message}` error shape (Slice A). The budget abort uses that shape.
- Tests: `npm test` = `node --experimental-strip-types --import ./scripts/register-loader.mjs
  --test "src/**/*.test.ts"`.

## 3. The pure cores — `src/lib/costs/budget.ts` (+ test)

Pure (no react/server/network), unit-tested. The single source of the estimate constants +
the allow/block decision.

```ts
// Rough, documented constants — a stop-gate estimate, not precise accounting. The pipeline's
// upcoming spend after the budget check is: generation (per generative clip) + compose
// (Sonnet) + render (Lambda) + ingest (ffmpeg, negligible). voice already ran (entry is
// post-voice). These are tunable here; GEN_RATE_USD is a PLACEHOLDER until the real Higgsfield
// adapter meters generation.
export const GEN_RATE_USD = 0.5;          // per generative clip (placeholder)
export const PIPELINE_BASELINE_USD = 0.5; // compose + render + ingest baseline, per run

export function estimatePipelineCostUsd(input: { generativeShotCount: number }): number {
  const n = Math.max(0, Math.floor(input.generativeShotCount));
  return PIPELINE_BASELINE_USD + n * GEN_RATE_USD;
}

export interface BudgetInput {
  alertOn: boolean;
  capUsd: number | null;       // accounts.monthly_cost_alert_usd
  currentSpendUsd: number;     // this account's current-calendar-month cost_events sum
  estimateUsd: number;         // estimatePipelineCostUsd(...)
}
export interface BudgetDecision {
  allow: boolean;
  projectedUsd: number;        // currentSpendUsd + estimateUsd
  reason?: string;             // set only when blocked
}

// Block only when enforcement is on AND a cap is set AND the projection exceeds it.
// Off / no cap ⇒ allow (byte-identical to pre-6b).
export function budgetDecision(input: BudgetInput): BudgetDecision;
```

- `budgetDecision`: `projectedUsd = currentSpendUsd + estimateUsd`. If `!alertOn || capUsd ==
  null` → `{ allow: true, projectedUsd }`. Else if `projectedUsd > capUsd` → `{ allow: false,
  projectedUsd, reason: 'Projected monthly spend $X would exceed the $Y cap.' }`. Else `{
  allow: true, projectedUsd }`. (A `capUsd` of 0 with `alertOn` blocks any non-zero
  projection — a valid "freeze spend" setting.)

Tested: estimate formula (baseline + n·rate; n floored/clamped at 0); decision off→allow,
no-cap→allow, under-cap→allow, over-cap→block-with-reason, exactly-at-cap→allow (strict `>`),
cap-0→block.

## 4. The guardrail step — `budget-check` in `reelscriptPipeline`

Insert immediately after `mark-running`, before the fan-out:

```ts
const budget = await step.run('budget-check', async () => {
  const { data: acct } = await admin
    .from('accounts')
    .select('monthly_cost_alert_usd, monthly_cost_alert_on')
    .eq('id', accountId)
    .single();
  const alertOn = Boolean(acct?.monthly_cost_alert_on);
  const capUsd = acct?.monthly_cost_alert_usd != null ? Number(acct.monthly_cost_alert_usd) : null;

  // Current-calendar-month spend (UTC month start). Sum cost_events.cost_usd for the account.
  const monthStart = startOfUtcMonthIso();                 // helper (pure, tested)
  const { data: rows } = await admin
    .from('cost_events')
    .select('cost_usd')
    .eq('account_id', accountId)
    .gte('created_at', monthStart);
  const currentSpendUsd = (rows ?? []).reduce((s, r) => s + Number(r.cost_usd ?? 0), 0);

  // Generative shot count for this video (via scene ids — shots have no video_id).
  const { data: scenes } = await admin.from('scenes').select('id').eq('video_id', videoId);
  const sceneIds = (scenes ?? []).map((s) => s.id as string);
  let generativeShotCount = 0;
  if (sceneIds.length) {
    const { count } = await admin.from('shots')
      .select('id', { count: 'exact', head: true })
      .in('scene_id', sceneIds).eq('kind', 'generative');
    generativeShotCount = count ?? 0;
  }

  const estimateUsd = estimatePipelineCostUsd({ generativeShotCount });
  return budgetDecision({ alertOn, capUsd, currentSpendUsd, estimateUsd });
});

if (!budget.allow) {
  await step.run('reject-budget', async () => {
    const error = {
      phase: 'budget',
      message: budget.reason ?? 'Projected monthly spend would exceed the cap.',
      projectedUsd: budget.projectedUsd,
    };
    await admin.from('renders').update({ status: 'failed', error }).eq('id', renderId);
    await admin.from('jobs').update({ status: 'failed', phase: 'failed', error }).eq('id', jobId);
  });
  return { jobId, failed: 'budget' as const };
}
// allow → fall through to the unchanged fan-out
```

- `startOfUtcMonthIso()` — a tiny pure helper (in `budget.ts`, tested) returning the ISO
  string for 00:00:00 UTC on the first of the current month. **Inngest scripts forbid argless
  `new Date()`** — but this runs inside a `step.run` in the function body, NOT in a workflow
  script, so `new Date()` is allowed here (the same way `render.ts` uses
  `new Date().toISOString()`). The helper takes `now: Date` as a param for testability and the
  step passes `new Date()`.
- The error shape `{phase:'budget', message, projectedUsd}` is the structured form
  `parseRenderError`/`RenderErrorCard` already render (Slice A) — the editor + `/jobs` show it.
- Off / no cap ⇒ `budget.allow` is always true ⇒ the block is skipped ⇒ byte-identical to 6a.
- The check is a **single extra step before the spend**; on a re-trigger it re-runs (cheap
  reads), which is correct (the cap may have changed).

## 5. Cap-setting UI — `/costs`

- `src/app/(app)/costs/cost-actions.ts` (create): `setCostBudget({ capUsd, enabled }): Promise<
  {ok:true} | {ok:false; reason:string}>` — account-scoped (`accounts` under RLS), validates
  `capUsd` (a non-negative number, or null to clear), writes `monthly_cost_alert_usd` +
  `monthly_cost_alert_on`. Pure `parseCostBudgetInput(raw): { capUsd: number | null; enabled:
  boolean } | { error: string }` (in `budget.ts`, tested) does the validation.
- `src/app/(app)/costs/page.tsx` (modify): read the account's current
  `monthly_cost_alert_usd`/`monthly_cost_alert_on`, render a small **Monthly budget** control
  (a number input prefilled with the cap + an enable checkbox + Save) via a small client
  component (`BudgetControl`) calling `setCostBudget`. Shows the current spend (already
  computed on the page) alongside, so the operator sees spend vs cap. When enforcement is on,
  a one-line note: "Auto-produce runs are blocked when projected spend exceeds this."

## 6. Testing

- **Unit (node:test):** `budget.ts` — `estimatePipelineCostUsd` (formula, clamp), `budgetDecision`
  (off/no-cap/under/over/at-boundary/cap-0), `parseCostBudgetInput` (valid number, null-clear,
  negative→error, non-number→error), `startOfUtcMonthIso(now)` (a fixed `now` → the expected
  UTC month-start ISO).
- **Guardrail + UI:** the `budget-check` step, `setCostBudget`, and the `/costs` control are
  verified via the operator path (`drive:pipeline` with the cap set low → the run aborts with
  the budget error; cap off/high → the run proceeds) — the Inngest/DB/UI wiring is not
  unit-tested (matching every prior pipeline slice).
- **Gates:** `npm test`, `npm run typecheck`, `npm run lint`, `npm run build` all green.
- **No migration.**

## 7. Backward compatibility

Additive. The guardrail is a single pre-fan-out step that **allows unless enforcement is
explicitly on with a cap set** — so every existing account (default `monthly_cost_alert_on =
false`) runs the pipeline byte-identically to 6a. The manual `Generate Video` path, the
`cost_events` recording, the cost rollup, and all other pipeline steps are untouched. The
cap-setting UI writes only the two pre-existing `accounts` columns. No schema change.

## 8. File structure (drives the plan)

| File | Responsibility |
| --- | --- |
| `src/lib/costs/budget.ts` (create) + test | `estimatePipelineCostUsd`, `budgetDecision`, `parseCostBudgetInput`, `startOfUtcMonthIso` |
| `src/lib/inngest/functions/pipeline.ts` (modify) | `budget-check` + `reject-budget` steps (pre-fan-out) |
| `src/app/(app)/costs/cost-actions.ts` (create) | `setCostBudget` server action |
| `src/app/(app)/costs/page.tsx` (modify) + `BudgetControl.tsx` (create) | cap + enable control, prefilled from the account |

## 9. Open items (resolved-by-default; flagged for the plan)

- **Estimate constants are rough + documented** (`GEN_RATE_USD`/`PIPELINE_BASELINE_USD`); the
  generation rate is a placeholder until the real Higgsfield adapter meters generation, at
  which point this is the single tuning point (or it switches to a per-account rate).
- **`new Date()` in the step** is allowed (the function body / `step.run`, not a workflow
  script); the pure `startOfUtcMonthIso` takes `now: Date` for testability.
- **Boundary semantics:** strict `>` (projection exactly at the cap is allowed). Cap `0` +
  enforcement blocks any non-zero projection (a valid freeze).
- **Re-trigger:** `budget-check` re-runs on each pipeline start (cheap), reflecting the latest
  cap — correct.
- **Surfacing:** the `{phase:'budget'}` error rides the existing `RenderErrorCard`; no new UI
  beyond the cap control. A blocked run leaves the render/job `failed` (recoverable: the
  operator raises/clears the cap and re-triggers).
