import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GATE_EVENT,
  GATE_TIMEOUT,
  GATE_PHASE,
  parseGateDecision,
  gateResolution,
} from './gate.ts';

test('gate constants', () => {
  assert.equal(GATE_EVENT, 'pipeline/gate.resolved');
  assert.equal(GATE_TIMEOUT, '7d');
  assert.equal(GATE_PHASE.storyboard, 'awaiting_storyboard_review');
  assert.equal(GATE_PHASE.preview, 'awaiting_preview_review');
});

test('parseGateDecision accepts the two decisions, rejects anything else', () => {
  assert.equal(parseGateDecision('approve'), 'approve');
  assert.equal(parseGateDecision('reject'), 'reject');
  assert.equal(parseGateDecision('bogus'), null);
  assert.equal(parseGateDecision(undefined), null);
  assert.equal(parseGateDecision(1), null);
});

test('gateResolution: null (timeout) and malformed → reject; valid passes through', () => {
  assert.equal(gateResolution(null), 'reject');
  assert.equal(gateResolution({ data: { decision: 'approve' } }), 'approve');
  assert.equal(gateResolution({ data: { decision: 'reject' } }), 'reject');
  assert.equal(gateResolution({ data: { decision: 'bogus' } }), 'reject');
  assert.equal(gateResolution({ data: {} }), 'reject');
  assert.equal(gateResolution({}), 'reject');
});
