# Channel resource library UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A resource library section on the channel page — list, upload (signed PUT + vision auto-tag), edit description/tags, and delete a channel's image/video resources.

**Architecture:** `channel_resources` is a first-class RLS table, so writes are direct RLS operations in `'use server'` actions (no RPC, no migration). A pure validation/sanitization core (`src/lib/resources/library.ts`) backs the actions; a client `ResourcesEditor` mirrors the existing `LogosEditor` upload pattern and reuses the deployed `createResourceUpload`/`confirmResourceUpload` server functions.

**Tech Stack:** TypeScript, Next.js App Router (RSC + `'use server'` actions + a client component), Supabase (RLS), Cloudflare R2 (signed PUT/GET, deleteObject), Anthropic vision (via the existing `confirmResourceUpload`), `node:test`.

## Global Constraints

- No schema change, migration, or RPC — `channel_resources` + RLS already exist; edit/delete are direct RLS writes scoped by `account_id`, using `.select('id')` to detect a no-op (`data == null`/empty → "Resource not found.", no phantom save).
- The pure core `src/lib/resources/library.ts` is pure (no react/server-only/network/supabase imports).
- The upload **kind is derived server-side** from the content type (`validateResourceUpload`), never trusted from the client.
- Allowed content types only: `image/jpeg`, `image/png`, `image/webp`, `video/mp4`. `MAX_RESOURCE_BYTES = 100 * 1024 * 1024`.
- Reuse `createResourceUpload(client, accountId, channelId, { filename, contentType, kind })` and `confirmResourceUpload(client, accountId, resourceId)` from `@/lib/resources/upload` UNCHANGED.
- Server actions resolve the account from the session (`accounts.id` via the RLS `createClient` from `@/lib/supabase/server`), mirroring `logo-actions.ts`.
- The client editor mirrors `LogosEditor`: object-URL previews with `URL.revokeObjectURL`, per-item busy flags, Save in try/catch/finally, dirty-gated.
- Out of scope: shot placement / compose binding (slice 2); url/audio/document kinds; a `resource_tagging` cost_event.
- Test command (single file): `node --experimental-strip-types --import ./scripts/register-loader.mjs --test <path>`. Full suite: `npm test`. Test imports use explicit `.ts` extensions.
- Commit footer on every commit: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Stage only the files each task names — there is unrelated `package-lock.json` drift in the tree; never `git add -A`.

---

## File Structure

- `src/lib/resources/library.ts` (create) — pure validation/sanitization core.
- `src/lib/resources/library.test.ts` (create) — node:test.
- `src/app/(app)/channels/[id]/resource-actions.ts` (create) — `'use server'` actions (create/confirm/update/delete).
- `src/app/(app)/channels/[id]/ResourcesEditor.tsx` (create) — client editor.
- `src/app/(app)/channels/[id]/page.tsx` (modify) — RLS resource read + signed preview URLs; render `<ResourcesEditor>`.

---

## Task 1: Pure validation/sanitization core

**Files:**
- Create: `src/lib/resources/library.ts`
- Test: `src/lib/resources/library.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export type ResourceKind = 'image' | 'video'`
  - `export const RESOURCE_CONTENT_TYPES: Record<string, { kind: ResourceKind; ext: string }>`
  - `export const MAX_RESOURCE_BYTES: number`, `MAX_DESCRIPTION_LEN`, `MAX_TAGS`, `MAX_TAG_LEN`
  - `export function validateResourceUpload(input: { contentType: string }): { ok: true; kind: ResourceKind; ext: string } | { ok: false; reason: string }`
  - `export function sanitizeResourceFields(input: { description?: unknown; tags?: unknown }): { description: string; tags: string[] }`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/resources/library.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateResourceUpload,
  sanitizeResourceFields,
  MAX_TAGS,
  MAX_TAG_LEN,
  MAX_DESCRIPTION_LEN,
} from './library.ts';

test('validateResourceUpload: accepts the four allowed types with kind + ext', () => {
  assert.deepEqual(validateResourceUpload({ contentType: 'image/jpeg' }), { ok: true, kind: 'image', ext: 'jpg' });
  assert.deepEqual(validateResourceUpload({ contentType: 'image/png' }), { ok: true, kind: 'image', ext: 'png' });
  assert.deepEqual(validateResourceUpload({ contentType: 'image/webp' }), { ok: true, kind: 'image', ext: 'webp' });
  assert.deepEqual(validateResourceUpload({ contentType: 'video/mp4' }), { ok: true, kind: 'video', ext: 'mp4' });
});

test('validateResourceUpload: rejects unsupported types', () => {
  assert.equal(validateResourceUpload({ contentType: 'image/gif' }).ok, false);
  assert.equal(validateResourceUpload({ contentType: 'application/pdf' }).ok, false);
  assert.equal(validateResourceUpload({ contentType: '' }).ok, false);
});

test('sanitizeResourceFields: trims + caps description; absent → empty string', () => {
  assert.equal(sanitizeResourceFields({ description: '  hi  ' }).description, 'hi');
  assert.equal(sanitizeResourceFields({}).description, '');
  assert.equal(sanitizeResourceFields({ description: 123 }).description, '');
  const long = 'x'.repeat(MAX_DESCRIPTION_LEN + 50);
  assert.equal(sanitizeResourceFields({ description: long }).description.length, MAX_DESCRIPTION_LEN);
});

test('sanitizeResourceFields: tags trimmed, empties dropped, deduped, capped', () => {
  assert.deepEqual(sanitizeResourceFields({ tags: [' a ', 'b', '', 'a', '  '] }).tags, ['a', 'b']);
  assert.deepEqual(sanitizeResourceFields({ tags: 'notarray' }).tags, []);
  assert.deepEqual(sanitizeResourceFields({}).tags, []);
  const many = Array.from({ length: MAX_TAGS + 10 }, (_, i) => `t${i}`);
  assert.equal(sanitizeResourceFields({ tags: many }).tags.length, MAX_TAGS);
  const longTag = 'y'.repeat(MAX_TAG_LEN + 20);
  assert.equal(sanitizeResourceFields({ tags: [longTag] }).tags[0].length, MAX_TAG_LEN);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/resources/library.test.ts`
Expected: FAIL — module/exports do not exist.

- [ ] **Step 3: Implement the core**

Create `src/lib/resources/library.ts`:

```ts
// Pure validation + sanitization for the channel resource library (Phase 8 slice 1).
// No imports — mirrors src/lib/channels/logos.ts. The kind is derived here so the
// client can never spoof it.

export type ResourceKind = 'image' | 'video';

export const RESOURCE_CONTENT_TYPES: Record<string, { kind: ResourceKind; ext: string }> = {
  'image/jpeg': { kind: 'image', ext: 'jpg' },
  'image/png': { kind: 'image', ext: 'png' },
  'image/webp': { kind: 'image', ext: 'webp' },
  'video/mp4': { kind: 'video', ext: 'mp4' },
};

export const MAX_RESOURCE_BYTES = 100 * 1024 * 1024; // 100 MB (videos)
export const MAX_DESCRIPTION_LEN = 500;
export const MAX_TAGS = 20;
export const MAX_TAG_LEN = 40;

// Validate an upload's content type → its kind + stored extension, or a reason.
export function validateResourceUpload(
  input: { contentType: string },
): { ok: true; kind: ResourceKind; ext: string } | { ok: false; reason: string } {
  const match = RESOURCE_CONTENT_TYPES[input.contentType];
  if (!match) {
    return { ok: false, reason: 'Unsupported file type. Use JPG, PNG, WebP, or MP4.' };
  }
  return { ok: true, kind: match.kind, ext: match.ext };
}

// Normalize editable fields. description → trimmed + capped (non-string → ''); tags →
// trimmed, non-empty, deduped (first-seen), each capped, count capped (non-array → []).
export function sanitizeResourceFields(
  input: { description?: unknown; tags?: unknown },
): { description: string; tags: string[] } {
  const description =
    typeof input.description === 'string'
      ? input.description.trim().slice(0, MAX_DESCRIPTION_LEN)
      : '';

  const tags: string[] = [];
  if (Array.isArray(input.tags)) {
    const seen = new Set<string>();
    for (const raw of input.tags) {
      const t = String(raw).trim().slice(0, MAX_TAG_LEN);
      if (t === '' || seen.has(t)) continue;
      seen.add(t);
      tags.push(t);
      if (tags.length >= MAX_TAGS) break;
    }
  }

  return { description, tags };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/resources/library.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/resources/library.ts src/lib/resources/library.test.ts
git commit -m "feat(resources): pure validation/sanitization core for the library

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Server actions (create / confirm / update / delete)

**Files:**
- Create: `src/app/(app)/channels/[id]/resource-actions.ts`

**Interfaces:**
- Consumes (Task 1): `validateResourceUpload`, `sanitizeResourceFields` from `@/lib/resources/library`. Existing: `createResourceUpload`, `confirmResourceUpload` from `@/lib/resources/upload`; `createClient` from `@/lib/supabase/server`; `deleteObject` from `@/lib/r2`.
- Produces:
  - `createResource(channelId: string, input: { filename: string; contentType: string }): Promise<{ ok: true; resourceId: string; uploadUrl: string } | { ok: false; reason: string }>`
  - `confirmResource(resourceId: string): Promise<{ ok: true; description: string; tags: string[] } | { ok: false; reason: string }>`
  - `updateResource(resourceId: string, fields: unknown): Promise<{ ok: true } | { ok: false; reason: string }>`
  - `deleteResource(resourceId: string): Promise<{ ok: true } | { ok: false; reason: string }>`

- [ ] **Step 1: Write the actions**

Create `src/app/(app)/channels/[id]/resource-actions.ts`:

```ts
'use server';

import { createClient } from '@/lib/supabase/server';
import { deleteObject } from '@/lib/r2';
import { createResourceUpload, confirmResourceUpload } from '@/lib/resources/upload';
import { validateResourceUpload, sanitizeResourceFields } from '@/lib/resources/library';

// Channel resource library actions (Phase 8 slice 1). channel_resources is a
// first-class RLS table, so update/delete are direct RLS writes scoped by account_id,
// confirmed via .select('id') (no row → not found, never a phantom "Saved"). Create +
// confirm reuse the Phase-5 server functions. Account resolved from the session.

async function resolveAccountId(
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<string | null> {
  const { data } = await supabase.from('accounts').select('id').maybeSingle();
  return (data?.id as string | undefined) ?? null;
}

// Reserve a channel_resources row + a signed PUT URL. The kind is derived from the
// content type server-side (never trusted from the client).
export async function createResource(
  channelId: string,
  input: { filename: string; contentType: string },
): Promise<{ ok: true; resourceId: string; uploadUrl: string } | { ok: false; reason: string }> {
  const valid = validateResourceUpload({ contentType: input.contentType });
  if (!valid.ok) return valid;

  const supabase = await createClient();
  const accountId = await resolveAccountId(supabase);
  if (!accountId) return { ok: false, reason: 'No account found.' };

  try {
    const { resourceId, uploadUrl } = await createResourceUpload(supabase, accountId, channelId, {
      filename: input.filename,
      contentType: input.contentType,
      kind: valid.kind,
    });
    return { ok: true, resourceId, uploadUrl };
  } catch {
    return { ok: false, reason: 'Could not start the upload. Please try again.' };
  }
}

// After the client PUTs the bytes: hash for dedupe + (images) one vision call to
// auto-describe + tag. Wrapped so a vision/network failure degrades gracefully — the
// row already exists with the filename, editable by hand.
export async function confirmResource(
  resourceId: string,
): Promise<{ ok: true; description: string; tags: string[] } | { ok: false; reason: string }> {
  const supabase = await createClient();
  const accountId = await resolveAccountId(supabase);
  if (!accountId) return { ok: false, reason: 'No account found.' };

  try {
    const { description, tags } = await confirmResourceUpload(supabase, accountId, resourceId);
    return { ok: true, description, tags };
  } catch {
    return { ok: false, reason: 'Uploaded, but auto-tagging failed. You can edit it manually.' };
  }
}

// Update the editable fields (description + tags). sanitizeResourceFields enforces the
// caps before the write.
export async function updateResource(
  resourceId: string,
  fields: unknown,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const clean = sanitizeResourceFields(fields as { description?: unknown; tags?: unknown });

  const supabase = await createClient();
  const accountId = await resolveAccountId(supabase);
  if (!accountId) return { ok: false, reason: 'No account found.' };

  const { data, error } = await supabase
    .from('channel_resources')
    .update({ description: clean.description, tags: clean.tags })
    .eq('id', resourceId)
    .eq('account_id', accountId)
    .select('id');
  if (error) return { ok: false, reason: error.message };
  if (!data || data.length === 0) return { ok: false, reason: 'Resource not found.' };
  return { ok: true };
}

// Delete a resource: best-effort remove the R2 object, then the row (RLS-scoped).
export async function deleteResource(
  resourceId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const supabase = await createClient();
  const accountId = await resolveAccountId(supabase);
  if (!accountId) return { ok: false, reason: 'No account found.' };

  const { data: row } = await supabase
    .from('channel_resources')
    .select('r2_key')
    .eq('id', resourceId)
    .eq('account_id', accountId)
    .maybeSingle();

  const r2Key = (row?.r2_key as string | null) ?? null;
  if (r2Key) {
    try {
      await deleteObject(r2Key);
    } catch {
      // best-effort: a stale/absent object must not block removing the row
    }
  }

  const { data, error } = await supabase
    .from('channel_resources')
    .delete()
    .eq('id', resourceId)
    .eq('account_id', accountId)
    .select('id');
  if (error) return { ok: false, reason: error.message };
  if (!data || data.length === 0) return { ok: false, reason: 'Resource not found.' };
  return { ok: true };
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors. (Confirms the reused `createResourceUpload`/`confirmResourceUpload` signatures and the RLS query types resolve.)

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: clean (no unused imports).

- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/channels/[id]/resource-actions.ts"
git commit -m "feat(resources): server actions (create/confirm/update/delete)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Page read + `ResourcesEditor` client component

**Files:**
- Create: `src/app/(app)/channels/[id]/ResourcesEditor.tsx`
- Modify: `src/app/(app)/channels/[id]/page.tsx`

**Interfaces:**
- Consumes (Task 1): `MAX_RESOURCE_BYTES` from `@/lib/resources/library`. (Task 2): `createResource`, `confirmResource`, `updateResource`, `deleteResource` from `./resource-actions`. Existing: `signedGetUrl` from `@/lib/r2` (already imported in page.tsx).
- Produces: `export type ResourceItem = { id: string; kind: 'image' | 'video'; description: string; tags: string[]; filename: string; previewUrl: string | null }`; `export function ResourcesEditor({ channelId, initial }: { channelId: string; initial: ResourceItem[] })`.

- [ ] **Step 1: Create the editor component**

Create `src/app/(app)/channels/[id]/ResourcesEditor.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { MAX_RESOURCE_BYTES } from '@/lib/resources/library';
import { createResource, confirmResource, updateResource, deleteResource } from './resource-actions';

export type ResourceItem = {
  id: string;
  kind: 'image' | 'video';
  description: string;
  tags: string[];
  filename: string;
  previewUrl: string | null;
};

const ACCEPT = 'image/jpeg,image/png,image/webp,video/mp4';

// One resource card: preview + editable description/tags (dirty-tracked Save) + Delete.
function ResourceCard({
  item,
  onDeleted,
}: {
  item: ResourceItem;
  onDeleted: (id: string) => void;
}) {
  const [description, setDescription] = useState(item.description);
  const [tagsText, setTagsText] = useState(item.tags.join(', '));
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function onSave() {
    setBusy(true);
    setError(null);
    try {
      const tags = tagsText.split(',').map((t) => t.trim()).filter(Boolean);
      const res = await updateResource(item.id, { description, tags });
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

  async function onDelete() {
    setBusy(true);
    setError(null);
    try {
      const res = await deleteResource(item.id);
      if (res.ok) {
        if (item.previewUrl && item.previewUrl.startsWith('blob:')) URL.revokeObjectURL(item.previewUrl);
        onDeleted(item.id);
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
    <div className="space-y-2 rounded-lg border border-black/10 p-3 dark:border-white/10">
      <div className="flex h-32 items-center justify-center overflow-hidden rounded bg-black/5 dark:bg-white/5">
        {item.previewUrl ? (
          item.kind === 'video' ? (
            <video src={item.previewUrl} muted className="max-h-full max-w-full object-contain" />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={item.previewUrl} alt={item.description || item.filename} className="max-h-full max-w-full object-contain" />
          )
        ) : (
          <span className="text-xs opacity-40">{item.kind}</span>
        )}
      </div>

      <textarea
        value={description}
        onChange={(e) => {
          setDescription(e.target.value);
          setDirty(true);
          setSaved(false);
        }}
        rows={2}
        placeholder="Description"
        className="w-full rounded border border-black/15 bg-transparent px-2 py-1 text-sm dark:border-white/15"
      />
      <input
        type="text"
        value={tagsText}
        onChange={(e) => {
          setTagsText(e.target.value);
          setDirty(true);
          setSaved(false);
        }}
        placeholder="tags, comma, separated"
        className="w-full rounded border border-black/15 bg-transparent px-2 py-1 text-sm dark:border-white/15"
      />

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onSave}
          disabled={busy || !dirty}
          className="rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={busy}
          className="text-sm text-red-600 disabled:opacity-50"
        >
          Delete
        </button>
        {saved && !dirty && <span className="text-sm text-green-600">Saved</span>}
        {error && <span className="text-sm text-red-600">{error}</span>}
      </div>
    </div>
  );
}

export function ResourcesEditor({ channelId, initial }: { channelId: string; initial: ResourceItem[] }) {
  const [items, setItems] = useState<ResourceItem[]>(initial);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onPick(file: File | undefined) {
    if (!file) return;
    setError(null);
    setStatus(null);
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
      setStatus('Analyzing…');
      const confirmed = await confirmResource(created.resourceId);
      const kind = file.type === 'video/mp4' ? 'video' : 'image';
      const item: ResourceItem = {
        id: created.resourceId,
        kind,
        description: confirmed.ok ? confirmed.description : file.name,
        tags: confirmed.ok ? confirmed.tags : [],
        filename: file.name,
        previewUrl: URL.createObjectURL(file),
      };
      setItems((xs) => [item, ...xs]);
      if (!confirmed.ok) setError(confirmed.reason);
      setStatus(null);
    } catch {
      setError('Upload failed. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  function onDeleted(id: string) {
    setItems((xs) => xs.filter((x) => x.id !== id));
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Resources</h2>
        <p className="text-sm opacity-70">
          Pinned images and video for this channel. Stored + auto-tagged — placement in
          videos comes next.
        </p>
      </div>

      <div className="flex items-center gap-3">
        <input
          type="file"
          accept={ACCEPT}
          disabled={busy}
          onChange={(e) => onPick(e.target.files?.[0])}
          className="block text-sm file:mr-2 file:rounded file:border-0 file:bg-foreground file:px-3 file:py-1.5 file:text-background disabled:opacity-50"
        />
        {status && <span className="text-sm opacity-60">{status}</span>}
        {error && <span className="text-sm text-red-600">{error}</span>}
      </div>

      {items.length === 0 ? (
        <p className="text-sm opacity-70">No resources yet.</p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((item) => (
            <ResourceCard key={item.id} item={item} onDeleted={onDeleted} />
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Wire the page read + render**

In `src/app/(app)/channels/[id]/page.tsx`:

Add the import alongside the other editor imports (after the `LogosEditor` import):

```ts
import { ResourcesEditor, type ResourceItem } from './ResourcesEditor';
```

After the `voiceInitial` / `videoDefaultsInitial` lines (just before the `return (`), add the resource read:

```ts
  const { data: resourceRows } = await supabase
    .from('channel_resources')
    .select('id, kind, r2_key, original_filename, description, tags, created_at')
    .eq('channel_id', id)
    .order('created_at', { ascending: false });
  const resources: ResourceItem[] = await Promise.all(
    (resourceRows ?? []).map(async (r) => ({
      id: r.id as string,
      kind: (r.kind as string) === 'video' ? ('video' as const) : ('image' as const),
      description: (r.description as string | null) ?? '',
      tags: (r.tags as string[] | null) ?? [],
      filename: (r.original_filename as string | null) ?? '',
      previewUrl: r.r2_key ? await signedGetUrl(r.r2_key as string, 60 * 60) : null,
    })),
  );
```

In the returned JSX, add a separator + the editor after the `<LogosEditor ... />` block:

```tsx
      <hr className="border-black/10 dark:border-white/10" />

      <ResourcesEditor channelId={channel.id as string} initial={resources} />
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Lint**

Run: `npm run lint`
Expected: clean.

- [ ] **Step 5: Build (client/server boundary check)**

Run: `npm run build`
Expected: build succeeds. Confirms `ResourcesEditor` (client) only pulls the pure module + the server actions across the boundary, and the channel page's resource read compiles.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(app)/channels/[id]/ResourcesEditor.tsx" "src/app/(app)/channels/[id]/page.tsx"
git commit -m "feat(resources): resource library editor on the channel page

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final verification (whole branch)

- [ ] `npm test` — full suite green.
- [ ] `npx tsc --noEmit` — clean.
- [ ] `npm run lint` — clean.
- [ ] `npm run build` — succeeds.
- [ ] **Manual / app-run e2e (operator):** channel page → upload an image → it auto-describes + tags ("Analyzing…") → edit the description + a tag → Save → reload persists → upload an MP4 → it lists with a video preview/filename → delete a resource → it disappears (and the R2 object is removed). (Needs PEXELS/Anthropic keys for the vision auto-tag; without them the upload still succeeds and the card shows the filename with a graceful "auto-tagging failed" note.)

## Post-merge bookkeeping (controller, after merge)

- Update `CLAUDE.md` Phase-5 deferral note: the channel-resource **library UI** shipped (create/upload+auto-tag/edit/delete); resource **placement** (`source='resource'`) + the compose-prompt binding remain slice 2.
- Update memory ([[phase-5-asset-richness-gotchas]] "resource caveat" / [[channel-settings-stack]] still-open list): library UI shipped; placement + compose binding still pending.
