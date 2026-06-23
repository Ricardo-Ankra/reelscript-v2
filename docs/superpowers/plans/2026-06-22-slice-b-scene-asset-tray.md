# Slice B — Scene Asset Tray + Operator Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator upload an image/video directly from the video editor and attach it to a shot — and see, per scene, which assets are attached — so a shot that stock can't satisfy (the Rivian R2 case) is fixed by attaching footage, without leaving the editor.

**Architecture:** Reuse the existing channel-resource upload (`createResource` → signed PUT → `confirmResource`) and the existing `setShotResource` binding. A new `SceneAssetUploader` client component encapsulates the upload dance and hands the resulting resource back; the editor adds it to its live resource list and pins it to the shot; `SceneCard` renders the uploader per shot and a small per-scene "attached assets" tray (derived by a pure helper).

**Tech Stack:** Next.js App Router (client components + existing server actions), Supabase (RLS), Cloudflare R2 (signed PUT), node:test.

## Global Constraints

- **Reuse, don't reinvent:** upload goes through `createResource(channelId, {filename, contentType})` → `fetch(uploadUrl, {method:'PUT', body:file, headers:{'Content-Type':file.type}})` → `confirmResource(resourceId)` (all in `src/app/(app)/channels/[id]/resource-actions.ts`); binding goes through `setShotResource(shotId, resourceId)` (`src/app/(app)/videos/[id]/shot-actions.ts`). No new server action, no new upload lib, **no schema change**.
- **Kind is `'image' | 'video'`**, derived client-side as `file.type === 'video/mp4' ? 'video' : 'image'` (the server re-derives authoritatively from the content type inside `createResource`).
- **Size cap** is `MAX_RESOURCE_BYTES` (`@/lib/resources/library`, 100 MB) — reject larger files client-side before upload, message exactly: `File must be under 100 MB.`
- **`ResourceOption`** (existing, `./SceneCard`) = `{ id: string; kind: string; description: string }` — the shape passed to shot pickers; a newly-uploaded asset becomes one of these.
- **The uploader renders for every shot regardless of how many resources exist** (it is how the first asset gets created); the existing pick-`<select>` stays gated on `resources.length > 0`.
- The editor's `resources` prop is the channel's resources at load; the editor holds a **live copy in state** so an upload appears immediately in every shot's picker.
- **Tests** run with `node --experimental-strip-types --import ./scripts/register-loader.mjs --test <file>`; test files import source with an explicit `.ts` extension; `import { test } from 'node:test'; import assert from 'node:assert/strict';`.
- **Server actions / client components are not unit-tested** (integration) — pure logic is in the tested helper; verification is `tsc` + `lint` + `build`.
- **Commit footer:** end every commit message with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- All Supabase reads/writes remain RLS-scoped to the session account (the reused actions already are).

## File Structure

**Create:**
- `src/lib/resources/scene-tray.ts` — pure `sceneAttachedResources` (derives a scene's attached assets for the tray).
- `src/lib/resources/scene-tray.test.ts` — its tests.
- `src/app/(app)/videos/[id]/SceneAssetUploader.tsx` — client upload affordance (create → PUT → confirm → callback).

**Modify:**
- `src/app/(app)/videos/[id]/Editor.tsx` — live resource list state + `onUploadAndAttach`; pass `channelId` + the handler + the live list to `SceneCard`.
- `src/app/(app)/videos/[id]/SceneCard.tsx` — accept `channelId` + `onUploadAndAttach`; render `<SceneAssetUploader>` per shot and the per-scene tray.

---

### Task 1: Pure `sceneAttachedResources` helper

**Files:**
- Create: `src/lib/resources/scene-tray.ts`
- Test: `src/lib/resources/scene-tray.test.ts`

**Interfaces:**
- Produces:
  - `interface ResourceLike { id: string; kind: string; description: string }`
  - `interface ShotLike { id: string; position: number; source: string; resource_id: string | null }`
  - `interface AttachedAsset { shotId: string; shotPosition: number; resource: ResourceLike }`
  - `sceneAttachedResources(shots: ShotLike[], resources: ResourceLike[]): AttachedAsset[]` — the resources attached to a scene's shots (`source === 'resource'` with a `resource_id` that resolves to a known resource), sorted by `shotPosition`. Shots that are stock, or whose `resource_id` is unknown, are omitted.

- [ ] **Step 1: Write the failing test**

Create `src/lib/resources/scene-tray.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sceneAttachedResources } from './scene-tray.ts';

const resources = [
  { id: 'r1', kind: 'image', description: 'Rivian R2 driving' },
  { id: 'r2', kind: 'video', description: 'charging at night' },
];

test('sceneAttachedResources: maps resource-pinned shots, sorted by position', () => {
  const shots = [
    { id: 's2', position: 2, source: 'resource', resource_id: 'r2' },
    { id: 's1', position: 1, source: 'resource', resource_id: 'r1' },
  ];
  const out = sceneAttachedResources(shots, resources);
  assert.equal(out.length, 2);
  assert.deepEqual(
    out.map((a) => [a.shotId, a.shotPosition, a.resource.id]),
    [['s1', 1, 'r1'], ['s2', 2, 'r2']],
  );
});

test('sceneAttachedResources: excludes stock shots and null resource_id', () => {
  const shots = [
    { id: 's1', position: 1, source: 'stock', resource_id: null },
    { id: 's2', position: 2, source: 'resource', resource_id: 'r1' },
  ];
  const out = sceneAttachedResources(shots, resources);
  assert.deepEqual(out.map((a) => a.shotId), ['s2']);
});

test('sceneAttachedResources: drops a pin whose resource is unknown', () => {
  const shots = [{ id: 's1', position: 1, source: 'resource', resource_id: 'gone' }];
  assert.deepEqual(sceneAttachedResources(shots, resources), []);
});

test('sceneAttachedResources: empty shots → empty', () => {
  assert.deepEqual(sceneAttachedResources([], resources), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/resources/scene-tray.test.ts`
Expected: FAIL — module `./scene-tray.ts` does not exist.

- [ ] **Step 3: Write the implementation**

Create `src/lib/resources/scene-tray.ts`:

```ts
// Pure derivation for the editor's per-scene asset tray: which resources are
// currently attached to a scene's shots. A shot contributes when it is pinned
// (source === 'resource') to a resource_id that resolves to a known resource;
// stock shots and dangling pins are omitted. Sorted by shot position.
export interface ResourceLike {
  id: string;
  kind: string;
  description: string;
}

export interface ShotLike {
  id: string;
  position: number;
  source: string;
  resource_id: string | null;
}

export interface AttachedAsset {
  shotId: string;
  shotPosition: number;
  resource: ResourceLike;
}

export function sceneAttachedResources(
  shots: ShotLike[],
  resources: ResourceLike[],
): AttachedAsset[] {
  const byId = new Map(resources.map((r) => [r.id, r]));
  return shots
    .filter((s) => s.source === 'resource' && s.resource_id != null)
    .map((s): AttachedAsset | null => {
      const resource = byId.get(s.resource_id as string);
      return resource ? { shotId: s.id, shotPosition: s.position, resource } : null;
    })
    .filter((a): a is AttachedAsset => a !== null)
    .sort((a, b) => a.shotPosition - b.shotPosition);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/resources/scene-tray.test.ts`
Expected: PASS (all 4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/resources/scene-tray.ts src/lib/resources/scene-tray.test.ts
git commit -m "feat(resources): sceneAttachedResources — derive a scene's attached assets

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `SceneAssetUploader` component

**Files:**
- Create: `src/app/(app)/videos/[id]/SceneAssetUploader.tsx`

**Interfaces:**
- Consumes: `MAX_RESOURCE_BYTES` (`@/lib/resources/library`); `createResource`, `confirmResource` (`@/app/(app)/channels/[id]/resource-actions`); `ResourceOption` type (`./SceneCard`).
- Produces: `SceneAssetUploader({ channelId, onUploaded, disabled }: { channelId: string; onUploaded: (resource: ResourceOption) => void; disabled?: boolean })`.

No unit test (client + network). Verify `tsc` + `lint`.

- [ ] **Step 1: Write the component**

Create `src/app/(app)/videos/[id]/SceneAssetUploader.tsx`:

```tsx
'use client';

import { useRef, useState } from 'react';
import { MAX_RESOURCE_BYTES } from '@/lib/resources/library';
import { createResource, confirmResource } from '@/app/(app)/channels/[id]/resource-actions';
import type { ResourceOption } from './SceneCard';

// Upload an image/video straight from the editor and hand the resulting channel
// resource back to the caller (which pins it to a shot). Reuses the channel-resource
// signed-PUT flow: createResource → PUT bytes → confirmResource. Bytes go client→R2
// directly; the frontend never proxies the file.
export function SceneAssetUploader({
  channelId,
  onUploaded,
  disabled,
}: {
  channelId: string;
  onUploaded: (resource: ResourceOption) => void;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onPick(file: File | undefined) {
    if (!file) return;
    setError(null);
    if (file.size > MAX_RESOURCE_BYTES) {
      setError('File must be under 100 MB.');
      return;
    }
    setBusy(true);
    try {
      const created = await createResource(channelId, { filename: file.name, contentType: file.type });
      if (!created.ok) {
        setError(created.reason);
        return;
      }
      const put = await fetch(created.uploadUrl, {
        method: 'PUT',
        body: file,
        headers: { 'Content-Type': file.type },
      });
      if (!put.ok) {
        setError(`Upload failed (${put.status}).`);
        return;
      }
      const confirmed = await confirmResource(created.resourceId);
      const kind = file.type === 'video/mp4' ? 'video' : 'image';
      onUploaded({
        id: created.resourceId,
        kind,
        description: confirmed.ok ? confirmed.description : file.name,
      });
      if (!confirmed.ok) setError(confirmed.reason);
    } catch {
      setError('Upload failed. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-1">
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,video/mp4"
        className="hidden"
        onChange={(e) => {
          void onPick(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      <button
        type="button"
        disabled={disabled || busy}
        onClick={() => inputRef.current?.click()}
        className="shrink-0 rounded border border-black/10 px-1 py-px text-[10px] enabled:hover:bg-black/[0.04] disabled:opacity-40 dark:border-white/10 dark:enabled:hover:bg-white/[0.06]"
        title="Upload an image/video and attach it to this shot"
      >
        {busy ? 'Uploading…' : 'Upload'}
      </button>
      {error && <span className="text-[10px] text-red-600">{error}</span>}
    </span>
  );
}
```

- [ ] **Step 2: Typecheck + lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(app)/videos/[id]/SceneAssetUploader.tsx"
git commit -m "feat(videos): SceneAssetUploader — upload an asset from the editor

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Wire upload-and-attach into the editor

**Files:**
- Modify: `src/app/(app)/videos/[id]/Editor.tsx`
- Modify: `src/app/(app)/videos/[id]/SceneCard.tsx`

**Interfaces:**
- Consumes: `SceneAssetUploader` (Task 2); `ResourceOption` (`./SceneCard`); existing `onSetShotResource` (Editor), `setShotResource` (already imported).
- Produces: `onUploadAndAttach(shotId: string, resource: ResourceOption): Promise<void>` (Editor) and the per-shot upload affordance (SceneCard); `SceneCard` gains props `channelId: string` and `onUploadAndAttach: (shotId: string, resource: ResourceOption) => void`.

No unit test (client). Verify `tsc` + `lint`.

- [ ] **Step 1: Editor — hold a live resource list in state**

In `src/app/(app)/videos/[id]/Editor.tsx`, the component destructures a `resources` prop (the channel's resources at load) and passes it to each `SceneCard`. Add a state copy so uploads appear immediately. Right after the existing recovery-state hooks (near the other `useState` calls — e.g. just after `const [recoveryError, setRecoveryError] = useState<string | null>(null);`), add:

```ts
  // Live copy of the channel's resources so an in-editor upload appears in every
  // shot picker immediately (the prop is the load-time snapshot).
  const [liveResources, setLiveResources] = useState<ResourceOption[]>(resources);
```

(`useState` and `ResourceOption` are already imported in this file.)

- [ ] **Step 2: Editor — add the `onUploadAndAttach` handler**

Immediately after the existing `onSetShotResource` `useCallback` (it ends around line 326), add:

```ts
  // Upload-and-attach: add the freshly-uploaded resource to the live list (so every
  // picker sees it) and pin it to the shot via the existing setShotResource path.
  const onUploadAndAttach = useCallback(
    async (shotId: string, resource: ResourceOption) => {
      setLiveResources((xs) => (xs.some((r) => r.id === resource.id) ? xs : [resource, ...xs]));
      await onSetShotResource(shotId, resource.id);
    },
    [onSetShotResource],
  );
```

- [ ] **Step 3: Editor — pass the live list + channelId + handler to `SceneCard`**

Find the `<SceneCard ... />` usage (around lines 496–512). Change the `resources` prop to the live list and add two props:

```tsx
              resources={liveResources}
              channelId={channelId}
              onSetShotResource={onSetShotResource}
              onUploadAndAttach={onUploadAndAttach}
```

(Replace the existing `resources={resources}` line with `resources={liveResources}`; keep `onSetShotResource={onSetShotResource}`; add `channelId` and `onUploadAndAttach`. `channelId` is already an Editor prop.)

- [ ] **Step 4: SceneCard — import the uploader and accept the new props**

In `src/app/(app)/videos/[id]/SceneCard.tsx`, add the import at the top (after the React import):

```ts
import { SceneAssetUploader } from './SceneAssetUploader';
```

Add the two props to the destructuring (alongside `resources`, `onSetShotResource`):

```ts
  channelId,
  onUploadAndAttach,
```

and to the prop type object (alongside the existing `resources` / `onSetShotResource` entries):

```ts
  channelId: string;
  onUploadAndAttach: (shotId: string, resource: ResourceOption) => void;
```

- [ ] **Step 5: SceneCard — render the uploader on every shot row**

In the shot `<li>` (currently lines 98–120), the row renders the description then either the pick-`<select>` (when `resources.length > 0`) or a read-only badge. Add the uploader as the last child of the `<li>`, after that conditional, so it is always present:

Replace:

```tsx
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
```

with:

```tsx
              <li key={shot.id} className="flex items-start gap-2 text-xs opacity-60">
                <span className="opacity-70">▸</span>
                <span className="flex-1">{shot.description}</span>
                {resources.length > 0 && (
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
                )}
                <SceneAssetUploader
                  channelId={channelId}
                  onUploaded={(resource) => onUploadAndAttach(shot.id, resource)}
                />
              </li>
```

(The read-only `{shot.source}` badge is removed because the uploader is now always available — when there are no resources yet, upload is the action that creates the first one; the shot's source is still visible via the tray in Task 4 once attached.)

- [ ] **Step 6: Typecheck + lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add "src/app/(app)/videos/[id]/Editor.tsx" "src/app/(app)/videos/[id]/SceneCard.tsx"
git commit -m "feat(videos): upload an asset from a shot and pin it (upload-and-attach)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Per-scene asset tray (and full gate)

**Files:**
- Modify: `src/app/(app)/videos/[id]/SceneCard.tsx`

**Interfaces:**
- Consumes: `sceneAttachedResources` (`@/lib/resources/scene-tray`, Task 1); the `shots` + `resources` already in `SceneCard` scope.

No unit test (client; the derivation is tested in Task 1). This task runs the FULL gate.

- [ ] **Step 1: Import the helper**

In `src/app/(app)/videos/[id]/SceneCard.tsx`, add:

```ts
import { sceneAttachedResources } from '@/lib/resources/scene-tray';
```

- [ ] **Step 2: Compute the attached assets**

Inside the `SceneCard` component body, after `const dot = audioDot(audioStatus, synthesizing);`, add:

```ts
  const attached = sceneAttachedResources(shots, resources);
```

- [ ] **Step 3: Render the tray above the shots list**

The shots `<ul>` is rendered by `{shots.length > 0 && ( <ul ...> )}`. Immediately BEFORE that block, add the tray (renders only when something is attached):

```tsx
      {attached.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1 border-t border-black/5 pt-2 text-[10px] dark:border-white/5">
          <span className="opacity-50">Attached:</span>
          {attached.map((a) => (
            <span
              key={a.shotId}
              className="rounded-full border border-black/10 px-1.5 py-px opacity-70 dark:border-white/10"
              title={`Shot ${a.shotPosition}: ${a.resource.description || '(untitled)'}`}
            >
              {(a.resource.description || '(untitled)').slice(0, 24)} ({a.resource.kind}) · shot {a.shotPosition}
            </span>
          ))}
        </div>
      )}
```

- [ ] **Step 4: Typecheck, lint, build**

Run: `npx tsc --noEmit && npm run lint && npm run build`
Expected: all succeed.

- [ ] **Step 5: Run the full unit suite**

Run: `npm test`
Expected: PASS (including `src/lib/resources/scene-tray.test.ts`).

- [ ] **Step 6: Commit**

```bash
git add "src/app/(app)/videos/[id]/SceneCard.tsx"
git commit -m "feat(videos): per-scene attached-asset tray

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage (slice B section of the design):**
- "Per-scene asset tray: shows assets attached to the scene's shots" → Task 1 (pure derivation) + Task 4 (render). ✓
- "An 'upload right here' affordance" → Task 2 (`SceneAssetUploader`) + Task 3 (per-shot placement). ✓
- "Reuses the existing signed-PUT + channel_resources machinery (createResource/confirmResource)" → Task 2 (exact reuse). ✓
- "Bound to the shot via the existing setShotResource (source='resource')" → Task 3 (`onUploadAndAttach` → `onSetShotResource` → `setShotResource`). ✓
- "Minimal/no schema change (reuses channel_resources + shots.resource_id); the tray is a UI grouping" → honored (no migration; tray is derived). ✓
- "Fixes the Rivian case: attach the footage; the resolver prefers it and the readiness gate clears" → the attach path lands here; the resolver-preference + readiness gate are slice C (correctly out of scope). ✓

**2. Placeholder scan:** No TBD/TODO/"handle errors"/"similar to". Every code step shows complete code; the SceneCard shot-row change shows the full before/after; the exact size-cap message and accept list are spelled out. ✓

**3. Type consistency:** `ResourceOption` (`{id, kind, description}`, existing in `./SceneCard`) is the type produced by `SceneAssetUploader.onUploaded` (Task 2), consumed by `onUploadAndAttach(shotId, resource)` (Task 3, Editor + SceneCard prop), and added to `liveResources: ResourceOption[]` (Task 3). `sceneAttachedResources(shots, resources)` (Task 1) is called in SceneCard (Task 4) with `shots: Shot[]` and `resources: ResourceOption[]` — both structurally satisfy `ShotLike` (`{id, position, source, resource_id}`) and `ResourceLike` (`{id, kind, description}`). `onSetShotResource(shotId, resourceId: string | null)` is reused unchanged by `onUploadAndAttach`. `channelId: string` (Editor prop) flows to `SceneCard` (Task 3) to `SceneAssetUploader` (Task 2). ✓
