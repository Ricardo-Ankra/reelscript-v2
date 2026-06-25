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
