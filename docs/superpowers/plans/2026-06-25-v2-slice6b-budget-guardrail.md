# V2 Slice 6b — Budget Guardrail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a pre-fan-out budget check to `reelscriptPipeline` that aborts an auto-produce run before any spend when the account's projected current-month cost would exceed an operator-set cap, plus a cap-setting control on `/costs`.

**Architecture:** A new pure module `src/lib/costs/budget.ts` holds the estimate constants, the allow/block decision, the input validator, and a UTC month-start helper (all unit-tested). The pipeline gains a `budget-check` step (reads the cap + current-month spend + generative-shot count, computes the decision) and a `reject-budget` step (marks render/job `failed` with a `{phase:'budget'}` error) inserted between `mark-running` and the existing fan-out. A `setCostBudget` server action + a small `BudgetControl` client component on `/costs` let the operator set the cap and toggle enforcement, writing the two pre-existing `accounts` columns directly under RLS.

**Tech Stack:** Next.js (App Router) server actions + client components, Supabase (Postgres + RLS), Inngest `step.run`, `node:test` unit tests.

## Global Constraints

- **No migration.** `accounts.monthly_cost_alert_usd` (`numeric(10,2)`, null = unset) and `accounts.monthly_cost_alert_on` (`boolean not null default false`) already exist (`20260604184050_init_schema.sql:97-98`). Do not add any migration.
- **Off ⇒ byte-identical.** When `monthly_cost_alert_on` is false OR `monthly_cost_alert_usd` is null, `budgetDecision` MUST return `allow: true`, so the pipeline behaves exactly as Slice 6a. Every existing account (default `monthly_cost_alert_on = false`) is unaffected.
- **Hard-block the pipeline only.** The guardrail lives ONLY in `reelscriptPipeline`. Do NOT add any check to the manual `Generate Video` / `startVideoRender` path.
- **Boundary semantics:** strict `>` — a projection exactly at the cap is allowed. Cap `0` with enforcement on blocks any non-zero projection (a valid "freeze spend" setting).
- **Estimate is a coarse, documented stop-gate.** `GEN_RATE_USD = 0.5` (per generative clip, a placeholder until real generation metering lands) and `PIPELINE_BASELINE_USD = 0.5` (compose + render + ingest baseline). Tunable in one place.
- **Import discipline:** `node:test` modules (`*.test.ts`) import the module under test by **relative path with the `.ts` extension** (the test loader does not apply the `@/` alias). Build-time files (Inngest functions, server actions, client components) use the `@/` alias.
- **Account write is direct-under-RLS.** The `accounts_owner` policy is `for all using (owner_user_id = auth.uid())`, so a direct `supabase.from('accounts').update(...)` works for the caller's own row. Do NOT add an RPC.
- **Structured error shape:** the budget abort writes `error = { phase: 'budget', message, projectedUsd }` — the shape `parseRenderError` / `RenderErrorCard` already render (Slice A).
- **Gates:** `npm test`, `npm run typecheck`, `npm run lint`, `npm run build` (17/17 routes) all green before each commit's task is considered done. When changing a shared contract, run the FULL `npm test`, not a name-pattern subset.

---

### Task 1: Pure cost-budget core — `src/lib/costs/budget.ts`

**Files:**
- Create: `src/lib/costs/budget.ts`
- Test: `src/lib/costs/budget.test.ts`

**Interfaces:**
- Consumes: nothing (zero imports — pure module, mirrors `src/lib/costs/aggregate.ts`).
- Produces (later tasks rely on these exact signatures):
  - `export const GEN_RATE_USD: number` (= 0.5)
  - `export const PIPELINE_BASELINE_USD: number` (= 0.5)
  - `export function estimatePipelineCostUsd(input: { generativeShotCount: number }): number`
  - `export interface BudgetInput { alertOn: boolean; capUsd: number | null; currentSpendUsd: number; estimateUsd: number }`
  - `export interface BudgetDecision { allow: boolean; projectedUsd: number; reason?: string }`
  - `export function budgetDecision(input: BudgetInput): BudgetDecision`
  - `export function parseCostBudgetInput(raw: unknown): { capUsd: number | null; enabled: boolean } | { error: string }`
  - `export function startOfUtcMonthIso(now: Date): string`

- [ ] **Step 1: Write the failing test**

Create `src/lib/costs/budget.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GEN_RATE_USD,
  PIPELINE_BASELINE_USD,
  estimatePipelineCostUsd,
  budgetDecision,
  parseCostBudgetInput,
  startOfUtcMonthIso,
} from './budget.ts';

test('estimatePipelineCostUsd: baseline + n*rate', () => {
  assert.equal(estimatePipelineCostUsd({ generativeShotCount: 0 }), PIPELINE_BASELINE_USD);
  assert.equal(
    estimatePipelineCostUsd({ generativeShotCount: 3 }),
    PIPELINE_BASELINE_USD + 3 * GEN_RATE_USD,
  );
});

test('estimatePipelineCostUsd: clamps/floors the count', () => {
  assert.equal(estimatePipelineCostUsd({ generativeShotCount: -5 }), PIPELINE_BASELINE_USD);
  assert.equal(
    estimatePipelineCostUsd({ generativeShotCount: 2.9 }),
    PIPELINE_BASELINE_USD + 2 * GEN_RATE_USD,
  );
});

test('budgetDecision: off → allow', () => {
  const d = budgetDecision({ alertOn: false, capUsd: 1, currentSpendUsd: 100, estimateUsd: 100 });
  assert.equal(d.allow, true);
  assert.equal(d.projectedUsd, 200);
  assert.equal(d.reason, undefined);
});

test('budgetDecision: no cap → allow even when on', () => {
  const d = budgetDecision({ alertOn: true, capUsd: null, currentSpendUsd: 100, estimateUsd: 100 });
  assert.equal(d.allow, true);
  assert.equal(d.projectedUsd, 200);
});

test('budgetDecision: under cap → allow', () => {
  const d = budgetDecision({ alertOn: true, capUsd: 50, currentSpendUsd: 10, estimateUsd: 5 });
  assert.equal(d.allow, true);
  assert.equal(d.projectedUsd, 15);
});

test('budgetDecision: over cap → block with reason', () => {
  const d = budgetDecision({ alertOn: true, capUsd: 20, currentSpendUsd: 18, estimateUsd: 5 });
  assert.equal(d.allow, false);
  assert.equal(d.projectedUsd, 23);
  assert.ok(d.reason && d.reason.includes('exceed'));
});

test('budgetDecision: exactly at cap → allow (strict >)', () => {
  const d = budgetDecision({ alertOn: true, capUsd: 23, currentSpendUsd: 18, estimateUsd: 5 });
  assert.equal(d.allow, true);
});

test('budgetDecision: cap 0 + on → blocks any non-zero projection', () => {
  const d = budgetDecision({ alertOn: true, capUsd: 0, currentSpendUsd: 0, estimateUsd: 0.5 });
  assert.equal(d.allow, false);
});

test('parseCostBudgetInput: valid number + enabled', () => {
  assert.deepEqual(parseCostBudgetInput({ capUsd: 25, enabled: true }), {
    capUsd: 25,
    enabled: true,
  });
});

test('parseCostBudgetInput: null clears the cap', () => {
  assert.deepEqual(parseCostBudgetInput({ capUsd: null, enabled: false }), {
    capUsd: null,
    enabled: false,
  });
});

test('parseCostBudgetInput: empty-string cap clears', () => {
  assert.deepEqual(parseCostBudgetInput({ capUsd: '', enabled: false }), {
    capUsd: null,
    enabled: false,
  });
});

test('parseCostBudgetInput: numeric string coerces', () => {
  assert.deepEqual(parseCostBudgetInput({ capUsd: '25.5', enabled: true }), {
    capUsd: 25.5,
    enabled: true,
  });
});

test('parseCostBudgetInput: negative → error', () => {
  const r = parseCostBudgetInput({ capUsd: -1, enabled: true });
  assert.ok('error' in r);
});

test('parseCostBudgetInput: non-number → error', () => {
  const r = parseCostBudgetInput({ capUsd: 'abc', enabled: true });
  assert.ok('error' in r);
});

test('parseCostBudgetInput: non-object → error', () => {
  const r = parseCostBudgetInput(null);
  assert.ok('error' in r);
});

test('startOfUtcMonthIso: returns first-of-month 00:00:00 UTC', () => {
  const now = new Date('2026-06-25T13:45:30.123Z');
  assert.equal(startOfUtcMonthIso(now), '2026-06-01T00:00:00.000Z');
});

test('startOfUtcMonthIso: handles January', () => {
  const now = new Date('2026-01-15T08:00:00.000Z');
  assert.equal(startOfUtcMonthIso(now), '2026-01-01T00:00:00.000Z');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern="budgetDecision|estimatePipelineCostUsd|parseCostBudgetInput|startOfUtcMonthIso"`
Expected: FAIL — `Cannot find module './budget.ts'` (the module does not exist yet).

- [ ] **Step 3: Write the implementation**

Create `src/lib/costs/budget.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --test-name-pattern="budgetDecision|estimatePipelineCostUsd|parseCostBudgetInput|startOfUtcMonthIso"`
Expected: PASS — all budget tests green.

- [ ] **Step 5: Run the full suite + typecheck**

Run: `npm test`
Expected: PASS — full suite green (no shared-contract assertions touched here).

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/costs/budget.ts src/lib/costs/budget.test.ts
git commit -m "feat(v2): pure cost-budget core (estimate + decision + validator + month-start)"
```

---

### Task 2: Guardrail steps in `reelscriptPipeline`

**Files:**
- Modify: `src/lib/inngest/functions/pipeline.ts`

**Interfaces:**
- Consumes (from Task 1, via `@/lib/costs/budget`): `estimatePipelineCostUsd`, `budgetDecision`, `startOfUtcMonthIso`.
- Produces: an early `return { jobId, failed: 'budget' as const }` path; no new exports.

**Context:** `pipeline.ts` (read the current file) defines `reelscriptPipeline`. After the `mark-running` step (line ~27-29) and **before** the `Promise.all([step.invoke('run-generation', …), step.invoke('run-ingest', …)])` fan-out (line ~33-36). In scope: `admin` (a `createAdminClient()` — service-role, no RLS), `jobId`, `videoId`, `accountId`, `renderId`. The existing `check-storyboard` step already shows the scene-ids → generative-shot-count query pattern (lines ~39-49) — mirror it. The handler is `async ({ event, step }: { event: { data: unknown }; step: any })` with an eslint-disable for the `any`.

- [ ] **Step 1: Add the budget import**

In `src/lib/inngest/functions/pipeline.ts`, add to the imports at the top (after the existing `@/lib/...` imports):

```ts
import { estimatePipelineCostUsd, budgetDecision, startOfUtcMonthIso } from '@/lib/costs/budget';
```

- [ ] **Step 2: Insert the `budget-check` + `reject-budget` steps**

Find this block (the `mark-running` step immediately followed by the fan-out comment):

```ts
    await step.run('mark-running', async () => {
      await admin.from('jobs').update({ status: 'running', phase: 'generating' }).eq('id', jobId);
    });

    // Fan-out → fan-in. Both children get the master jobId (cancel cascade). They are
    // idempotent (re-runs only touch shots whose key is still null), so a retry is safe.
    await Promise.all([
```

Insert the budget guardrail **between** the `mark-running` step's closing `});` and the `// Fan-out` comment, so it reads:

```ts
    await step.run('mark-running', async () => {
      await admin.from('jobs').update({ status: 'running', phase: 'generating' }).eq('id', jobId);
    });

    // Budget guardrail (Slice 6b) — pre-fan-out, before any spend. Off / no cap ⇒ always
    // allow ⇒ byte-identical to 6a. Reads the account cap, sums this calendar month's
    // cost_events, counts generative shots, and decides. new Date() is fine here (step.run
    // body, not a workflow script).
    const budget = await step.run('budget-check', async () => {
      const { data: acct } = await admin
        .from('accounts')
        .select('monthly_cost_alert_usd, monthly_cost_alert_on')
        .eq('id', accountId)
        .single();
      const alertOn = Boolean(acct?.monthly_cost_alert_on);
      const capUsd =
        acct?.monthly_cost_alert_usd != null ? Number(acct.monthly_cost_alert_usd) : null;

      const monthStart = startOfUtcMonthIso(new Date());
      const { data: rows } = await admin
        .from('cost_events')
        .select('cost_usd')
        .eq('account_id', accountId)
        .gte('created_at', monthStart);
      const currentSpendUsd = (rows ?? []).reduce(
        (s: number, r: { cost_usd: number | null }) => s + Number(r.cost_usd ?? 0),
        0,
      );

      // Generative shot count for this video (via scene ids — shots have no video_id).
      const { data: scenes } = await admin.from('scenes').select('id').eq('video_id', videoId);
      const sceneIds = (scenes ?? []).map((s: { id: string }) => s.id);
      let generativeShotCount = 0;
      if (sceneIds.length) {
        const { count } = await admin
          .from('shots')
          .select('id', { count: 'exact', head: true })
          .in('scene_id', sceneIds)
          .eq('kind', 'generative');
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
        await admin
          .from('jobs')
          .update({ status: 'failed', phase: 'failed', error })
          .eq('id', jobId);
      });
      return { jobId, failed: 'budget' as const };
    }

    // Fan-out → fan-in. Both children get the master jobId (cancel cascade). They are
    // idempotent (re-runs only touch shots whose key is still null), so a retry is safe.
    await Promise.all([
```

(If `tsc`/`lint` reject the inline parameter type annotations because the `admin` client's row types are already inferred, drop the `: { cost_usd: ... }` / `: { id: string }` annotations and let inference apply — the existing `check-storyboard` step uses `(s) => s.id as string`, so match whichever the surrounding file already does. Prefer matching the existing style in the file.)

- [ ] **Step 3: Typecheck + lint**

Run: `npm run typecheck`
Expected: no errors.

Run: `npm run lint`
Expected: no errors (the file already carries the `eslint-disable` for the `step: any`).

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS — unchanged (no unit test covers the Inngest function itself, matching every prior pipeline slice; the pure core is covered by Task 1).

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: success, 17/17 routes.

- [ ] **Step 6: Commit**

```bash
git add src/lib/inngest/functions/pipeline.ts
git commit -m "feat(v2): pre-fan-out budget guardrail in reelscriptPipeline"
```

---

### Task 3: `setCostBudget` server action

**Files:**
- Create: `src/app/(app)/costs/cost-actions.ts`

**Interfaces:**
- Consumes (from Task 1, via `@/lib/costs/budget`): `parseCostBudgetInput`.
- Produces: `export async function setCostBudget(input: unknown): Promise<{ ok: true } | { ok: false; reason: string }>`.

**Context:** Mirror `src/app/(app)/settings/model-routing-actions.ts` for the `'use server'` + `createClient()` + `{ ok }` result shape, and `src/app/(app)/videos/[id]/gate-actions.ts` for the account-resolve-then-scoped-write pattern. The `accounts_owner` RLS policy (`for all using (owner_user_id = auth.uid())`) permits a direct `.update()` on the caller's own account row — no RPC.

- [ ] **Step 1: Write the implementation**

Create `src/app/(app)/costs/cost-actions.ts`:

```ts
'use server';

import { createClient } from '@/lib/supabase/server';
import { parseCostBudgetInput } from '@/lib/costs/budget';

// Set the account's monthly cost cap + enforcement toggle (V2 Slice 6b). Writes
// the two pre-existing accounts columns directly under RLS (the accounts_owner
// policy scopes the write to the caller's own row). capUsd null/'' clears the cap.
export async function setCostBudget(
  input: unknown,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const parsed = parseCostBudgetInput(input);
  if ('error' in parsed) return { ok: false, reason: parsed.error };

  const supabase = await createClient();
  const { data: account } = await supabase.from('accounts').select('id').maybeSingle();
  if (!account) return { ok: false, reason: 'No account found.' };

  const { error } = await supabase
    .from('accounts')
    .update({
      monthly_cost_alert_usd: parsed.capUsd,
      monthly_cost_alert_on: parsed.enabled,
    })
    .eq('id', account.id as string);
  if (error) return { ok: false, reason: error.message };
  return { ok: true };
}
```

- [ ] **Step 2: Typecheck + lint**

Run: `npm run typecheck`
Expected: no errors.

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(app)/costs/cost-actions.ts"
git commit -m "feat(v2): setCostBudget server action (account cap + enforcement toggle)"
```

---

### Task 4: Cap-setting control on `/costs`

**Files:**
- Create: `src/app/(app)/costs/BudgetControl.tsx`
- Modify: `src/app/(app)/costs/page.tsx`

**Interfaces:**
- Consumes (from Task 3, via `./cost-actions`): `setCostBudget`. From Task 1 (via `@/lib/costs/budget`, in the page): nothing required, but `formatUsd` from `@/lib/costs/aggregate` is already imported in the page for the spend display.
- Produces: `export function BudgetControl({ initialCapUsd, initialEnabled, currentSpendUsd }: { initialCapUsd: number | null; initialEnabled: boolean; currentSpendUsd: number }): JSX.Element`.

**Context:** `BudgetControl` is a client component mirroring `src/app/(app)/settings/ModelRoutingEditor.tsx` (`'use client'` + `useState` + dirty/busy/saved/error + a single Save calling the action). The page is a server component that already computes `grand` (the account's total spend via `totalCost`) and imports `formatUsd`. It must additionally read `monthly_cost_alert_usd` / `monthly_cost_alert_on` from the account and pass them to `BudgetControl`.

- [ ] **Step 1: Write the `BudgetControl` client component**

Create `src/app/(app)/costs/BudgetControl.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { setCostBudget } from './cost-actions';
import { formatUsd } from '@/lib/costs/aggregate';

// Monthly budget cap control (V2 Slice 6b). Sets accounts.monthly_cost_alert_usd
// + monthly_cost_alert_on. When enforcement is on, Auto-produce runs are blocked
// if projected spend exceeds the cap. Mirrors ModelRoutingEditor's dirty-Save.
export function BudgetControl({
  initialCapUsd,
  initialEnabled,
  currentSpendUsd,
}: {
  initialCapUsd: number | null;
  initialEnabled: boolean;
  currentSpendUsd: number;
}) {
  const [cap, setCap] = useState<string>(initialCapUsd != null ? String(initialCapUsd) : '');
  const [enabled, setEnabled] = useState<boolean>(initialEnabled);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function touch() {
    setDirty(true);
    setSaved(false);
  }

  async function onSave() {
    setBusy(true);
    setError(null);
    try {
      const res = await setCostBudget({ capUsd: cap, enabled });
      if (res.ok) {
        setDirty(false);
        setSaved(true);
      } else {
        setError(res.reason);
      }
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-black/10 p-4 dark:border-white/10">
      <div>
        <h2 className="text-lg font-semibold">Monthly budget</h2>
        <p className="text-sm opacity-70">
          Spent this month: {formatUsd(currentSpendUsd)}
          {cap !== '' ? ` of ${formatUsd(Number(cap) || 0)}` : ''}.
        </p>
      </div>

      <label className="flex items-center justify-between gap-4">
        <span className="text-sm font-medium">Monthly cap (USD)</span>
        <input
          type="number"
          min="0"
          step="0.01"
          value={cap}
          placeholder="No cap"
          onChange={(e) => {
            setCap(e.target.value);
            touch();
          }}
          className="w-32 rounded border border-black/15 bg-transparent px-2 py-1.5 text-sm dark:border-white/15"
        />
      </label>

      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => {
            setEnabled(e.target.checked);
            touch();
          }}
        />
        <span className="text-sm">Block Auto-produce runs that would exceed the cap</span>
      </label>

      {enabled && (
        <p className="text-xs opacity-60">
          Auto-produce runs are blocked when projected spend exceeds this. The manual Generate
          Video button is not affected.
        </p>
      )}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onSave}
          disabled={busy || !dirty}
          className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
        {saved && !dirty && <span className="text-sm text-green-600">Saved</span>}
        {error && <span className="text-sm text-red-600">{error}</span>}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire it into the page**

Modify `src/app/(app)/costs/page.tsx`. Add the `BudgetControl` import after the existing imports:

```ts
import { BudgetControl } from './BudgetControl';
```

Add an account read for the cap columns (place it alongside the existing `videos` / `cost_events` reads, before the JSX):

```ts
  const { data: account } = await supabase
    .from('accounts')
    .select('monthly_cost_alert_usd, monthly_cost_alert_on')
    .maybeSingle();
  const capUsd =
    account?.monthly_cost_alert_usd != null ? Number(account.monthly_cost_alert_usd) : null;
  const alertOn = Boolean(account?.monthly_cost_alert_on);
```

Render the control just below the header `</div>` (the `flex items-baseline justify-between` block) and above the `rows.length === 0 ? …` list. Insert:

```tsx
      <BudgetControl initialCapUsd={capUsd} initialEnabled={alertOn} currentSpendUsd={grand} />
```

- [ ] **Step 3: Typecheck + lint**

Run: `npm run typecheck`
Expected: no errors.

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: success, 17/17 routes (the `/costs` route still builds; the page stays a server component, the control is a client island).

- [ ] **Step 5: Full suite**

Run: `npm test`
Expected: PASS — full suite green.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(app)/costs/BudgetControl.tsx" "src/app/(app)/costs/page.tsx"
git commit -m "feat(v2): monthly budget cap control on /costs"
```

---

## Final verification (after all tasks)

- [ ] Run `npm test` — full suite green (includes the new `budget.test.ts`).
- [ ] Run `npm run typecheck` — no errors.
- [ ] Run `npm run lint` — no errors.
- [ ] Run `npm run build` — success, 17/17 routes.
- [ ] Confirm no migration was added (`git diff --stat` shows no file under `supabase/migrations/`).
- [ ] Confirm the manual `Generate Video` / `startVideoRender` path is unchanged (`git diff` touches only `budget.ts`, `budget.test.ts`, `pipeline.ts`, `cost-actions.ts`, `BudgetControl.tsx`, `costs/page.tsx`).

## Operator verification (deferred, not part of this plan's gates)

- `npm run drive:pipeline -- <videoId>` with the cap set low on `/costs` and enforcement on → the run aborts with the `{phase:'budget'}` error (shown via `RenderErrorCard`), render + job left `failed`.
- Same with enforcement off (or cap high/cleared) → the run proceeds exactly as 6a.
- These exercise the Inngest/DB/UI wiring that is intentionally not unit-tested (matching every prior pipeline slice).
