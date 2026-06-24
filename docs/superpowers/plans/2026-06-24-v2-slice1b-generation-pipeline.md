# Reelscript V2 — Slice 1b: Generation pipeline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire Slice 1a's generation provider seam into Inngest — per generative shot: keyframe still → Higgsfield clip (submit + durable poll) → R2, recording keys/model/provenance — proven headlessly against the fake provider.

**Architecture:** A new Inngest function `generateShots` (event `generation/run`) loads a video's `kind='generative'` shots and, per shot, runs a durable spine that mirrors `render.ts`'s `runLambdaSpine`: generate a keyframe still from the shot's `VisualBrief`/`CameraSpec`/`LightingSpec`, stream it to R2, submit a clip (keyframe + motion + routed model + a per-video seed), poll to completion, stream the clip to R2, and write `clip_key`/`routed_model`/`provenance`. A provider factory resolves to a fake by default; a drive script proves the flow offline with `data:`-URL fixtures.

**Tech Stack:** TypeScript, Next.js, Inngest, Supabase (admin client), Cloudflare R2, `node:test`. Slice 1a cores: `provider.ts`, `fake-provider.ts`, `motion-presets.ts`, `prompt.ts`, `router.ts`; Slice 0 cinematography types.

## Global Constraints

- **Sandbox build** — no concern for DB migration / data loss. **No migration this slice** (1a added `shots.{keyframe_first_key,keyframe_last_key,clip_key,routed_model}` + the `entities` table).
- **Additive only.** Compose/render/readiness/script-gen are untouched. The new function only fires on an explicit `generation/run` event (Slice 6 wires it into the master pipeline).
- **Continuity = per-video seed only.** All generative shots in a video share `videoSeed(videoId)`, recorded on each clip's `provenance`. The `entities` table stays **unused** in 1b. No per-entity seed-locking, no reference-image carry, no recurring-entity extraction (later slice).
- **`keyframe_last_key` stays null** (first/last-frame chaining defers past Slice 2).
- **Provider seam is never bypassed** — orchestration calls `getGenerationProvider()`; concrete providers live only behind it. Real Higgsfield/image adapters are NOT written this slice.
- **Test commands:** unit tests run with `node --experimental-strip-types --import ./scripts/register-loader.mjs --test <file>`; test files import siblings with explicit `.ts` extensions; test header is `import { test } from 'node:test'; import assert from 'node:assert/strict';`. Gates: `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`.
- **The Inngest function + spine + drive script are NOT unit-tested** (they need the Inngest runtime + R2) — they are proven via `npm run drive:generation` by the operator, following the established `runLambdaSpine`/`drive:render` precedent. This is plan-mandated; do not add a unit test that executes the spine against live network/DB.
- **Commit footer** (every commit): a blank line then `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **`Provenance` has seven fields** (`synthetic`/`source`/`model`/`seed`/`source_uri`/`created_at`/`operator`) — write the complete object.

---

### Task 1: Pure cores — `videoSeed` + `buildStillPrompt`

**Files:**
- Create: `src/lib/generation/seed.ts`
- Create: `src/lib/generation/seed.test.ts`
- Modify: `src/lib/generation/prompt.ts` (add `buildStillPrompt`)
- Modify/Create: `src/lib/generation/prompt.test.ts` (add `buildStillPrompt` cases — create the file if it does not exist)

**Interfaces:**
- Consumes (type-only): `CameraSpec`, `LightingSpec` from `../videos/cinematography`; `VisualBrief` from `../videos/visual-brief`. Test helpers: `parseCameraSpec`, `parseLightingSpec` from `../videos/cinematography`; `parseVisualBrief` from `../videos/visual-brief`.
- Produces: `videoSeed(videoId: string): number`; `buildStillPrompt(brief: VisualBrief, camera: CameraSpec, lighting: LightingSpec): string`.

- [ ] **Step 1: Write the failing test for `videoSeed`**

`src/lib/generation/seed.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { videoSeed } from './seed.ts';

test('videoSeed is deterministic for the same id', () => {
  assert.equal(videoSeed('abc-123'), videoSeed('abc-123'));
});

test('videoSeed differs across ids', () => {
  assert.notEqual(videoSeed('abc-123'), videoSeed('abc-124'));
});

test('videoSeed is a non-negative safe integer', () => {
  const s = videoSeed('00000000-0000-0000-0000-000000000000');
  assert.ok(Number.isSafeInteger(s), 'safe integer');
  assert.ok(s >= 0, 'non-negative');
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/generation/seed.test.ts`
Expected: FAIL — `Cannot find module './seed.ts'`.

- [ ] **Step 3: Implement `src/lib/generation/seed.ts`**

```ts
// Deterministic, stable per-video seed for generative continuity (V2 Slice 1b). All
// generative shots in a video share this seed — recorded on each clip's provenance —
// so a re-run reproduces the same look. FNV-1a over the id's char codes → a
// non-negative 32-bit integer; same id → same seed across runs and processes.
export function videoSeed(videoId: string): number {
  let hash = 0x811c9dc5; // FNV-1a offset basis
  for (let i = 0; i < videoId.length; i++) {
    hash ^= videoId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193); // FNV-1a prime
  }
  return hash >>> 0; // coerce to a non-negative 32-bit integer
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/generation/seed.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Add the failing test for `buildStillPrompt`**

Append to `src/lib/generation/prompt.test.ts` (if the file does not exist, create it with the header below + this test; the import line for `buildStillPrompt` is added alongside any existing `buildClipPrompt` import):
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStillPrompt } from './prompt.ts';
import { parseCameraSpec, parseLightingSpec } from '../videos/cinematography.ts';
import { parseVisualBrief } from '../videos/visual-brief.ts';

test('buildStillPrompt front-loads shot size, omits the camera-move clause, ends with the negative', () => {
  const brief = parseVisualBrief({ subject: 'a turbine', action: 'spinning', setting: 'a wind farm', specificity: 'generic', recommended_source: 'generate' })!;
  const camera = parseCameraSpec({ shot_size: 'WS', angle: 'low', move: 'orbit_360', lens_mm: 24, dof: 'deep' })!;
  const lighting = parseLightingSpec({ palette: 'cool blue' })!;
  const p = buildStillPrompt(brief, camera, lighting);
  assert.ok(p.startsWith('WS low angle, 24mm lens, deep depth of field.'), 'front-loads framing');
  assert.match(p, /a turbine\. spinning\. a wind farm\./);
  assert.doesNotMatch(p, /Camera:/, 'no camera-move clause');
  assert.doesNotMatch(p, /orbit/, 'no move name');
  assert.ok(p.endsWith('Negative: no text, no logo, no warped anatomy, no smeared motion blur.'), 'ends with negative');
});
```
> If `prompt.test.ts` already exists, only add the `buildStillPrompt` import and this `test(...)` block — do not duplicate the `node:test`/`assert` header.

- [ ] **Step 6: Run it, verify it fails**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/generation/prompt.test.ts`
Expected: FAIL — `buildStillPrompt` is not exported.

- [ ] **Step 7: Implement `buildStillPrompt` in `src/lib/generation/prompt.ts`**

Add this export below the existing `buildClipPrompt` (reuse the existing module-level `NEGATIVE` const — do not redeclare it):
```ts
// Build the Higgsfield text→still keyframe prompt: the same framing / subject / lighting
// as the clip prompt but WITHOUT a camera move (a still has no motion). Ends with the
// same explicit negative. Pure, total.
export function buildStillPrompt(
  brief: VisualBrief,
  camera: CameraSpec,
  lighting: LightingSpec,
): string {
  return [
    `${camera.shot_size} ${camera.angle} angle, ${camera.lens_mm}mm lens, ${camera.dof} depth of field.`,
    `${brief.subject}. ${brief.action}. ${brief.setting}.`,
    `${lighting.key}, ${lighting.ratio} key-to-fill, ${lighting.time_of_day}, ${lighting.palette}, ${lighting.texture}.`,
    `Negative: ${NEGATIVE}.`,
  ].join(' ');
}
```

- [ ] **Step 8: Run prompt tests, verify they pass**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/generation/prompt.test.ts`
Expected: PASS (the new `buildStillPrompt` test plus any pre-existing `buildClipPrompt` tests).

- [ ] **Step 9: Commit**

```bash
git add src/lib/generation/seed.ts src/lib/generation/seed.test.ts src/lib/generation/prompt.ts src/lib/generation/prompt.test.ts
git commit -m "$(printf 'feat(v2): generation seed + still-prompt cores\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 2: Provider factory + router `HERO_MOVES` tightening

**Files:**
- Create: `src/lib/generation/provider-factory.ts`
- Create: `src/lib/generation/provider-factory.test.ts`
- Modify: `src/lib/generation/router.ts:6` (`HERO_MOVES` type + import)

**Interfaces:**
- Consumes: `GenerationProvider` from `./provider`; `createFakeProvider` + `FakeConfig` from `./fake-provider`; `CameraMove` from `../videos/cinematography`.
- Produces: `getGenerationProvider(): GenerationProvider`. (`createFakeProvider({ stillUrl?, clipUrl? })` already accepts `string | undefined` for both — `FakeConfig` in `fake-provider.ts`.)

- [ ] **Step 1: Write the failing test**

`src/lib/generation/provider-factory.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getGenerationProvider } from './provider-factory.ts';

test('defaults to a fake provider exposing the full seam', () => {
  delete process.env.GENERATION_PROVIDER;
  const p = getGenerationProvider();
  assert.equal(typeof p.generateStill, 'function');
  assert.equal(typeof p.submitClip, 'function');
  assert.equal(typeof p.checkClip, 'function');
});

test('higgsfield throws until an adapter exists', () => {
  process.env.GENERATION_PROVIDER = 'higgsfield';
  assert.throws(() => getGenerationProvider(), /not configured/);
  delete process.env.GENERATION_PROVIDER;
});

test('an unknown provider name throws', () => {
  process.env.GENERATION_PROVIDER = 'nope';
  assert.throws(() => getGenerationProvider(), /Unknown GENERATION_PROVIDER/);
  delete process.env.GENERATION_PROVIDER;
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/generation/provider-factory.test.ts`
Expected: FAIL — `Cannot find module './provider-factory.ts'`.

- [ ] **Step 3: Implement `src/lib/generation/provider-factory.ts`**

```ts
import type { GenerationProvider } from './provider';
import { createFakeProvider } from './fake-provider';

// Resolve the generation provider — the single swap point (V2 Slice 1b). Default 'fake'
// (headless, no creds). Real adapters (a text→still image model + Higgsfield clips) drop
// in here behind the same seam when credentials exist — orchestration never changes.
//
// When 'fake', optional GEN_FAKE_STILL_URL / GEN_FAKE_CLIP_URL fixtures are threaded into
// the fake so the drive script can make streamUrlToR2 round-trip offline with data: URLs.
// These must live in the dev-server env (.env.local) because the Inngest function builds
// its provider in that process. Unset in normal runs → the fake's built-in defaults.
export function getGenerationProvider(): GenerationProvider {
  const which = process.env.GENERATION_PROVIDER ?? 'fake';
  switch (which) {
    case 'fake':
      return createFakeProvider({
        stillUrl: process.env.GEN_FAKE_STILL_URL,
        clipUrl: process.env.GEN_FAKE_CLIP_URL,
      });
    case 'higgsfield':
      throw new Error('GENERATION_PROVIDER=higgsfield not configured yet (no adapter)');
    default:
      throw new Error(`Unknown GENERATION_PROVIDER: ${which}`);
  }
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/generation/provider-factory.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Tighten `HERO_MOVES` in `src/lib/generation/router.ts`**

Change the import on line 1 to also bring in `CameraMove`, and retype `HERO_MOVES`:
```ts
import type { CameraMove, CameraSpec, ShotKind } from '../videos/cinematography';
```
```ts
// Moves where the camera motion IS the hero → Higgsfield's first-party dop model.
const HERO_MOVES: readonly CameraMove[] = ['orbit_360', 'bullet_time', 'arc_left', 'arc_right', 'snorricam', 'whip_pan', 'fpv_drone'];
```
(No behavior change — a `readonly CameraMove[]` makes a future move-name typo a compile error. `Array.includes` on a `readonly CameraMove[]` with a `CameraMove` argument typechecks unchanged.)

- [ ] **Step 6: Verify the router tests still pass + typecheck**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/generation/router.test.ts`
Expected: PASS (unchanged behavior).
Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/generation/provider-factory.ts src/lib/generation/provider-factory.test.ts src/lib/generation/router.ts
git commit -m "$(printf 'feat(v2): generation provider factory + typed HERO_MOVES\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 3: `generateShots` Inngest function + durable spine + registration

**Files:**
- Create: `src/lib/inngest/functions/generate-shots.ts`
- Modify: `src/app/api/inngest/route.ts` (import + register `generateShots`)

**Interfaces:**
- Consumes: `inngest` from `@/lib/inngest/client`; `createAdminClient` from `@/lib/supabase/admin`; `signedGetUrl`, `streamUrlToR2` from `@/lib/r2`; `getGenerationProvider` from `@/lib/generation/provider-factory`; `GenerationProvider` from `@/lib/generation/provider`; `resolveMotion` from `@/lib/generation/motion-presets`; `buildClipPrompt`, `buildStillPrompt` from `@/lib/generation/prompt`; `route` from `@/lib/generation/router`; `videoSeed` from `@/lib/generation/seed`; `parseVisualBrief` from `@/lib/videos/visual-brief`; `parseCameraSpec`, `parseLightingSpec`, `Provenance` from `@/lib/videos/cinematography`.
- Produces: `export const generateShots` (Inngest function, event `generation/run`, `data: { videoId: string; accountId: string; jobId?: string }`).
- **No unit test** (see Global Constraints) — verified by typecheck/lint/build here and `drive:generation` in Task 4.

- [ ] **Step 1: Create `src/lib/inngest/functions/generate-shots.ts`**

```ts
import { inngest } from '@/lib/inngest/client';
import { createAdminClient } from '@/lib/supabase/admin';
import { signedGetUrl, streamUrlToR2 } from '@/lib/r2';
import { getGenerationProvider } from '@/lib/generation/provider-factory';
import type { GenerationProvider } from '@/lib/generation/provider';
import { resolveMotion } from '@/lib/generation/motion-presets';
import { buildClipPrompt, buildStillPrompt } from '@/lib/generation/prompt';
import { route } from '@/lib/generation/router';
import { videoSeed } from '@/lib/generation/seed';
import { parseVisualBrief } from '@/lib/videos/visual-brief';
import { parseCameraSpec, parseLightingSpec, type Provenance } from '@/lib/videos/cinematography';

const MAX_POLLS = 150;

type GenShot = {
  id: string;
  visual_brief: unknown;
  camera_spec: unknown;
  lighting_spec: unknown;
  hero: boolean;
  needs_speech: boolean;
  broadcast_4k: boolean;
};

// Generate a keyframe still + Higgsfield clip for each generative shot of a video,
// durably (V2 Slice 1b). The clip lifecycle is async (submit → poll), mirroring
// render.ts's runLambdaSpine. Fires only on an explicit generation/run event; the
// master pipeline (Slice 6) wires it in later. cancelOn mirrors the other job functions.
export const generateShots = inngest.createFunction(
  {
    id: 'generate-shots',
    retries: 2,
    cancelOn: [{ event: 'jobs/cancel', if: 'async.data.jobId == event.data.jobId' }],
  },
  { event: 'generation/run' },
  async ({ event, step }) => {
    const { videoId } = event.data as { videoId: string; accountId: string; jobId?: string };
    const admin = createAdminClient();
    const provider = getGenerationProvider();
    const seed = videoSeed(videoId);

    // Aspect ratio for the keyframe still, from the video settings (default 9:16).
    const aspectRatio = await step.run('load-video', async () => {
      const { data, error } = await admin.from('videos').select('settings').eq('id', videoId).single();
      if (error || !data) throw new Error(`load video: ${error?.message ?? 'not found'}`);
      const settings = (data.settings ?? {}) as Record<string, unknown>;
      return (settings.aspect_ratio as string) ?? '9:16';
    });

    // Generative shots = kind 'generative' shots in this video's scenes with no clip yet
    // (so re-runs are idempotent). Shots have no video_id → resolve via scene ids.
    const shots = await step.run('load-shots', async () => {
      const { data: scenes } = await admin.from('scenes').select('id').eq('video_id', videoId);
      const sceneIds = (scenes ?? []).map((s) => s.id as string);
      if (sceneIds.length === 0) return [] as GenShot[];
      const { data, error } = await admin
        .from('shots')
        .select('id, visual_brief, camera_spec, lighting_spec, hero, needs_speech, broadcast_4k')
        .in('scene_id', sceneIds)
        .eq('kind', 'generative')
        .is('clip_key', null);
      if (error) throw new Error(`load shots: ${error.message}`);
      return (data ?? []) as GenShot[];
    });

    for (const shot of shots) {
      await runGenerationSpine(step, provider, admin, shot, seed, aspectRatio);
    }

    return { generated: shots.length };
  },
);

// One generative shot: keyframe still → submit clip → durable poll → finalize. Each
// external touch is its own durable step.run so a mid-shot failure resumes in place.
async function runGenerationSpine(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  step: any,
  provider: GenerationProvider,
  admin: ReturnType<typeof createAdminClient>,
  shot: GenShot,
  seed: number,
  aspectRatio: string,
): Promise<void> {
  // Never-throw parsers; a script-gen'd generative shot has camera/lighting, but default
  // if absent ({} → defaults, never null).
  const brief = parseVisualBrief(shot.visual_brief) ?? parseVisualBrief({})!;
  const camera = parseCameraSpec(shot.camera_spec) ?? parseCameraSpec({})!;
  const lighting = parseLightingSpec(shot.lighting_spec) ?? parseLightingSpec({})!;

  // 1. Keyframe still → R2 → shots.keyframe_first_key.
  const keyframeKey = await step.run(`keyframe-${shot.id}`, async () => {
    const prompt = buildStillPrompt(brief, camera, lighting);
    const { url } = await provider.generateStill({ prompt, aspectRatio, seed, styleRefUrl: null });
    const key = `generation/${shot.id}/keyframe.png`;
    // NOTE: shots.keyframe_first_key = this per-shot GENERATED keyframe. Distinct from
    // entities.keyframe_key (1a, unused in 1b) — the future per-recurring-entity anchor
    // for seed-locking + reference-image carry.
    await streamUrlToR2(url, key, 'image/png');
    const { error } = await admin.from('shots').update({ keyframe_first_key: key }).eq('id', shot.id);
    if (error) throw new Error(`write keyframe key for shot ${shot.id}: ${error.message}`);
    return key;
  });

  // 2. Submit the clip (keyframe + motion + routed model + per-video seed).
  const submit = await step.run(`submit-${shot.id}`, async () => {
    const imageUrl = await signedGetUrl(keyframeKey, 3600);
    const { motionId, motionStrength } = resolveMotion(camera);
    const clipPrompt = buildClipPrompt(brief, camera, lighting);
    const engine = route({
      kind: 'generative',
      camera,
      hero: shot.hero,
      needs_speech: shot.needs_speech,
      broadcast_4k: shot.broadcast_4k,
    });
    const model = engine.replace('higgsfield.', '');
    const { requestId } = await provider.submitClip({
      prompt: clipPrompt,
      imageUrl,
      motionId,
      motionStrength,
      seed,
      model,
    });
    return { requestId, model };
  });

  // 3. Durable poll to completion (mirrors runLambdaSpine).
  let mediaUrl: string | null = null;
  for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
    const status = await step.run(`poll-${shot.id}-${attempt}`, () => provider.checkClip(submit.requestId));
    if (status.state === 'failed') throw new Error(`clip failed for shot ${shot.id}: ${status.error}`);
    if (status.state === 'completed') {
      mediaUrl = status.mediaUrl;
      break;
    }
    await step.sleep(`wait-${shot.id}-${attempt}`, '3s');
  }
  if (!mediaUrl) throw new Error(`clip generation timed out for shot ${shot.id}`);
  const resolvedUrl: string = mediaUrl;

  // 4. Finalize: clip → R2 → shots.clip_key + routed_model + provenance.
  await step.run(`finalize-${shot.id}`, async () => {
    const clipKey = `generation/${shot.id}/clip.mp4`;
    await streamUrlToR2(resolvedUrl, clipKey, 'video/mp4');
    const provenance: Provenance = {
      synthetic: true,
      source: `higgsfield:${submit.model}`,
      model: submit.model,
      seed,
      source_uri: null,
      created_at: null,
      operator: null,
    };
    const { error } = await admin
      .from('shots')
      .update({ clip_key: clipKey, routed_model: submit.model, provenance })
      .eq('id', shot.id);
    if (error) throw new Error(`finalize shot ${shot.id}: ${error.message}`);
  });
}
```

- [ ] **Step 2: Register `generateShots` in `src/app/api/inngest/route.ts`**

Add the import (with the other function imports):
```ts
import { generateShots } from '@/lib/inngest/functions/generate-shots';
```
> Note: the existing imports in this file use the relative form (e.g. `'@/lib/inngest/functions/render'`). Match whichever path style is already in the file — if the existing imports are `@/lib/...`, use `@/lib/inngest/functions/generate-shots`; if they are relative, mirror that.

Add it to the `functions` array:
```ts
export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [renderVideo, renderSample, generateScript, synthesizeVoice, musicRemux, deployPrimitive, generateShots],
});
```

- [ ] **Step 3: Typecheck, lint, build, full test suite**

Run: `npm run typecheck`
Expected: no errors.
Run: `npm run lint`
Expected: no errors (the `step: any` line carries an `eslint-disable-next-line` like `runLambdaSpine`).
Run: `npm run build`
Expected: success (all routes compile).
Run: `npm test`
Expected: PASS (existing suite + Tasks 1–2 unit tests; no new unit tests here).

- [ ] **Step 4: Commit**

```bash
git add src/lib/inngest/functions/generate-shots.ts src/app/api/inngest/route.ts
git commit -m "$(printf 'feat(v2): generateShots Inngest function (keyframe + clip durable poll)\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 4: Drive script — `drive:generation`

**Files:**
- Create: `scripts/drive-generation.ts`
- Modify: `package.json` (add the `drive:generation` script entry)

**Interfaces:**
- Consumes: `createAdminClient` from `../src/lib/supabase/admin`; `inngest` from `../src/lib/inngest/client`; `signedGetUrl` from `../src/lib/r2`. Sends the `generation/run` event consumed by Task 3's `generateShots`.
- Produces: an `npm run drive:generation -- <videoId>` entry. Not unit-tested; verified by typecheck/lint/build here and an operator run.

- [ ] **Step 1: Create `scripts/drive-generation.ts`**

```ts
// Headless generation driver (V2 Slice 1b verification). Triggers generateShots against
// the FAKE provider so keyframe → clip → R2 is proven end-to-end without Higgsfield
// creds. Mirrors drive-render.ts.
//
// PREREQUISITE — the Inngest function runs in the dev-server process, so the fake's
// fixture URLs must be in .env.local (NOT set here; a value set in this process would
// not reach the function). Add these two lines to .env.local, then restart the dev
// server + Inngest dev server before running this script:
//
//   GEN_FAKE_STILL_URL=data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQAY3Y2wAAAAAElFTkSuQmCC
//   GEN_FAKE_CLIP_URL=data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDE=
//
// (Trivial bytes — R2 putObject does not validate content; we only prove the round-trip
// + key write. Node 20+ fetch supports data: URLs.)
//
// Run: npm run drive:generation -- <videoId>
import { createAdminClient } from '../src/lib/supabase/admin';
import { inngest } from '../src/lib/inngest/client';
import { signedGetUrl } from '../src/lib/r2';

async function main(): Promise<void> {
  const videoId = process.argv[2];
  if (!videoId) throw new Error('Usage: npm run drive:generation -- <videoId>');
  const admin = createAdminClient();

  const { data: video, error: vErr } = await admin
    .from('videos')
    .select('account_id, title')
    .eq('id', videoId)
    .single();
  if (vErr || !video) throw new Error(`load video: ${vErr?.message ?? 'not found'}`);
  const accountId = video.account_id as string;
  console.log(`Video: "${video.title}" (${videoId})`);

  // 1b does not author shots — script-gen does. Operate on an existing video.
  const { data: scenes } = await admin.from('scenes').select('id').eq('video_id', videoId);
  const sceneIds = (scenes ?? []).map((s) => s.id as string);
  const genShots = sceneIds.length
    ? (await admin.from('shots').select('id').in('scene_id', sceneIds).eq('kind', 'generative')).data ?? []
    : [];
  if (genShots.length === 0) {
    throw new Error(
      'No generative shots on this video. Pick a video whose script-gen produced kind=generative shots (1b does not fabricate them).',
    );
  }
  console.log(`  ${genShots.length} generative shot(s).`);

  if (!process.env.GEN_FAKE_STILL_URL || !process.env.GEN_FAKE_CLIP_URL) {
    console.warn(
      '  ⚠ GEN_FAKE_STILL_URL / GEN_FAKE_CLIP_URL not visible in THIS process. That is fine —\n' +
        '    they must be in the DEV-SERVER .env.local (see this file header). If the run hangs\n' +
        '    with no clip_key, the fake is returning https://fake.local/… which streamUrlToR2\n' +
        '    cannot fetch; add the two data: URLs to .env.local and restart the dev server.',
    );
  }

  await inngest.send({ name: 'generation/run', data: { videoId, accountId } });
  console.log('  Sent generation/run. Polling for clip_key …');

  const shotIds = genShots.map((s) => s.id as string);
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const { data: rows } = await admin
      .from('shots')
      .select('id, keyframe_first_key, clip_key, routed_model')
      .in('id', shotIds);
    const done = (rows ?? []).filter((r) => r.clip_key);
    console.log(`  [${i}] ${done.length}/${shotIds.length} clips ready`);
    if (done.length === shotIds.length) {
      for (const r of rows ?? []) {
        const kf = r.keyframe_first_key ? await signedGetUrl(r.keyframe_first_key as string, 600) : null;
        const clip = r.clip_key ? await signedGetUrl(r.clip_key as string, 600) : null;
        console.log(`  shot ${r.id}: model=${r.routed_model}`);
        console.log(`    keyframe=${kf}`);
        console.log(`    clip=${clip}`);
      }
      console.log('✓ Generation complete.');
      return;
    }
  }
  throw new Error('Timed out waiting for clips (3 min). Check the Inngest dev server + .env.local fixtures.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 2: Add the npm script to `package.json`**

In the `scripts` block, next to `drive:render`, add:
```json
"drive:generation": "node --env-file=.env.local --experimental-strip-types --import ./scripts/register-smoke-loader.mjs scripts/drive-generation.ts",
```

- [ ] **Step 3: Typecheck, lint, build**

Run: `npm run typecheck`
Expected: no errors.
Run: `npm run lint`
Expected: no errors.
Run: `npm run build`
Expected: success.

> The script is executed end-to-end by the operator (it needs the local Inngest dev
> server + R2 creds + a video with generative shots + the two `.env.local` fixtures). Do
> not attempt to run `npm run drive:generation` inside the implementer subagent — it is an
> operator verification step, like `drive:render`.

- [ ] **Step 4: Commit**

```bash
git add scripts/drive-generation.ts package.json
git commit -m "$(printf 'feat(v2): drive:generation headless keyframe→clip→R2 proof (fake)\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

## Self-Review

**1. Spec coverage:**
- §3 provider factory → Task 2. §4.1 `videoSeed` → Task 1. §4.2 `buildStillPrompt` → Task 1. §5 `generateShots` + spine + registration → Task 3. §6 `HERO_MOVES` tightening → Task 2. §7 drive script + npm entry → Task 4. §8 testing → unit tests in Tasks 1–2, gates in Tasks 3–4, operator drive run noted. §9 backward-compat (additive, event-gated) → preserved by the no-wiring constraint. §10 file structure → every row mapped to a task. §11 open items (placeholders, cost deferral, per-video seed, aspect default) → reflected in Global Constraints + code comments. All covered.
- §0 continuity decision (per-video seed, `entities` unused) → Global Constraints + the seed comment + the keyframe NOTE comment. `keyframe_last_key` null → Global Constraints (never written).

**2. Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to Task N". Every code step shows complete code. The only intentional placeholders are Slice-1a's `MOTION_ID` UUIDs (out of scope here) and the import-path-style note in Task 3 Step 2 (a deliberate "match the file" instruction, with both concrete forms given).

**3. Type consistency:**
- `videoSeed(videoId: string): number` — defined Task 1, consumed Task 3 (`const seed = videoSeed(videoId)`), passed to `runGenerationSpine(..., seed, ...)` and into `StillRequest.seed`/`ClipRequest.seed` (both `number | null` in `provider.ts` — `number` is assignable) and `Provenance.seed` (`number | null`). ✓
- `buildStillPrompt(brief, camera, lighting): string` — signature matches `buildClipPrompt` (Task 1) and the call in Task 3. ✓
- `getGenerationProvider(): GenerationProvider` — Task 2, called in Task 3. `createFakeProvider({ stillUrl?, clipUrl? })` accepts `string | undefined` (`FakeConfig`, verified). ✓
- `route({ kind, camera, hero, needs_speech, broadcast_4k })` — matches `RoutableShot` (router.ts). Returns `Engine`; `.replace('higgsfield.', '')` yields the model string. For `kind:'generative'` `route` always returns `higgsfield.*`. ✓
- `resolveMotion(camera) → { motionId, motionStrength }` → `ClipRequest.motionId`/`motionStrength`. ✓
- `provider.checkClip` returns `ClipStatus` (`pending | completed{mediaUrl} | failed{error}`) — narrowed in the poll loop. ✓
- `Provenance` written with all seven fields. ✓
- `streamUrlToR2(url, key, contentType?)` / `signedGetUrl(key, ttl)` — signatures match r2.ts. ✓
- Inngest function shape (`inngest.createFunction({ id, retries, cancelOn }, { event }, handler)`) mirrors `renderVideo`. ✓

No inconsistencies found.
