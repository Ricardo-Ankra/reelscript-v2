# Reelscript V2 — Slice 1a: Generation cores & provider seam — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the generation building blocks 1b consumes — a typed `GenerationProvider` seam + a configurable fake, the pure cores (`resolveMotion`/`buildClipPrompt`/`route`), an R2 stream-to-key helper, and the generation data-contract schema — all unit-tested with zero external calls.

**Architecture:** New pure modules under `src/lib/generation/` + one helper in `src/lib/r2.ts` + an additive Supabase migration. The seam mirrors v3's image-fast / video-async-submit-poll split; cores consume Slice 0's `CameraSpec`/`LightingSpec`/`VisualBrief`/`ShotKind`. Nothing is wired into the pipeline yet (1b does that).

**Tech Stack:** TypeScript, Supabase/PostgreSQL, `node:test` via the repo's strip-types loader.

## Global Constraints

- Tests run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test <file>`. Test imports use explicit `.ts` extensions. Header: `import { test } from 'node:test'; import assert from 'node:assert/strict';`.
- Pure modules under `src/lib/generation/` (except none here are server-only) — no react/server/network; type-only imports OK. `provider.ts` is types-only. The fake is a pure-ish in-memory test double (no network). `streamUrlToR2` lives in the existing `server-only` `r2.ts`.
- Cores consume Slice 0 types: `import type { CameraSpec, LightingSpec, CameraMove, ShotKind } from '../videos/cinematography'` and `import type { VisualBrief } from '../videos/visual-brief'`.
- The fixed negative prompt is exactly: `no text, no logo, no warped anatomy, no smeared motion blur`.
- `MOTION_ID` values are placeholders — replace with live Higgsfield `motion_id` UUIDs before go-live (v3 §12); flag in-file.
- This slice changes NO existing behavior — purely additive; nothing imports the new modules yet.
- Sandbox DB: migrations may be liberal; no data-preservation concern.
- Commit footer, every commit: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

### Task 1: Provider seam + fake + R2 stream helper

**Files:**
- Create: `src/lib/generation/provider.ts` (types only)
- Create: `src/lib/generation/fake-provider.ts`
- Test: `src/lib/generation/fake-provider.test.ts`
- Modify: `src/lib/r2.ts` (add `streamUrlToR2`)

**Interfaces:**
- Produces: `GenerationProvider`/`ImageProvider`/`VideoProvider` + `StillRequest`/`StillResult`/`ClipRequest`/`ClipSubmit`/`ClipStatus`; `createFakeProvider(config)`; `streamUrlToR2(url, key, contentType?)`.

- [ ] **Step 1: Create the seam — `src/lib/generation/provider.ts`**

```ts
// The generation provider seam (V2 Slice 1a). Image generation is fast (await a
// result); video generation is the long async job 1b drives with a durable Inngest
// poll. Real Higgsfield / text-to-still adapters implement this when creds exist; the
// fake provider implements it for headless testing. Results are FETCHABLE URLs the
// pipeline streams to R2 (they expire ~1h).

export interface StillRequest {
  prompt: string;
  aspectRatio: string;            // '9:16' | '1:1' | '16:9'
  seed: number | null;
  styleRefUrl: string | null;     // a live_action sibling frame (Slice 2+); null for now
}
export interface StillResult {
  url: string;
}

export interface ClipRequest {
  prompt: string;
  imageUrl: string;               // the ingredient keyframe (a presigned R2 GET url)
  motionId: string;
  motionStrength: number;
  seed: number | null;
  model: string;                  // routed model, e.g. 'dop-preview'
}
export interface ClipSubmit {
  requestId: string;
}
export type ClipStatus =
  | { state: 'pending' }
  | { state: 'completed'; mediaUrl: string }
  | { state: 'failed'; error: string };

export interface ImageProvider {
  generateStill(req: StillRequest): Promise<StillResult>;
}
export interface VideoProvider {
  submitClip(req: ClipRequest): Promise<ClipSubmit>;
  checkClip(requestId: string): Promise<ClipStatus>;
}
export interface GenerationProvider extends ImageProvider, VideoProvider {}
```

- [ ] **Step 2: Write the failing fake test — `src/lib/generation/fake-provider.test.ts`**

```ts
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
```

- [ ] **Step 3: Run the test, verify it fails**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/generation/fake-provider.test.ts`
Expected: FAIL — `Cannot find module './fake-provider.ts'`.

- [ ] **Step 4: Implement `src/lib/generation/fake-provider.ts`**

```ts
import type {
  GenerationProvider,
  StillRequest,
  StillResult,
  ClipRequest,
  ClipSubmit,
  ClipStatus,
} from './provider';

export interface FakeConfig {
  pollsUntilReady?: number; // checkClip returns 'pending' this many times, then 'completed' (default 2)
  stillUrl?: string;        // overrides the seed-derived still url
  clipUrl?: string;         // default 'https://fake.local/clip.mp4'
}

export interface FakeProvider extends GenerationProvider {
  failNext(): void; // the next submitted clip will report 'failed' on check
}

// A stateful in-memory test double (NOT pure) that simulates the async clip lifecycle
// so 1b's durable poll can be proven headlessly.
export function createFakeProvider(config: FakeConfig = {}): FakeProvider {
  const pollsUntilReady = config.pollsUntilReady ?? 2;
  const clipUrl = config.clipUrl ?? 'https://fake.local/clip.mp4';
  let counter = 0;
  const polls = new Map<string, number>();
  const failed = new Set<string>();
  let failArmed = false;

  return {
    async generateStill(req: StillRequest): Promise<StillResult> {
      const url = config.stillUrl ?? `https://fake.local/still/${req.seed ?? 'noseed'}.png`;
      return { url };
    },
    async submitClip(req: ClipRequest): Promise<ClipSubmit> {
      const requestId = `fake-${req.model}-${counter++}`;
      polls.set(requestId, 0);
      if (failArmed) {
        failed.add(requestId);
        failArmed = false;
      }
      return { requestId };
    },
    async checkClip(requestId: string): Promise<ClipStatus> {
      if (failed.has(requestId)) return { state: 'failed', error: 'fake failure' };
      const n = (polls.get(requestId) ?? 0) + 1;
      polls.set(requestId, n);
      if (n > pollsUntilReady) return { state: 'completed', mediaUrl: clipUrl };
      return { state: 'pending' };
    },
    failNext() {
      failArmed = true;
    },
  };
}
```

- [ ] **Step 5: Run the test, verify it passes**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/generation/fake-provider.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Add `streamUrlToR2` to `src/lib/r2.ts`**

Append after `signedGetUrl`:

```ts
/** Fetch a remote URL and store its bytes in R2 under `key`. Used to persist
 *  generation/ingest results whose source URLs expire (e.g. Higgsfield ~1h).
 *  Returns the key. */
export async function streamUrlToR2(
  url: string,
  key: string,
  contentType?: string,
): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`streamUrlToR2 fetch ${res.status} for ${key}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  return putObject(key, bytes, contentType ?? res.headers.get('content-type') ?? 'application/octet-stream');
}
```

- [ ] **Step 7: Type-check + lint**

Run: `npm run typecheck && npx eslint src/lib/generation/provider.ts src/lib/generation/fake-provider.ts src/lib/r2.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/lib/generation/provider.ts src/lib/generation/fake-provider.ts src/lib/generation/fake-provider.test.ts src/lib/r2.ts
git commit -m "$(printf 'feat(v2): generation provider seam + fake + R2 stream helper\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 2: Pure cores — motion presets, prompt, router

**Files:**
- Create: `src/lib/generation/motion-presets.ts` + `motion-presets.test.ts`
- Create: `src/lib/generation/prompt.ts` + `prompt.test.ts`
- Create: `src/lib/generation/router.ts` + `router.test.ts`

**Interfaces:**
- Consumes (type-only): `CameraSpec`, `CameraMove`, `LightingSpec`, `ShotKind` from `../videos/cinematography`; `VisualBrief` from `../videos/visual-brief`.
- Produces: `MOTION_ID`, `resolveMotion(camera) → { motionId, motionStrength }`; `buildClipPrompt(brief, camera, lighting) → string`; `type Engine`, `route(shot) → Engine`.

- [ ] **Step 1: Write the failing tests**

`src/lib/generation/motion-presets.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MOTION_ID, resolveMotion } from './motion-presets.ts';
import { CAMERA_MOVES, parseCameraSpec } from '../videos/cinematography.ts';

test('every CameraMove has a non-empty motion id', () => {
  for (const move of CAMERA_MOVES) {
    assert.ok(MOTION_ID[move] && MOTION_ID[move].length > 0, `missing id for ${move}`);
  }
});

test('resolveMotion returns the move id + the spec motion_strength', () => {
  const camera = parseCameraSpec({ move: 'orbit_360', motion_strength: 0.4 })!;
  const { motionId, motionStrength } = resolveMotion(camera);
  assert.equal(motionId, MOTION_ID['orbit_360']);
  assert.equal(motionStrength, 0.4);
});
```

`src/lib/generation/prompt.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildClipPrompt } from './prompt.ts';
import { parseCameraSpec, parseLightingSpec } from '../videos/cinematography.ts';
import { parseVisualBrief } from '../videos/visual-brief.ts';

test('buildClipPrompt front-loads shot size, spaces the move, ends with the negative', () => {
  const brief = parseVisualBrief({ subject: 'a turbine', action: 'spinning', setting: 'a wind farm', specificity: 'generic', recommended_source: 'generate' })!;
  const camera = parseCameraSpec({ shot_size: 'WS', angle: 'low', move: 'orbit_360', lens_mm: 24, dof: 'deep' })!;
  const lighting = parseLightingSpec({ palette: 'cool blue' })!;
  const p = buildClipPrompt(brief, camera, lighting);
  assert.ok(p.startsWith('WS low angle, 24mm lens, deep depth of field.'));
  assert.match(p, /a turbine\. spinning\. a wind farm\./);
  assert.match(p, /Camera: orbit 360, smooth and deliberate\./); // underscores spaced
  assert.ok(p.endsWith('Negative: no text, no logo, no warped anatomy, no smeared motion blur.'));
});
```

`src/lib/generation/router.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { route } from './router.ts';
import { parseCameraSpec } from '../videos/cinematography.ts';

const base = { camera: null, hero: false, needs_speech: false, broadcast_4k: false };

test('non-generative kinds route to remotion / ingest', () => {
  assert.equal(route({ ...base, kind: 'motion_graphic' }), 'remotion');
  assert.equal(route({ ...base, kind: 'live_action' }), 'ingest');
});

test('generative routing: hero-move → dop-preview', () => {
  assert.equal(route({ ...base, kind: 'generative', camera: parseCameraSpec({ move: 'bullet_time' }) }), 'higgsfield.dop-preview');
});

test('generative routing: flags in priority order needs_speech > broadcast_4k > hero > default', () => {
  assert.equal(route({ ...base, kind: 'generative', needs_speech: true }), 'higgsfield.veo-3.1');
  assert.equal(route({ ...base, kind: 'generative', broadcast_4k: true }), 'higgsfield.kling-3.0');
  assert.equal(route({ ...base, kind: 'generative', hero: true }), 'higgsfield.seedance-2.0');
  assert.equal(route({ ...base, kind: 'generative' }), 'higgsfield.dop-preview');
  // a hero move beats the speech flag (move checked first)
  assert.equal(route({ ...base, kind: 'generative', camera: parseCameraSpec({ move: 'orbit_360' }), needs_speech: true }), 'higgsfield.dop-preview');
});
```

- [ ] **Step 2: Run the tests, verify they fail**

Run each: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/generation/motion-presets.test.ts src/lib/generation/prompt.test.ts src/lib/generation/router.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `src/lib/generation/motion-presets.ts`**

```ts
import type { CameraMove, CameraSpec } from '../videos/cinematography';

// Map each camera move to a Higgsfield motion_id. PLACEHOLDER ids — replace with the
// live Higgsfield motion_id UUID set before go-live (v3 §12). The fake provider does
// not care about the value; only that one exists per move.
export const MOTION_ID: Record<CameraMove, string> = {
  static: 'placeholder-static',
  dolly_in: 'placeholder-dolly_in',
  dolly_out: 'placeholder-dolly_out',
  arc_left: 'placeholder-arc_left',
  arc_right: 'placeholder-arc_right',
  orbit_360: 'placeholder-orbit_360',
  crane_up: 'placeholder-crane_up',
  crane_down: 'placeholder-crane_down',
  tracking: 'placeholder-tracking',
  pan_left: 'placeholder-pan_left',
  pan_right: 'placeholder-pan_right',
  tilt_up: 'placeholder-tilt_up',
  tilt_down: 'placeholder-tilt_down',
  whip_pan: 'placeholder-whip_pan',
  push_in: 'placeholder-push_in',
  pull_back: 'placeholder-pull_back',
  handheld: 'placeholder-handheld',
  bullet_time: 'placeholder-bullet_time',
  boom: 'placeholder-boom',
  snorricam: 'placeholder-snorricam',
  fpv_drone: 'placeholder-fpv_drone',
};

export function resolveMotion(camera: CameraSpec): { motionId: string; motionStrength: number } {
  return { motionId: MOTION_ID[camera.move], motionStrength: camera.motion_strength };
}
```

- [ ] **Step 4: Implement `src/lib/generation/prompt.ts`**

```ts
import type { CameraSpec, LightingSpec } from '../videos/cinematography';
import type { VisualBrief } from '../videos/visual-brief';

const NEGATIVE = 'no text, no logo, no warped anatomy, no smeared motion blur';

// Build the Higgsfield image-to-video prompt (v3 §6): front-load shot size, lock the
// subject with the brief, describe one camera move, end with the explicit negative.
export function buildClipPrompt(
  brief: VisualBrief,
  camera: CameraSpec,
  lighting: LightingSpec,
): string {
  return [
    `${camera.shot_size} ${camera.angle} angle, ${camera.lens_mm}mm lens, ${camera.dof} depth of field.`,
    `${brief.subject}. ${brief.action}. ${brief.setting}.`,
    `${lighting.key}, ${lighting.ratio} key-to-fill, ${lighting.time_of_day}, ${lighting.palette}, ${lighting.texture}.`,
    `Camera: ${camera.move.replace(/_/g, ' ')}, smooth and deliberate.`,
    `Negative: ${NEGATIVE}.`,
  ].join(' ');
}
```

- [ ] **Step 5: Implement `src/lib/generation/router.ts`**

```ts
import type { CameraSpec, ShotKind } from '../videos/cinematography';

export type Engine = 'remotion' | 'ingest' | `higgsfield.${string}`;

// Moves where the camera motion IS the hero → Higgsfield's first-party dop model.
const HERO_MOVES = ['orbit_360', 'bullet_time', 'arc_left', 'arc_right', 'snorricam', 'whip_pan', 'fpv_drone'];

export interface RoutableShot {
  kind: ShotKind;
  camera: CameraSpec | null;
  hero: boolean;
  needs_speech: boolean;
  broadcast_4k: boolean;
}

// Pick the engine per shot (v3 §4). motion_graphic → Remotion; live_action → ingest;
// generative → a Higgsfield model by move/flags. (Fallback chains are a 1b runtime concern.)
export function route(shot: RoutableShot): Engine {
  if (shot.kind === 'motion_graphic') return 'remotion';
  if (shot.kind === 'live_action') return 'ingest';
  if (shot.camera && HERO_MOVES.includes(shot.camera.move)) return 'higgsfield.dop-preview';
  if (shot.needs_speech) return 'higgsfield.veo-3.1';
  if (shot.broadcast_4k) return 'higgsfield.kling-3.0';
  if (shot.hero) return 'higgsfield.seedance-2.0';
  return 'higgsfield.dop-preview';
}
```

- [ ] **Step 6: Run the tests, verify they pass**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/generation/motion-presets.test.ts src/lib/generation/prompt.test.ts src/lib/generation/router.test.ts`
Expected: PASS (all).

- [ ] **Step 7: Commit**

```bash
git add src/lib/generation/motion-presets.ts src/lib/generation/motion-presets.test.ts src/lib/generation/prompt.ts src/lib/generation/prompt.test.ts src/lib/generation/router.ts src/lib/generation/router.test.ts
git commit -m "$(printf 'feat(v2): generation pure cores — motion presets, prompt, router\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 3: Migration — generation-output columns + `entities` table

**Files:**
- Create: `supabase/migrations/20260624130000_v2_generation_contract.sql`

**Interfaces:**
- Produces: `shots.{keyframe_first_key,keyframe_last_key,clip_key,routed_model}` (nullable text); `entities` table (account/video-scoped, `unique(video_id,name)`) with RLS. Populated by 1b.

**Context:** Additive. RLS mirrors the existing `acct_isolation` pattern (`for all using (auth_owns_account(account_id)) with check (auth_owns_account(account_id))`). `auth_owns_account` already exists.

- [ ] **Step 1: Write the migration** — `supabase/migrations/20260624130000_v2_generation_contract.sql`

```sql
-- Reelscript V2 Slice 1a: the generation data contract. Additive — generation-output
-- columns on shots (written by 1b's generation pipeline) + an entities table for
-- locked-seed-per-entity continuity (1b assigns/reuses the seed).

alter table shots add column if not exists keyframe_first_key text;
alter table shots add column if not exists keyframe_last_key  text;
alter table shots add column if not exists clip_key           text;
alter table shots add column if not exists routed_model       text;

create table if not exists entities (
  id           uuid primary key default gen_random_uuid(),
  account_id   uuid not null references accounts (id) on delete cascade,
  video_id     uuid not null references videos (id) on delete cascade,
  name         text not null,
  seed         integer not null,
  keyframe_key text,
  created_at   timestamptz not null default now(),
  unique (video_id, name)
);

create index if not exists entities_video_idx on entities (video_id);

alter table entities enable row level security;

drop policy if exists acct_isolation on entities;
create policy acct_isolation on entities
  for all using (auth_owns_account(account_id)) with check (auth_owns_account(account_id));
```

- [ ] **Step 2: Apply to the sandbox DB**

Run: `npm run db:apply -- supabase/migrations/20260624130000_v2_generation_contract.sql`
Expected: `Applied …` with no error.

- [ ] **Step 3: Verify in the hosted DB**

Write a tiny temporary `.mjs` in the PROJECT ROOT (so it resolves the project's `pg`), run with `node --env-file=.env.local ./<tmp>.mjs`, then delete it. Queries:
```sql
select column_name from information_schema.columns
 where table_name = 'shots'
   and column_name in ('keyframe_first_key','keyframe_last_key','clip_key','routed_model')
 order by column_name;                                            -- expect 4 rows
select to_regclass('public.entities') is not null as entities_exists;  -- expect true
select relrowsecurity from pg_class where relname = 'entities';   -- expect true
select polname from pg_policies where tablename = 'entities';     -- expect acct_isolation
```
(`pg_policies` exposes `polname` as `policyname`; use `select policyname from pg_policies where tablename='entities'`.)

- [ ] **Step 4: Commit** (only the migration; delete the temp verify script first)

```bash
git add supabase/migrations/20260624130000_v2_generation_contract.sql
git commit -m "$(printf 'feat(v2): generation-output columns + entities table (continuity)\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

## Self-Review

- **Spec coverage:** §3 seam → Task 1; §4 fake → Task 1; §5 cores → Task 2; §6 R2 helper → Task 1; §7 schema → Task 3; §8 testing → tests in Tasks 1–2 + verify in Task 3. All covered.
- **Type consistency:** `resolveMotion` returns `{motionId, motionStrength}` consumed by `ClipRequest.motionId/motionStrength`; `route` returns `Engine` (`higgsfield.${string}`) whose model suffix feeds `ClipRequest.model` (1b); cores import Slice-0 types by the exact names (`CameraSpec`/`CameraMove`/`LightingSpec`/`ShotKind`/`VisualBrief`). The fake implements `GenerationProvider` exactly.
- **No placeholders** (other than the intentional, flagged `MOTION_ID` preset values): complete code in every step. Each task ends green (node:test for 1–2; typecheck+lint in Task 1; DB verify in Task 3).
- **Ordering:** Tasks are independent; 1 → 2 → 3. Task 2's tests import Slice-0 `cinematography.ts`/`visual-brief.ts` (already on main). Nothing imports the new modules outside their own tests, so the tree stays green throughout.
