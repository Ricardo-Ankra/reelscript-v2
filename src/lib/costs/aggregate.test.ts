import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  totalCost,
  costByOperation,
  costByRender,
  sumByVideo,
  formatUsd,
  type CostEvent,
} from './aggregate.ts';

const ev = (
  videoId: string | null,
  renderId: string | null,
  operation: string,
  costUsd: number,
): CostEvent => ({ videoId, renderId, operation, costUsd });

test('totalCost: sums costUsd; empty → 0', () => {
  assert.equal(totalCost([]), 0);
  assert.equal(totalCost([{ costUsd: 0.5 }, { costUsd: 0.25 }]), 0.75);
});

test('costByOperation: groups, sums, sorts desc by costUsd', () => {
  const out = costByOperation([
    ev('v1', 'r1', 'render', 0.1),
    ev('v1', null, 'voice_synthesis', 0.3),
    ev('v1', 'r1', 'render', 0.2),
  ]);
  assert.deepEqual(out, [
    { operation: 'render', costUsd: 0.30000000000000004 },
    { operation: 'voice_synthesis', costUsd: 0.3 },
  ]);
});

test('costByRender: one bucket per renderId, first-seen order, null bucket LAST', () => {
  const out = costByRender([
    ev('v1', null, 'script_generation', 0.05),
    ev('v1', 'r1', 'composition', 0.2),
    ev('v1', 'r2', 'render', 0.4),
    ev('v1', 'r1', 'render', 0.1),
  ]);
  assert.equal(out.length, 3);
  assert.equal(out[0].renderId, 'r1');
  assert.equal(out[0].costUsd, 0.30000000000000004);
  assert.deepEqual(out[0].byOperation, [
    { operation: 'composition', costUsd: 0.2 },
    { operation: 'render', costUsd: 0.1 },
  ]);
  assert.equal(out[1].renderId, 'r2');
  assert.equal(out[2].renderId, null); // null bucket placed last
  assert.equal(out[2].costUsd, 0.05);
});

test('sumByVideo: videoId → total; null videoId ignored; empty → empty Map', () => {
  assert.equal(sumByVideo([]).size, 0);
  const m = sumByVideo([
    ev('v1', null, 'x', 0.2),
    ev('v1', 'r1', 'y', 0.3),
    ev('v2', 'r2', 'z', 0.4),
    ev(null, null, 'w', 9.9),
  ]);
  assert.equal(m.get('v1'), 0.5);
  assert.equal(m.get('v2'), 0.4);
  assert.equal(m.has(null as unknown as string), false);
  assert.equal(m.size, 2);
});

test('formatUsd: 2dp at |n|>=1, else 4dp', () => {
  assert.equal(formatUsd(1.234), '$1.23');
  assert.equal(formatUsd(0.0123), '$0.0123');
  assert.equal(formatUsd(0), '$0.0000');
  assert.equal(formatUsd(-1.5), '$-1.50');
});
