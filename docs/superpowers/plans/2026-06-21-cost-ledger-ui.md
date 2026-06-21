# Cost ledger UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface recorded `cost_events` as a per-video lifetime total with a per-render/per-operation breakdown on the video page, plus an account-wide `/costs` rollup page.

**Architecture:** A pure, unit-tested aggregation module (`src/lib/costs/aggregate.ts`) groups/sums/formats normalized cost rows. Two display-only server components read `cost_events` directly under RLS and feed the pure core: a `VideoCostsPanel` appended to the video editor page, and a new `/costs` account page (with a nav link). No schema change, no SQL, no client components.

**Tech Stack:** TypeScript, Next.js App Router (React Server Components), Supabase (RLS-scoped reads), `node:test` via `--experimental-strip-types`.

## Global Constraints

- The pure core `src/lib/costs/aggregate.ts` has ZERO imports (pure functions over plain data). It must not import react/server-only/network/supabase.
- The server normalizes `cost_usd` (a Postgres `numeric`, which supabase-js may return as a string) to a `number` with `Number(r.cost_usd ?? 0)` BEFORE calling the pure core. The core assumes numbers.
- All reads are RLS-scoped via `createClient` from `@/lib/supabase/server` (the caller's account). Do NOT use the `video_costs` / `render_costs` views (they are security-definer and bypass RLS). Do NOT add any migration, RPC, or SQL view.
- Both new/changed pages are server components — NO `'use client'`, no interactivity.
- `formatUsd(n)` rule (exact): `` `$${n.toFixed(n >= 1 || n <= -1 ? 2 : 4)}` ``. → `$1.23`, `$0.0123`, `$0.0000`.
- Per-render bucket labels: `renderId === null` → `"Script & voice"`; otherwise `` `Render ${renderId.slice(0, 8)}` ``.
- Every figure is labeled "Estimated — from recorded usage." Do NOT change any cost-writing code or the accounting itself.
- Test command (single file): `node --experimental-strip-types --import ./scripts/register-loader.mjs --test <path>`. Full suite: `npm test`. Test imports use explicit `.ts` extensions.
- Commit footer on every commit: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Stage only the files each task names — there is unrelated `package-lock.json` drift in the tree; never `git add -A`.

---

## File Structure

- `src/lib/costs/aggregate.ts` (create) — pure aggregation/formatting core.
- `src/lib/costs/aggregate.test.ts` (create) — node:test for the core.
- `src/app/(app)/videos/[id]/VideoCostsPanel.tsx` (create) — presentational server component: per-video lifetime total + per-render breakdown.
- `src/app/(app)/videos/[id]/page.tsx` (modify) — add the RLS cost read, render `<VideoCostsPanel>` after `<Editor>`.
- `src/app/(app)/costs/page.tsx` (create) — account rollup server page.
- `src/app/(app)/layout.tsx` (modify) — add the "Costs" nav link.

---

## Task 1: Pure aggregation core

**Files:**
- Create: `src/lib/costs/aggregate.ts`
- Test: `src/lib/costs/aggregate.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export interface CostEvent { videoId: string | null; renderId: string | null; operation: string; costUsd: number }`
  - `export interface OperationTotal { operation: string; costUsd: number }`
  - `export interface RenderGroup { renderId: string | null; costUsd: number; byOperation: OperationTotal[] }`
  - `export function totalCost(events: { costUsd: number }[]): number`
  - `export function costByOperation(events: CostEvent[]): OperationTotal[]`
  - `export function costByRender(events: CostEvent[]): RenderGroup[]`
  - `export function sumByVideo(events: CostEvent[]): Map<string, number>`
  - `export function formatUsd(n: number): string`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/costs/aggregate.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/costs/aggregate.test.ts`
Expected: FAIL — module/exports do not exist.

- [ ] **Step 3: Implement the core**

Create `src/lib/costs/aggregate.ts`:

```ts
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
```

Note on the `costByRender` sort: `Array.prototype.sort` is stable (ECMAScript 2019+), so mapping `null → 1` / non-null → 0 and sorting moves the single null bucket to the end while preserving the first-seen order of the others.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/costs/aggregate.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/costs/aggregate.ts src/lib/costs/aggregate.test.ts
git commit -m "feat(costs): pure cost-ledger aggregation core

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Per-video cost panel + video page wiring

**Files:**
- Create: `src/app/(app)/videos/[id]/VideoCostsPanel.tsx`
- Modify: `src/app/(app)/videos/[id]/page.tsx`

**Interfaces:**
- Consumes (from Task 1): `type CostEvent`, `totalCost`, `costByRender`, `formatUsd` from `@/lib/costs/aggregate`.
- Produces: `export function VideoCostsPanel({ events }: { events: CostEvent[] })`.

- [ ] **Step 1: Create the panel component**

Create `src/app/(app)/videos/[id]/VideoCostsPanel.tsx`:

```tsx
import { totalCost, costByRender, formatUsd, type CostEvent } from '@/lib/costs/aggregate';

// Presentational server component (display-only): the video's lifetime cost and a
// per-render breakdown itemized by operation, plus a "Script & voice" bucket for
// the events not tied to a render (script generation + voice synthesis).
export function VideoCostsPanel({ events }: { events: CostEvent[] }) {
  const lifetime = totalCost(events);
  const renders = costByRender(events);

  return (
    <section className="space-y-3 rounded-lg border border-black/10 p-4 dark:border-white/10">
      <div className="flex items-baseline justify-between">
        <h2 className="text-lg font-semibold">Costs</h2>
        <span className="text-sm font-medium">{formatUsd(lifetime)} lifetime</span>
      </div>
      <p className="text-xs opacity-60">Estimated — from recorded usage.</p>

      {events.length === 0 ? (
        <p className="text-sm opacity-70">No costs recorded yet.</p>
      ) : (
        <div className="space-y-3">
          {renders.map((r) => (
            <div key={r.renderId ?? 'pre-render'} className="space-y-1">
              <div className="flex items-baseline justify-between text-sm font-medium">
                <span>{r.renderId === null ? 'Script & voice' : `Render ${r.renderId.slice(0, 8)}`}</span>
                <span>{formatUsd(r.costUsd)}</span>
              </div>
              <ul className="space-y-0.5 pl-3 text-sm opacity-80">
                {r.byOperation.map((op) => (
                  <li key={op.operation} className="flex items-baseline justify-between">
                    <span>{op.operation}</span>
                    <span>{formatUsd(op.costUsd)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 2: Wire the read into the video page**

In `src/app/(app)/videos/[id]/page.tsx`:

Add the import near the top (after the existing imports):

```ts
import { VideoCostsPanel } from './VideoCostsPanel';
import type { CostEvent } from '@/lib/costs/aggregate';
```

After the existing `job` query block (the `.from('jobs')...maybeSingle()` block) and before the `return (`, add:

```ts
  const { data: costRows } = await supabase
    .from('cost_events')
    .select('render_id, operation, cost_usd')
    .eq('video_id', id)
    .order('created_at');
  const costEvents: CostEvent[] = (costRows ?? []).map((r) => ({
    videoId: id,
    renderId: (r.render_id as string | null) ?? null,
    operation: r.operation as string,
    costUsd: Number(r.cost_usd ?? 0),
  }));
```

Change the return from rendering just `<Editor ... />` to a fragment that also renders the panel. The existing return is:

```tsx
  return (
    <Editor
      videoId={id}
      title={video.title as string}
      initialScenes={scenes}
      initialStatus={(job?.status as string | null) ?? null}
      initialSettings={(video.settings as Record<string, unknown>) ?? {}}
      initialPrompt={(video.prompt as string | null) ?? ''}
    />
  );
```

Replace it with:

```tsx
  return (
    <div className="space-y-6">
      <Editor
        videoId={id}
        title={video.title as string}
        initialScenes={scenes}
        initialStatus={(job?.status as string | null) ?? null}
        initialSettings={(video.settings as Record<string, unknown>) ?? {}}
        initialPrompt={(video.prompt as string | null) ?? ''}
      />
      <VideoCostsPanel events={costEvents} />
    </div>
  );
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Lint**

Run: `npm run lint`
Expected: clean (no unused imports).

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/videos/[id]/VideoCostsPanel.tsx" "src/app/(app)/videos/[id]/page.tsx"
git commit -m "feat(costs): per-video cost panel on the video page

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Account `/costs` page + nav link

**Files:**
- Create: `src/app/(app)/costs/page.tsx`
- Modify: `src/app/(app)/layout.tsx`

**Interfaces:**
- Consumes (from Task 1): `type CostEvent`, `totalCost`, `sumByVideo`, `formatUsd` from `@/lib/costs/aggregate`; `createClient` from `@/lib/supabase/server`.
- Produces: the `/costs` route; a nav link.

- [ ] **Step 1: Create the account costs page**

Create `src/app/(app)/costs/page.tsx`:

```tsx
import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { totalCost, sumByVideo, formatUsd, type CostEvent } from '@/lib/costs/aggregate';

// Account cost rollup (Phase 8). RLS scopes both reads to the caller's account.
// The grand total counts every cost event (including any with a null video_id);
// the per-video rows cover videos that still exist.
export default async function CostsPage() {
  const supabase = await createClient();

  const { data: videos } = await supabase
    .from('videos')
    .select('id, title, created_at')
    .order('created_at', { ascending: false });

  const { data: costRows } = await supabase.from('cost_events').select('video_id, cost_usd');
  const events: CostEvent[] = (costRows ?? []).map((r) => ({
    videoId: (r.video_id as string | null) ?? null,
    renderId: null,
    operation: '',
    costUsd: Number(r.cost_usd ?? 0),
  }));

  const byVideo = sumByVideo(events);
  const grand = totalCost(events);
  const rows = videos ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Costs</h1>
          <p className="text-xs opacity-60">Estimated — from recorded usage.</p>
        </div>
        <span className="text-lg font-medium">{formatUsd(grand)} total</span>
      </div>

      {rows.length === 0 ? (
        <p className="text-sm opacity-70">No videos yet.</p>
      ) : (
        <ul className="divide-y divide-black/10 rounded-lg border border-black/10 dark:divide-white/10 dark:border-white/10">
          {rows.map((v) => (
            <li key={v.id as string} className="flex items-baseline justify-between px-4 py-3">
              <Link href={`/videos/${v.id}`} className="text-sm underline">
                {(v.title as string | null) ?? 'Untitled'}
              </Link>
              <span className="text-sm">{formatUsd(byVideo.get(v.id as string) ?? 0)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Add the nav link**

In `src/app/(app)/layout.tsx`, add a "Costs" link to the header nav. The existing nav block is:

```tsx
          <Link href="/channels" className="text-sm opacity-70 hover:opacity-100">
            Channels
          </Link>
          <Link href="/settings" className="text-sm opacity-70 hover:opacity-100">
            Settings
          </Link>
```

Insert a Costs link before Settings so it becomes:

```tsx
          <Link href="/channels" className="text-sm opacity-70 hover:opacity-100">
            Channels
          </Link>
          <Link href="/costs" className="text-sm opacity-70 hover:opacity-100">
            Costs
          </Link>
          <Link href="/settings" className="text-sm opacity-70 hover:opacity-100">
            Settings
          </Link>
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Lint**

Run: `npm run lint`
Expected: clean.

- [ ] **Step 5: Build (server-component compile check)**

Run: `npm run build`
Expected: build succeeds; `/costs` and `/videos/[id]` compile (server components, no client-boundary errors).

- [ ] **Step 6: Commit**

```bash
git add "src/app/(app)/costs/page.tsx" "src/app/(app)/layout.tsx"
git commit -m "feat(costs): account-level cost rollup page + nav link

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final verification (whole branch)

- [ ] `npm test` — full suite green.
- [ ] `npx tsc --noEmit` — clean.
- [ ] `npm run lint` — clean.
- [ ] `npm run build` — succeeds.
- [ ] **Manual / app-run e2e (operator):** open a video that has at least one completed render → the Costs panel shows a lifetime total, a per-render bucket with an operation breakdown, and the "Script & voice" bucket → open `/costs` from the nav → the grand total and a per-video table appear, each row linking to its video.

## Post-merge bookkeeping (controller, after merge)

- Update `CLAUDE.md` Phase-8 notes: the cost ledger UI (per-render + per-video lifetime totals on the video page, account `/costs` rollup) shipped; the Sonnet-pinned cost accounting remains a known limitation (figures labeled "Estimated").
- Update memory (`model-routing.md` notes "cost accounting still Sonnet-pinned"; `channel-settings-stack.md` lists the cost ledger as still-open) — mark the cost ledger UI shipped.
