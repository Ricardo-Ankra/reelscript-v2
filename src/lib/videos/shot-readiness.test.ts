import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shotReadiness } from './shot-readiness.ts';
import type { VisualBrief } from './visual-brief.ts';

const entity = (name: string | null): VisualBrief => ({
  subject: '',
  action: '',
  setting: '',
  framing: '',
  mood: '',
  specificity: 'entity',
  entity_name: name,
  recommended_source: 'upload',
});

const generic: VisualBrief = {
  subject: '',
  action: '',
  setting: '',
  framing: '',
  mood: '',
  specificity: 'generic',
  entity_name: null,
  recommended_source: 'stock',
};

test('entity with no attached asset → unresolved with named reason', () => {
  const r = shotReadiness({ brief: entity('Rivian R2'), source: 'stock', resourceId: null });
  assert.equal(r.resolved, false);
  if (!r.resolved) assert.match(r.reason, /Rivian R2/);
});

test('entity with an attached resource → resolved', () => {
  const r = shotReadiness({ brief: entity('Rivian R2'), source: 'resource', resourceId: 'res1' });
  assert.equal(r.resolved, true);
});

test('entity with source=resource but null resource_id → unresolved', () => {
  const r = shotReadiness({ brief: entity('Rivian R2'), source: 'resource', resourceId: null });
  assert.equal(r.resolved, false);
});

test('entity with no name → unresolved with generic reason', () => {
  const r = shotReadiness({ brief: entity(null), source: 'stock', resourceId: null });
  assert.equal(r.resolved, false);
  if (!r.resolved) assert.match(r.reason, /attached asset/i);
});

test('generic / abstract / spokesperson / no-brief → resolved', () => {
  assert.equal(shotReadiness({ brief: generic, source: 'stock', resourceId: null }).resolved, true);
  assert.equal(shotReadiness({ brief: null, source: 'stock', resourceId: null }).resolved, true);
});
