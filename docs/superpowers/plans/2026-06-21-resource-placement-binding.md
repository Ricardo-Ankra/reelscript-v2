# Resource placement + compose binding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the operator pin a channel resource to a shot in the video editor, and have the composition AI (agentic + procedural) place that exact resource as the scene's primary visual.

**Architecture:** Placement is a pure validator + a direct-RLS `setShotResource` action + a per-shot picker in the editor. Binding adds `SceneBrief.pinnedResources`, rendered by `buildCompositionUserPrompt` (which both compose paths share) as a strong directive; `render.ts` `loadBrief` populates the pins from the shots. No migration — the columns + FK already exist.

**Tech Stack:** TypeScript, Next.js App Router (RSC + `'use server'` action + a client editor), Supabase (RLS), Inngest (render worker), `node:test`.

## Global Constraints

- No schema change/migration — `shots.source`/`shots.resource_id` + `videos.channel_id` already exist. Placement is a direct RLS write scoped by `account_id`, confirmed via `.select('id')` (no row → "Shot not found.", no phantom save).
- The pure cores (`src/lib/resources/shot-placement.ts`, the `compose.ts` prompt builder) stay pure (no react/server-only/network/supabase imports).
- `validateShotResource({ resourceId })`: a non-empty string → `{ source: 'resource', resourceId }`; null/`''` → `{ source: 'stock', resourceId: null }`.
- Strong pin: the prompt directive instructs the AI to place each pinned resource as the scene's primary visual (Image/Video at layer 0, fit "cover") and NOT search stock for that scene. Both agentic + procedural honor it because both use `buildCompositionUserPrompt`.
- The resource manifest assetId is `resourceAssetId(resourceId)` = `resource-<id>` (from `@/lib/assets/resolve`). `AssetManifestEntry` is unchanged (`{ id, kind, r2Key }`); the description rides only in the prompt via `SceneBrief.pinnedResources`.
- Back-compat: a video with no resource-pinned shots produces a byte-identical brief + prompt (no `pinnedResources` → no directive).
- Test command (single file): `node --experimental-strip-types --import ./scripts/register-loader.mjs --test <path>`. Full suite: `npm test`. Test imports use explicit `.ts` extensions.
- Commit footer on every commit: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Stage only the files each task names — there is unrelated `package-lock.json` drift; never `git add -A`.

---

## File Structure

- `src/lib/resources/shot-placement.ts` (create) — pure `validateShotResource`.
- `src/lib/resources/shot-placement.test.ts` (create) — node:test.
- `src/app/(app)/videos/[id]/shot-actions.ts` (create) — `setShotResource` server action.
- `src/lib/composition/compose.ts` (modify) — `SceneBrief.pinnedResources` + prompt directive + a system-prompt rule line.
- `src/lib/composition/compose.test.ts` (modify) — pinned-directive test.
- `src/lib/inngest/functions/render.ts` (modify) — `loadBrief` populates per-scene `pinnedResources`.
- `src/app/(app)/videos/[id]/SceneCard.tsx` (modify) — `Shot.resource_id` + per-shot picker.
- `src/app/(app)/videos/[id]/Editor.tsx` (modify) — `resources` prop + `onSetShotResource` handler + thread to SceneCard + add `resource_id` to its shot selects.
- `src/app/(app)/videos/[id]/page.tsx` (modify) — read channel resources + `resource_id`; pass to Editor.

---

## Task 1: Pure shot-placement validator

**Files:**
- Create: `src/lib/resources/shot-placement.ts`
- Test: `src/lib/resources/shot-placement.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export function validateShotResource(input: { resourceId: string | null }): { source: 'resource'; resourceId: string } | { source: 'stock'; resourceId: null }`

- [ ] **Step 1: Write the failing test**

Create `src/lib/resources/shot-placement.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateShotResource } from './shot-placement.ts';

test('validateShotResource: a non-empty id pins to resource', () => {
  assert.deepEqual(validateShotResource({ resourceId: 'abc-123' }), {
    source: 'resource',
    resourceId: 'abc-123',
  });
});

test('validateShotResource: null or empty clears to stock', () => {
  assert.deepEqual(validateShotResource({ resourceId: null }), { source: 'stock', resourceId: null });
  assert.deepEqual(validateShotResource({ resourceId: '' }), { source: 'stock', resourceId: null });
  assert.deepEqual(validateShotResource({ resourceId: '   ' }), { source: 'stock', resourceId: null });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/resources/shot-placement.test.ts`
Expected: FAIL — module/export does not exist.

- [ ] **Step 3: Implement**

Create `src/lib/resources/shot-placement.ts`:

```ts
// Pure normalization of a shot's resource pick (Phase 8 slice 2). A non-empty id pins
// the shot to a channel resource (source='resource'); null/empty clears it back to
// stock. No imports — the server action + UI both rely on this single rule.

export function validateShotResource(
  input: { resourceId: string | null },
): { source: 'resource'; resourceId: string } | { source: 'stock'; resourceId: null } {
  const id = typeof input.resourceId === 'string' ? input.resourceId.trim() : '';
  if (id === '') return { source: 'stock', resourceId: null };
  return { source: 'resource', resourceId: id };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/resources/shot-placement.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/resources/shot-placement.ts src/lib/resources/shot-placement.test.ts
git commit -m "feat(resources): pure shot-resource placement validator

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: `setShotResource` server action

**Files:**
- Create: `src/app/(app)/videos/[id]/shot-actions.ts`

**Interfaces:**
- Consumes (Task 1): `validateShotResource` from `@/lib/resources/shot-placement`. Existing: `createClient` from `@/lib/supabase/server`.
- Produces: `setShotResource(shotId: string, resourceId: string | null): Promise<{ ok: true; source: 'resource' | 'stock' } | { ok: false; reason: string }>`

- [ ] **Step 1: Write the action**

Create `src/app/(app)/videos/[id]/shot-actions.ts`:

```ts
'use server';

import { createClient } from '@/lib/supabase/server';
import { validateShotResource } from '@/lib/resources/shot-placement';

// Pin a shot to a channel resource (source='resource' + resource_id) or clear it back
// to stock. Direct RLS write scoped by account_id, confirmed via .select('id') (no row
// → "Shot not found.", no phantom save). The editor's picker only offers the video's
// channel resources; RLS guarantees the shot is the caller's.
export async function setShotResource(
  shotId: string,
  resourceId: string | null,
): Promise<{ ok: true; source: 'resource' | 'stock' } | { ok: false; reason: string }> {
  const norm = validateShotResource({ resourceId });

  const supabase = await createClient();
  const { data: account } = await supabase.from('accounts').select('id').maybeSingle();
  if (!account) return { ok: false, reason: 'No account found.' };

  const { data, error } = await supabase
    .from('shots')
    .update({ source: norm.source, resource_id: norm.resourceId })
    .eq('id', shotId)
    .eq('account_id', account.id as string)
    .select('id');
  if (error) return { ok: false, reason: error.message };
  if (!data || data.length === 0) return { ok: false, reason: 'Shot not found.' };
  return { ok: true, source: norm.source };
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/videos/[id]/shot-actions.ts"
git commit -m "feat(resources): setShotResource action (pin/clear a shot)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Compose binding — `SceneBrief.pinnedResources` + prompt directive

**Files:**
- Modify: `src/lib/composition/compose.ts`
- Test: `src/lib/composition/compose.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `SceneBrief` gains `pinnedResources?: { assetId: string; kind: 'image' | 'video'; description: string }[]`; `buildCompositionUserPrompt` emits a PINNED directive per scene that has pins; `buildCompositionSystemPrompt` gains a pin-precedence rule line.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/composition/compose.test.ts` (the module-level `theme` and `brief` fixtures already exist):

```ts
test('user prompt emits a PINNED directive for scenes with pinnedResources, omits it otherwise', () => {
  const pinnedBrief: CompositionBrief = {
    ...brief,
    assets: [...brief.assets, { id: 'resource-abc', kind: 'image', r2Key: 'resources/x.jpg' }],
    scenes: [
      {
        ...brief.scenes[0],
        pinnedResources: [{ assetId: 'resource-abc', kind: 'image', description: 'brand logo on white' }],
      },
      brief.scenes[1],
    ],
  };
  const u = buildCompositionUserPrompt(pinnedBrief);
  assert.ok(u.includes('PINNED'));
  assert.ok(u.includes('resource-abc'));
  assert.ok(u.includes('brand logo on white'));
  assert.equal(u.match(/PINNED/g)?.length, 1); // only scene-1 has a pin
  assert.ok(!buildCompositionUserPrompt(brief).includes('PINNED')); // no pins → no directive
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/composition/compose.test.ts`
Expected: FAIL — `buildCompositionUserPrompt` does not emit "PINNED" (and `pinnedResources` is not yet on the type).

- [ ] **Step 3: Add `pinnedResources` to `SceneBrief`**

In `src/lib/composition/compose.ts`, extend the `SceneBrief` interface (currently ends with `voiceoverAssetId?: string;`):

```ts
export interface SceneBrief {
  id: string;
  position: number;
  narration: string;
  shotHints: string[]; // the shots' descriptions/intents from the script
  durationInFrames: number; // system-fixed, from the synthesized audio
  voiceoverAssetId?: string; // manifest id for this scene's audio
  // Channel resources pinned to this scene's shots (source='resource'). The AI MUST
  // place these as the scene's primary visual (see buildCompositionUserPrompt).
  pinnedResources?: { assetId: string; kind: 'image' | 'video'; description: string }[];
}
```

- [ ] **Step 4: Emit the directive in `buildCompositionUserPrompt`**

Replace the `const scenes = brief.scenes.map(...)` block in `buildCompositionUserPrompt` with:

```ts
  const scenes = brief.scenes
    .map((s) => {
      const hints = s.shotHints.length ? s.shotHints.map((h) => `    - ${h}`).join('\n') : '    (none)';
      const lines = [
        `Scene ${s.position} (sceneId "${s.id}", durationInFrames ${s.durationInFrames}):`,
        `  narration: ${JSON.stringify(s.narration)}`,
        `  shot intents:`,
        hints,
      ];
      if (s.pinnedResources && s.pinnedResources.length > 0) {
        lines.push(
          '  PINNED resources (you MUST place these as this scene\'s primary visual — an',
          '  Image/Video at layer 0, fit "cover"; do NOT search stock for this scene\'s background):',
          ...s.pinnedResources.map((r) => `    - ${r.assetId} (${r.kind}): ${r.description}`),
        );
      }
      return lines.join('\n');
    })
    .join('\n\n');
```

- [ ] **Step 5: Add the pin-precedence rule to the system prompt**

In `buildCompositionSystemPrompt`, in the `Rules:` array, add a line immediately after `backgroundRule`:

```ts
    backgroundRule,
    '- If a scene lists PINNED resources, you MUST use them as its primary visual (Image/Video',
    '  at layer 0) and not search stock for that scene — a pin is an explicit operator choice.',
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/composition/compose.test.ts`
Expected: PASS — including the existing prompt assertions (still green).

- [ ] **Step 7: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/lib/composition/compose.ts src/lib/composition/compose.test.ts
git commit -m "feat(compose): pinned-resource directive in the composition prompt

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: `loadBrief` populates per-scene `pinnedResources`

**Files:**
- Modify: `src/lib/inngest/functions/render.ts`

**Interfaces:**
- Consumes (Task 3): `SceneBrief.pinnedResources`. Existing: `resourceAssetId` from `@/lib/assets/resolve`.
- Produces: each `SceneBrief` in the loaded brief carries `pinnedResources` for its `source='resource'` shots.

- [ ] **Step 1: Import `resourceAssetId`**

In `src/lib/inngest/functions/render.ts`, the existing import is:

```ts
import { resolveStockAssets, resolveResourceAssets } from '@/lib/assets/resolve';
```

Change it to:

```ts
import { resolveStockAssets, resolveResourceAssets, resourceAssetId } from '@/lib/assets/resolve';
```

- [ ] **Step 2: Collect pinned resource ids per scene**

In `loadBrief`, the shot-loading block currently declares `const resourceIdSet = new Set<string>();` and a `for (const sh of shotRows ?? [])` loop. Add a per-scene map next to `resourceIdSet`:

```ts
  const shotsByScene = new Map<string, string[]>();
  let needsStock = false;
  const resourceIdSet = new Set<string>();
  const pinnedByScene = new Map<string, string[]>();
```

And in the loop, extend the `resource` branch to also record the per-scene pin:

```ts
      if (sh.source === 'resource' && sh.resource_id) {
        resourceIdSet.add(sh.resource_id as string);
        const pins = pinnedByScene.get(sh.scene_id as string) ?? [];
        pins.push(sh.resource_id as string);
        pinnedByScene.set(sh.scene_id as string, pins);
      } else {
        needsStock = true; // 'stock' (the default) — this shot wants real footage
      }
```

- [ ] **Step 3: Fetch resource metadata for the pinned ids**

Immediately AFTER the shot-loading `if (ids.length) { ... }` block and BEFORE `const assets: AssetManifestEntry[] = [];`, add:

```ts
  // Resource kind + description for the pinned shots, so the compose prompt can name
  // and describe each pin. One batched read; missing ids (e.g. a deleted resource
  // whose FK cleared) simply don't appear and are skipped below.
  const resourceMeta = new Map<string, { kind: 'image' | 'video'; description: string }>();
  if (resourceIdSet.size) {
    const { data: resRows } = await admin
      .from('channel_resources')
      .select('id, kind, description')
      .in('id', [...resourceIdSet]);
    for (const r of resRows ?? []) {
      resourceMeta.set(r.id as string, {
        kind: (r.kind as string) === 'video' ? 'video' : 'image',
        description: (r.description as string | null) ?? '',
      });
    }
  }
```

- [ ] **Step 4: Attach `pinnedResources` to each scene brief**

In the `const briefScenes: SceneBrief[] = scenes.map((s) => { ... })` block, compute the pins and include them in the returned object. Add, inside the map callback before the `return {`:

```ts
    const pinnedResources = (pinnedByScene.get(s.id as string) ?? [])
      .map((rid) => {
        const meta = resourceMeta.get(rid);
        return meta ? { assetId: resourceAssetId(rid), kind: meta.kind, description: meta.description } : null;
      })
      .filter((p): p is { assetId: string; kind: 'image' | 'video'; description: string } => p !== null);
```

And extend the returned object (currently ends with `voiceoverAssetId,`):

```ts
    return {
      id: s.id as string,
      position,
      narration,
      shotHints: shotsByScene.get(s.id as string) ?? [],
      durationInFrames,
      voiceoverAssetId,
      pinnedResources: pinnedResources.length ? pinnedResources : undefined,
    };
```

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Run the compose tests (the consumer of the shape)**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/composition/compose.test.ts`
Expected: PASS (the brief shape `loadBrief` now produces matches `SceneBrief`).

- [ ] **Step 7: Lint**

Run: `npm run lint`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add src/lib/inngest/functions/render.ts
git commit -m "feat(render): loadBrief populates per-scene pinned resources

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Per-shot resource picker in the editor

**Files:**
- Modify: `src/app/(app)/videos/[id]/SceneCard.tsx`
- Modify: `src/app/(app)/videos/[id]/Editor.tsx`
- Modify: `src/app/(app)/videos/[id]/page.tsx`

**Interfaces:**
- Consumes (Task 2): `setShotResource` from `./shot-actions`.
- Produces: `Shot` gains `resource_id: string | null`; `SceneCard`/`Editor` gain a `resources` list + an `onSetShotResource` handler; the page reads the channel's resources and passes them down. Type `ResourceOption = { id: string; kind: string; description: string }`.

- [ ] **Step 1: Extend `Shot` + add the picker in `SceneCard.tsx`**

In `src/app/(app)/videos/[id]/SceneCard.tsx`, extend the `Shot` type:

```ts
export type Shot = {
  id: string;
  position: number;
  description: string;
  source: string;
  stock_query: string | null;
  resource_id: string | null;
};

export type ResourceOption = { id: string; kind: string; description: string };
```

Add two props to the `SceneCard` function signature (alongside the existing ones) — add to the destructured params and the prop types:

```ts
  resources,
  onSetShotResource,
```

and in the type block:

```ts
  resources: ResourceOption[];
  onSetShotResource: (shotId: string, resourceId: string | null) => void;
```

Replace the shots `<li>` block (the one rendering description + the `source` badge) with one that adds the picker:

```tsx
            .map((shot) => (
              <li key={shot.id} className="flex items-start gap-2 text-xs opacity-60">
                <span className="opacity-70">▸</span>
                <span className="flex-1">{shot.description}</span>
                {resources.length > 0 ? (
                  <select
                    value={shot.resource_id ?? ''}
                    onChange={(e) => onSetShotResource(shot.id, e.target.value || null)}
                    className="max-w-[10rem] truncate rounded border border-black/10 bg-transparent px-1 py-px text-[10px] dark:border-white/10"
                    title="Pin a channel resource (or use stock)"
                  >
                    <option value="">Use stock</option>
                    {resources.map((r) => (
                      <option key={r.id} value={r.id}>
                        {(r.description || '(untitled)').slice(0, 40)} ({r.kind})
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="rounded-full border border-black/10 px-1.5 py-px text-[10px] dark:border-white/10">
                    {shot.source}
                  </span>
                )}
              </li>
            ))}
```

- [ ] **Step 2: Thread the picker through `Editor.tsx`**

In `src/app/(app)/videos/[id]/Editor.tsx`:

Add the imports (extend the existing `SceneCard` import and add the action):

```ts
import { SceneCard, type Shot, type ResourceOption } from './SceneCard';
import { setShotResource } from './shot-actions';
```

Add `resources` to the `Editor` props (destructure + type):

```ts
  resources,
```

and in the props type block (after `initialPrompt: string;`):

```ts
  resources: ResourceOption[];
```

Add the `resource_id` column to the two shot selects so the pin survives Realtime reconcile. In `fetchShots`:

```ts
        .select('id, position, description, source, stock_query, resource_id')
```

In `reconcile`:

```ts
        .select('id, scene_id, position, description, source, stock_query, resource_id')
```

Add the handler (near the other `useCallback`s, e.g. after `getAudioUrl`):

```ts
  const onSetShotResource = useCallback(
    async (shotId: string, resourceId: string | null) => {
      const res = await setShotResource(shotId, resourceId);
      if (!res.ok) return;
      setScenes((prev) =>
        prev.map((s) => ({
          ...s,
          shots: s.shots.map((sh) =>
            sh.id === shotId ? { ...sh, source: res.source, resource_id: resourceId } : sh,
          ),
        })),
      );
    },
    [],
  );
```

Pass the two new props to `<SceneCard>` (in the `ordered.map`):

```tsx
              getAudioUrl={() => getAudioUrl(scene.id)}
              resources={resources}
              onSetShotResource={onSetShotResource}
```

- [ ] **Step 3: Read channel resources + `resource_id` in `page.tsx`**

In `src/app/(app)/videos/[id]/page.tsx`:

Add `channel_id` to the video select (currently `select('id, title, settings, prompt')`):

```ts
    .select('id, title, settings, prompt, channel_id')
```

Add `resource_id` to the shots select (currently `select('id, scene_id, position, description, source, stock_query')`):

```ts
      .select('id, scene_id, position, description, source, stock_query, resource_id')
```

Add `resource_id` to the `Shot` mapping (the `byScene` push). The current push is:

```ts
      list.push({
        id: row.id as string,
        position: row.position as number,
        description: row.description as string,
        source: row.source as string,
        stock_query: (row.stock_query as string | null) ?? null,
      });
```

Change it to:

```ts
      list.push({
        id: row.id as string,
        position: row.position as number,
        description: row.description as string,
        source: row.source as string,
        stock_query: (row.stock_query as string | null) ?? null,
        resource_id: (row.resource_id as string | null) ?? null,
      });
```

After the `job` query block and before the `return (`, read the channel's resources:

```ts
  const { data: resourceRows } = await supabase
    .from('channel_resources')
    .select('id, kind, description')
    .eq('channel_id', video.channel_id as string)
    .order('created_at', { ascending: false });
  const resources = (resourceRows ?? []).map((r) => ({
    id: r.id as string,
    kind: r.kind as string,
    description: (r.description as string | null) ?? '',
  }));
```

Pass it to `<Editor>` (add the prop to the existing element):

```tsx
      initialPrompt={(video.prompt as string | null) ?? ''}
      resources={resources}
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Lint**

Run: `npm run lint`
Expected: clean.

- [ ] **Step 6: Build (client/server boundary check)**

Run: `npm run build`
Expected: build succeeds — the video editor compiles with the new picker; `setShotResource` is a server action imported into the client editor (a reference, not a server-only runtime import).

- [ ] **Step 7: Commit**

```bash
git add "src/app/(app)/videos/[id]/SceneCard.tsx" "src/app/(app)/videos/[id]/Editor.tsx" "src/app/(app)/videos/[id]/page.tsx"
git commit -m "feat(resources): per-shot resource picker in the video editor

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final verification (whole branch)

- [ ] `npm test` — full suite green.
- [ ] `npx tsc --noEmit` — clean.
- [ ] `npm run lint` — clean.
- [ ] `npm run build` — succeeds.
- [ ] **Manual / app-run e2e (operator):** open a video whose channel has resources → each shot shows a resource picker → pin a resource to a shot → its badge/selection persists on reload → Generate Video with stock keys ON (agentic) → the pinned asset is the scene's visual → with stock keys OFF (procedural) → the pinned asset still appears → set the picker back to "Use stock" → the scene returns to stock/procedural. (A channel with no resources shows the old read-only `source` badge.)

## Post-merge bookkeeping (controller, after merge)

- Update `CLAUDE.md` Phase-5 deferral note: resource **placement + compose binding** shipped (per-shot picker → `source='resource'`; strong-pin directive honored by agentic + procedural) — the channel-resource feature is now fully unlocked.
- Update memory ([[channel-resource-library]] "slice 2 pending" + [[phase-5-asset-richness-gotchas]] "placement dormant"): placement + binding shipped.
