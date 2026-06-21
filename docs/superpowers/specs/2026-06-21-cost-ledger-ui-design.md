# Cost ledger UI — design

**Date:** 2026-06-21
**Phase:** 8 (Full surfaces) — surface the cost ledger
**Status:** design approved, ready for implementation plan

## Context

Every paid operation already writes a `cost_events` row (init migration
`20260604184050`):

```sql
create table cost_events (
  id         uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts (id) on delete cascade,
  video_id   uuid references videos (id) on delete set null,
  render_id  uuid references renders (id) on delete set null,
  operation  cost_operation not null,   -- enum (see below)
  provider   text not null,             -- anthropic|openai|elevenlabs|aws_lambda|...
  units      numeric(14,4),
  cost_usd   numeric(12,6) not null,
  created_at timestamptz not null default now()
);
-- RLS: acct_isolation for all using/with check (auth_owns_account(account_id))
```

`cost_operation` enum: `script_generation, shot_edit, voice_synthesis,
composition, render, smoke_frame, music_remux, resource_tagging, thumbnail_copy,
asset_search`.

**Which writers set what (verified in code):**

- `script_generation` (generate-script), `voice_synthesis` (synthesize-voice):
  `video_id` set, **`render_id` null**.
- `composition`, `render`, `smoke_frame`, `asset_search`, `music_remux`
  (render.ts / gate2.ts / music-remux.ts): `video_id` **and** `render_id` set.

Nothing surfaces this data in the UI yet. The build plan (§ Phase 8) calls for
"the cost ledger surfaced as per-render and per-video lifetime totals."

There are convenience views `video_costs` / `render_costs` in the init schema,
but a Postgres view created without `security_invoker=true` runs with the view
owner's privileges and **bypasses the querying user's RLS** — so this design
does not use them. Reads aggregate directly from `cost_events` under RLS.

**Known accounting caveats (label, don't fix here):** model-routing cost
accounting is still Sonnet-pinned (a non-Sonnet `video_composition` route bills
at Sonnet rates), and a few operations (e.g. thumbnails) don't emit events yet.
Figures are therefore labeled "Estimated — from recorded usage." Correcting the
accounting is out of scope.

## Goal

Let the operator see what a video and a render cost: a per-video lifetime total
with a per-render, per-operation breakdown on the video page, and an
account-wide rollup (grand total + per-video totals) on a dedicated page.

## Scope

**In scope:**

- A pure aggregation module (grouping/summing/formatting) with unit tests.
- A per-video cost panel on the video editor page: lifetime total + per-render
  breakdown itemized by operation (plus a "Script & voice" bucket for the
  null-`render_id` events).
- A dedicated `/costs` account page: grand total + a table of the account's
  videos with lifetime totals, each linking to the video.
- A "Costs" nav link.

**Out of scope (YAGNI):**

- Per-event row tables, CSV export, date-range filters, charts/graphs.
- Cost alerts / budgets (Phase 9).
- Fixing the Sonnet-pinned accounting or metering thumbnails.
- Any schema change, migration, RPC, or new SQL view.
- Per-channel cost rollups.

## Architecture

Approach: **pure TS aggregation over RLS-scoped rows** (no new SQL). The two
server components read `cost_events` directly under RLS and hand the rows to the
pure core. For a single operator the row counts are tiny, the pattern matches
the codebase's "pure core + node:test", and it sidesteps the security-definer
view risk entirely.

### Pure core: `src/lib/costs/aggregate.ts` (unit-tested)

Zero imports (pure functions over plain data). The server normalizes
`cost_usd` (a `numeric` column, which supabase-js may return as a string) to a
`number` **before** calling these — the core assumes numbers.

```ts
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
  renderId: string | null;        // null bucket = pre-render (script & voice)
  costUsd: number;
  byOperation: OperationTotal[];   // desc by costUsd
}

// Sum of costUsd over all events.
export function totalCost(events: { costUsd: number }[]): number;

// Group by operation, sum, sort desc by costUsd.
export function costByOperation(events: CostEvent[]): OperationTotal[];

// Group by renderId. Buckets appear in first-seen order of their renderId
// (the server selects ordered by created_at), with the renderId === null
// bucket placed LAST. Each bucket carries its total and its per-operation
// breakdown (costByOperation of the bucket's events).
export function costByRender(events: CostEvent[]): RenderGroup[];

// videoId → lifetime total. Events with a null videoId are ignored.
export function sumByVideo(events: CostEvent[]): Map<string, number>;

// "$x.xx" when |n| >= 1, otherwise "$0.xxxx" (costs are often sub-cent).
export function formatUsd(n: number): string;
```

`formatUsd` rule: `` `$${n.toFixed(n >= 1 || n <= -1 ? 2 : 4)}` ``. So `$1.23`,
`$0.0123`, `$0.0000`.

### Surface 1 — per-video panel

`src/app/(app)/videos/[id]/page.tsx` (existing server component) adds, after the
scenes/shots/job reads:

```ts
const { data: costRows } = await supabase
  .from('cost_events')
  .select('render_id, operation, cost_usd')
  .eq('video_id', id)
  .order('created_at');
const events: CostEvent[] = (costRows ?? []).map((r) => ({
  videoId: id,
  renderId: (r.render_id as string | null) ?? null,
  operation: r.operation as string,
  costUsd: Number(r.cost_usd ?? 0),
}));
```

It renders `<VideoCostsPanel events={events} />` after `<Editor />` (the page
returns a fragment wrapping both).

`src/app/(app)/videos/[id]/VideoCostsPanel.tsx` — a **presentational server
component** (no `'use client'`). Props: `{ events: CostEvent[] }`. Renders:

- A heading "Costs" + the caption "Estimated — from recorded usage."
- The lifetime total: `formatUsd(totalCost(events))`.
- `costByRender(events)` as a list: each render bucket shows a label
  (`renderId === null` → "Script & voice"; otherwise `Render ${renderId.slice(0, 8)}`),
  its total, and its `byOperation` rows (`operation` + `formatUsd(costUsd)`).
- If `events` is empty: "No costs recorded yet."

### Surface 2 — account page

`src/app/(app)/costs/page.tsx` — new **server component**. Reads (RLS-scoped):

```ts
const { data: videos } = await supabase
  .from('videos')
  .select('id, title, created_at')
  .order('created_at', { ascending: false });
const { data: costRows } = await supabase
  .from('cost_events')
  .select('video_id, cost_usd');
const events: CostEvent[] = (costRows ?? []).map((r) => ({
  videoId: (r.video_id as string | null) ?? null,
  renderId: null,
  operation: '',
  costUsd: Number(r.cost_usd ?? 0),
}));
const byVideo = sumByVideo(events);
const grand = totalCost(events);
```

Renders:

- `<h1>Costs</h1>` + the "Estimated — from recorded usage" caption.
- The grand total: `formatUsd(grand)`.
- A table of videos: title (link to `/videos/${id}`) + `formatUsd(byVideo.get(id) ?? 0)`.
  A video with no recorded cost shows `$0.0000`.
- If there are no videos: "No videos yet."

(The grand total counts every cost event for the account, including any whose
`video_id` is null — so it is the true account spend even if a row is not tied
to a surviving video. The per-video rows necessarily only cover videos that
still exist.)

### Nav

`src/app/(app)/layout.tsx` gains a `<Link href="/costs">Costs</Link>` in the
header nav, in the same style as the existing links (Primitives / Channels /
Settings).

## Data flow

```
cost_events (RLS) ─┬─ video page: where video_id=id, order created_at
                   │     → CostEvent[] → VideoCostsPanel
                   │         totalCost (lifetime) + costByRender (per-render → byOperation)
                   └─ /costs page: all rows (video_id, cost_usd) + videos(id,title)
                         → sumByVideo (per-video) + totalCost (grand)
```

## Error handling

- Every read is RLS-scoped; a null/absent result → `[] ` → "$0.0000" and an
  empty-state line ("No costs recorded yet." / "No videos yet."). Nothing throws.
- `cost_usd` is coerced with `Number(r.cost_usd ?? 0)` at the server boundary, so
  a string-typed numeric or a null can never produce `NaN` in the UI.
- The pure functions are total (defined for `[]`): `totalCost([]) === 0`,
  `costByRender([]) === []`, `sumByVideo([])` is an empty Map.

## Back-compatibility

- Read-only addition. No write path, schema, or existing component behavior
  changes. The video page keeps rendering `<Editor>` exactly as before; the panel
  is appended.
- The unused convenience views and `is_fallback`-style dormant bits are left
  untouched.

## Testing

- **Unit (`src/lib/costs/aggregate.test.ts`):**
  - `totalCost` — sums; `[]` → 0.
  - `costByOperation` — groups duplicates, sums, sorts desc by costUsd.
  - `costByRender` — one bucket per renderId in first-seen order; the
    `renderId === null` bucket is LAST; each bucket's `byOperation` is desc;
    bucket totals correct.
  - `sumByVideo` — videoId → summed total; null videoId ignored; `[]` → empty Map.
  - `formatUsd` — `1.234 → "$1.23"`, `0.0123 → "$0.0123"`, `0 → "$0.0000"`,
    negative path uses 2 dp at `<= -1`.
- **Regression:** `npm test` green; `npx tsc --noEmit` + `npm run lint` clean;
  `npm run build` succeeds (both new/changed pages compile as server components).
- **Manual / app-run e2e:** open a video that has at least one completed render →
  the Costs panel shows a lifetime total, a per-render bucket with an operation
  breakdown, and the "Script & voice" bucket → open `/costs` → the grand total
  and a per-video table appear, each row linking to its video.

## Open questions

None. Surfaces (both), granularity (totals + per-operation), and the pure-TS
RLS-scoped aggregation approach are settled.
