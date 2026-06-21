import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MODEL_TASKS,
  DEFAULT_MODELS,
  MODEL_ALLOWLIST,
  parseModelRouting,
  validateModelRoutingForm,
} from './model-routing.ts';

const ALLOWED = new Set(MODEL_ALLOWLIST.map((m) => m.id));

test('every DEFAULT_MODELS value is in the allowlist', () => {
  for (const task of MODEL_TASKS) assert.ok(ALLOWED.has(DEFAULT_MODELS[task]), task);
});

test('parseModelRouting: empty → DEFAULT_MODELS', () => {
  assert.deepEqual(parseModelRouting({}), DEFAULT_MODELS);
});

test('parseModelRouting: null / garbage → DEFAULT_MODELS', () => {
  assert.deepEqual(parseModelRouting(null), DEFAULT_MODELS);
  assert.deepEqual(parseModelRouting('nope'), DEFAULT_MODELS);
});

test('parseModelRouting: partial object backfills missing tasks', () => {
  const r = parseModelRouting({ script_generation: 'claude-sonnet-4-6' });
  assert.equal(r.script_generation, 'claude-sonnet-4-6');
  assert.equal(r.video_composition, DEFAULT_MODELS.video_composition);
  assert.equal(r.caption_emphasis, DEFAULT_MODELS.caption_emphasis);
});

test('parseModelRouting: a non-allowlisted stored id → that task default', () => {
  const r = parseModelRouting({ video_composition: 'gpt-4o', caption_emphasis: 'made-up' });
  assert.equal(r.video_composition, DEFAULT_MODELS.video_composition);
  assert.equal(r.caption_emphasis, DEFAULT_MODELS.caption_emphasis);
});

test('parseModelRouting: ignores unknown keys', () => {
  const r = parseModelRouting({ nonsense: 'x', script_generation: 'claude-haiku-4-5-20251001' });
  assert.equal(r.script_generation, 'claude-haiku-4-5-20251001');
  assert.equal(Object.keys(r).length, MODEL_TASKS.length);
});

test('validateModelRoutingForm: all four valid → value', () => {
  const input = {
    script_generation: 'claude-opus-4-8',
    video_composition: 'claude-sonnet-4-6',
    caption_emphasis: 'claude-haiku-4-5-20251001',
    primitive_drafting: 'claude-fable-5',
  };
  const r = validateModelRoutingForm(input);
  assert.equal(r.ok, true);
  assert.ok(r.ok && r.value.primitive_drafting === 'claude-fable-5');
});

test('validateModelRoutingForm: rejects a missing task', () => {
  const r = validateModelRoutingForm({
    script_generation: 'claude-opus-4-8',
    video_composition: 'claude-sonnet-4-6',
    caption_emphasis: 'claude-haiku-4-5-20251001',
  });
  assert.equal(r.ok, false);
});

test('validateModelRoutingForm: rejects a non-allowlisted id', () => {
  const r = validateModelRoutingForm({
    script_generation: 'gpt-4o',
    video_composition: 'claude-sonnet-4-6',
    caption_emphasis: 'claude-haiku-4-5-20251001',
    primitive_drafting: 'claude-opus-4-8',
  });
  assert.equal(r.ok, false);
});
