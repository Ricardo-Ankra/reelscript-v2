# V2 Slice 2b — Ingest pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire 2a's ingest cores into a durable `ingestShots` Inngest function that conforms every uploaded/resource live-action shot of a video (video → probe/conform/trim/keyframe; image → reframe) to the video's target dims/fps, recording `footage_key` + `style_ref_key` idempotently.

**Architecture:** Additive, mirrors 1b's `generateShots` exactly — a job-style Inngest fn fired by an explicit `ingest/run` event nothing sends yet (Slice 6 wires it), loading shots via scene ids, running a per-shot durable spine with every step namespaced by shot UUID. Each external touch (probe, conform, keyframe) is its own `step.run` calling the **real** ffmpeg Lambda (`invokeProbe`/`invokeRemux`); the pure argv/timestamp cores are unit-tested, the wiring is verified by an operator `drive:ingest`. Nothing in render/compose/assembly changes — Slice 3 consumes the recorded keys.

**Tech Stack:** Next.js + Supabase (admin client) + Inngest + R2 (`signedGetUrl`/`signedPutUrl`) + the deployed ffmpeg/ffprobe Lambda. Tests via `node --experimental-strip-types --import ./scripts/register-loader.mjs --test`.

## Global Constraints

- **Additive only.** No change to `render.ts`/compose/assembly/script-gen/readiness/the music remux path/the generation pipeline. New modules + columns + one Inngest fn + one registry line + one drive script only.
- **Mirror `generate-shots.ts` structurally:** `triggers: [{ event: 'ingest/run' }]` + `cancelOn: [{ event: 'jobs/cancel', if: 'async.data.jobId == event.data.jobId' }]`; `retries: 2`; load shots via `scenes.id` (shots have no `video_id`); every `step.run` name suffixed `-${shot.id}`.
- **Idempotent re-runs:** the `load-shots` query filters `.is('footage_key', null)`; per-step DB writes (not a final finalize) so a mid-shot failure resumes without re-conforming.
- **Pure builders never do source-dimension arithmetic** — geometry is target-driven + ffmpeg runtime expressions (the 2a invariant).
- **Sibling imports use explicit `.ts` extensions** (the node-test loader requires it).
- **One output per `invokeRemux` call** — the single `outputContentType` field suffices.
- **styleRef = store only** — write `shots.style_ref_key`; never wire it into generation.
- Gates after every code task: `npm test`, `npm run typecheck`, `npm run lint`, `npm run build` all green.

## File Structure

| File | Responsibility |
| --- | --- |
| `supabase/migrations/20260624140000_v2_ingest_contract.sql` (create) | `shots.footage_key` + `shots.style_ref_key` |
| `src/lib/ingest/ffmpeg.ts` (modify) | add `buildImageConformArgs` + `styleRefAt` |
| `src/lib/ingest/ffmpeg.test.ts` (modify) | tests for both new exports |
| `src/lib/inngest/functions/ingest-shots.ts` (create) | `ingestShots` + `runIngestSpine` |
| `src/app/api/inngest/route.ts` (modify) | register `ingestShots` |
| `scripts/drive-ingest.ts` (create) | operator `drive:ingest` |
| `package.json` (modify) | `drive:ingest` script |

---

### Task 1: Ingest contract migration

**Files:**
- Create: `supabase/migrations/20260624140000_v2_ingest_contract.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: `shots.footage_key text` (the conformed clip/still R2 key) + `shots.style_ref_key text` (a representative still R2 key), both nullable. Task 3 writes them.

- [ ] **Step 1: Write the migration**

`supabase/migrations/20260624140000_v2_ingest_contract.sql`:
```sql
-- Reelscript V2 Slice 2b: the ingest data contract. Additive — conform-output columns on
-- shots, written by 2b's ingestShots pipeline. footage_key = the conformed clip/still in
-- R2 (target dims/fps); style_ref_key = a representative still (extract+store only, not
-- wired to generation yet). No RPC change — these are pipeline outputs, never authored by
-- script-gen.
alter table shots add column if not exists footage_key   text;
alter table shots add column if not exists style_ref_key text;
```

- [ ] **Step 2: Apply the migration**

Run: `npm run db:apply`
Expected: applies cleanly; `shots` now has `footage_key` + `style_ref_key`. (If `db:apply` is operator-only in this environment, leave applied-by-operator and proceed — the columns are referenced only by Task 3, which type-checks against the generated types if present, else against `unknown`.)

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260624140000_v2_ingest_contract.sql
git commit -m "feat(v2): shots.footage_key + style_ref_key ingest contract (Slice 2b)"
```

---

### Task 2: Pure image-conform builder + styleRef timestamp

**Files:**
- Modify: `src/lib/ingest/ffmpeg.ts`
- Test: `src/lib/ingest/ffmpeg.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces:
  - `export interface ImageConformInput { inPath: string; outPath: string; target: { width: number; height: number } }`
  - `export function buildImageConformArgs(input: ImageConformInput): string[]`
  - `export function styleRefAt(durationSec: number | null | undefined): number` — `min(0.5, dur/2)` when `dur > 0`, else `0`.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/ingest/ffmpeg.test.ts` (match the file's existing `node:test`/`node:assert` style and `buildConformArgs` test patterns):
```ts
test('buildImageConformArgs reframes to target dims with a single frame out', () => {
  const args = buildImageConformArgs({ inPath: '/tmp/in', outPath: '/tmp/out.png', target: { width: 1080, height: 1920 } });
  const vf = args[args.indexOf('-vf') + 1];
  assert.match(vf, /scale=1080:1920:force_original_aspect_ratio=increase/);
  assert.match(vf, /crop=1080:1920/);
  assert.ok(args.includes('-frames:v'));
  assert.equal(args[args.indexOf('-frames:v') + 1], '1');
  assert.equal(args[args.length - 1], '/tmp/out.png');
});

test('buildImageConformArgs emits no video-only flags', () => {
  const args = buildImageConformArgs({ inPath: '/tmp/in', outPath: '/tmp/out.png', target: { width: 1080, height: 1080 } });
  for (const flag of ['-c:a', '-an', '-r', '-t', '-movflags', 'fps=']) {
    assert.ok(!args.join(' ').includes(flag), `should not contain ${flag}`);
  }
});

test('buildImageConformArgs geometry is target-dims-only (no source arithmetic)', () => {
  const args = buildImageConformArgs({ inPath: '/tmp/in', outPath: '/tmp/out.png', target: { width: 720, height: 1280 } });
  const joined = args.join(' ');
  assert.ok(joined.includes('720') && joined.includes('1280'));
});

test('styleRefAt is min(0.5, dur/2) for positive durations', () => {
  assert.equal(styleRefAt(10), 0.5);
  assert.equal(styleRefAt(0.6), 0.3);
  assert.equal(styleRefAt(1), 0.5);
});

test('styleRefAt is 0 for zero/negative/absent durations', () => {
  assert.equal(styleRefAt(0), 0);
  assert.equal(styleRefAt(-5), 0);
  assert.equal(styleRefAt(null), 0);
  assert.equal(styleRefAt(undefined), 0);
});
```
Add `buildImageConformArgs, styleRefAt` to the existing import from `./ffmpeg.ts` at the top of the test file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/ingest/ffmpeg.test.ts`
Expected: FAIL — `buildImageConformArgs`/`styleRefAt` not exported.

- [ ] **Step 3: Implement the builders**

Append to `src/lib/ingest/ffmpeg.ts` (the `f()` helper already exists in the file — reuse it):
```ts
export interface ImageConformInput {
  inPath: string;
  outPath: string;
  target: { width: number; height: number };
}

// Reframe a still image to cover the target frame (scale-to-fill + crop). No fps/audio/
// trim/movflags — those are video concerns. One image out. Same target-driven geometry
// invariant as buildConformArgs (never source-dim arithmetic).
export function buildImageConformArgs(input: ImageConformInput): string[] {
  const { inPath, outPath, target } = input;
  const vf = [
    `scale=${target.width}:${target.height}:force_original_aspect_ratio=increase`,
    `crop=${target.width}:${target.height}`,
  ].join(',');
  return ['-y', '-i', inPath, '-vf', vf, '-frames:v', '1', outPath];
}

// Deterministic, representative styleRef timestamp: a touch past frame 0 (avoids a black
// fade-in) but never beyond the clip midpoint. Needs no probe round-trip.
export function styleRefAt(durationSec: number | null | undefined): number {
  const d = typeof durationSec === 'number' && Number.isFinite(durationSec) ? durationSec : 0;
  if (d <= 0) return 0;
  return Math.min(0.5, d / 2);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/ingest/ffmpeg.test.ts`
Expected: PASS (all new + existing tests).

- [ ] **Step 5: Run gates**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/lib/ingest/ffmpeg.ts src/lib/ingest/ffmpeg.test.ts
git commit -m "feat(v2): buildImageConformArgs + styleRefAt ingest cores (Slice 2b)"
```

---

### Task 3: ingestShots Inngest function + registration

**Files:**
- Create: `src/lib/inngest/functions/ingest-shots.ts`
- Modify: `src/app/api/inngest/route.ts`

**Interfaces:**
- Consumes: `buildConformArgs`, `buildKeyframeArgs`, `buildImageConformArgs`, `styleRefAt` from `@/lib/ingest/ffmpeg`; `parseProbe` from `@/lib/ingest/probe`; `invokeProbe`, `invokeRemux` from `@/lib/music/remux-invoke`; `signedGetUrl`, `signedPutUrl` from `@/lib/r2`; `createAdminClient` from `@/lib/supabase/admin`; `inngest` from `@/lib/inngest/client`.
- Produces: `export const ingestShots` (an Inngest function), registered in the serve handler. Fires on `ingest/run { videoId, accountId, jobId? }`.

> **No unit test for this task** — like `generate-shots.ts`, the spine touches the real Lambda + DB and has no in-process fake (per the spec's "no fake seam" decision). Verification is the gates (tsc/lint/build) here + the operator `drive:ingest` in Task 4. Keep all testable logic in the Task 2 pure cores.

- [ ] **Step 1: Write the function**

Create `src/lib/inngest/functions/ingest-shots.ts`:
```ts
import { inngest } from '@/lib/inngest/client';
import { createAdminClient } from '@/lib/supabase/admin';
import { signedGetUrl, signedPutUrl } from '@/lib/r2';
import { invokeProbe, invokeRemux } from '@/lib/music/remux-invoke';
import { parseProbe } from '@/lib/ingest/probe';
import { buildConformArgs, buildKeyframeArgs, buildImageConformArgs, styleRefAt } from '@/lib/ingest/ffmpeg';

type IngestShot = { id: string; resource_id: string; duration_seconds: number | null };
type Target = { width: number; height: number; fps: number };

const DIMS: Record<string, { width: number; height: number }> = {
  '9:16': { width: 1080, height: 1920 },
  '1:1': { width: 1080, height: 1080 },
  '16:9': { width: 1920, height: 1080 },
};

// Conform every uploaded/resource live-action shot of a video to the target dims/fps,
// durably (V2 Slice 2b). Mirrors generate-shots.ts: fires only on an explicit ingest/run
// event nothing sends yet (Slice 6 wires it); cancelOn mirrors the other job functions.
// Each external touch is its own durable step.run namespaced by shot UUID.
export const ingestShots = inngest.createFunction(
  {
    id: 'ingest-shots',
    retries: 2,
    triggers: [{ event: 'ingest/run' }],
    cancelOn: [{ event: 'jobs/cancel', if: 'async.data.jobId == event.data.jobId' }],
  },
  async ({ event, step }) => {
    const { videoId, accountId } = event.data as { videoId: string; accountId: string; jobId?: string };
    const admin = createAdminClient();

    const target = await step.run('load-video', async () => {
      const { data, error } = await admin.from('videos').select('settings').eq('id', videoId).single();
      if (error || !data) throw new Error(`load video: ${error?.message ?? 'not found'}`);
      const settings = (data.settings ?? {}) as Record<string, unknown>;
      const ratio = (settings.aspect_ratio as string) ?? '9:16';
      const { width, height } = DIMS[ratio] ?? DIMS['9:16'];
      const fps = (settings.fps as number) ?? 30;
      return { width, height, fps } as Target;
    });

    // Live-action, resource-pinned shots not yet conformed (idempotent on footage_key).
    // Shots have no video_id → resolve via scene ids.
    const shots = await step.run('load-shots', async () => {
      const { data: scenes } = await admin.from('scenes').select('id').eq('video_id', videoId);
      const sceneIds = (scenes ?? []).map((s) => s.id as string);
      if (sceneIds.length === 0) return [] as IngestShot[];
      const { data, error } = await admin
        .from('shots')
        .select('id, resource_id, duration_seconds')
        .in('scene_id', sceneIds)
        .eq('kind', 'live_action')
        .eq('source', 'resource')
        .not('resource_id', 'is', null)
        .is('footage_key', null);
      if (error) throw new Error(`load shots: ${error.message}`);
      return (data ?? []) as IngestShot[];
    });

    for (const shot of shots) {
      await runIngestSpine(step, admin, accountId, shot, target);
    }

    return { ingested: shots.length };
  },
);

// One resource shot: resolve → (video: probe → conform → keyframe) | (image: reframe).
// Per-step DB writes so a mid-shot failure resumes without re-conforming.
async function runIngestSpine(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  step: any,
  admin: ReturnType<typeof createAdminClient>,
  accountId: string,
  shot: IngestShot,
  target: Target,
): Promise<void> {
  const resource = await step.run(`resolve-${shot.id}`, async () => {
    const { data, error } = await admin
      .from('channel_resources')
      .select('r2_key, kind')
      .eq('id', shot.resource_id)
      .eq('account_id', accountId)
      .single();
    if (error || !data || !data.r2_key) {
      throw new Error(`resolve resource ${shot.resource_id} for shot ${shot.id}: ${error?.message ?? 'no r2_key'}`);
    }
    return { r2Key: data.r2_key as string, kind: data.kind === 'video' ? 'video' : 'image' };
  });

  if (resource.kind === 'image') {
    await step.run(`conform-image-${shot.id}`, async () => {
      const inUrl = await signedGetUrl(resource.r2Key);
      const outKey = `ingest/${shot.id}/footage.png`;
      const outUrl = await signedPutUrl(outKey, 'image/png');
      const args = buildImageConformArgs({
        inPath: '/tmp/in',
        outPath: '/tmp/out.png',
        target: { width: target.width, height: target.height },
      });
      await invokeRemux({ args, inputs: { '/tmp/in': inUrl }, outputs: { '/tmp/out.png': outUrl }, outputContentType: 'image/png' });
      // The conformed still IS its own styleRef — no separate keyframe extraction.
      const { error } = await admin.from('shots').update({ footage_key: outKey, style_ref_key: outKey }).eq('id', shot.id);
      if (error) throw new Error(`write image footage for shot ${shot.id}: ${error.message}`);
      return outKey;
    });
    return;
  }

  // Video: probe → conform (reframe + normalize + trim + autorotate) → styleRef keyframe.
  const probe = await step.run(`probe-${shot.id}`, async () => {
    const url = await signedGetUrl(resource.r2Key);
    return parseProbe(await invokeProbe(url));
  });

  const footageKey = await step.run(`conform-${shot.id}`, async () => {
    const inUrl = await signedGetUrl(resource.r2Key);
    const outKey = `ingest/${shot.id}/footage.mp4`;
    const outUrl = await signedPutUrl(outKey, 'video/mp4');
    const args = buildConformArgs({
      inPath: '/tmp/in',
      outPath: '/tmp/out.mp4',
      target,
      probe,
      durationSec: shot.duration_seconds ?? undefined,
    });
    await invokeRemux({ args, inputs: { '/tmp/in': inUrl }, outputs: { '/tmp/out.mp4': outUrl }, outputContentType: 'video/mp4' });
    const { error } = await admin.from('shots').update({ footage_key: outKey }).eq('id', shot.id);
    if (error) throw new Error(`write footage for shot ${shot.id}: ${error.message}`);
    return outKey;
  });

  await step.run(`keyframe-${shot.id}`, async () => {
    const inUrl = await signedGetUrl(footageKey);
    const styleKey = `ingest/${shot.id}/styleref.png`;
    const outUrl = await signedPutUrl(styleKey, 'image/png');
    const args = buildKeyframeArgs({ inPath: '/tmp/in.mp4', outPath: '/tmp/out.png', atSec: styleRefAt(shot.duration_seconds) });
    await invokeRemux({ args, inputs: { '/tmp/in.mp4': inUrl }, outputs: { '/tmp/out.png': outUrl }, outputContentType: 'image/png' });
    const { error } = await admin.from('shots').update({ style_ref_key: styleKey }).eq('id', shot.id);
    if (error) throw new Error(`write styleRef for shot ${shot.id}: ${error.message}`);
  });
}
```

- [ ] **Step 2: Register the function**

In `src/app/api/inngest/route.ts`: add the import beside the others and append `ingestShots` to the `functions: [...]` array:
```ts
import { ingestShots } from '@/lib/inngest/functions/ingest-shots';
```
```ts
  functions: [renderVideo, renderSample, generateScript, synthesizeVoice, musicRemux, deployPrimitive, generateShots, ingestShots],
```

- [ ] **Step 3: Run gates**

Run: `npm test && npm run typecheck && npm run lint && npm run build`
Expected: all green; the build still emits its full route set (17/17 or current count) and the Inngest route compiles with `ingestShots` registered.

- [ ] **Step 4: Commit**

```bash
git add src/lib/inngest/functions/ingest-shots.ts src/app/api/inngest/route.ts
git commit -m "feat(v2): ingestShots Inngest function — conform resource live-action shots (Slice 2b)"
```

---

### Task 4: Operator drive script + docs

**Files:**
- Create: `scripts/drive-ingest.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `createAdminClient` (`../src/lib/supabase/admin`), `inngest` (`../src/lib/inngest/client`), `signedGetUrl` (`../src/lib/r2`).
- Produces: `npm run drive:ingest -- <videoId>` — sends `ingest/run` and polls `shots.footage_key`/`style_ref_key`. Operator-run against the real Lambda.

- [ ] **Step 1: Write the drive script**

Create `scripts/drive-ingest.ts`:
```ts
// Headless ingest driver (V2 Slice 2b verification). Triggers ingestShots, which conforms
// the video's resource-pinned live-action shots via the REAL ffmpeg Lambda. Mirrors
// drive-generation.ts / drive-remux.ts.
//
// PREREQUISITES (operator):
//   1. The ffmpeg Lambda is redeployed with 2a's probe mode (node scripts/deploy-music-lambda.mjs).
//   2. The dev server + Inngest dev server are running (the function runs in the dev-server process).
//   3. The target video has at least one source='resource', kind='live_action' shot (pin
//      one in the editor first — this script never fabricates shots).
//
// Run: npm run drive:ingest -- <videoId>
import { createAdminClient } from '../src/lib/supabase/admin';
import { inngest } from '../src/lib/inngest/client';
import { signedGetUrl } from '../src/lib/r2';

async function main(): Promise<void> {
  const videoId = process.argv[2];
  if (!videoId) throw new Error('Usage: npm run drive:ingest -- <videoId>');
  const admin = createAdminClient();

  const { data: video, error: vErr } = await admin
    .from('videos')
    .select('account_id, title')
    .eq('id', videoId)
    .single();
  if (vErr || !video) throw new Error(`load video: ${vErr?.message ?? 'not found'}`);
  const accountId = video.account_id as string;
  console.log(`Video: "${video.title}" (${videoId})`);

  const { data: scenes } = await admin.from('scenes').select('id').eq('video_id', videoId);
  const sceneIds = (scenes ?? []).map((s) => s.id as string);
  const ingestShotsRows = sceneIds.length
    ? (await admin
        .from('shots')
        .select('id')
        .in('scene_id', sceneIds)
        .eq('kind', 'live_action')
        .eq('source', 'resource')
        .not('resource_id', 'is', null)).data ?? []
    : [];
  if (ingestShotsRows.length === 0) {
    throw new Error(
      'No resource-pinned live-action shots on this video. Pin an uploaded image/video to a shot in the editor first (2b does not fabricate shots).',
    );
  }
  console.log(`  ${ingestShotsRows.length} resource live-action shot(s).`);

  await inngest.send({ name: 'ingest/run', data: { videoId, accountId } });
  console.log('  Sent ingest/run. Polling for footage_key …');

  const shotIds = ingestShotsRows.map((s) => s.id as string);
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const { data: rows } = await admin
      .from('shots')
      .select('id, footage_key, style_ref_key')
      .in('id', shotIds);
    const done = (rows ?? []).filter((r) => r.footage_key);
    console.log(`  [${i}] ${done.length}/${shotIds.length} conformed`);
    if (done.length === shotIds.length) {
      for (const r of rows ?? []) {
        const footage = r.footage_key ? await signedGetUrl(r.footage_key as string, 600) : null;
        const styleRef = r.style_ref_key ? await signedGetUrl(r.style_ref_key as string, 600) : null;
        console.log(`  shot ${r.id}:`);
        console.log(`    footage=${footage}`);
        console.log(`    styleRef=${styleRef}`);
      }
      console.log('✓ Ingest complete.');
      return;
    }
  }
  throw new Error('Timed out waiting for conform (3 min). Check the Inngest dev server + that the probe Lambda is redeployed.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 2: Add the package.json script**

In `package.json` `scripts`, add beside `drive:generation` (copy its exact runner flags):
```json
    "drive:ingest": "node --env-file=.env.local --experimental-strip-types --import ./scripts/register-smoke-loader.mjs scripts/drive-ingest.ts",
```

- [ ] **Step 3: Verify the script parses (no run — needs AWS)**

Run: `npm run typecheck`
Expected: PASS (the script type-checks; it is NOT executed here — `drive:ingest` is an operator step against the real Lambda, gated on 2a's redeploy).

- [ ] **Step 4: Commit**

```bash
git add scripts/drive-ingest.ts package.json
git commit -m "feat(v2): drive:ingest operator proof for ingestShots (Slice 2b)"
```

---

### Task 5: Final review gates + docs

**Files:**
- Modify: `CLAUDE.md` (add the Slice 2b shipped entry under the Slice 2 program block)
- Modify: the auto-memory `v2-higgsfield-program.md` + `MEMORY.md` pointer (Slice 2b line)

- [ ] **Step 1: Run the full gate set**

Run: `npm test && npm run typecheck && npm run lint && npm run build`
Expected: all green. Record the test count + build route count for the CLAUDE.md entry.

- [ ] **Step 2: Update CLAUDE.md**

Add a Slice 2b sub-bullet under the Slice 2 block mirroring the 2a entry's style: what shipped (migration, `ingestShots`, image+video branches, `buildImageConformArgs`/`styleRefAt`, drive script), what's deferred (styleRef wiring, stock-sourced conform, assembly consumption = Slice 3), the operator gate (2a redeploy still required before `drive:ingest`), and the green test/build counts.

- [ ] **Step 3: Update auto-memory**

Append a Slice 2b line to `…/memory/v2-higgsfield-program.md` and its `MEMORY.md` pointer (one line, hook-style), per the memory rules.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: record V2 Slice 2b shipped (ingest pipeline)"
```

---

## Self-Review notes

- **Spec coverage:** §3 migration → Task 1; §4 `buildImageConformArgs` + §5 `styleRefAt` → Task 2; §5 `ingestShots`/`runIngestSpine` (video + image branches, idempotency, per-step writes) + §6 registration → Task 3; §7 drive script → Task 4; §8 gates + §0 docs → Tasks 2/3/5. All spec sections map to a task.
- **Type consistency:** `Target = {width,height,fps}`, `IngestShot = {id, resource_id, duration_seconds}`, `ImageConformInput`, `styleRefAt(number|null|undefined)`, `buildImageConformArgs`/`buildConformArgs`/`buildKeyframeArgs` signatures, and the `invokeRemux({args,inputs,outputs,outputContentType})` shape are used identically across Tasks 2–4.
- **No placeholders:** every code step shows full content; the Inngest fn has no unit test by design (documented), matching `generate-shots.ts`.
