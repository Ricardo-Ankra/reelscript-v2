# Model routing — design

**Date:** 2026-06-18
**Phase:** 8 (Full surfaces) — account settings
**Status:** design approved, ready for implementation plan

## Context

Every AI call in the codebase uses a hardcoded model constant from
`src/lib/ai/anthropic.ts`:

- `SCRIPT_MODEL = 'claude-opus-4-8'` — script generation.
- `COMPOSITION_MODEL = 'claude-sonnet-4-6'` — composition (procedural + agentic),
  and the vision-capable calls that share it: Gate-2 QA (`gate2.ts`), resource
  auto-tagging (`resources/upload.ts`), primitive brand-gate (`primitives/gates.ts`).
- `PRIMITIVE_DRAFT_MODEL = 'claude-opus-4-8'` — primitive drafting.
- `EMPHASIS_MODEL = 'claude-haiku-4-5-20251001'` — caption emphasis pass.

The comments on these constants say "pinned until model_routing." Only Anthropic
is wired (`serverEnv.anthropic.apiKey`); OpenAI/Google have a `credential_provider`
enum value but no client or key. The schema (`docs/schema/`) designs a relational
`model_routing` table (per-account × per-task, with `provider` + thinking columns)
and an `ai_task` enum, but neither is deployed and both carry multi-provider /
per-task-thinking baggage out of scope here.

This slice unpins the four models behind a per-account, per-task selection of the
**Anthropic** model. It is the first account-level settings feature, so it also
introduces a minimal account-settings page.

## Goal

Let the operator choose, per task, which Anthropic model is used — persisted on
the account, with code-default fallback so behavior is unchanged until they pick.

## Scope

**In scope:**

- Four routable tasks: **`script_generation`** (default Opus), **`video_composition`**
  (default Sonnet), **`caption_emphasis`** (default Haiku), **`primitive_drafting`**
  (default Opus).
- The vision/QA calls that share the composition model today — Gate-2 QA, resource
  auto-tagging, primitive brand-gate — **follow `video_composition`** (they are the
  "composition/vision" model, not separately routable).
- Stored as `accounts.model_routing` (JSONB): `{ script_generation, video_composition,
  caption_emphasis, primitive_drafting }` → Anthropic model-ID strings.
- A new account-settings page at `/settings` with a Model routing editor + a nav link.
- Selection is from a **curated allowlist** of current Anthropic model IDs.

**Out of scope:**

- OpenAI / Google / any non-Anthropic provider. The Anthropic client is unchanged;
  provider is implicitly `'anthropic'`.
- Per-task thinking config (`thinking_enabled` / `thinking_budget`). Adaptive
  thinking stays in code, tied to the task (script + composition use
  `thinking: { type: 'adaptive' }` exactly as today). Routing changes only the
  model ID.
- The designed relational `model_routing` table + `ai_task` enum — **superseded by
  the JSONB column for this Anthropic-only scope**; re-introducible if multi-provider
  or per-task thinking ever lands.
- Vision-QA / resource-tagging as separately routable tasks (they follow composition).
- Cost ledger and credentials UI on `/settings` (this slice ships only model routing
  there; those are later account-settings sections).
- Free-text model entry (allowlist only — an invalid ID would fail at job time).

## Architecture

A **pure routing core** owns the task list, the default model IDs, and the
allowlist. The four `anthropic.ts` constants are refactored to source their values
from the core, so there is one source of truth for the default strings (no
duplication, no drift). A **server loader** reads `accounts.model_routing` and
resolves a `task → modelId` map (per-task fallback to the defaults). Each AI call
site uses the resolved model; the deep render-time calls (`runGate2`,
`annotateSceneEmphasis`, `runBrandGate`) gain a `model` parameter so routing is
loaded once per job/request and threaded down rather than re-loaded per scene/frame.

### Data model

`accounts` gains one column. One **migration**:

```sql
-- Phase 8 — model routing. Per-account map of task → Anthropic model id, e.g.
-- { "script_generation": "claude-opus-4-8", ... }. Empty {} → code defaults apply.
alter table accounts
  add column if not exists model_routing jsonb not null default '{}'::jsonb;

-- Writes the caller's own account's model_routing wholesale (the editor owns all
-- four keys). SECURITY INVOKER → only the owner (owner_user_id = auth.uid()) can
-- write. RETURNS the updated id (NULL when no row matched) → no phantom save.
create or replace function set_account_model_routing(p_value jsonb)
returns uuid
language sql
security invoker
as $$
  update accounts
  set model_routing = p_value,
      updated_at    = now()
  where owner_user_id = auth.uid()
  returning id;
$$;

grant execute on function set_account_model_routing(jsonb) to authenticated;
```

(`accounts` has `owner_user_id` unique per session and an `updated_at` column from
the init schema. The write needs no `account_id` argument — it targets the caller's
own account via `auth.uid()`, mirroring how the account is resolved elsewhere.)

## Components

### Pure core (`src/lib/ai/model-routing.ts`, unit-tested)

No react/server/network — plain constants + pure functions, importable by both the
server-only `anthropic.ts` and the tests.

```ts
export const MODEL_TASKS = [
  'script_generation',
  'video_composition',
  'caption_emphasis',
  'primitive_drafting',
] as const;
export type ModelTask = (typeof MODEL_TASKS)[number];

// Today's pins — the single source of truth for the default model strings.
export const DEFAULT_MODELS: Record<ModelTask, string> = {
  script_generation: 'claude-opus-4-8',
  video_composition: 'claude-sonnet-4-6',
  caption_emphasis: 'claude-haiku-4-5-20251001',
  primitive_drafting: 'claude-opus-4-8',
};

// Curated selectable Anthropic models (id + UI label). Every DEFAULT_MODELS value
// must appear here (a unit test guards this).
export const MODEL_ALLOWLIST: readonly { id: string; label: string }[] = [
  { id: 'claude-opus-4-8', label: 'Opus 4.8 (most capable)' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6 (balanced)' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5 (fast, cheap)' },
  { id: 'claude-fable-5', label: 'Fable 5' },
];

// Resolve the stored routing to a complete task→id map: a stored id is used only
// if it is in the allowlist, else the task's default. Ignores unknown keys.
export function parseModelRouting(raw: unknown): Record<ModelTask, string>;

// Validate a form submission → the object to store. Requires all four tasks, each
// an allowlisted id. Rejects a missing task or a non-allowlisted id.
export function validateModelRoutingForm(input: unknown):
  | { ok: true; value: Record<ModelTask, string> }
  | { ok: false; reason: string };
```

### `anthropic.ts` refactor

Import `DEFAULT_MODELS` from the pure core and redefine the four constants as
`DEFAULT_MODELS.<task>` (keeping their names + comments). This removes the literal
strings from `anthropic.ts` (one source of truth) while leaving every existing
import working as the fallback default. The `anthropic()` client factory is
unchanged.

### Server loader (`src/lib/ai/model-routing.server.ts`, `import 'server-only'`)

```ts
import type { SupabaseClient } from '@supabase/supabase-js';
import { parseModelRouting, type ModelTask } from './model-routing';

// Load the account's task→model map once per job/request. Takes a client so it
// works from both the Inngest admin client and the RLS server client. On any read
// error, returns the code defaults (resolution must never block a render).
export async function loadModelRouting(
  client: SupabaseClient,
  accountId: string,
): Promise<Record<ModelTask, string>>;
```

Reads `accounts.model_routing` for `accountId` and returns `parseModelRouting(row)`;
a miss / error returns `parseModelRouting({})` (= defaults).

### Server action (`src/app/(app)/settings/model-routing-actions.ts`, `'use server'`)

```ts
export async function saveModelRouting(
  input: unknown,
): Promise<{ ok: true } | { ok: false; reason: string }>;
```

`validateModelRoutingForm(input)` (return its `reason` on failure) →
`supabase.rpc('set_account_model_routing', { p_value })` → RPC error →
`{ ok:false, reason }`; `data == null` → `{ ok:false, reason:'Account not found.' }`;
else `{ ok:true }`.

### UI

- `src/app/(app)/settings/page.tsx` (server) — resolve the session account, read
  its `model_routing`, run `parseModelRouting`, render `<ModelRoutingEditor
  initial={...} />`. A heading establishes the page as "Account settings."
- `src/app/(app)/settings/ModelRoutingEditor.tsx` (client) — one row per task
  (label + a `<select>` populated from `MODEL_ALLOWLIST`), a single dirty-tracked
  **Save** → `saveModelRouting(form)` (try/catch/finally; `{ ok:false }` keeps
  edits + shows the reason; `{ ok:true }` clears dirty + shows "Saved"). Mirrors the
  channel editors.
- `src/app/(app)/layout.tsx` — add a `Settings` nav link alongside the existing
  Dashboard / Primitives / Channels links.

### Wiring the call sites

Routing is loaded once at the top of each job/request and the resolved model is
used (or threaded into deep calls):

- `generate-script.ts` — `loadModelRouting(admin, accountId)`; use
  `resolved.script_generation` at the `.stream({ model })` call (replaces
  `SCRIPT_MODEL`).
- `render.ts` — `loadModelRouting(admin, accountId)` once; use
  `resolved.video_composition` for both compose `.stream({ model })` calls
  (replaces `COMPOSITION_MODEL`); pass `resolved.video_composition` to `runGate2`;
  pass `resolved.caption_emphasis` to `annotateSceneEmphasis`.
- `gate2.ts` `runGate2(...)` — gains a `model: string` field in its params; uses it
  instead of importing `COMPOSITION_MODEL`.
- `emphasis-annotate.ts` `annotateSceneEmphasis(...)` — gains a `model: string`
  parameter; uses it instead of `EMPHASIS_MODEL`.
- `primitives/gates.ts` `runBrandGate(...)` — gains a `model: string` param; the
  primitive-authoring caller loads routing → `resolved.video_composition`.
- `primitives/actions.ts` (drafting) — `loadModelRouting(rls, accountId)`; use
  `resolved.primitive_drafting` (replaces `PRIMITIVE_DRAFT_MODEL`).
- `resources/upload.ts` (auto-tag) — `loadModelRouting(rls, accountId)`; use
  `resolved.video_composition` (replaces `COMPOSITION_MODEL`).

The `anthropic.ts` constants remain (sourced from `DEFAULT_MODELS`) as the
fallback, so any not-yet-rewired path still resolves to today's pin.

## Data flow

```
/settings (server) → read accounts.model_routing → parseModelRouting → form
ModelRoutingEditor (client) → Save → saveModelRouting → set_account_model_routing RPC → { ok }
job/request start → loadModelRouting(client, accountId) → resolved {task→id} (fallback DEFAULT_MODELS)
each AI call → uses resolved[task] (threaded into runGate2 / annotateSceneEmphasis / runBrandGate via a model param)
```

## Error handling

- `validateModelRoutingForm` → friendly `reason` for a missing task or a
  non-allowlisted id; the editor shows it and keeps edits.
- `saveModelRouting` → `{ ok:false, reason }` on RPC error; `data == null` →
  `'Account not found.'` (no phantom save).
- `loadModelRouting` is resilient: any read error → the code defaults, so a routing
  read can never block a render or generation.
- A stored id that has since left the allowlist (e.g. a retired model) →
  `parseModelRouting` falls back to that task's default; the editor shows the
  default selected.

## Back-compatibility

- An account with empty `model_routing` → `DEFAULT_MODELS` = today's exact pins.
  Byte-for-byte the same model strings reach every call until the operator changes
  one.
- The `anthropic.ts` constants keep their names and (via `DEFAULT_MODELS`) their
  values, so any code/tests importing them are unaffected.
- Adaptive thinking, max-tokens, effort, tools — all unchanged (per task in code);
  only the `model` field is now resolved.
- The Anthropic client and keys are unchanged. No provider change.

## Testing

- **Unit (`src/lib/ai/model-routing.test.ts`):**
  - `DEFAULT_MODELS` — every value is present in `MODEL_ALLOWLIST` (defaults are
    always selectable).
  - `parseModelRouting` — empty `{}` → `DEFAULT_MODELS`; a partial object backfills
    only the missing tasks; a stored non-allowlisted id → that task's default; a
    full valid object → those ids; unknown keys ignored; garbage/null → defaults.
  - `validateModelRoutingForm` — all four valid ids → `value` with the four tasks;
    rejects a missing task; rejects a non-allowlisted id.
- **Migration:** `npm run db:apply` the migration; confirm the column + RPC applied.
- **Manual / app-run e2e:** open `/settings` → Model routing shows the four tasks
  at their defaults → change `script_generation` to Sonnet → Save → reload persists
  → run a script generation and confirm the chosen model is used (logs / cost
  event) → an account with empty routing generates with the same models as before.
  No render gate (no render-output change; only the model id differs).

## Open questions

None. Anthropic-only, four routable tasks (vision/resource calls follow
composition), `accounts.model_routing` JSONB, a new `/settings` page, and an
allowlist-only selection are all settled.
