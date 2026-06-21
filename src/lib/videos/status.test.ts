import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveVideoStatus } from './status.ts';

test('ready: latest render complete', () => {
  assert.equal(deriveVideoStatus({ hasScenes: true, latestRenderStatus: 'complete' }).status, 'ready');
});

test('rendering: latest render in a live phase', () => {
  for (const s of ['queued', 'composing', 'resolving_assets', 'validating', 'rendering', 'encoding']) {
    assert.equal(deriveVideoStatus({ hasScenes: true, latestRenderStatus: s }).status, 'rendering');
  }
});

test('render_failed: latest render failed', () => {
  assert.equal(deriveVideoStatus({ hasScenes: true, latestRenderStatus: 'failed' }).status, 'render_failed');
});

test('script_failed: script job failed, no render', () => {
  assert.equal(deriveVideoStatus({ scriptJobStatus: 'failed', hasScenes: false }).status, 'script_failed');
});

test('generating: script job running, no scenes yet', () => {
  assert.equal(deriveVideoStatus({ scriptJobStatus: 'running', hasScenes: false }).status, 'generating');
  assert.equal(deriveVideoStatus({ scriptJobStatus: 'queued', hasScenes: false }).status, 'generating');
});

test('draft: scenes exist, no render', () => {
  assert.equal(deriveVideoStatus({ scriptJobStatus: 'complete', hasScenes: true }).status, 'draft');
});

test('render takes precedence over script job', () => {
  assert.equal(
    deriveVideoStatus({ scriptJobStatus: 'failed', hasScenes: true, latestRenderStatus: 'complete' }).status,
    'ready',
  );
});

test('fallback: nothing known → generating', () => {
  assert.equal(deriveVideoStatus({ hasScenes: false }).status, 'generating');
});

test('returns a human label', () => {
  assert.equal(deriveVideoStatus({ hasScenes: true, latestRenderStatus: 'complete' }).label, 'Ready');
});
