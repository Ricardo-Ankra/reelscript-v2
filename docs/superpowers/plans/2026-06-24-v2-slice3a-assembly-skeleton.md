# V2 Slice 3a — Assembly skeleton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render generative-clip (`clip_key`) and live-action-footage (`footage_key`) shots as full-frame, VO-fit `OffthreadVideo` **segments** that tile each scene's voiceover-driven timeline, coexisting with the existing primitive/stock composition.

**Architecture:** Additive extension of the existing render spine. The composition spec gains `CompositionScene.segments`; `loadBrief` (render.ts) computes per-scene segments deterministically (proportional partition of the scene's frames + trim/freeze VO-fit) from shot data, adds the clip/footage R2 keys as `kind:'video'` manifest assets, and excludes assembly-backed shots from the compose hints (A-lite); the single `assembleSpec` carries `segments` onto the output scene; `ReelComposition` renders each segment above primitives. No color grade (3b), no migration, no AI involvement for clip/footage shots. Legacy videos (no shot has a clip/footage key) render byte-identically.

**Tech Stack:** Next.js + Supabase (admin) + Inngest + Remotion 4.0.472 (`OffthreadVideo`, `Freeze`, `Sequence`) + R2. Tests via `node --experimental-strip-types --import ./scripts/register-loader.mjs --test`.

## Global Constraints

- **Additive only.** No migration. No change to voice synthesis, captions, music re-mux, script-gen, generation (1b), or ingest (2b). A video where no shot has a `clip_key`/`footage_key` produces no `segments`, identical `shotHints`, a byte-identical spec + render.
- **VO-first, scene-driven.** Scenes stay the VO unit; a scene's shots partition its existing `durationInFrames` proportionally to each shot's `duration_seconds`; partitions tile `[0, sceneFrames)` exactly.
- **VO-fit = trim-long / freeze-hold-short.** `native ≥ allotted → 'trim'` (`trimAfter={allotted}`); `native < allotted → 'freeze'` (play fully, then `<Freeze>` the last source frame). `sourceDurationInFrames = max(round((shot.duration_seconds||0) * fps), 1)` — the only native-duration estimate available in 3a (footage was conformed-trimmed to `duration_seconds`; a generative clip was generated for that shot's `duration_seconds`).
- **A-lite mixed scenes.** A shot with `clip_key ?? footage_key` non-null is assembly-backed: dropped from `shotHints`, emitted as a full-frame segment over its sub-range, occluding primitives there. Non-assembly shots compose as today. Confining primitives to sub-ranges is a later slice.
- **Segments are full-frame and muted** (VO-first; the per-scene `<Audio>` owns sound), layered above primitives but below the composition-level caption/attribution overlays.
- **Assembly-backed shots are NOT stock** — they must not set `needsStock`.
- Sibling test imports use explicit `.ts` extensions. Gates after every code task: `npm test`, `npm run typecheck`, `npm run lint`, `npm run build` all green.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/lib/composition/spec.ts` (modify) | add `ShotSegment` + `CompositionScene.segments?` |
| `src/lib/composition/assembly.ts` (+ test) (create) | pure `partitionSceneFrames`, `fitForSegment`, `segmentAssetId`, `buildSegmentAssets` |
| `src/lib/composition/compose.ts` (modify) | `SceneBrief.segments?` + `assembleSpec` carries it |
| `src/lib/composition/compose.test.ts` (modify) | test the `assembleSpec` segment carry |
| `src/lib/inngest/functions/render.ts` (modify) | `loadBrief`: emit `segments`, add segment assets, exclude assembly shots from `shotHints` |
| `remotion/ReelComposition.tsx` (modify) | render `segments` (trim / freeze-hold, muted, above primitives) |

---

### Task 1: Composition spec — `ShotSegment` type + `CompositionScene.segments`

**Files:**
- Modify: `src/lib/composition/spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export interface ShotSegment { shotId: string; from: number; durationInFrames: number; assetId: string; fit: 'trim' | 'freeze'; sourceDurationInFrames: number }`
  - `CompositionScene.segments?: ShotSegment[]` (optional, additive).

- [ ] **Step 1: Add the type + field**

In `src/lib/composition/spec.ts`, add before `CompositionScene`:
```ts
/**
 * One clip/footage shot placed on the timeline (Slice 3a). The shot's allotted span
 * (`from`/`durationInFrames`) tiles its scene; `assetId` points at a kind:'video' manifest
 * entry (the resolved clip_key/footage_key). `fit` is precomputed in loadBrief so the
 * renderer stays declarative: 'trim' = clip ≥ allotted (trimAfter to fit); 'freeze' = clip
 * < allotted (play fully, then hold the last source frame). `sourceDurationInFrames` is the
 * clip's native length, used to split the freeze.
 */
export interface ShotSegment {
  shotId: string;
  from: number; // start frame within the scene (0 = scene start)
  durationInFrames: number; // allotted span
  assetId: string; // a kind:'video' manifest entry
  fit: 'trim' | 'freeze';
  sourceDurationInFrames: number;
}
```
Then add to `CompositionScene` (after `instances`):
```ts
  /** Clip/footage shot segments tiling this scene (Slice 3a). Absent/empty ⇒ legacy
   *  primitive-only render. Rendered full-frame above primitives. */
  segments?: ShotSegment[];
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS (pure additive type change; nothing consumes it yet).

- [ ] **Step 3: Commit**

```bash
git add src/lib/composition/spec.ts
git commit -m "feat(v2): ShotSegment type + CompositionScene.segments (Slice 3a)"
```

---

### Task 2: Pure assembly cores — `assembly.ts`

**Files:**
- Create: `src/lib/composition/assembly.ts`
- Test: `src/lib/composition/assembly.test.ts`

**Interfaces:**
- Consumes: `AssetManifestEntry` from `./spec` (Task 1's file).
- Produces:
  - `export interface ShotTiming { shotId: string; from: number; durationInFrames: number }`
  - `export function partitionSceneFrames(sceneFrames: number, shots: { shotId: string; durationSeconds: number }[]): ShotTiming[]`
  - `export function fitForSegment(nativeFrames: number, allottedFrames: number): 'trim' | 'freeze'`
  - `export function segmentAssetId(shotId: string): string`
  - `export function buildSegmentAssets(shots: { shotId: string; key: string }[]): AssetManifestEntry[]`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/composition/assembly.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { partitionSceneFrames, fitForSegment, segmentAssetId, buildSegmentAssets } from './assembly.ts';

test('partitionSceneFrames splits proportionally and tiles exactly', () => {
  const t = partitionSceneFrames(10, [
    { shotId: 'a', durationSeconds: 1 },
    { shotId: 'b', durationSeconds: 1 },
  ]);
  assert.deepEqual(t, [
    { shotId: 'a', from: 0, durationInFrames: 5 },
    { shotId: 'b', from: 5, durationInFrames: 5 },
  ]);
});

test('partitionSceneFrames hands the rounding remainder to the last shot', () => {
  const t = partitionSceneFrames(10, [
    { shotId: 'a', durationSeconds: 1 },
    { shotId: 'b', durationSeconds: 1 },
    { shotId: 'c', durationSeconds: 1 },
  ]);
  assert.deepEqual(t.map((x) => x.durationInFrames), [3, 3, 4]);
  assert.deepEqual(t.map((x) => x.from), [0, 3, 6]);
  assert.equal(t.reduce((s, x) => s + x.durationInFrames, 0), 10);
});

test('partitionSceneFrames falls back to an equal split when all weights are 0', () => {
  const t = partitionSceneFrames(9, [
    { shotId: 'a', durationSeconds: 0 },
    { shotId: 'b', durationSeconds: 0 },
    { shotId: 'c', durationSeconds: 0 },
  ]);
  assert.deepEqual(t.map((x) => x.durationInFrames), [3, 3, 3]);
});

test('partitionSceneFrames handles a single shot and uneven weights', () => {
  assert.deepEqual(partitionSceneFrames(7, [{ shotId: 'a', durationSeconds: 5 }]), [
    { shotId: 'a', from: 0, durationInFrames: 7 },
  ]);
  const t = partitionSceneFrames(10, [
    { shotId: 'a', durationSeconds: 3 },
    { shotId: 'b', durationSeconds: 1 },
  ]);
  assert.equal(t.reduce((s, x) => s + x.durationInFrames, 0), 10);
  assert.equal(t[0].durationInFrames, 7); // floor(10*3/4)=7
});

test('partitionSceneFrames returns [] for no shots', () => {
  assert.deepEqual(partitionSceneFrames(10, []), []);
});

test('fitForSegment: native >= allotted is trim, native < allotted is freeze', () => {
  assert.equal(fitForSegment(30, 30), 'trim');
  assert.equal(fitForSegment(31, 30), 'trim');
  assert.equal(fitForSegment(29, 30), 'freeze');
});

test('segmentAssetId is stable and shot-scoped', () => {
  assert.equal(segmentAssetId('abc'), 'seg-abc');
});

test('buildSegmentAssets maps each key to a kind:video manifest entry', () => {
  const entries = buildSegmentAssets([
    { shotId: 's1', key: 'generation/s1/clip.mp4' },
    { shotId: 's2', key: 'ingest/s2/footage.mp4' },
  ]);
  assert.deepEqual(entries, [
    { id: 'seg-s1', kind: 'video', r2Key: 'generation/s1/clip.mp4' },
    { id: 'seg-s2', kind: 'video', r2Key: 'ingest/s2/footage.mp4' },
  ]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/composition/assembly.test.ts`
Expected: FAIL — module/exports not found.

- [ ] **Step 3: Implement `assembly.ts`**

Create `src/lib/composition/assembly.ts`:
```ts
import type { AssetManifestEntry } from './spec';

// Pure assembly cores (Slice 3a). Deterministic timeline math — no media inspection, no
// AI — so the renderer stays declarative and the logic is unit-tested.

export interface ShotTiming {
  shotId: string;
  from: number;
  durationInFrames: number;
}

// Partition a scene's frames among its shots proportionally to duration_seconds, tiling
// [0, sceneFrames) exactly: floor each share, give the accumulated rounding remainder to
// the last shot. All-zero (or absent) weights ⇒ an equal split. No shots ⇒ [].
export function partitionSceneFrames(
  sceneFrames: number,
  shots: { shotId: string; durationSeconds: number }[],
): ShotTiming[] {
  if (shots.length === 0) return [];
  const weights = shots.map((s) => (s.durationSeconds > 0 ? s.durationSeconds : 0));
  const total = weights.reduce((a, b) => a + b, 0);
  // Equal split when every weight is 0.
  const shares = total > 0 ? weights.map((w) => w / total) : shots.map(() => 1 / shots.length);

  const out: ShotTiming[] = [];
  let from = 0;
  for (let i = 0; i < shots.length; i++) {
    const isLast = i === shots.length - 1;
    const dur = isLast ? sceneFrames - from : Math.floor(sceneFrames * shares[i]);
    out.push({ shotId: shots[i].shotId, from, durationInFrames: dur });
    from += dur;
  }
  return out;
}

export function fitForSegment(nativeFrames: number, allottedFrames: number): 'trim' | 'freeze' {
  return nativeFrames >= allottedFrames ? 'trim' : 'freeze';
}

export function segmentAssetId(shotId: string): string {
  return `seg-${shotId}`;
}

// Build the kind:'video' manifest entries for clip/footage segments. The key IS the durable
// r2Key (own content — no attribution, no DB lookup; the keys were loaded with the shots).
export function buildSegmentAssets(shots: { shotId: string; key: string }[]): AssetManifestEntry[] {
  return shots.map((s) => ({ id: segmentAssetId(s.shotId), kind: 'video' as const, r2Key: s.key }));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/composition/assembly.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Run gates**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/lib/composition/assembly.ts src/lib/composition/assembly.test.ts
git commit -m "feat(v2): pure assembly cores — partition/fit/segment-assets (Slice 3a)"
```

---

### Task 3: `SceneBrief.segments` + `assembleSpec` carry

**Files:**
- Modify: `src/lib/composition/compose.ts`
- Test: `src/lib/composition/compose.test.ts`

**Interfaces:**
- Consumes: `ShotSegment` from `./spec` (Task 1).
- Produces: `SceneBrief.segments?: ShotSegment[]`; `assembleSpec` copies a scene brief's `segments` onto the output `CompositionScene`.

- [ ] **Step 1: Write the failing test**

In `src/lib/composition/compose.test.ts`, add (mirror the existing `assembleSpec carries captionFocus onto the scene` test — reuse its `brief` fixture shape):
```ts
test('assembleSpec carries segments onto the scene and omits them when absent', () => {
  const seg = {
    shotId: 'shot-1',
    from: 0,
    durationInFrames: 60,
    assetId: 'seg-shot-1',
    fit: 'trim' as const,
    sourceDurationInFrames: 60,
  };
  const briefWithSeg = {
    ...brief,
    scenes: [{ ...brief.scenes[0], segments: [seg] }],
  };
  const withSeg = assembleSpec({ scenes: [{ sceneId: brief.scenes[0].id, instances: [] }] }, briefWithSeg);
  assert.deepEqual(withSeg.scenes[0].segments, [seg]);

  const withoutSeg = assembleSpec({ scenes: [{ sceneId: brief.scenes[0].id, instances: [] }] }, brief);
  assert.equal(withoutSeg.scenes[0].segments, undefined);
});
```
(If the file's shared `brief` fixture has more than one scene, index the first; match the file's existing fixture variable names.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/composition/compose.test.ts`
Expected: FAIL — `segments` is `undefined` on the with-segments case (assembleSpec doesn't copy it yet).

- [ ] **Step 3: Implement**

In `src/lib/composition/compose.ts`:
1. Import the type — add `ShotSegment` to the existing `import type { … } from './spec'` (or add an import if none): `import type { CompositionSpec, CompositionMetadata, AssetManifestEntry, ShotSegment } from './spec';` (match the file's actual existing import list — only ADD `ShotSegment`).
2. Add to `SceneBrief` (after `pinnedResources`):
```ts
  // Clip/footage shot segments (Slice 3a), precomputed in loadBrief. Carried straight onto
  // the output scene by assembleSpec — the AI never sees or composes these shots.
  segments?: ShotSegment[];
```
3. In `assembleSpec`, in the `scenes: brief.scenes.map((s) => { … return { … } })`, add the segments spread next to the `captionFocus` spread:
```ts
        ...(s.segments && s.segments.length ? { segments: s.segments } : {}),
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/composition/compose.test.ts`
Expected: PASS.

- [ ] **Step 5: Run gates**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/lib/composition/compose.ts src/lib/composition/compose.test.ts
git commit -m "feat(v2): SceneBrief.segments + assembleSpec carry (Slice 3a)"
```

---

### Task 4: `loadBrief` — emit segments, add assets, exclude from hints

**Files:**
- Modify: `src/lib/inngest/functions/render.ts`

**Interfaces:**
- Consumes: `partitionSceneFrames`, `fitForSegment`, `segmentAssetId`, `buildSegmentAssets`, `ShotTiming` from `@/lib/composition/assembly`; `ShotSegment` from `@/lib/composition/spec`; `SceneBrief.segments` (Task 3).
- Produces: each `SceneBrief` may carry `segments`; the manifest `assets` includes the segment video entries; `shotHints` excludes assembly-backed shots; assembly-backed shots don't set `needsStock`.

> **No unit test for this task** — `loadBrief` is server-only (DB I/O), like the rest of the render spine. All testable logic lives in the Task 2/3 pure cores. Verification is the gates (tsc/lint/build) here + the existing `drive:render` operator path. Keep the wiring thin: call the pure cores, don't re-implement them.

- [ ] **Step 1: Extend the shot query**

In `loadBrief`, the shots `select` (currently `'scene_id, description, position, source, resource_id, visual_brief'`) → add `id` + the new columns (`id` is needed by Step 2):
```ts
      .select('id, scene_id, description, position, source, resource_id, visual_brief, kind, clip_key, footage_key, duration_seconds')
```

- [ ] **Step 2: Collect per-scene assembly data in the shot loop**

Replace the existing shot loop body so it also gathers, per scene, the ordered shot list (for partitioning) and the assembly-backed shots, and **excludes assembly-backed shots from `shotHints` / `needsStock`**. Add before the loop:
```ts
    // Per-scene ordered shots (for the proportional partition) + the assembly-backed ones.
    const sceneShots = new Map<string, { shotId: string; durationSeconds: number }[]>();
    const sceneSegShots = new Map<string, { shotId: string; key: string; durationSeconds: number }[]>();
```
Then the loop (`for (const sh of shotRows ?? [])`) becomes:
```ts
    for (const sh of shotRows ?? []) {
      const sceneId = sh.scene_id as string;
      const shotId = sh.id as string;
      const durationSeconds = Number(sh.duration_seconds) || 0;
      const key = (sh.clip_key as string | null) ?? (sh.footage_key as string | null);

      // Every shot participates in the scene's proportional partition.
      const all = sceneShots.get(sceneId) ?? [];
      all.push({ shotId, durationSeconds });
      sceneShots.set(sceneId, all);

      if (key) {
        // Assembly-backed: becomes a full-frame segment; never a hint, never stock.
        const segs = sceneSegShots.get(sceneId) ?? [];
        segs.push({ shotId, key, durationSeconds });
        sceneSegShots.set(sceneId, segs);
        continue;
      }

      // Non-assembly shots flow into the compose hints / pins / needsStock exactly as before.
      const list = shotsByScene.get(sceneId) ?? [];
      list.push(formatShotHint(parseVisualBrief(sh.visual_brief), sh.description as string));
      shotsByScene.set(sceneId, list);
      if (sh.source === 'resource' && sh.resource_id) {
        resourceIdSet.add(sh.resource_id as string);
        const pins = pinnedByScene.get(sceneId) ?? [];
        pins.push(sh.resource_id as string);
        pinnedByScene.set(sceneId, pins);
      } else {
        needsStock = true;
      }
    }
```

- [ ] **Step 3: Emit segments + assets in the `briefScenes` map**

Inside `const briefScenes: SceneBrief[] = scenes.map((s) => { … })`, after `durationInFrames` is computed and before the `return`, add:
```ts
    // Slice 3a: place this scene's clip/footage shots as segments tiling the scene frames.
    let segments: ShotSegment[] | undefined;
    const segShots = sceneSegShots.get(s.id as string) ?? [];
    if (segShots.length) {
      const timings = partitionSceneFrames(durationInFrames, sceneShots.get(s.id as string) ?? []);
      const byShot = new Map(timings.map((t) => [t.shotId, t]));
      assets.push(...buildSegmentAssets(segShots.map((x) => ({ shotId: x.shotId, key: x.key }))));
      segments = segShots
        .map((x) => {
          const t = byShot.get(x.shotId);
          if (!t) return null;
          const sourceDurationInFrames = Math.max(Math.round(x.durationSeconds * fps), 1);
          return {
            shotId: x.shotId,
            from: t.from,
            durationInFrames: t.durationInFrames,
            assetId: segmentAssetId(x.shotId),
            fit: fitForSegment(sourceDurationInFrames, t.durationInFrames),
            sourceDurationInFrames,
          } satisfies ShotSegment;
        })
        .filter((x): x is ShotSegment => x !== null);
      if (segments.length === 0) segments = undefined;
    }
```
Then add `segments` to the returned `SceneBrief` object literal (next to `pinnedResources`):
```ts
      segments,
```

- [ ] **Step 4: Add the imports**

At the top of `render.ts`, add:
```ts
import { partitionSceneFrames, fitForSegment, segmentAssetId, buildSegmentAssets } from '@/lib/composition/assembly';
import type { ShotSegment } from '@/lib/composition/spec';
```
(If `render.ts` already imports from `@/lib/composition/spec`, add `ShotSegment` to that type import instead of a second line.)

- [ ] **Step 5: Run gates**

Run: `npm test && npm run typecheck && npm run lint && npm run build`
Expected: all green; build emits its full route set (note the count). A video with no clip/footage shots is unaffected (no `segments`, identical hints).

- [ ] **Step 6: Commit**

```bash
git add src/lib/inngest/functions/render.ts
git commit -m "feat(v2): loadBrief emits clip/footage segments + excludes them from hints (Slice 3a)"
```

---

### Task 5: `ReelComposition` — render segments

**Files:**
- Modify: `remotion/ReelComposition.tsx`

**Interfaces:**
- Consumes: `CompositionScene.segments` (Task 1); `assetUrl(assetId)` (already defined in the file); `OffthreadVideo`, `Freeze`, `Sequence` from `remotion`.
- Produces: per-scene segment rendering, full-frame, muted, above primitives.

> **No unit test** — Remotion rendering isn't unit-tested in this repo (matches the spine). Verified by `npm run build` (the bundle compiles) + the existing `drive:render` operator path.

- [ ] **Step 1: Extend the remotion imports**

In `remotion/ReelComposition.tsx`, add `OffthreadVideo`, `Freeze` to the existing `from 'remotion'` import:
```ts
import { AbsoluteFill, Audio, OffthreadVideo, Freeze, Sequence, type CalculateMetadataFunction } from 'remotion';
```

- [ ] **Step 2: Add the segment layer constant + render segments**

Inside the file, add a module-level constant (above the component):
```ts
// Segments are full-frame and occlude primitives within their sub-range (Slice 3a A-lite).
// Composition-level overlays (captions, attribution) render after the scenes, so they stay
// on top regardless of this z-index.
const SEGMENT_LAYER = 10000;
```
Then, inside the per-scene `<Sequence>` (after the voiceover `{voiceUrl && <Audio src={voiceUrl} />}` line, before the `{scene.instances.map(...)}`), add:
```tsx
              {scene.segments?.map((seg) => {
                const url = assetUrl(seg.assetId);
                if (!url) return null; // durable (unsigned) spec ⇒ no playback, like voiceover
                return (
                  <Sequence
                    key={seg.shotId}
                    from={seg.from}
                    durationInFrames={seg.durationInFrames}
                    layout="none"
                  >
                    <div style={{ position: 'absolute', inset: 0, zIndex: SEGMENT_LAYER }}>
                      {/* Muted: VO-first; the per-scene <Audio> owns sound. */}
                      {seg.fit === 'trim' ? (
                        <OffthreadVideo src={url} trimAfter={seg.durationInFrames} muted />
                      ) : (
                        <>
                          <Sequence durationInFrames={seg.sourceDurationInFrames} layout="none">
                            <OffthreadVideo src={url} muted />
                          </Sequence>
                          <Sequence from={seg.sourceDurationInFrames} layout="none">
                            <Freeze frame={seg.sourceDurationInFrames - 1}>
                              <OffthreadVideo src={url} muted />
                            </Freeze>
                          </Sequence>
                        </>
                      )}
                    </div>
                  </Sequence>
                );
              })}
```
> Segments render BEFORE `instances.map` in DOM order but carry `zIndex: SEGMENT_LAYER` (above any `inst.layer`), so they occlude primitives in their sub-range while captions/attribution (composition-level, later) stay on top. If `<Freeze>`'s prop name differs in Remotion 4.0.472, check `node_modules/remotion` for the `Freeze` signature and adjust (`frame` is the held source frame); the trim path is the common case and must be correct regardless.

- [ ] **Step 3: Build to verify the bundle compiles**

Run: `npm run build`
Expected: PASS — the Remotion entry compiles with the new imports/JSX; full route set emitted.

- [ ] **Step 4: Run the remaining gates**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add remotion/ReelComposition.tsx
git commit -m "feat(v2): ReelComposition renders clip/footage segments (Slice 3a)"
```

---

### Task 6: Final gates + docs

**Files:**
- Modify: `CLAUDE.md` (Slice 3a entry under the Slice 3 program block)
- Modify: auto-memory `v2-higgsfield-program.md` + `MEMORY.md` pointer

- [ ] **Step 1: Full gate set**

Run: `npm test && npm run typecheck && npm run lint && npm run build`
Expected: all green. Record the test count + build route count for the docs.

- [ ] **Step 2: Update CLAUDE.md**

Add a Slice 3a sub-bullet under the Slice 3 block (mirror the 2a/2b entries' style): the spike findings (OffthreadVideo sequencing ✅; color = ffmpeg post-pass for 3b ✅), what shipped (ShotSegment spec + assembly cores + assembleSpec carry + loadBrief segment emission + ReelComposition rendering), the locked decisions (scene-driven, AI-bypass, trim/freeze, A-lite), what's deferred (color/LUT/match-grade = 3b, sub-range-confined primitives, generative-clip probing), and the green test/build counts. Note 3a needs no migration and legacy videos render byte-identically.

- [ ] **Step 3: Update auto-memory**

Append a Slice 3a section to `…/memory/v2-higgsfield-program.md` and update its `MEMORY.md` pointer line (Slice 3 status → 3a shipped, 3b next), per the memory rules.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: record V2 Slice 3a shipped (assembly skeleton)"
```

---

## Self-Review notes

- **Spec coverage:** §4 data model → Task 1; §5 timing core (`partitionSceneFrames`/`fitForSegment`) + the asset helpers → Task 2; §6 integration (`assembleSpec` carry) → Task 3; §6 `loadBrief` (emit segments, add assets, exclude hints, no needsStock for assembly shots) → Task 4; §7 renderer (trim/freeze/muted/layer) → Task 5; §8 gates + §9 docs → Tasks 2/3/4/5/6. Every spec section maps to a task.
- **Type consistency:** `ShotSegment { shotId, from, durationInFrames, assetId, fit, sourceDurationInFrames }`, `ShotTiming { shotId, from, durationInFrames }`, `partitionSceneFrames(sceneFrames, {shotId,durationSeconds}[])`, `fitForSegment(native, allotted)`, `segmentAssetId(shotId)→`seg-${id}``, `buildSegmentAssets({shotId,key}[])→AssetManifestEntry[]`, and `SceneBrief.segments`/`CompositionScene.segments` are used identically across Tasks 1–5.
- **No placeholders:** every code step shows full content. Tasks 4 and 5 have no unit test by design (server-only / Remotion), documented and matching the existing spine; their logic is pushed into the Task 2/3 tested cores.
- **`sourceDurationInFrames` source:** uniformly `max(round(duration_seconds*fps),1)` (the only native estimate available in 3a) — per spec §11; precise generative-clip probing is a deferred follow-up.
