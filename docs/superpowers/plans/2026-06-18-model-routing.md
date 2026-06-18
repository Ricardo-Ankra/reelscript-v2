# Model Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-account, per-task selection of the Anthropic model, replacing the four hardcoded pins; editable on a new `/settings` page, with code-default fallback.

**Architecture:** A pure routing core owns the task list, default model IDs, and a curated allowlist; `anthropic.ts`'s four constants are refactored to source their values from it. A server loader resolves `accounts.model_routing` (JSONB) to a `task→model` map (per-task default fallback). Each AI call site uses the resolved model; deep render calls take a `model` parameter. A `/settings` page + editor writes the routing.

**Tech Stack:** Next.js App Router (server actions, Inngest functions), Supabase (Postgres RPC, RLS), Anthropic SDK, `node:test` + `--experimental-strip-types`.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-06-18-model-routing-design.md`.
- **Anthropic-only.** No new provider. The `anthropic()` client and keys are unchanged. Routing changes only the `model` string.
- **Pure-core rule:** `src/lib/ai/model-routing.ts` imports nothing impure (no react/server/network). It is the single source of truth for the default model IDs; `anthropic.ts` imports them from it.
- **Four tasks:** `script_generation` (default `claude-opus-4-8`), `video_composition` (default `claude-sonnet-4-6`), `caption_emphasis` (default `claude-haiku-4-5-20251001`), `primitive_drafting` (default `claude-opus-4-8`). The vision/QA calls (Gate-2, resource-tag, primitive brand-gate) follow `video_composition`.
- **Allowlist-only selection.** `MODEL_ALLOWLIST` = Opus 4.8, Sonnet 4.6, Haiku 4.5, Fable 5 (`claude-fable-5`). A stored id not in the allowlist → that task's default.
- **No-phantom-save:** `set_account_model_routing` is `security invoker`, targets `owner_user_id = auth.uid()`, returns `id`; `data == null` → `{ ok:false, reason:'Account not found.' }`.
- **Resilience:** `loadModelRouting` returns the code defaults on any read error (never blocks a render).
- **Back-compat:** empty `model_routing` → the exact pins used today. Adaptive thinking / max_tokens / effort / tools unchanged per task.
- **Tests:** `npm test` (all) or single file `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/ai/model-routing.test.ts`. Test imports use explicit `.ts` extensions.
- **Migrations:** `npm run db:apply -- supabase/migrations/<file>.sql`.
- **Commit footer:** `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## File Structure

- `src/lib/ai/model-routing.ts` (create) — pure core.
- `src/lib/ai/model-routing.test.ts` (create) — unit tests.
- `src/lib/ai/anthropic.ts` (modify) — source the four constants from `DEFAULT_MODELS`.
- `supabase/migrations/20260618170000_model_routing.sql` (create) — column + RPC.
- `src/lib/ai/model-routing.server.ts` (create) — `loadModelRouting`.
- `src/app/(app)/settings/model-routing-actions.ts` (create) — `saveModelRouting`.
- `src/lib/inngest/functions/generate-script.ts` (modify) — route script_generation.
- `src/lib/inngest/functions/render.ts` (modify) — route video_composition + caption_emphasis.
- `src/lib/composition/gate2.ts` (modify) — `model` param.
- `src/lib/captions/emphasis-annotate.ts` (modify) — `model` param.
- `src/lib/primitives/gates.ts` (modify) — optional `model` param.
- `src/app/(app)/primitives/actions.ts` (modify) — route primitive_drafting + brand-gate.
- `src/lib/resources/upload.ts` (modify) — route video_composition.
- `src/app/(app)/settings/page.tsx` (create), `src/app/(app)/settings/ModelRoutingEditor.tsx` (create), `src/app/(app)/layout.tsx` (modify) — UI + nav.

---

### Task 1: Pure routing core `model-routing.ts` + tests

**Files:**
- Create: `src/lib/ai/model-routing.ts`
- Test: `src/lib/ai/model-routing.test.ts`

**Interfaces:**
- Produces: `MODEL_TASKS`, `type ModelTask`, `DEFAULT_MODELS`, `MODEL_ALLOWLIST`, `parseModelRouting`, `validateModelRoutingForm`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/ai/model-routing.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/ai/model-routing.test.ts`
Expected: FAIL — cannot find module `./model-routing.ts`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/ai/model-routing.ts`:

```ts
// Pure model-routing core (Phase 8 — account model routing). No react/server/network.
// The single source of truth for the default model ids (anthropic.ts imports these),
// the routable task list, and the selectable Anthropic allowlist.

export const MODEL_TASKS = [
  'script_generation',
  'video_composition',
  'caption_emphasis',
  'primitive_drafting',
] as const;
export type ModelTask = (typeof MODEL_TASKS)[number];

// Today's pins. Changing one here changes the code default for that task everywhere.
export const DEFAULT_MODELS: Record<ModelTask, string> = {
  script_generation: 'claude-opus-4-8',
  video_composition: 'claude-sonnet-4-6',
  caption_emphasis: 'claude-haiku-4-5-20251001',
  primitive_drafting: 'claude-opus-4-8',
};

// Selectable Anthropic models (id + label). Every DEFAULT_MODELS value must appear
// here (a unit test guards this).
export const MODEL_ALLOWLIST: readonly { id: string; label: string }[] = [
  { id: 'claude-opus-4-8', label: 'Opus 4.8 (most capable)' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6 (balanced)' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5 (fast, cheap)' },
  { id: 'claude-fable-5', label: 'Fable 5' },
];

const ALLOWED = new Set(MODEL_ALLOWLIST.map((m) => m.id));

// Resolve stored routing → a complete task→id map. A stored id is used only if it
// is allowlisted, else the task's default. Unknown keys are ignored.
export function parseModelRouting(raw: unknown): Record<ModelTask, string> {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out = {} as Record<ModelTask, string>;
  for (const task of MODEL_TASKS) {
    const v = o[task];
    out[task] = typeof v === 'string' && ALLOWED.has(v) ? v : DEFAULT_MODELS[task];
  }
  return out;
}

// Validate a form submission → the object to store. Requires all four tasks, each
// an allowlisted id.
export function validateModelRoutingForm(
  input: unknown,
): { ok: true; value: Record<ModelTask, string> } | { ok: false; reason: string } {
  const o = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const out = {} as Record<ModelTask, string>;
  for (const task of MODEL_TASKS) {
    const v = o[task];
    if (typeof v !== 'string' || !ALLOWED.has(v)) {
      return { ok: false, reason: `Pick a valid model for ${task.replace(/_/g, ' ')}.` };
    }
    out[task] = v;
  }
  return { ok: true, value: out };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/ai/model-routing.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/model-routing.ts src/lib/ai/model-routing.test.ts
git commit -m "feat: pure model-routing core (tasks, defaults, allowlist, parse/validate)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Source `anthropic.ts` constants from `DEFAULT_MODELS`

**Files:**
- Modify: `src/lib/ai/anthropic.ts`

**Interfaces:**
- Consumes: `DEFAULT_MODELS` from `./model-routing` (Task 1).
- Produces: the four exported constants `SCRIPT_MODEL`, `COMPOSITION_MODEL`, `PRIMITIVE_DRAFT_MODEL`, `EMPHASIS_MODEL` keep their names + values (now sourced from `DEFAULT_MODELS`).

**Context:** `anthropic.ts` currently declares the four constants as literal strings (lines 16, 22, 26, 32). Replace the literals with references to `DEFAULT_MODELS`; keep the comments. `anthropic.ts` is `import 'server-only'` but `model-routing.ts` is pure, so the import is fine.

- [ ] **Step 1: Add the import and re-source the constants**

In `src/lib/ai/anthropic.ts`, add near the top imports:

```ts
import { DEFAULT_MODELS } from './model-routing';
```

Then replace the four literal assignments (keep each constant's existing explanatory comment above it):

```ts
export const SCRIPT_MODEL = DEFAULT_MODELS.script_generation;
```
```ts
export const COMPOSITION_MODEL = DEFAULT_MODELS.video_composition;
```
```ts
export const PRIMITIVE_DRAFT_MODEL = DEFAULT_MODELS.primitive_drafting;
```
```ts
export const EMPHASIS_MODEL = DEFAULT_MODELS.caption_emphasis;
```

- [ ] **Step 2: Type-check and run the suite**

Run: `npx tsc --noEmit`
Expected: no new errors.

Run: `npm test`
Expected: PASS — the constants keep their exact values, so nothing that imports them changes behavior.

- [ ] **Step 3: Commit**

```bash
git add src/lib/ai/anthropic.ts
git commit -m "refactor: source anthropic model constants from DEFAULT_MODELS

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Migration — `accounts.model_routing` column + RPC

**Files:**
- Create: `supabase/migrations/20260618170000_model_routing.sql`

**Interfaces:**
- Produces: `accounts.model_routing jsonb`; `set_account_model_routing(p_value jsonb) returns uuid` (used by Task 6's action).

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260618170000_model_routing.sql`:

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

- [ ] **Step 2: Apply the migration**

Run: `npm run db:apply -- supabase/migrations/20260618170000_model_routing.sql`
Expected: applies cleanly (column added, function created); the script reports success.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260618170000_model_routing.sql
git commit -m "feat: accounts.model_routing column + set_account_model_routing RPC

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Server loader + save action

**Files:**
- Create: `src/lib/ai/model-routing.server.ts`
- Create: `src/app/(app)/settings/model-routing-actions.ts`

**Interfaces:**
- Consumes: `parseModelRouting`, `validateModelRoutingForm`, `type ModelTask` from `@/lib/ai/model-routing`; `createClient` from `@/lib/supabase/server`; the `set_account_model_routing` RPC (Task 3).
- Produces:
  - `loadModelRouting(client: SupabaseClient, accountId: string): Promise<Record<ModelTask, string>>`
  - `saveModelRouting(input: unknown): Promise<{ ok: true } | { ok: false; reason: string }>`

- [ ] **Step 1: Write the loader**

Create `src/lib/ai/model-routing.server.ts`:

```ts
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { parseModelRouting, type ModelTask } from './model-routing';

// Load the account's task→model map once per job/request. Takes a client so it
// works from both the Inngest admin client and the RLS server client. Any read
// error → the code defaults (resolution must never block a render).
export async function loadModelRouting(
  client: SupabaseClient,
  accountId: string,
): Promise<Record<ModelTask, string>> {
  try {
    const { data } = await client
      .from('accounts')
      .select('model_routing')
      .eq('id', accountId)
      .maybeSingle();
    return parseModelRouting(data?.model_routing);
  } catch {
    return parseModelRouting({});
  }
}
```

- [ ] **Step 2: Write the save action**

Create `src/app/(app)/settings/model-routing-actions.ts`:

```ts
'use server';

import { createClient } from '@/lib/supabase/server';
import { validateModelRoutingForm } from '@/lib/ai/model-routing';

// Persist the account's model routing via set_account_model_routing (writes the
// caller's own account by auth.uid()). The RPC returns the id, or null when no row
// matched — a failure, not a phantom "Saved".
export async function saveModelRouting(
  input: unknown,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const valid = validateModelRoutingForm(input);
  if (!valid.ok) return valid;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc('set_account_model_routing', {
    p_value: valid.value,
  });
  if (error) return { ok: false, reason: error.message };
  if (data == null) return { ok: false, reason: 'Account not found.' };
  return { ok: true };
}
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no new type errors.

- [ ] **Step 4: Commit**

```bash
git add src/lib/ai/model-routing.server.ts "src/app/(app)/settings/model-routing-actions.ts"
git commit -m "feat: loadModelRouting loader + saveModelRouting action

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Route `generate-script.ts`

**Files:**
- Modify: `src/lib/inngest/functions/generate-script.ts`

**Interfaces:**
- Consumes: `loadModelRouting` from `@/lib/ai/model-routing.server`.

**Context:** The function destructures `accountId` from the event data and builds `admin = createAdminClient()`. The script stream uses `model: SCRIPT_MODEL` (line ~92, inside the `stream-and-insert` step.run).

- [ ] **Step 1: Add the import**

Add:

```ts
import { loadModelRouting } from '@/lib/ai/model-routing.server';
```

(The existing `import { anthropic, SCRIPT_MODEL } from '@/lib/ai/anthropic';` can keep `SCRIPT_MODEL` or drop it — see Step 3.)

- [ ] **Step 2: Load routing in a memoized step, before the stream-and-insert step**

Add a step that resolves the model once (Inngest-correct: a `step.run` so it isn't re-read on every replay):

```ts
    const models = await step.run('load-model-routing', () =>
      loadModelRouting(admin, accountId),
    );
```

Place it after `admin` is created and `accountId` is in scope, before the `stream-and-insert` step.

- [ ] **Step 3: Use the resolved model**

Change the stream call:

```ts
        model: models.script_generation,
```

If `SCRIPT_MODEL` is now unused in the file, drop it from the import to keep lint clean: `import { anthropic } from '@/lib/ai/anthropic';`.

- [ ] **Step 4: Type-check + suite**

Run: `npx tsc --noEmit` → no new errors.
Run: `npm test` → PASS (additive; no test asserts the model string).

- [ ] **Step 5: Commit**

```bash
git add src/lib/inngest/functions/generate-script.ts
git commit -m "feat: route script generation through model routing

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Route the render path (`render.ts` + `gate2.ts` + `emphasis-annotate.ts`)

**Files:**
- Modify: `src/lib/inngest/functions/render.ts`
- Modify: `src/lib/composition/gate2.ts`
- Modify: `src/lib/captions/emphasis-annotate.ts`

**Interfaces:**
- Consumes: `loadModelRouting` from `@/lib/ai/model-routing.server`.
- Produces: `Gate2Params` gains `model: string`; `annotateSceneEmphasis`'s input gains `model: string`; `proceduralCompose`/`agenticCompose` gain a `model: string` param.

**Context:** `render.ts` runs compose in a `step.run('compose', ...)` where `brief = await loadBrief(admin, videoId)` exposes `brief.accountId`; it calls `agenticCompose(brief, admin, brief.accountId)` or `proceduralCompose(brief)`, runs `annotateSceneEmphasis({...})` per scene inside that step, and runs `runGate2({...})` in a separate `step.run('gate2', ...)`. The two compose streams (`model: COMPOSITION_MODEL`) live inside `proceduralCompose` (~line 630) and `agenticCompose` (~line 682). Imports `COMPOSITION_MODEL` at line 11.

- [ ] **Step 1: `gate2.ts` — add a `model` param**

In `src/lib/composition/gate2.ts`: add `model: string;` to the `Gate2Params` interface, change the vision call from `model: COMPOSITION_MODEL` to `model: params.model`, and remove `COMPOSITION_MODEL` from the `import { anthropic, COMPOSITION_MODEL } from '../ai/anthropic';` (→ `import { anthropic } from '../ai/anthropic';`).

- [ ] **Step 2: `emphasis-annotate.ts` — add a `model` param**

In `src/lib/captions/emphasis-annotate.ts`: add `model: string;` to the `annotateSceneEmphasis` input object type, change `model: EMPHASIS_MODEL` to `model: input.model`, and remove `EMPHASIS_MODEL` from the import (→ `import { anthropic } from '../ai/anthropic';`).

- [ ] **Step 3: `render.ts` — thread the model into the compose helpers**

In `proceduralCompose`, add a `model: string` parameter and use it at the stream call:

```ts
async function proceduralCompose(brief: CompositionBrief, model: string): Promise<ComposeOutcome> {
```
```ts
    const stream = anthropic().messages.stream({
      model,
```

In `agenticCompose`, add a `model: string` parameter and use it at the stream call:

```ts
async function agenticCompose(
  brief: CompositionBrief,
  admin: ReturnType<typeof createAdminClient>,
  accountId: string,
  model: string,
): Promise<ComposeOutcome> {
```
```ts
        const stream = anthropic().messages.stream({
          model,
```

- [ ] **Step 4: `render.ts` — load routing once and pass it through**

Add the import:

```ts
import { loadModelRouting } from '@/lib/ai/model-routing.server';
```

Inside the `step.run('compose', ...)`, after `const brief = await loadBrief(admin, videoId);`, resolve the models once:

```ts
      const models = await loadModelRouting(admin, brief.accountId);
```

Update the compose calls (the ternary at ~line 108-114) to pass `models.video_composition`:

```ts
        ? await agenticCompose(briefWithResources, admin, brief.accountId, models.video_composition)
        : await proceduralCompose(briefWithResources, models.video_composition);
```
```ts
        const fb = await proceduralCompose(briefWithResources, models.video_composition);
```

Update the `annotateSceneEmphasis` call (inside the same step) to pass the model:

```ts
              : await annotateSceneEmphasis({
                  alignment: ci.alignment,
                  sceneScript: ci.narration,
                  density: brief.captionEmphasisDensity,
                  model: models.caption_emphasis,
                });
```

Have the compose step return the resolved composition model so the separate gate2 step can use it without re-loading. Add `videoModel: models.video_composition` to the object the compose `step.run` returns, and read it in the gate2 step:

```ts
      const result = await runGate2({
        region,
        functionName,
        serveUrl: serverEnv.remotion.serveUrl,
        specUrl,
        midFrame,
        sceneIntent: composed.midSceneIntent,
        model: composed.videoModel,
      });
```

Finally, remove `COMPOSITION_MODEL` from the `render.ts` import if it is now unused (`import { anthropic } from '@/lib/ai/anthropic';`).

> Note for the implementer: confirm what the compose `step.run` currently returns and add `videoModel` to that returned object so `composed.videoModel` exists in the gate2 step. If any other site in `render.ts` still references `COMPOSITION_MODEL`, leave the import; otherwise drop it.

- [ ] **Step 5: Type-check + full suite**

Run: `npx tsc --noEmit` → no new errors.
Run: `npm test` → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/inngest/functions/render.ts src/lib/composition/gate2.ts src/lib/captions/emphasis-annotate.ts
git commit -m "feat: route the render path (composition + gate2 + emphasis) through model routing

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Route the primitive + resource server actions (`gates.ts` + `primitives/actions.ts` + `resources/upload.ts`)

**Files:**
- Modify: `src/lib/primitives/gates.ts`
- Modify: `src/app/(app)/primitives/actions.ts`
- Modify: `src/lib/resources/upload.ts`

**Interfaces:**
- Consumes: `loadModelRouting` from `@/lib/ai/model-routing.server`.
- Produces: `runGates` + `runBrandGate` accept an optional `model?: string` (default `COMPOSITION_MODEL`).

**Context:** `runGates(input)` (`gates.ts`) is called by `primitives/actions.ts:69` (authoring, has `accountId` via `requireAccountId`) and by `captions/effect-gate.ts:26` (effect gating — leave unchanged, it relies on the default). `runGates` internally calls `runBrandGate` which uses `COMPOSITION_MODEL`. `primitives/actions.ts` drafting uses `PRIMITIVE_DRAFT_MODEL` (line ~50). `resources/upload.ts` `confirmResourceUpload(... , accountId)` has a client + accountId and uses `COMPOSITION_MODEL` (line ~89).

- [ ] **Step 1: `gates.ts` — optional `model` threaded to `runBrandGate`**

Add an optional `model?: string` to `runGates`'s input type and to `runBrandGate`'s signature. In `runBrandGate`, change `model: COMPOSITION_MODEL` to `model: model ?? COMPOSITION_MODEL` (keep the `COMPOSITION_MODEL` import as the default). When `runGates` calls `runBrandGate`, pass its `input.model` through. (Optional + default preserves the `effect-gate.ts` caller, which does not pass a model.)

- [ ] **Step 2: `primitives/actions.ts` — route drafting + brand-gate**

Add:

```ts
import { loadModelRouting } from '@/lib/ai/model-routing.server';
```

In the drafting function (uses `requireAccountId` → `accountId`, and `createClient` → `supabase`), load routing and use it:

```ts
  const models = await loadModelRouting(supabase, accountId);
```
```ts
    model: models.primitive_drafting,
```

In the function that calls `runGates(input)` (line ~69), load routing for that function's account/client and pass the composition model:

```ts
  const out = await runGates({ ...input, model: models.video_composition });
```

(If drafting and gate-running are the same function, load `models` once and use both fields. If they are separate functions, load `models` in each via that function's `requireAccountId` + client.) If `PRIMITIVE_DRAFT_MODEL` becomes unused, drop it from the import.

- [ ] **Step 3: `resources/upload.ts` — route the auto-tag vision call**

Add:

```ts
import { loadModelRouting } from '@/lib/ai/model-routing.server';
```

In `confirmResourceUpload` (has the authed client + `accountId`), load routing and use it for the vision call (line ~89):

```ts
  const models = await loadModelRouting(<client>, accountId);
```
```ts
      model: models.video_composition,
```

(Use the same authed Supabase client the function already receives/creates.) Drop `COMPOSITION_MODEL` from the import if now unused.

- [ ] **Step 4: Type-check + full suite**

Run: `npx tsc --noEmit` → no new errors.
Run: `npm test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/primitives/gates.ts "src/app/(app)/primitives/actions.ts" src/lib/resources/upload.ts
git commit -m "feat: route primitive drafting/brand-gate + resource tagging through model routing

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: `/settings` page + `ModelRoutingEditor` + nav link

**Files:**
- Create: `src/app/(app)/settings/page.tsx`
- Create: `src/app/(app)/settings/ModelRoutingEditor.tsx`
- Modify: `src/app/(app)/layout.tsx`

**Interfaces:**
- Consumes: `parseModelRouting`, `MODEL_TASKS`, `MODEL_ALLOWLIST`, `type ModelTask` from `@/lib/ai/model-routing`; `saveModelRouting` from `./model-routing-actions`; `createClient` from `@/lib/supabase/server`.

- [ ] **Step 1: Write the editor**

Create `src/app/(app)/settings/ModelRoutingEditor.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { saveModelRouting } from './model-routing-actions';
import { MODEL_TASKS, MODEL_ALLOWLIST, type ModelTask } from '@/lib/ai/model-routing';

const TASK_LABELS: Record<ModelTask, string> = {
  script_generation: 'Script generation',
  video_composition: 'Composition & vision',
  caption_emphasis: 'Caption emphasis',
  primitive_drafting: 'Primitive drafting',
};

// Account model-routing editor (Phase 8). One Anthropic model per task; one
// dirty-tracked Save. Mirrors the channel editors.
export function ModelRoutingEditor({ initial }: { initial: Record<ModelTask, string> }) {
  const [form, setForm] = useState<Record<ModelTask, string>>(initial);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function patch(task: ModelTask, id: string) {
    setForm((f) => ({ ...f, [task]: id }));
    setDirty(true);
    setSaved(false);
  }

  async function onSave() {
    setBusy(true);
    setError(null);
    try {
      const res = await saveModelRouting(form);
      if (res.ok) {
        setDirty(false);
        setSaved(true);
      } else {
        setError(res.reason);
      }
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Model routing</h2>
        <p className="text-sm opacity-70">Which Anthropic model each task uses.</p>
      </div>

      <div className="space-y-3">
        {MODEL_TASKS.map((task) => (
          <label key={task} className="flex items-center justify-between gap-4">
            <span className="text-sm font-medium">{TASK_LABELS[task]}</span>
            <select
              value={form[task]}
              onChange={(e) => patch(task, e.target.value)}
              className="rounded border border-black/15 bg-transparent px-2 py-1.5 text-sm dark:border-white/15"
            >
              {MODEL_ALLOWLIST.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onSave}
          disabled={busy || !dirty}
          className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
        {saved && !dirty && <span className="text-sm text-green-600">Saved</span>}
        {error && <span className="text-sm text-red-600">{error}</span>}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Write the page**

Create `src/app/(app)/settings/page.tsx`:

```tsx
import { createClient } from '@/lib/supabase/server';
import { parseModelRouting } from '@/lib/ai/model-routing';
import { ModelRoutingEditor } from './ModelRoutingEditor';

// Account settings (Phase 8). First section: model routing. RLS scopes the read to
// the caller's own account.
export default async function SettingsPage() {
  const supabase = await createClient();
  const { data: account } = await supabase.from('accounts').select('model_routing').maybeSingle();
  const initial = parseModelRouting(account?.model_routing);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Account settings</h1>
        <p className="text-sm opacity-70">Defaults that apply across your channels.</p>
      </div>
      <ModelRoutingEditor initial={initial} />
    </div>
  );
}
```

- [ ] **Step 3: Add the nav link**

In `src/app/(app)/layout.tsx`, add a `Settings` link alongside the existing nav links (matching their style), e.g. after the Channels link:

```tsx
          <Link href="/settings" className="text-sm opacity-70 hover:opacity-100">
            Settings
          </Link>
```

- [ ] **Step 4: Type-check + full suite**

Run: `npx tsc --noEmit` → no new errors.
Run: `npm test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/settings/page.tsx" "src/app/(app)/settings/ModelRoutingEditor.tsx" "src/app/(app)/layout.tsx"
git commit -m "feat: /settings account page with model-routing editor + nav link

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Manual / app-run e2e (operator, after Task 8)

Not an automated task:

1. Open `/settings` → Model routing shows the four tasks at their defaults (Opus / Sonnet / Haiku / Opus).
2. Change `script_generation` to Sonnet → Save → reload persists.
3. Run a script generation → confirm the chosen model is used (logs / cost event).
4. Reset to defaults (or an account with empty routing) → generation/compose use the same models as before this slice.
5. A composition render still passes Gate-2 and produces captions (the threaded models reach gate2 + emphasis).

---

## Self-Review

**1. Spec coverage:**
- Pure core (tasks/defaults/allowlist/parse/validate) → Task 1. ✅
- Single source of truth for defaults → Task 2. ✅
- `accounts.model_routing` + RPC, no phantom save → Task 3. ✅
- Loader (resilient) + save action → Task 4. ✅
- All call sites routed: script (T5), composition+gate2+emphasis (T6), primitive drafting+brand-gate+resource-tag (T7). ✅
- `/settings` page + editor + nav → Task 8. ✅
- Back-compat (empty → defaults; constants keep values) → Tasks 1, 2, 4. ✅
- Anthropic-only / thinking unchanged → no client/thinking change in any task. ✅

**2. Placeholder scan:** the only non-literal references are `<client>` in Task 7 Step 3 (the function's existing authed client — named in context) and the "confirm what the compose step returns" note in Task 6 Step 4; both are precise instructions, not vague stubs. All code steps carry complete code.

**3. Type consistency:** `ModelTask` + `Record<ModelTask,string>` consistent across Tasks 1, 4, 8; `loadModelRouting(client, accountId)` consistent across Tasks 4–7; the `model` param added to `Gate2Params` / `annotateSceneEmphasis` / `proceduralCompose` / `agenticCompose` / `runGates` / `runBrandGate` consistent between the modifying task (T6/T7) and its callers. RPC name `set_account_model_routing` consistent across Tasks 3 and 4. The four `DEFAULT_MODELS` keys match `MODEL_TASKS` and the `anthropic.ts` constant mapping in Task 2.
