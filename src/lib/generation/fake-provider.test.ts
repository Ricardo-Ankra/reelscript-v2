import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeProvider } from './fake-provider.ts';

const clipReq = {
  prompt: 'p', imageUrl: 'https://r2/key.png', motionId: 'placeholder-static',
  motionStrength: 0.7, seed: 42, model: 'dop-preview',
};

test('generateStill returns a url that reflects the seed', async () => {
  const p = createFakeProvider();
  const r = await p.generateStill({ prompt: 'x', aspectRatio: '9:16', seed: 7, styleRefUrl: null });
  assert.match(r.url, /7/);
  const r2 = await p.generateStill({ prompt: 'x', aspectRatio: '9:16', seed: null, styleRefUrl: null });
  assert.match(r2.url, /noseed/);
});

test('submitClip returns an id reflecting the model; checkClip is pending N times then completed', async () => {
  const p = createFakeProvider({ pollsUntilReady: 2, clipUrl: 'https://fake.local/clip.mp4' });
  const { requestId } = await p.submitClip(clipReq);
  assert.match(requestId, /dop-preview/);
  assert.deepEqual(await p.checkClip(requestId), { state: 'pending' });
  assert.deepEqual(await p.checkClip(requestId), { state: 'pending' });
  assert.deepEqual(await p.checkClip(requestId), { state: 'completed', mediaUrl: 'https://fake.local/clip.mp4' });
});

test('failNext makes the next submitted clip fail on check', async () => {
  const p = createFakeProvider();
  p.failNext();
  const { requestId } = await p.submitClip(clipReq);
  const status = await p.checkClip(requestId);
  assert.equal(status.state, 'failed');
  // a subsequent (non-failed) submit still succeeds
  const ok = await p.submitClip(clipReq);
  assert.notEqual((await p.checkClip(ok.requestId)).state, 'failed');
});

test('distinct submits get distinct ids with independent poll counts', async () => {
  const p = createFakeProvider({ pollsUntilReady: 1 });
  const a = await p.submitClip(clipReq);
  const b = await p.submitClip(clipReq);
  assert.notEqual(a.requestId, b.requestId);
  assert.equal((await p.checkClip(a.requestId)).state, 'pending');
  assert.equal((await p.checkClip(a.requestId)).state, 'completed');
  assert.equal((await p.checkClip(b.requestId)).state, 'pending'); // b unaffected by a's polls
});
