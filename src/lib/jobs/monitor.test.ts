import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isCancellable,
  isRetryable,
  jobStatusLabel,
  partitionJobs,
  ACTIVE_JOB_STATUSES,
  type JobRow,
} from './monitor.ts';

test('isCancellable: true for active statuses only', () => {
  for (const s of ['queued', 'running', 'paused']) assert.equal(isCancellable(s), true);
  for (const s of ['failed', 'complete', 'cancelled', 'weird']) assert.equal(isCancellable(s), false);
});

test('ACTIVE_JOB_STATUSES is exactly the three active statuses', () => {
  assert.deepEqual([...ACTIVE_JOB_STATUSES], ['queued', 'running', 'paused']);
});

test('jobStatusLabel: known statuses + unknown fallback', () => {
  assert.equal(jobStatusLabel('queued'), 'Queued');
  assert.equal(jobStatusLabel('running'), 'Running');
  assert.equal(jobStatusLabel('paused'), 'Paused');
  assert.equal(jobStatusLabel('complete'), 'Complete');
  assert.equal(jobStatusLabel('failed'), 'Failed');
  assert.equal(jobStatusLabel('cancelled'), 'Cancelled');
  assert.equal(jobStatusLabel('mystery'), 'mystery');
});

function row(id: string, status: string, createdAt: string, updatedAt: string): JobRow {
  return { id, type: 'render', status, phase: null, videoId: null, videoTitle: null, createdAt, updatedAt, error: null };
}

test('partitionJobs: active (by created desc) vs recent (by updated desc)', () => {
  const rows = [
    row('a', 'running', '2026-06-21T10:00:00Z', '2026-06-21T10:05:00Z'),
    row('b', 'complete', '2026-06-21T09:00:00Z', '2026-06-21T09:30:00Z'),
    row('c', 'queued', '2026-06-21T11:00:00Z', '2026-06-21T11:00:00Z'),
    row('d', 'cancelled', '2026-06-21T08:00:00Z', '2026-06-21T12:00:00Z'),
  ];
  const { active, recent } = partitionJobs(rows);
  assert.deepEqual(active.map((r) => r.id), ['c', 'a']); // created desc
  assert.deepEqual(recent.map((r) => r.id), ['d', 'b']); // updated desc
});

test('isRetryable: only failed/cancelled script_generation', () => {
  assert.equal(isRetryable('script_generation', 'failed'), true);
  assert.equal(isRetryable('script_generation', 'cancelled'), true);
  for (const s of ['queued', 'running', 'complete', 'paused']) {
    assert.equal(isRetryable('script_generation', s), false);
  }
  for (const t of ['render', 'voice_synthesis', 'primitive_deploy']) {
    assert.equal(isRetryable(t, 'failed'), false);
    assert.equal(isRetryable(t, 'cancelled'), false);
  }
});

import { isAwaitingPreview, gatePhaseLabel } from './monitor.ts';

test('isAwaitingPreview: true only for paused + preview phase', () => {
  assert.equal(isAwaitingPreview({ status: 'paused', phase: 'awaiting_preview_review' }), true);
  assert.equal(isAwaitingPreview({ status: 'running', phase: 'awaiting_preview_review' }), false);
  assert.equal(isAwaitingPreview({ status: 'paused', phase: 'rendering' }), false);
  assert.equal(isAwaitingPreview({ status: 'paused', phase: null }), false);
});

test('gatePhaseLabel: friendly for the preview gate, passthrough otherwise', () => {
  assert.equal(gatePhaseLabel('awaiting_preview_review'), 'Awaiting preview review');
  assert.equal(gatePhaseLabel('rendering'), 'rendering');
  assert.equal(gatePhaseLabel(null), '');
});
