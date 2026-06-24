# Reelscript V2 — Slice 0: Shot-model contract & beat classification — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every newly generated shot carries a deterministic `kind` (`generative|motion_graphic|live_action`), AI-authored `CameraSpec`/`LightingSpec` for generative shots, and a `provenance` stub — all typed, tested, and persisted at script-generation time. No rendering/resolution behavior changes.

**Architecture:** Additive extension of the existing Supabase `shots` table + the pure `src/lib/videos` shape modules + the pure `src/lib/ai/script-generation.ts` authoring helpers. `kind` is a pure deterministic function of the already-authored visual brief (auditable, not an LLM freeform choice). Mirrors the existing `visual-brief.ts` (never-throw parsers) + `sceneToRpcArgs` (single camelCase→snake_case conversion) patterns.

**Tech Stack:** TypeScript, zod (AI-output schema), Supabase/PostgreSQL (plpgsql RPC), `node:test` via the repo's strip-types loader.

## Global Constraints

- Tests run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test <file>`. Test imports use explicit `.ts` extensions. Header: `import { test } from 'node:test'; import assert from 'node:assert/strict';`.
- Pure modules under `src/lib/**` — no react/server/network imports; type-only imports OK.
- Stored shape is **snake_case**; AI-output shape is **camelCase**. The single conversion site is `sceneToRpcArgs`.
- Never-throw parser pattern (mirror `parseVisualBrief`): absent/garbage → `null`; bad enum → stated default; objects always normalize.
- `classifyBeat` is pure and total; `kind` derives from `specificity` + `recommendedSource` only (NOT from `shots.source`).
- This slice changes **no rendering, resolution, or readiness behavior**. The `shots.source` enum and what the AI emits for `source` are unchanged (source↔kind coherence for generative shots is deferred to Slice 1).
- Sandbox DB: migrations may be liberal; no data-preservation concern.
- Commit message footer, every commit: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

### Task 1: `cinematography.ts` — types + never-throw parsers

**Files:**
- Create: `src/lib/videos/cinematography.ts`
- Test: `src/lib/videos/cinematography.test.ts`

**Interfaces:**
- Consumes: nothing (pure leaf).
- Produces:
  ```ts
  type ShotKind = 'generative' | 'motion_graphic' | 'live_action';
  const SHOT_KINDS: readonly ShotKind[];
  interface CameraSpec { shot_size; angle; move; lens_mm: number; dof; motion_strength: number }
  interface LightingSpec { key; ratio; time_of_day; palette; texture: string }
  interface Provenance { synthetic: boolean; source; model; seed; source_uri; created_at; operator }
  function parseCameraSpec(value: unknown): CameraSpec | null
  function parseLightingSpec(value: unknown): LightingSpec | null
  function parseProvenance(value: unknown): Provenance | null
  ```

- [ ] **Step 1: Write the failing test** — `src/lib/videos/cinematography.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCameraSpec,
  parseLightingSpec,
  parseProvenance,
  SHOT_KINDS,
} from './cinematography.ts';

test('SHOT_KINDS lists the three source classes', () => {
  assert.deepEqual([...SHOT_KINDS], ['generative', 'motion_graphic', 'live_action']);
});

test('parseCameraSpec: absent → null', () => {
  assert.equal(parseCameraSpec(null), null);
  assert.equal(parseCameraSpec(undefined), null);
  assert.equal(parseCameraSpec('x'), null);
});

test('parseCameraSpec: empty object → all defaults', () => {
  assert.deepEqual(parseCameraSpec({}), {
    shot_size: 'MS', angle: 'eye_level', move: 'static',
    lens_mm: 35, dof: 'shallow', motion_strength: 0.7,
  });
});

test('parseCameraSpec: valid values kept; bad enum → default', () => {
  const c = parseCameraSpec({ shot_size: 'WS', angle: 'low', move: 'orbit_360', lens_mm: 85, dof: 'deep', motion_strength: 0.4 });
  assert.deepEqual(c, { shot_size: 'WS', angle: 'low', move: 'orbit_360', lens_mm: 85, dof: 'deep', motion_strength: 0.4 });
  const bad = parseCameraSpec({ shot_size: 'nope', move: 'fly', dof: 'x' });
  assert.equal(bad?.shot_size, 'MS');
  assert.equal(bad?.move, 'static');
  assert.equal(bad?.dof, 'shallow');
});

test('parseCameraSpec: lens_mm coerced to int; motion_strength clamped [0,1]', () => {
  assert.equal(parseCameraSpec({ lens_mm: 50.7 })?.lens_mm, 51);
  assert.equal(parseCameraSpec({ motion_strength: 5 })?.motion_strength, 1);
  assert.equal(parseCameraSpec({ motion_strength: -2 })?.motion_strength, 0);
  assert.equal(parseCameraSpec({ lens_mm: 'big' })?.lens_mm, 35);
});

test('parseLightingSpec: absent → null; empty → defaults; provided kept', () => {
  assert.equal(parseLightingSpec(null), null);
  assert.deepEqual(parseLightingSpec({}), {
    key: 'soft key from frame left', ratio: '3:1', time_of_day: 'golden hour',
    palette: 'teal shadows, warm highlights', texture: 'subtle film grain',
  });
  assert.equal(parseLightingSpec({ palette: 'cool blue' })?.palette, 'cool blue');
  // empty string falls back to default
  assert.equal(parseLightingSpec({ palette: '' })?.palette, 'teal shadows, warm highlights');
});

test('parseProvenance: absent → null; synthetic coerced; fields nullable', () => {
  assert.equal(parseProvenance(null), null);
  assert.deepEqual(parseProvenance({}), {
    synthetic: false, source: null, model: null, seed: null,
    source_uri: null, created_at: null, operator: null,
  });
  const p = parseProvenance({ synthetic: true, source: 'higgsfield:dop-preview', seed: 42 });
  assert.equal(p?.synthetic, true);
  assert.equal(p?.source, 'higgsfield:dop-preview');
  assert.equal(p?.seed, 42);
  assert.equal(parseProvenance({ synthetic: 'yes' })?.synthetic, false); // only boolean true counts
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/videos/cinematography.test.ts`
Expected: FAIL — `Cannot find module './cinematography.ts'`.

- [ ] **Step 3: Implement `src/lib/videos/cinematography.ts`**

```ts
// Structured cinematography + provenance authored/derived per shot (V2 Slice 0).
// Stored snake_case on shots.{camera_spec,lighting_spec,provenance}; this module is
// the single source of the stored shapes for the editor, the router (Slice 1), and
// assembly (Slice 3). Never-throw normalizers mirror parseVisualBrief.

export type ShotKind = 'generative' | 'motion_graphic' | 'live_action';
export const SHOT_KINDS: readonly ShotKind[] = ['generative', 'motion_graphic', 'live_action'];

export type ShotSize = 'ECU' | 'CU' | 'MS' | 'WS' | 'EWS' | 'two_shot' | 'OTS' | 'POV';
export type CameraAngle = 'eye_level' | 'low' | 'high' | 'dutch' | 'aerial' | 'overhead';
export type CameraMove =
  | 'static' | 'dolly_in' | 'dolly_out' | 'arc_left' | 'arc_right' | 'orbit_360'
  | 'crane_up' | 'crane_down' | 'tracking' | 'pan_left' | 'pan_right' | 'tilt_up'
  | 'tilt_down' | 'whip_pan' | 'push_in' | 'pull_back' | 'handheld' | 'bullet_time'
  | 'boom' | 'snorricam' | 'fpv_drone';
export type Dof = 'shallow' | 'deep' | 'rack_focus';

export const SHOT_SIZES: readonly ShotSize[] = ['ECU', 'CU', 'MS', 'WS', 'EWS', 'two_shot', 'OTS', 'POV'];
export const CAMERA_ANGLES: readonly CameraAngle[] = ['eye_level', 'low', 'high', 'dutch', 'aerial', 'overhead'];
export const CAMERA_MOVES: readonly CameraMove[] = [
  'static', 'dolly_in', 'dolly_out', 'arc_left', 'arc_right', 'orbit_360',
  'crane_up', 'crane_down', 'tracking', 'pan_left', 'pan_right', 'tilt_up',
  'tilt_down', 'whip_pan', 'push_in', 'pull_back', 'handheld', 'bullet_time',
  'boom', 'snorricam', 'fpv_drone',
];
export const DOFS: readonly Dof[] = ['shallow', 'deep', 'rack_focus'];

export interface CameraSpec {
  shot_size: ShotSize;
  angle: CameraAngle;
  move: CameraMove;       // ONE primary move — single value, never an array
  lens_mm: number;
  dof: Dof;
  motion_strength: number;
}

export interface LightingSpec {
  key: string;
  ratio: string;
  time_of_day: string;
  palette: string;
  texture: string;
}

export interface Provenance {
  synthetic: boolean;
  source: string | null;     // 'higgsfield:dop-preview' | 'remotion' | 'stock:pexels' | 'shot:on-site' | null (stub)
  model: string | null;
  seed: number | null;
  source_uri: string | null;
  created_at: string | null;
  operator: string | null;
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

export function parseCameraSpec(value: unknown): CameraSpec | null {
  if (!value || typeof value !== 'object') return null;
  const o = value as Record<string, unknown>;
  const lensRaw = typeof o.lens_mm === 'number' && Number.isFinite(o.lens_mm) ? (o.lens_mm as number) : 35;
  const msRaw = typeof o.motion_strength === 'number' && Number.isFinite(o.motion_strength) ? (o.motion_strength as number) : 0.7;
  return {
    shot_size: SHOT_SIZES.includes(o.shot_size as ShotSize) ? (o.shot_size as ShotSize) : 'MS',
    angle: CAMERA_ANGLES.includes(o.angle as CameraAngle) ? (o.angle as CameraAngle) : 'eye_level',
    move: CAMERA_MOVES.includes(o.move as CameraMove) ? (o.move as CameraMove) : 'static',
    lens_mm: Math.round(lensRaw),
    dof: DOFS.includes(o.dof as Dof) ? (o.dof as Dof) : 'shallow',
    motion_strength: clamp01(msRaw),
  };
}

export function parseLightingSpec(value: unknown): LightingSpec | null {
  if (!value || typeof value !== 'object') return null;
  const o = value as Record<string, unknown>;
  const str = (k: string, dflt: string): string =>
    typeof o[k] === 'string' && (o[k] as string).length > 0 ? (o[k] as string) : dflt;
  return {
    key: str('key', 'soft key from frame left'),
    ratio: str('ratio', '3:1'),
    time_of_day: str('time_of_day', 'golden hour'),
    palette: str('palette', 'teal shadows, warm highlights'),
    texture: str('texture', 'subtle film grain'),
  };
}

export function parseProvenance(value: unknown): Provenance | null {
  if (!value || typeof value !== 'object') return null;
  const o = value as Record<string, unknown>;
  const sOrNull = (k: string): string | null => (typeof o[k] === 'string' ? (o[k] as string) : null);
  return {
    synthetic: o.synthetic === true,
    source: sOrNull('source'),
    model: sOrNull('model'),
    seed: typeof o.seed === 'number' && Number.isFinite(o.seed) ? (o.seed as number) : null,
    source_uri: sOrNull('source_uri'),
    created_at: sOrNull('created_at'),
    operator: sOrNull('operator'),
  };
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/videos/cinematography.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/videos/cinematography.ts src/lib/videos/cinematography.test.ts
git commit -m "$(printf 'feat(v2): cinematography shape module — CameraSpec/LightingSpec/Provenance + parsers\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 2: `classify-beat.ts` — deterministic kind derivation

**Files:**
- Create: `src/lib/videos/classify-beat.ts`
- Test: `src/lib/videos/classify-beat.test.ts`

**Interfaces:**
- Consumes: `Specificity`, `RecommendedSource` (type-only from `./visual-brief`); `ShotKind` (type-only from `./cinematography`).
- Produces: `function classifyBeat(specificity: Specificity, recommendedSource: RecommendedSource): ShotKind`.

**Context:** `kind` is a pure, total function of the authored brief. The authenticity test wins: a specific named entity must be real footage (`live_action`) regardless of what was recommended. Otherwise map `recommendedSource`: `primitive`→`motion_graphic`, `generate`→`generative`, `stock`/`upload`→`live_action`.

- [ ] **Step 1: Write the failing test** — `src/lib/videos/classify-beat.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyBeat } from './classify-beat.ts';

test('entity always → live_action (authenticity test wins)', () => {
  assert.equal(classifyBeat('entity', 'stock'), 'live_action');
  assert.equal(classifyBeat('entity', 'upload'), 'live_action');
  assert.equal(classifyBeat('entity', 'generate'), 'live_action');
  assert.equal(classifyBeat('entity', 'primitive'), 'live_action');
});

test('non-entity maps by recommendedSource', () => {
  assert.equal(classifyBeat('generic', 'primitive'), 'motion_graphic');
  assert.equal(classifyBeat('abstract', 'primitive'), 'motion_graphic');
  assert.equal(classifyBeat('generic', 'generate'), 'generative');
  assert.equal(classifyBeat('spokesperson', 'generate'), 'generative');
  assert.equal(classifyBeat('generic', 'stock'), 'live_action');
  assert.equal(classifyBeat('abstract', 'upload'), 'live_action');
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/videos/classify-beat.test.ts`
Expected: FAIL — `Cannot find module './classify-beat.ts'`.

- [ ] **Step 3: Implement `src/lib/videos/classify-beat.ts`**

```ts
import type { Specificity, RecommendedSource } from './visual-brief';
import type { ShotKind } from './cinematography';

// Derive a shot's source class deterministically from the authored visual brief.
// kind is an auditable pure function of (specificity, recommendedSource) — never an
// LLM freeform choice. The authenticity test wins: a specific named entity must be
// real footage (live_action), regardless of what was recommended.
export function classifyBeat(
  specificity: Specificity,
  recommendedSource: RecommendedSource,
): ShotKind {
  if (specificity === 'entity') return 'live_action';
  if (recommendedSource === 'primitive') return 'motion_graphic';
  if (recommendedSource === 'generate') return 'generative';
  return 'live_action'; // 'stock' | 'upload'
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/videos/classify-beat.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/videos/classify-beat.ts src/lib/videos/classify-beat.test.ts
git commit -m "$(printf 'feat(v2): classifyBeat — deterministic shot kind from the visual brief\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 3: Migration — `shot_kind` enum, columns, backfill, RPC rewrite

**Files:**
- Create: `supabase/migrations/20260624120000_v2_shot_kind.sql`

**Interfaces:**
- Consumes: existing `shots` table + `upsert_scene_with_shots(uuid,uuid,integer,text,numeric,jsonb)`.
- Produces: `shots.kind`/`camera_spec`/`lighting_spec`/`provenance`/`hero`/`needs_speech`/`broadcast_4k`; the RPC persists them from each `p_shots` element (keys: `kind`, `camera_spec`, `lighting_spec`, `provenance`, `hero`, `needs_speech`, `broadcast_4k`).

**Context:** Additive. `kind` defaults `live_action` then is backfilled from `source` (`procedural`→`motion_graphic`, `generated`→`generative`, else `live_action`). The RPC reads `kind` from the jsonb (the TS `sceneToRpcArgs` computes it via `classifyBeat` in Task 4); SQL does not classify.

- [ ] **Step 1: Write the migration** — `supabase/migrations/20260624120000_v2_shot_kind.sql`

```sql
-- Reelscript V2 Slice 0: the three source classes + cinematography + provenance on
-- shots. Additive. kind = producing subsystem (generative|motion_graphic|live_action),
-- distinct from source = acquisition path. camera_spec/lighting_spec authored for
-- generative shots; provenance is a script-time stub. Classification is done in TS
-- (classifyBeat) and passed in; SQL only persists.

do $$
begin
  if not exists (select 1 from pg_type where typname = 'shot_kind') then
    create type shot_kind as enum ('generative', 'motion_graphic', 'live_action');
  end if;
end $$;

alter table shots add column if not exists kind shot_kind not null default 'live_action';
alter table shots add column if not exists camera_spec jsonb;
alter table shots add column if not exists lighting_spec jsonb;
alter table shots add column if not exists provenance jsonb;
alter table shots add column if not exists hero boolean not null default false;
alter table shots add column if not exists needs_speech boolean not null default false;
alter table shots add column if not exists broadcast_4k boolean not null default false;

-- Backfill kind from the existing source for pre-V2 rows.
update shots set kind = case
  when source = 'procedural' then 'motion_graphic'::shot_kind
  when source = 'generated'  then 'generative'::shot_kind
  else 'live_action'::shot_kind
end;

-- Rewrite the upsert to persist the new fields (alongside visual_brief).
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
    insert into shots (
      account_id, scene_id, position, description, source, stock_query, duration_seconds,
      visual_brief, kind, camera_spec, lighting_spec, provenance, hero, needs_speech, broadcast_4k
    )
    values (
      p_account_id,
      v_scene_id,
      (v_shot->>'position')::integer,
      coalesce(v_shot->>'description', ''),
      coalesce(v_shot->>'source', 'stock')::shot_source,
      v_shot->>'stock_query',
      nullif(v_shot->>'duration_seconds', '')::numeric,
      v_shot->'visual_brief',
      coalesce(v_shot->>'kind', 'live_action')::shot_kind,
      v_shot->'camera_spec',
      v_shot->'lighting_spec',
      v_shot->'provenance',
      coalesce((v_shot->>'hero')::boolean, false),
      coalesce((v_shot->>'needs_speech')::boolean, false),
      coalesce((v_shot->>'broadcast_4k')::boolean, false)
    );
  end loop;

  return v_scene_id;
end;
$$;

grant execute on function public.upsert_scene_with_shots(uuid, uuid, integer, text, numeric, jsonb) to service_role;
```

- [ ] **Step 2: Apply the migration to the sandbox DB**

Run: `npm run db:apply -- supabase/migrations/20260624120000_v2_shot_kind.sql`
Expected: `Applied …` with no error (txn commits).

- [ ] **Step 3: Verify schema in the hosted DB**

Run (psql/pg over `SUPABASE_DB_URL`, or reuse the project's apply harness pattern):
```sql
select column_name from information_schema.columns
 where table_name = 'shots'
   and column_name in ('kind','camera_spec','lighting_spec','provenance','hero','needs_speech','broadcast_4k')
 order by column_name;
select unnest(enum_range(null::shot_kind))::text as kind;
```
Expected: 7 columns present; enum yields `generative, motion_graphic, live_action`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260624120000_v2_shot_kind.sql
git commit -m "$(printf 'feat(v2): shots.kind + camera/lighting/provenance columns + RPC persist\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 4: Script-gen authoring — schema, prompt, `sceneToRpcArgs`

**Files:**
- Modify: `src/lib/ai/script-generation.ts`
- Test: `src/lib/ai/script-generation.test.ts` (extend)

**Interfaces:**
- Consumes: `classifyBeat` from `../videos/classify-beat`.
- Produces: `generatedShotSchema` gains optional `camera`/`lighting`; `sceneToRpcArgs` output adds `kind`, `camera_spec`, `lighting_spec`, `provenance`, `hero`, `needs_speech`, `broadcast_4k` per shot.

**Context:** `sceneToRpcArgs` is the single conversion site. Compute `kind` from the brief (defaulting `specificity`→`generic`, `recommendedSource`→`stock` when no brief); convert `camera`/`lighting` camelCase→snake_case (or `null` when absent); attach a provenance stub (`synthetic = kind === 'generative'`); default the three flags to `false`. The existing `visual_brief` conversion and `source` enum are unchanged.

- [ ] **Step 1: Write the failing tests** — append to `src/lib/ai/script-generation.test.ts`

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSceneLine, sceneToRpcArgs } from './script-generation.ts';

test('sceneToRpcArgs derives kind from the brief', () => {
  const scene = parseSceneLine(JSON.stringify({
    position: 1, narration: 'hi',
    shots: [
      { position: 1, source: 'procedural', visualBrief: { specificity: 'abstract', recommendedSource: 'primitive' } },
      { position: 2, source: 'stock', visualBrief: { specificity: 'generic', recommendedSource: 'generate' } },
      { position: 3, source: 'resource', visualBrief: { specificity: 'entity', entityName: 'Rivian R2', recommendedSource: 'generate' } },
      { position: 4, source: 'stock', visualBrief: { specificity: 'generic', recommendedSource: 'stock' } },
    ],
  }));
  assert.ok(scene);
  const args = sceneToRpcArgs(scene!, 'acct', 'vid');
  assert.deepEqual(args.p_shots.map((s) => s.kind), ['motion_graphic', 'generative', 'live_action', 'live_action']);
});

test('sceneToRpcArgs: kind defaults to live_action when no brief', () => {
  const scene = parseSceneLine(JSON.stringify({ position: 1, narration: 'x', shots: [{ position: 1, source: 'stock' }] }));
  const args = sceneToRpcArgs(scene!, 'a', 'v');
  assert.equal(args.p_shots[0].kind, 'live_action');
});

test('sceneToRpcArgs: provenance stub synthetic matches generative kind', () => {
  const scene = parseSceneLine(JSON.stringify({
    position: 1, narration: 'x',
    shots: [
      { position: 1, source: 'stock', visualBrief: { specificity: 'generic', recommendedSource: 'generate' }, camera: { move: 'orbit_360' }, lighting: { palette: 'cool blue' } },
      { position: 2, source: 'procedural', visualBrief: { specificity: 'abstract', recommendedSource: 'primitive' } },
    ],
  }));
  const args = sceneToRpcArgs(scene!, 'a', 'v');
  assert.equal(args.p_shots[0].provenance.synthetic, true);
  assert.equal(args.p_shots[1].provenance.synthetic, false);
  assert.equal(args.p_shots[0].provenance.source, null);
});

test('sceneToRpcArgs: camera/lighting camelCase→snake_case; omitted → null; flags default false', () => {
  const scene = parseSceneLine(JSON.stringify({
    position: 1, narration: 'x',
    shots: [
      { position: 1, source: 'stock', visualBrief: { specificity: 'generic', recommendedSource: 'generate' },
        camera: { shotSize: 'WS', move: 'orbit_360', lensMm: 24, motionStrength: 0.5 },
        lighting: { timeOfDay: 'night', palette: 'neon' } },
      { position: 2, source: 'stock' },
    ],
  }));
  const args = sceneToRpcArgs(scene!, 'a', 'v');
  assert.deepEqual(args.p_shots[0].camera_spec, {
    shot_size: 'WS', angle: 'eye_level', move: 'orbit_360', lens_mm: 24, dof: 'shallow', motion_strength: 0.5,
  });
  assert.equal(args.p_shots[0].lighting_spec.time_of_day, 'night');
  assert.equal(args.p_shots[0].lighting_spec.palette, 'neon');
  assert.equal(args.p_shots[1].camera_spec, null);
  assert.equal(args.p_shots[1].lighting_spec, null);
  assert.equal(args.p_shots[0].hero, false);
  assert.equal(args.p_shots[0].needs_speech, false);
  assert.equal(args.p_shots[0].broadcast_4k, false);
});

test('sceneToRpcArgs: existing visual_brief conversion unchanged (regression)', () => {
  const scene = parseSceneLine(JSON.stringify({
    position: 1, narration: 'x',
    shots: [{ position: 1, source: 'resource', visualBrief: { subject: 'a', action: 'b', setting: 'c', framing: 'd', mood: 'e', specificity: 'entity', entityName: 'ACME', recommendedSource: 'upload' } }],
  }));
  const args = sceneToRpcArgs(scene!, 'a', 'v');
  assert.deepEqual(args.p_shots[0].visual_brief, {
    subject: 'a', action: 'b', setting: 'c', framing: 'd', mood: 'e',
    specificity: 'entity', entity_name: 'ACME', recommended_source: 'upload',
  });
});

test('parseSceneLine tolerates camera/lighting and their absence', () => {
  assert.ok(parseSceneLine(JSON.stringify({ position: 1, narration: 'x', shots: [{ position: 1, source: 'stock', camera: { move: 'tracking' }, lighting: { key: 'rim' } }] })));
  assert.ok(parseSceneLine(JSON.stringify({ position: 1, narration: 'x', shots: [{ position: 1, source: 'stock' }] })));
});
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/ai/script-generation.test.ts`
Expected: FAIL — `kind`/`camera_spec`/`provenance` undefined on the RPC args.

- [ ] **Step 3: Add camera/lighting schemas + import classifyBeat** — edit `src/lib/ai/script-generation.ts`

At the top, after `import { z } from 'zod';`:
```ts
import { classifyBeat } from '../videos/classify-beat';
```

After `generatedVisualBriefSchema` (before `generatedShotSchema`), add:
```ts
// Cinematography the model authors for generative-bound shots (camelCase in AI
// output; stored snake_case via sceneToRpcArgs). Optional everywhere.
export const generatedCameraSchema = z.object({
  shotSize: z.enum(['ECU', 'CU', 'MS', 'WS', 'EWS', 'two_shot', 'OTS', 'POV']).default('MS'),
  angle: z.enum(['eye_level', 'low', 'high', 'dutch', 'aerial', 'overhead']).default('eye_level'),
  move: z.enum([
    'static', 'dolly_in', 'dolly_out', 'arc_left', 'arc_right', 'orbit_360',
    'crane_up', 'crane_down', 'tracking', 'pan_left', 'pan_right', 'tilt_up',
    'tilt_down', 'whip_pan', 'push_in', 'pull_back', 'handheld', 'bullet_time',
    'boom', 'snorricam', 'fpv_drone',
  ]).default('static'),
  lensMm: z.number().int().default(35),
  dof: z.enum(['shallow', 'deep', 'rack_focus']).default('shallow'),
  motionStrength: z.number().min(0).max(1).default(0.7),
});

export const generatedLightingSchema = z.object({
  key: z.string().default('soft key from frame left'),
  ratio: z.string().default('3:1'),
  timeOfDay: z.string().default('golden hour'),
  palette: z.string().default('teal shadows, warm highlights'),
  texture: z.string().default('subtle film grain'),
});
```

Extend `generatedShotSchema` — add after `visualBrief: generatedVisualBriefSchema.optional(),`:
```ts
  camera: generatedCameraSchema.optional(),
  lighting: generatedLightingSchema.optional(),
```

- [ ] **Step 4: Rewrite the shot mapping in `sceneToRpcArgs`**

Replace the `p_shots: scene.shots.map((s) => ({ … }))` block with:
```ts
    p_shots: scene.shots.map((s) => {
      const specificity = s.visualBrief?.specificity ?? 'generic';
      const recommendedSource = s.visualBrief?.recommendedSource ?? 'stock';
      const kind = classifyBeat(specificity, recommendedSource);
      return {
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
        kind,
        camera_spec: s.camera
          ? {
              shot_size: s.camera.shotSize,
              angle: s.camera.angle,
              move: s.camera.move,
              lens_mm: s.camera.lensMm,
              dof: s.camera.dof,
              motion_strength: s.camera.motionStrength,
            }
          : null,
        lighting_spec: s.lighting
          ? {
              key: s.lighting.key,
              ratio: s.lighting.ratio,
              time_of_day: s.lighting.timeOfDay,
              palette: s.lighting.palette,
              texture: s.lighting.texture,
            }
          : null,
        provenance: {
          synthetic: kind === 'generative',
          source: null,
          model: null,
          seed: null,
          source_uri: null,
          created_at: null,
          operator: null,
        },
        hero: false,
        needs_speech: false,
        broadcast_4k: false,
      };
    }),
```

- [ ] **Step 5: Extend the system prompt** — in `buildSystemPrompt`, insert after the `recommendedSource` line (the line ending `…only operator footage is reliable).`) and before the blank line preceding `'Guidance:`:

```ts
    '     "camera" and "lighting" (author ONLY when recommendedSource is "generate"; omit otherwise):',
    '        "camera": { "shotSize": one of ECU/CU/MS/WS/EWS/two_shot/OTS/POV,',
    '          "angle": eye_level/low/high/dutch/aerial/overhead,',
    '          "move": EXACTLY ONE of static/dolly_in/dolly_out/arc_left/arc_right/orbit_360/',
    '            crane_up/crane_down/tracking/pan_left/pan_right/tilt_up/tilt_down/whip_pan/',
    '            push_in/pull_back/handheld/bullet_time/boom/snorricam/fpv_drone (never stack moves),',
    '          "lensMm": 24 wide / 35 standard / 85 portrait, "dof": shallow/deep/rack_focus,',
    '          "motionStrength": a number 0..1 }',
    '        "lighting": { "key", "ratio" (e.g. "3:1"), "timeOfDay", "palette", "texture" }',
```

- [ ] **Step 6: Run the full gate**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/ai/script-generation.test.ts && npm run typecheck && npm run lint && npm run build && npm test`
Expected: target test PASS; typecheck clean; lint clean; build all routes; full suite green (prior baseline + the new Task 1/2/4 tests).

- [ ] **Step 7: Commit**

```bash
git add "src/lib/ai/script-generation.ts" "src/lib/ai/script-generation.test.ts"
git commit -m "$(printf 'feat(v2): script-gen authors kind + camera/lighting + provenance stub per shot\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

## Self-Review

- **Spec coverage:** §3 migration → Task 3; §4 types/parsers → Task 1; §5 classifyBeat → Task 2; §6 script-gen authoring → Task 4; §7 testing → tests in every task. All covered.
- **Type consistency:** `classifyBeat(specificity, recommendedSource)` signature identical in Task 2 (def) and Task 4 (call). `CameraSpec`/`LightingSpec`/`Provenance` snake_case field names identical between Task 1 (parsers), Task 3 (RPC keys), and Task 4 (`sceneToRpcArgs` output). The RPC's jsonb keys (`kind`, `camera_spec`, `lighting_spec`, `provenance`, `hero`, `needs_speech`, `broadcast_4k`) match exactly what `sceneToRpcArgs` emits.
- **No placeholders:** complete code in every step. Each task ends green (pure tests for 1/2; DB verify for 3; full gate for 4).
- **Ordering:** 1 → 2 (consumes Task 1 type) → 3 (independent; RPC contract matches Task 4 keys) → 4 (consumes Tasks 1+2). Task 3 before Task 4 so the DB persists what authoring emits.
