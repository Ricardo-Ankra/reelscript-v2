// Pure cost-ledger aggregation (Phase 8). Zero imports: groups/sums/formats
// normalized cost_events rows for the cost UI. The server coerces the numeric
// cost_usd column to a number before calling these.

export interface CostEvent {
  videoId: string | null;
  renderId: string | null;
  operation: string;
  costUsd: number;
}

export interface OperationTotal {
  operation: string;
  costUsd: number;
}

export interface RenderGroup {
  renderId: string | null; // null bucket = pre-render (script & voice)
  costUsd: number;
  byOperation: OperationTotal[];
}

export function totalCost(events: { costUsd: number }[]): number {
  let sum = 0;
  for (const e of events) sum += e.costUsd;
  return sum;
}

// Group by operation, sum, sort desc by costUsd.
export function costByOperation(events: CostEvent[]): OperationTotal[] {
  const totals = new Map<string, number>();
  const order: string[] = [];
  for (const e of events) {
    if (!totals.has(e.operation)) order.push(e.operation);
    totals.set(e.operation, (totals.get(e.operation) ?? 0) + e.costUsd);
  }
  return order
    .map((operation) => ({ operation, costUsd: totals.get(operation) ?? 0 }))
    .sort((a, b) => b.costUsd - a.costUsd);
}

// Group by renderId. Buckets in first-seen renderId order; the null bucket last.
// Each bucket carries its total and its per-operation breakdown.
export function costByRender(events: CostEvent[]): RenderGroup[] {
  const buckets = new Map<string | null, CostEvent[]>();
  const order: (string | null)[] = [];
  for (const e of events) {
    if (!buckets.has(e.renderId)) {
      buckets.set(e.renderId, []);
      order.push(e.renderId);
    }
    buckets.get(e.renderId)!.push(e);
  }
  // Stable sort: null bucket to the end, everything else keeps first-seen order.
  order.sort((a, b) => (a === null ? 1 : 0) - (b === null ? 1 : 0));
  return order.map((renderId) => {
    const bucket = buckets.get(renderId)!;
    return {
      renderId,
      costUsd: totalCost(bucket),
      byOperation: costByOperation(bucket),
    };
  });
}

// videoId → summed total. Events with a null videoId are ignored.
export function sumByVideo(events: CostEvent[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of events) {
    if (e.videoId === null) continue;
    out.set(e.videoId, (out.get(e.videoId) ?? 0) + e.costUsd);
  }
  return out;
}

// "$x.xx" when |n| >= 1, otherwise "$0.xxxx" (costs are often sub-cent).
export function formatUsd(n: number): string {
  return `$${n.toFixed(n >= 1 || n <= -1 ? 2 : 4)}`;
}
