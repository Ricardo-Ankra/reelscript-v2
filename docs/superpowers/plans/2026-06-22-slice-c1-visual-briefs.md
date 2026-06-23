# Slice C1 — Visual Briefs + Editor + Readiness Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each shot carries a structured, AI-authored, operator-editable **visual brief** (authored at script time); the editor surfaces and edits it; and a readiness gate blocks **Generate Video** when a shot depicts a specific entity but has no attached asset — closing the "stock can't satisfy this" dead-end before a render is spent.

**Architecture:** A new `shots.visual_brief` jsonb column (+ a `generated` `shot_source` value for the later generation slice) is written by the `upsert_scene_with_shots` RPC. The script-gen AI emits the brief alongside the existing fields; a pure `parseVisualBrief` normalizes it for the UI; a `ShotBriefEditor` reads/edits it via a new `setShotVisualBrief` action; a pure `shotReadiness` helper drives an editor-side gate. The resolver is NOT changed in this slice — the brief is additive and compose still uses the existing `description`/`stock_query` path (the resolver routing is slice C2).

**Tech Stack:** Supabase/Postgres (migration + plpgsql RPC), Zod (AI output schema), Next.js App Router (server action + client editor), node:test.

## Global Constraints

- **Additive, back-compatible.** New `shots.visual_brief jsonb` (nullable) + new `shot_source` enum value `generated`. No column drops; existing `description`/`source`/`stock_query`/`resource_id` retained and still honored. A shot with no brief (legacy or pre-migration) behaves exactly as today.
- **The resolver / compose path is UNCHANGED in this slice** — the brief is stored + shown + gated only. Routing on the brief is slice C2.
- **`VisualBrief`** (stored shape, snake_case) = `{ subject: string; action: string; setting: string; framing: string; mood: string; specificity: 'generic'|'entity'|'abstract'|'spokesperson'; entity_name: string | null; recommended_source: 'stock'|'upload'|'generate'|'primitive' }`. `entity_name` is non-null only when `specificity === 'entity'`.
- **`parseVisualBrief(value: unknown): VisualBrief | null`** — `null` for absent/non-object; otherwise normalized with defaults (strings → `''`, `specificity` → `'generic'`, `recommended_source` → `'stock'`, `entity_name` kept only when `specificity === 'entity'`). Never throws.
- **Readiness rule:** a shot is **unresolved** when its brief's `specificity === 'entity'` AND no asset is attached (`source !== 'resource'` or `resource_id == null`). Everything else is resolved.
- **Migrations** are applied with `npm run db:apply -- <relative-path>` (wraps the file in a begin/commit over `SUPABASE_DB_URL`). `ALTER TYPE … ADD VALUE` coexists with the column add + RPC rewrite in one file (the new value is not *used* in the same txn — same as the prior `job_status_cancelled` migration on PG15).
- **Tests** run with `node --experimental-strip-types --import ./scripts/register-loader.mjs --test <file>`; test files import source with an explicit `.ts` extension; `import { test } from 'node:test'; import assert from 'node:assert/strict';`.
- **Server actions / client components / SQL are not unit-tested** — pure logic (`parseVisualBrief`, `shotReadiness`, the AI schema/map) is tested; the rest is verified by `tsc` + `lint` + `build` (+ migration apply).
- **Commit footer:** end every commit message with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- All Supabase reads/writes remain RLS-scoped to the session account.

## File Structure

**Create:**
- `supabase/migrations/20260622120000_shot_visual_brief.sql` — column + enum + RPC rewrite.
- `src/lib/videos/visual-brief.ts` — `VisualBrief` type, constants, `parseVisualBrief`.
- `src/lib/videos/visual-brief.test.ts` — its tests.
- `src/lib/videos/shot-readiness.ts` — `shotReadiness` (pure).
- `src/lib/videos/shot-readiness.test.ts` — its tests.
- `src/app/(app)/videos/[id]/ShotBriefEditor.tsx` — per-shot brief read/edit UI.

**Modify:**
- `src/lib/ai/script-generation.ts` — emit the brief (zod schema + prompt + RPC-args map).
- `src/lib/ai/script-generation.test.ts` — brief parse/map tests.
- `src/app/(app)/videos/[id]/page.tsx` — select + parse `visual_brief` into shots.
- `src/app/(app)/videos/[id]/SceneCard.tsx` — `Shot` type gains `visual_brief`; render `ShotBriefEditor`.
- `src/app/(app)/videos/[id]/Editor.tsx` — select/parse `visual_brief` in both shot reads; `onSetShotBrief` handler; readiness gate on Generate Video.
- `src/app/(app)/videos/[id]/shot-actions.ts` — `setShotVisualBrief` action.

---

### Task 1: Migration — `visual_brief` column, `generated` enum, RPC rewrite

**Files:**
- Create: `supabase/migrations/20260622120000_shot_visual_brief.sql`

**Interfaces:**
- Produces: `shots.visual_brief jsonb` (nullable); `shot_source` value `generated`; `upsert_scene_with_shots` persisting `visual_brief` from each shot's `visual_brief` jsonb key.

No unit test (SQL). Verified by applying + a column/enum check.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260622120000_shot_visual_brief.sql`:

```sql
-- Slice C1: a structured, editable visual brief per shot (authored at script time),
-- and a 'generated' shot source for the later generation slice. Additive: the column
-- is nullable and the enum value is unused until slice D registers a generator.

alter table shots add column if not exists visual_brief jsonb;

-- Safe to add in this migration's txn (PG15): the value is not USED until committed.
alter type shot_source add value if not exists 'generated';

-- Rewrite the scene+shots upsert to also persist each shot's visual_brief (the
-- worker passes it under the snake_case "visual_brief" key in the p_shots array).
create or replace function public.upsert_scene_with_shots(
  p_account_id      uuid,
  p_video_id        uuid,
  p_position        integer,
  p_narration       text,
  p_duration_seconds numeric,
  p_shots           jsonb
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_scene_id uuid;
  v_shot     jsonb;
begin
  insert into scenes (account_id, video_id, position, narration, duration_seconds)
  values (p_account_id, p_video_id, p_position, coalesce(p_narration, ''), p_duration_seconds)
  on conflict (video_id, position) do update
    set narration        = excluded.narration,
        duration_seconds = excluded.duration_seconds
  returning id into v_scene_id;

  delete from shots where scene_id = v_scene_id;

  for v_shot in select * from jsonb_array_elements(coalesce(p_shots, '[]'::jsonb))
  loop
    insert into shots (account_id, scene_id, position, description, source, stock_query, duration_seconds, visual_brief)
    values (
      p_account_id,
      v_scene_id,
      (v_shot->>'position')::integer,
      coalesce(v_shot->>'description', ''),
      coalesce(v_shot->>'source', 'stock')::shot_source,
      v_shot->>'stock_query',
      nullif(v_shot->>'duration_seconds', '')::numeric,
      v_shot->'visual_brief'
    );
  end loop;

  return v_scene_id;
end;
$$;

grant execute on function public.upsert_scene_with_shots(uuid, uuid, integer, text, numeric, jsonb) to service_role;
```

- [ ] **Step 2: Apply the migration**

Run: `npm run db:apply -- supabase/migrations/20260622120000_shot_visual_brief.sql`
Expected: applies without error (begin/commit). If Postgres rejects the `ADD VALUE` for being used in the same txn, that means a row tried to use it — it does not here, so this should not occur; if it does, the implementer reports BLOCKED rather than guessing.

- [ ] **Step 3: Verify the column + enum exist**

Run (psql via the project's DB URL — use the same connection the apply script uses):
`npm run db:apply -- /dev/stdin <<'SQL'
do $$ begin
  perform 1 from information_schema.columns where table_name='shots' and column_name='visual_brief';
  if not found then raise exception 'visual_brief missing'; end if;
  perform 1 from pg_enum e join pg_type t on t.oid=e.enumtypid where t.typname='shot_source' and e.enumlabel='generated';
  if not found then raise exception 'generated enum missing'; end if;
end $$;
SQL`
Expected: no exception (both checks pass). If the heredoc-to-`db:apply` form is not supported by the apply script, instead run the two checks through whatever psql one-shot the project uses and confirm both rows exist; report the method used.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260622120000_shot_visual_brief.sql
git commit -m "feat(db): shots.visual_brief jsonb + generated shot_source + upsert persists brief

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `VisualBrief` type + `parseVisualBrief`

**Files:**
- Create: `src/lib/videos/visual-brief.ts`
- Test: `src/lib/videos/visual-brief.test.ts`

**Interfaces:**
- Produces:
  - `type Specificity = 'generic' | 'entity' | 'abstract' | 'spokesperson'`
  - `type RecommendedSource = 'stock' | 'upload' | 'generate' | 'primitive'`
  - `interface VisualBrief { subject: string; action: string; setting: string; framing: string; mood: string; specificity: Specificity; entity_name: string | null; recommended_source: RecommendedSource }`
  - `const SPECIFICITIES: readonly Specificity[]`, `const RECOMMENDED_SOURCES: readonly RecommendedSource[]`
  - `parseVisualBrief(value: unknown): VisualBrief | null`

- [ ] **Step 1: Write the failing test**

Create `src/lib/videos/visual-brief.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVisualBrief } from './visual-brief.ts';

test('parseVisualBrief: full entity brief round-trips', () => {
  const b = parseVisualBrief({
    subject: 'Rivian R2',
    action: 'driving on a coastal road',
    setting: 'sunset, Pacific coast',
    framing: 'wide tracking shot',
    mood: 'aspirational',
    specificity: 'entity',
    entity_name: 'Rivian R2',
    recommended_source: 'upload',
  });
  assert.deepEqual(b, {
    subject: 'Rivian R2',
    action: 'driving on a coastal road',
    setting: 'sunset, Pacific coast',
    framing: 'wide tracking shot',
    mood: 'aspirational',
    specificity: 'entity',
    entity_name: 'Rivian R2',
    recommended_source: 'upload',
  });
});

test('parseVisualBrief: missing fields get defaults', () => {
  const b = parseVisualBrief({ subject: 'a city street' });
  assert.equal(b?.subject, 'a city street');
  assert.equal(b?.action, '');
  assert.equal(b?.specificity, 'generic');
  assert.equal(b?.recommended_source, 'stock');
  assert.equal(b?.entity_name, null);
});

test('parseVisualBrief: invalid specificity/source fall back', () => {
  const b = parseVisualBrief({ specificity: 'nonsense', recommended_source: 'wat' });
  assert.equal(b?.specificity, 'generic');
  assert.equal(b?.recommended_source, 'stock');
});

test('parseVisualBrief: entity_name dropped unless specificity is entity', () => {
  const b = parseVisualBrief({ specificity: 'generic', entity_name: 'Rivian R2' });
  assert.equal(b?.entity_name, null);
  const e = parseVisualBrief({ specificity: 'entity', entity_name: '  Rivian R2  ' });
  assert.equal(e?.entity_name, 'Rivian R2');
  const blank = parseVisualBrief({ specificity: 'entity', entity_name: '   ' });
  assert.equal(blank?.entity_name, null);
});

test('parseVisualBrief: null / non-object / garbage → null', () => {
  assert.equal(parseVisualBrief(null), null);
  assert.equal(parseVisualBrief(undefined), null);
  assert.equal(parseVisualBrief('x'), null);
  assert.equal(parseVisualBrief(42), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/videos/visual-brief.test.ts`
Expected: FAIL — module `./visual-brief.ts` does not exist.

- [ ] **Step 3: Write the implementation**

Create `src/lib/videos/visual-brief.ts`:

```ts
// The structured visual brief authored per shot at script time (slice C1).
// Stored snake_case on shots.visual_brief; this is the single source of the shape
// for the editor, the readiness gate, and (slice C2) the resolver router.
export type Specificity = 'generic' | 'entity' | 'abstract' | 'spokesperson';
export type RecommendedSource = 'stock' | 'upload' | 'generate' | 'primitive';

export interface VisualBrief {
  subject: string;
  action: string;
  setting: string;
  framing: string;
  mood: string;
  specificity: Specificity;
  entity_name: string | null;
  recommended_source: RecommendedSource;
}

export const SPECIFICITIES: readonly Specificity[] = [
  'generic',
  'entity',
  'abstract',
  'spokesperson',
];

export const RECOMMENDED_SOURCES: readonly RecommendedSource[] = [
  'stock',
  'upload',
  'generate',
  'primitive',
];

// Normalize a stored/unknown value into a VisualBrief, or null when absent. Never
// throws. Strings default to ''; specificity/recommended_source fall back to the
// first option; entity_name is kept (trimmed) only when specificity === 'entity'.
export function parseVisualBrief(value: unknown): VisualBrief | null {
  if (!value || typeof value !== 'object') return null;
  const o = value as Record<string, unknown>;
  const str = (k: string): string => (typeof o[k] === 'string' ? (o[k] as string) : '');

  const specificity: Specificity = SPECIFICITIES.includes(o.specificity as Specificity)
    ? (o.specificity as Specificity)
    : 'generic';
  const recommended_source: RecommendedSource = RECOMMENDED_SOURCES.includes(
    o.recommended_source as RecommendedSource,
  )
    ? (o.recommended_source as RecommendedSource)
    : 'stock';
  const entityRaw = typeof o.entity_name === 'string' ? (o.entity_name as string).trim() : '';

  return {
    subject: str('subject'),
    action: str('action'),
    setting: str('setting'),
    framing: str('framing'),
    mood: str('mood'),
    specificity,
    entity_name: specificity === 'entity' && entityRaw ? entityRaw : null,
    recommended_source,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/videos/visual-brief.test.ts`
Expected: PASS (all 5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/videos/visual-brief.ts src/lib/videos/visual-brief.test.ts
git commit -m "feat(videos): VisualBrief type + parseVisualBrief

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Script generation emits the brief

**Files:**
- Modify: `src/lib/ai/script-generation.ts`
- Test: `src/lib/ai/script-generation.test.ts`

**Interfaces:**
- Consumes: nothing new (defines the AI-output brief shape locally to keep the AI schema self-contained).
- Produces: `generatedShotSchema` with an optional `visualBrief`; `sceneToRpcArgs` maps it to a snake_case `visual_brief` per shot; `buildSystemPrompt` instructs the model to author it.

- [ ] **Step 1: Add the failing tests**

Append to `src/lib/ai/script-generation.test.ts` (import `parseSceneLine` and `sceneToRpcArgs` if not already imported — add to the existing import from `./script-generation.ts`):

```ts
test('parseSceneLine: accepts a shot visualBrief', () => {
  const line = JSON.stringify({
    position: 1,
    narration: 'The new electric SUV.',
    shots: [
      {
        position: 1,
        description: 'Rivian R2 driving',
        source: 'stock',
        stockQuery: 'electric suv road',
        visualBrief: {
          subject: 'Rivian R2',
          action: 'driving',
          setting: 'coastal road',
          framing: 'wide',
          mood: 'aspirational',
          specificity: 'entity',
          entityName: 'Rivian R2',
          recommendedSource: 'upload',
        },
      },
    ],
  });
  const scene = parseSceneLine(line);
  assert.ok(scene);
  assert.equal(scene?.shots[0].visualBrief?.specificity, 'entity');
  assert.equal(scene?.shots[0].visualBrief?.entityName, 'Rivian R2');
});

test('sceneToRpcArgs: maps visualBrief to snake_case visual_brief', () => {
  const scene = {
    position: 1,
    narration: 'x',
    shots: [
      {
        position: 1,
        description: 'd',
        source: 'stock' as const,
        visualBrief: {
          subject: 'Rivian R2',
          action: 'driving',
          setting: 'road',
          framing: 'wide',
          mood: 'calm',
          specificity: 'entity' as const,
          entityName: 'Rivian R2',
          recommendedSource: 'upload' as const,
        },
      },
    ],
  };
  const args = sceneToRpcArgs(scene, 'acc', 'vid');
  assert.deepEqual(args.p_shots[0].visual_brief, {
    subject: 'Rivian R2',
    action: 'driving',
    setting: 'road',
    framing: 'wide',
    mood: 'calm',
    specificity: 'entity',
    entity_name: 'Rivian R2',
    recommended_source: 'upload',
  });
});

test('sceneToRpcArgs: no visualBrief → visual_brief null', () => {
  const scene = {
    position: 1,
    narration: 'x',
    shots: [{ position: 1, description: 'd', source: 'stock' as const }],
  };
  const args = sceneToRpcArgs(scene, 'acc', 'vid');
  assert.equal(args.p_shots[0].visual_brief, null);
});

test('sceneToRpcArgs: entity_name dropped when specificity is not entity', () => {
  const scene = {
    position: 1,
    narration: 'x',
    shots: [
      {
        position: 1,
        description: 'd',
        source: 'stock' as const,
        visualBrief: {
          subject: 's',
          action: 'a',
          setting: '',
          framing: '',
          mood: '',
          specificity: 'generic' as const,
          entityName: 'Rivian R2',
          recommendedSource: 'stock' as const,
        },
      },
    ],
  };
  const args = sceneToRpcArgs(scene, 'acc', 'vid');
  assert.equal(args.p_shots[0].visual_brief?.entity_name, null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/ai/script-generation.test.ts`
Expected: FAIL — `visualBrief` is stripped by the schema / `visual_brief` is undefined in the args.

- [ ] **Step 3: Extend the zod schema**

In `src/lib/ai/script-generation.ts`, add a brief schema and include it on the shot. Replace the `generatedShotSchema` definition:

```ts
export const generatedShotSchema = z.object({
  position: z.number().int().positive(),
  description: z.string().default(''),
  source: z.enum(['stock', 'resource', 'procedural']).default('stock'),
  stockQuery: z.string().optional(),
  durationSeconds: z.number().positive().optional(),
});
```

with:

```ts
// The visual brief the model authors per shot (camelCase in AI output; stored
// snake_case — see sceneToRpcArgs). Drives the editor, the readiness gate, and
// (slice C2) the resolver router.
export const generatedVisualBriefSchema = z.object({
  subject: z.string().default(''),
  action: z.string().default(''),
  setting: z.string().default(''),
  framing: z.string().default(''),
  mood: z.string().default(''),
  specificity: z.enum(['generic', 'entity', 'abstract', 'spokesperson']).default('generic'),
  entityName: z.string().optional(),
  recommendedSource: z.enum(['stock', 'upload', 'generate', 'primitive']).default('stock'),
});

export const generatedShotSchema = z.object({
  position: z.number().int().positive(),
  description: z.string().default(''),
  source: z.enum(['stock', 'resource', 'procedural']).default('stock'),
  stockQuery: z.string().optional(),
  durationSeconds: z.number().positive().optional(),
  visualBrief: generatedVisualBriefSchema.optional(),
});
```

- [ ] **Step 4: Map the brief in `sceneToRpcArgs`**

In `sceneToRpcArgs`, replace the `p_shots` map:

```ts
    p_shots: scene.shots.map((s) => ({
      position: s.position,
      description: s.description,
      source: s.source,
      stock_query: s.stockQuery ?? null,
      duration_seconds: s.durationSeconds ?? null,
    })),
```

with:

```ts
    p_shots: scene.shots.map((s) => ({
      position: s.position,
      description: s.description,
      source: s.source,
      stock_query: s.stockQuery ?? null,
      duration_seconds: s.durationSeconds ?? null,
      visual_brief: s.visualBrief
        ? {
            subject: s.visualBrief.subject,
            action: s.visualBrief.action,
            setting: s.visualBrief.setting,
            framing: s.visualBrief.framing,
            mood: s.visualBrief.mood,
            specificity: s.visualBrief.specificity,
            entity_name:
              s.visualBrief.specificity === 'entity' ? (s.visualBrief.entityName ?? null) : null,
            recommended_source: s.visualBrief.recommendedSource,
          }
        : null,
    })),
```

- [ ] **Step 5: Instruct the model in the system prompt**

In `buildSystemPrompt`, the shot field list currently ends with the `stockQuery` line and is followed by the `Guidance:` line. Add the brief instructions. Replace:

```ts
    '     "stockQuery": a short search query (include only when source is "stock")',
    '',
    'Guidance: prefer "stock" for real footage (always give a stockQuery), and',
    '"procedural" for text/animation/diagrams. Keep 1-3 shots per scene.',
```

with:

```ts
    '     "stockQuery": a short search query (include only when source is "stock")',
    '     "visualBrief": a structured description of the shot (author this for EVERY shot):',
    '        "subject": what is on screen, "action": what happens, "setting": where,',
    '        "framing": shot type (wide/close-up/aerial/screen-recording/…),',
    '        "mood": tone/lighting,',
    '        "specificity": one of "generic" (a generic concept stock can show),',
    '          "entity" (a SPECIFIC named real product/person/place stock cannot reliably show),',
    '          "abstract" (branded motion/stylized/data-viz), "spokesperson" (a talking head),',
    '        "entityName": the exact name (REQUIRED when specificity is "entity"),',
    '        "recommendedSource": one of "stock", "upload", "generate", "primitive"',
    '          (use "upload" when specificity is "entity" — only operator footage is reliable).',
    '',
    'Guidance: prefer "stock" for real footage (always give a stockQuery), and',
    '"procedural" for text/animation/diagrams. Keep 1-3 shots per scene. Be honest in',
    '"specificity": if a shot names a specific real product/person/place, mark it "entity".',
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/ai/script-generation.test.ts`
Expected: PASS (existing tests + the 4 new ones).

- [ ] **Step 7: Commit**

```bash
git add src/lib/ai/script-generation.ts src/lib/ai/script-generation.test.ts
git commit -m "feat(ai): script generation authors a structured visual brief per shot

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Load + thread `visual_brief` into the editor

**Files:**
- Modify: `src/app/(app)/videos/[id]/SceneCard.tsx` (the `Shot` type)
- Modify: `src/app/(app)/videos/[id]/page.tsx`
- Modify: `src/app/(app)/videos/[id]/Editor.tsx`

**Interfaces:**
- Consumes: `parseVisualBrief`, `VisualBrief` (`@/lib/videos/visual-brief`, Task 2).
- Produces: `Shot.visual_brief: VisualBrief | null` populated everywhere shots are read (server first paint + the editor's two Realtime reads).

No unit test (data plumbing). Verify `tsc` + `lint`.

- [ ] **Step 1: Add `visual_brief` to the `Shot` type**

In `src/app/(app)/videos/[id]/SceneCard.tsx`, add the import at the top (after the React import):

```ts
import type { VisualBrief } from '@/lib/videos/visual-brief';
```

and add the field to the `Shot` type (after `resource_id`):

```ts
  visual_brief: VisualBrief | null;
```

- [ ] **Step 2: Select + parse in `page.tsx`**

In `src/app/(app)/videos/[id]/page.tsx`, add the import:

```ts
import { parseVisualBrief } from '@/lib/videos/visual-brief';
```

Change the shots select (currently `.select('id, scene_id, position, description, source, stock_query, resource_id')`) to include `visual_brief`:

```ts
      .select('id, scene_id, position, description, source, stock_query, resource_id, visual_brief')
```

and in the shot row mapping (where `resource_id: (row.resource_id as string | null) ?? null,` is set) add:

```ts
        visual_brief: parseVisualBrief(row.visual_brief),
```

- [ ] **Step 3: Select + parse in the editor's two shot reads**

In `src/app/(app)/videos/[id]/Editor.tsx`, add the import:

```ts
import { parseVisualBrief } from '@/lib/videos/visual-brief';
```

Both shot selects currently read `.select('id, position, description, source, stock_query, resource_id')` (the per-scene `fetchShots`) and `.select('id, scene_id, position, description, source, stock_query, resource_id')` (the reconcile). Add `, visual_brief` to BOTH select strings.

Then, wherever each read maps DB rows into `Shot` objects, set `visual_brief: parseVisualBrief(row.visual_brief)`. (If a read currently does `data as Shot[]` without an explicit map — the per-scene `fetchShots` assigns `data as Shot[]` — change it to map each row to a `Shot` with `visual_brief: parseVisualBrief(row.visual_brief)` and the existing fields, so the type is honest. The reconcile read already maps rows; add the field there.)

- [ ] **Step 4: Typecheck + lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors (every `Shot` now carries `visual_brief`).

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/videos/[id]/SceneCard.tsx" "src/app/(app)/videos/[id]/page.tsx" "src/app/(app)/videos/[id]/Editor.tsx"
git commit -m "feat(videos): load + thread visual_brief into editor shots

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: `setShotVisualBrief` action + `ShotBriefEditor`

**Files:**
- Modify: `src/app/(app)/videos/[id]/shot-actions.ts`
- Create: `src/app/(app)/videos/[id]/ShotBriefEditor.tsx`
- Modify: `src/app/(app)/videos/[id]/SceneCard.tsx` (render the editor)
- Modify: `src/app/(app)/videos/[id]/Editor.tsx` (the `onSetShotBrief` handler + prop)

**Interfaces:**
- Consumes: `parseVisualBrief`, `VisualBrief`, `SPECIFICITIES`, `RECOMMENDED_SOURCES` (Task 2); `setShotVisualBrief` (this task).
- Produces: `setShotVisualBrief(shotId: string, brief: unknown): Promise<{ ok: true } | { ok: false; reason: string }>`; `ShotBriefEditor({ brief, onSave })`; `SceneCard` prop `onSetShotBrief: (shotId: string, brief: VisualBrief) => void`.

No unit test (server action + client). Verify `tsc` + `lint`.

- [ ] **Step 1: Add the `setShotVisualBrief` action**

In `src/app/(app)/videos/[id]/shot-actions.ts`, add the import:

```ts
import { parseVisualBrief } from '@/lib/videos/visual-brief';
```

and append the action:

```ts
// Save a shot's visual brief (the operator-edited structured description). The
// value is normalized through parseVisualBrief before the write. Direct RLS write
// scoped by account_id, confirmed via .select('id') (no row → "Shot not found.").
export async function setShotVisualBrief(
  shotId: string,
  brief: unknown,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const clean = parseVisualBrief(brief);
  if (!clean) return { ok: false, reason: 'Invalid brief.' };

  const supabase = await createClient();
  const { data: account } = await supabase.from('accounts').select('id').maybeSingle();
  if (!account) return { ok: false, reason: 'No account found.' };

  const { data, error } = await supabase
    .from('shots')
    .update({ visual_brief: clean })
    .eq('id', shotId)
    .eq('account_id', account.id as string)
    .select('id');
  if (error) return { ok: false, reason: error.message };
  if (!data || data.length === 0) return { ok: false, reason: 'Shot not found.' };
  return { ok: true };
}
```

- [ ] **Step 2: Create the brief editor component**

Create `src/app/(app)/videos/[id]/ShotBriefEditor.tsx`:

```tsx
'use client';

import { useState } from 'react';
import {
  type VisualBrief,
  type Specificity,
  type RecommendedSource,
  SPECIFICITIES,
  RECOMMENDED_SOURCES,
} from '@/lib/videos/visual-brief';

const EMPTY: VisualBrief = {
  subject: '',
  action: '',
  setting: '',
  framing: '',
  mood: '',
  specificity: 'generic',
  entity_name: null,
  recommended_source: 'stock',
};

// Per-shot brief editor: a collapsed summary that expands to a compact form.
// Save hands the edited brief up; the parent persists + updates state.
export function ShotBriefEditor({
  brief,
  onSave,
}: {
  brief: VisualBrief | null;
  onSave: (brief: VisualBrief) => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<VisualBrief>(brief ?? EMPTY);
  const [busy, setBusy] = useState(false);

  const set = (patch: Partial<VisualBrief>) => setDraft((d) => ({ ...d, ...patch }));

  async function save() {
    setBusy(true);
    try {
      const normalized: VisualBrief = {
        ...draft,
        entity_name:
          draft.specificity === 'entity' && draft.entity_name && draft.entity_name.trim()
            ? draft.entity_name.trim()
            : null,
      };
      await onSave(normalized);
      setOpen(false);
    } finally {
      setBusy(false);
    }
  }

  const summary = brief
    ? `${brief.specificity}${brief.entity_name ? ` · ${brief.entity_name}` : ''}`
    : 'no brief';

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setDraft(brief ?? EMPTY);
          setOpen(true);
        }}
        className="shrink-0 rounded border border-black/10 px-1 py-px text-[10px] opacity-70 enabled:hover:bg-black/[0.04] dark:border-white/10 dark:enabled:hover:bg-white/[0.06]"
        title="Edit the visual brief"
      >
        Brief: {summary}
      </button>
    );
  }

  const field = (label: string, key: 'subject' | 'action' | 'setting' | 'framing' | 'mood') => (
    <label className="flex flex-col gap-0.5">
      <span className="opacity-50">{label}</span>
      <input
        value={draft[key]}
        onChange={(e) => set({ [key]: e.target.value } as Partial<VisualBrief>)}
        className="rounded border border-black/10 bg-transparent px-1 py-px dark:border-white/10"
      />
    </label>
  );

  return (
    <div className="mt-1 w-full space-y-1.5 rounded-md border border-black/10 p-2 text-[10px] dark:border-white/10">
      <div className="grid grid-cols-2 gap-1.5">
        {field('Subject', 'subject')}
        {field('Action', 'action')}
        {field('Setting', 'setting')}
        {field('Framing', 'framing')}
        {field('Mood', 'mood')}
        <label className="flex flex-col gap-0.5">
          <span className="opacity-50">Specificity</span>
          <select
            value={draft.specificity}
            onChange={(e) => set({ specificity: e.target.value as Specificity })}
            className="rounded border border-black/10 bg-transparent px-1 py-px dark:border-white/10"
          >
            {SPECIFICITIES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        {draft.specificity === 'entity' && (
          <label className="flex flex-col gap-0.5">
            <span className="opacity-50">Entity name</span>
            <input
              value={draft.entity_name ?? ''}
              onChange={(e) => set({ entity_name: e.target.value })}
              className="rounded border border-black/10 bg-transparent px-1 py-px dark:border-white/10"
            />
          </label>
        )}
        <label className="flex flex-col gap-0.5">
          <span className="opacity-50">Recommended source</span>
          <select
            value={draft.recommended_source}
            onChange={(e) => set({ recommended_source: e.target.value as RecommendedSource })}
            className="rounded border border-black/10 bg-transparent px-1 py-px dark:border-white/10"
          >
            {RECOMMENDED_SOURCES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={save}
          className="rounded border border-black/15 px-2 py-px font-medium enabled:hover:bg-black/[0.04] disabled:opacity-40 dark:border-white/20 dark:enabled:hover:bg-white/[0.06]"
        >
          {busy ? 'Saving…' : 'Save brief'}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="opacity-60 hover:opacity-100">
          Cancel
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Render the editor in `SceneCard`**

In `src/app/(app)/videos/[id]/SceneCard.tsx`, import the editor (after the `SceneAssetUploader` import):

```ts
import { ShotBriefEditor } from './ShotBriefEditor';
import type { VisualBrief } from '@/lib/videos/visual-brief';
```

(If Task 4 already added `import type { VisualBrief } …`, keep a single import — add `ShotBriefEditor` only.)

Add the prop to the destructuring (alongside `onSetShotResource`, `onUploadAndAttach`):

```ts
  onSetShotBrief,
```

and the prop type:

```ts
  onSetShotBrief: (shotId: string, brief: VisualBrief) => void;
```

The shot `<li>` currently wraps the row in `flex items-start`. To fit the expandable brief editor (which is full-width when open), wrap the shot in a column. Change the shot `<li>` opening from:

```tsx
              <li key={shot.id} className="flex items-start gap-2 text-xs opacity-60">
```

to a column container holding the existing row plus the brief editor:

```tsx
              <li key={shot.id} className="flex flex-col gap-1 text-xs opacity-60">
                <div className="flex items-start gap-2">
```

and close the new inner `<div>` immediately before the existing `</li>` (after the `<SceneAssetUploader … />` line), then render the brief editor as the second child of the `<li>`:

```tsx
                </div>
                <ShotBriefEditor
                  brief={shot.visual_brief}
                  onSave={(brief) => onSetShotBrief(shot.id, brief)}
                />
              </li>
```

(Net: the row’s existing children — `▸`, description, the resource `<select>`, the `<SceneAssetUploader>` — move inside the new inner `<div className="flex items-start gap-2">`; the `<ShotBriefEditor>` sits below them inside the `<li>`.)

- [ ] **Step 4: Editor — `onSetShotBrief` handler + pass it down**

In `src/app/(app)/videos/[id]/Editor.tsx`, add the import:

```ts
import { setShotVisualBrief } from './shot-actions';
import type { VisualBrief } from '@/lib/videos/visual-brief';
```

(`setShotResource` is already imported from `./shot-actions` — add `setShotVisualBrief` to that existing import instead of a second line. If Task 4 already imported `parseVisualBrief`/`VisualBrief`, keep a single `visual-brief` import.)

After the `onSetShotResource` `useCallback`, add:

```ts
  const onSetShotBrief = useCallback(async (shotId: string, brief: VisualBrief) => {
    const res = await setShotVisualBrief(shotId, brief);
    if (!res.ok) return;
    setScenes((prev) =>
      prev.map((s) => ({
        ...s,
        shots: s.shots.map((sh) => (sh.id === shotId ? { ...sh, visual_brief: brief } : sh)),
      })),
    );
  }, []);
```

In the `<SceneCard ... />` usage, add the prop:

```tsx
              onSetShotBrief={onSetShotBrief}
```

- [ ] **Step 5: Typecheck + lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(app)/videos/[id]/shot-actions.ts" "src/app/(app)/videos/[id]/ShotBriefEditor.tsx" "src/app/(app)/videos/[id]/SceneCard.tsx" "src/app/(app)/videos/[id]/Editor.tsx"
git commit -m "feat(videos): edit a shot's visual brief in the scene editor

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Pure `shotReadiness` helper

**Files:**
- Create: `src/lib/videos/shot-readiness.ts`
- Test: `src/lib/videos/shot-readiness.test.ts`

**Interfaces:**
- Consumes: `VisualBrief` (`./visual-brief`, Task 2).
- Produces:
  - `interface ReadinessInput { brief: VisualBrief | null; source: string; resourceId: string | null }`
  - `type Readiness = { resolved: true } | { resolved: false; reason: string }`
  - `shotReadiness(input: ReadinessInput): Readiness`

- [ ] **Step 1: Write the failing test**

Create `src/lib/videos/shot-readiness.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/videos/shot-readiness.test.ts`
Expected: FAIL — module `./shot-readiness.ts` does not exist.

- [ ] **Step 3: Write the implementation**

Create `src/lib/videos/shot-readiness.ts`:

```ts
import type { VisualBrief } from './visual-brief';

// Pre-render readiness for a single shot. A shot that depicts a SPECIFIC named
// entity needs an operator-attached asset — stock/generation cannot reliably show
// it (slice C1's fail-forward gate). Everything else is resolvable downstream.
export interface ReadinessInput {
  brief: VisualBrief | null;
  source: string;
  resourceId: string | null;
}

export type Readiness = { resolved: true } | { resolved: false; reason: string };

export function shotReadiness(input: ReadinessInput): Readiness {
  const needsEntityAsset = input.brief?.specificity === 'entity';
  if (!needsEntityAsset) return { resolved: true };

  const hasAsset = input.source === 'resource' && input.resourceId != null;
  if (hasAsset) return { resolved: true };

  const name = input.brief?.entity_name;
  return {
    resolved: false,
    reason: name ? `Needs an asset for "${name}".` : 'Needs an attached asset.',
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/videos/shot-readiness.test.ts`
Expected: PASS (all 5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/videos/shot-readiness.ts src/lib/videos/shot-readiness.test.ts
git commit -m "feat(videos): shotReadiness — entity shots need an attached asset

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Editor readiness gate on Generate Video (full gate)

**Files:**
- Modify: `src/app/(app)/videos/[id]/Editor.tsx`

**Interfaces:**
- Consumes: `shotReadiness` (`@/lib/videos/shot-readiness`, Task 6); the per-shot `visual_brief`/`source`/`resource_id` already on `scenes` state (Task 4).
- Produces: a render block + override when any shot is unresolved.

No unit test (client; the rule is tested in Task 6). This task runs the FULL gate.

- [ ] **Step 1: Add the import**

In `src/app/(app)/videos/[id]/Editor.tsx`:

```ts
import { shotReadiness } from '@/lib/videos/shot-readiness';
```

- [ ] **Step 2: Add the override state**

Near the other `useState` hooks (e.g. after `liveResources`), add a set of shot ids the operator has explicitly accepted despite being unresolved:

```ts
  // Shots the operator chose to render anyway despite the readiness gate.
  const [acceptedShots, setAcceptedShots] = useState<Set<string>>(new Set());
```

- [ ] **Step 3: Compute unresolved shots**

After `const ordered = scenes.slice()...` and the other derived values (near `const canRender = ...`, around line 400), add:

```ts
  // Shots that depict a specific entity with no attached asset (and not overridden).
  const unresolvedShots = scenes
    .flatMap((s) => s.shots)
    .map((sh) => ({ shot: sh, readiness: shotReadiness({ brief: sh.visual_brief, source: sh.source, resourceId: sh.resource_id }) }))
    .filter((x) => !x.readiness.resolved && !acceptedShots.has(x.shot.id));
```

- [ ] **Step 4: Block Generate Video on unresolved shots**

Change the `canRender` line (currently `const canRender = scenes.length > 0 && unsynthesized === 0 && !renderActive;`) to also require zero unresolved shots:

```ts
  const canRender =
    scenes.length > 0 && unsynthesized === 0 && !renderActive && unresolvedShots.length === 0;
```

- [ ] **Step 5: Render the readiness warning + per-shot override**

Immediately before the render-controls block (the `{ordered.length > 0 && ( <div ...> ... Generate Video ... )}` section, around line 452), add a warning that lists each unresolved shot with an "Accept anyway" button:

```tsx
      {ordered.length > 0 && unresolvedShots.length > 0 && (
        <div className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
          <p className="font-medium">
            {unresolvedShots.length} shot{unresolvedShots.length === 1 ? '' : 's'} need an attached
            asset before rendering.
          </p>
          <ul className="space-y-1 text-xs">
            {unresolvedShots.map(({ shot, readiness }) => (
              <li key={shot.id} className="flex items-center justify-between gap-2">
                <span className="min-w-0 flex-1 truncate">
                  {shot.visual_brief?.entity_name || shot.description || 'Shot'} —{' '}
                  {readiness.resolved ? '' : readiness.reason}
                </span>
                <button
                  type="button"
                  onClick={() => setAcceptedShots((p) => new Set(p).add(shot.id))}
                  className="shrink-0 rounded-md border border-black/15 px-2 py-0.5 font-medium enabled:hover:bg-black/[0.04] dark:border-white/20 dark:enabled:hover:bg-white/[0.06]"
                  title="Render anyway with stock/fallback for this shot"
                >
                  Accept anyway
                </button>
              </li>
            ))}
          </ul>
          <p className="text-xs opacity-70">
            Upload footage on the shot to resolve it, or accept to render with a fallback.
          </p>
        </div>
      )}
```

- [ ] **Step 6: Typecheck, lint, build**

Run: `npx tsc --noEmit && npm run lint && npm run build`
Expected: all succeed.

- [ ] **Step 7: Run the full unit suite**

Run: `npm test`
Expected: PASS (including `visual-brief.test.ts`, `shot-readiness.test.ts`, and the extended `script-generation.test.ts`).

- [ ] **Step 8: Commit**

```bash
git add "src/app/(app)/videos/[id]/Editor.tsx"
git commit -m "feat(videos): readiness gate — block Generate Video on unresolved entity shots

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage (slice C, C1 half of the design):**
- `shots.visual_brief jsonb` + `generated` enum (migration) → Task 1. ✓
- `VisualBrief` type + parser → Task 2. ✓
- Script generation emits the brief → Task 3. ✓
- Brief loaded + editable in the scene editor → Tasks 4 (load) + 5 (edit). ✓
- Pure `shotReadiness` + editor Generate-Video gate (fail-forward, with override) → Tasks 6 + 7. ✓
- Resolver router refactor + compose preference → **correctly NOT here (slice C2).** The brief is additive; compose/resolver unchanged. ✓
- Gate-2 vision QA stays as the backstop → unchanged (no task touches render.ts). ✓
- Back-compat: a shot with no brief → `parseVisualBrief` returns null, `shotReadiness` resolves true, compose unchanged → renders as today. ✓

**2. Placeholder scan:** No TBD/TODO/"handle errors"/"similar to". Every code step shows complete code; the migration is the full `CREATE OR REPLACE`; the SceneCard restructure spells out the inner-`<div>` wrap and where the editor renders. ✓

**3. Type consistency:** `VisualBrief` (snake_case, Task 2) is the type stored, parsed (`parseVisualBrief`), carried on `Shot.visual_brief` (Task 4), edited by `ShotBriefEditor`/`onSetShotBrief`/`setShotVisualBrief` (Task 5), and read by `shotReadiness` (Tasks 6/7). The AI output is camelCase (`visualBrief`, `entityName`, `recommendedSource`, Task 3) and `sceneToRpcArgs` converts it to the snake_case stored shape (Task 3) — matching what `parseVisualBrief` reads back. The RPC reads `v_shot->'visual_brief'` (Task 1) = the key `sceneToRpcArgs` writes (Task 3). `shotReadiness`'s `ReadinessInput {brief, source, resourceId}` (Task 6) is built from `sh.visual_brief`/`sh.source`/`sh.resource_id` (Task 7) — all present on `Shot`. ✓
