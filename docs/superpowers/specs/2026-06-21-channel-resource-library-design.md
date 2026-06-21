# Channel resource library UI — design (slice 1 of 2)

**Date:** 2026-06-21
**Phase:** 8 (Full surfaces) — channel resources, slice 1 of 2
**Status:** design approved, ready for implementation plan

## Context

Phase 5 built the server capability for channel resources but deferred all UI to
Phase 8 — so the feature is dormant. Already in place:

- **Schema (init migration `20260604184050`):** `channel_resources (id, account_id,
  channel_id, kind resource_kind, r2_key, source_url, original_filename,
  content_hash, description, tags text[], created_at)`, RLS `acct_isolation`
  (`auth_owns_account(account_id)`). `shots.source shot_source` (`stock|resource|
  procedural`) + `shots.resource_id` (FK → `channel_resources`, on delete set null).
- **Server functions (`src/lib/resources/upload.ts`):**
  `createResourceUpload(client, accountId, channelId, { filename, contentType, kind })`
  → `{ resourceId, r2Key, uploadUrl }` (reserves the row + a signed PUT URL); and
  `confirmResourceUpload(client, accountId, resourceId)` → `{ description, tags }`
  (hashes bytes for dedupe; for images runs one Claude-vision call to auto-describe
  + tag; non-images keep the filename). `UploadableResourceKind = 'image' | 'video'`.
- **`resolveResourceAssets` (`src/lib/assets/resolve.ts`)** turns `source='resource'`
  shots into manifest entries (slice 2 consumer).
- **R2 (`src/lib/r2.ts`):** `signedPutUrl`, `signedGetUrl`, `deleteObject`.
- **Established editor pattern** (channel brand/caption/logos/voice slices): a pure
  core (`src/lib/channels/<name>.ts`) + a client editor with dirty-tracked Save. The
  **logos slice** is the closest precedent — it already does client→R2 signed-PUT
  upload (`createLogoUpload` + `LogosEditor`).

This slice (1 of 2) builds the **resource library UI** on the channel page:
list / upload (auto-tag) / edit / delete. Slice 2 (later) wires shot placement
(`source='resource'`) + the compose-prompt binding.

## Goal

Let the operator manage a channel's pinned image/video resources from the channel
page: see them, upload new ones (auto-described + tagged), edit the description and
tags, and delete them.

## Scope

**In scope:**

- A "Resources" section on the channel page: a grid of the channel's resources.
- Add a resource: file picker (image/video) → reserve row + signed PUT → client PUTs
  bytes to R2 → confirm (hash + vision auto-tag for images) → the card appears.
- Edit a resource's description + tags (per-card dirty-tracked Save).
- Delete a resource (removes the R2 object + the row).
- A pure validation/sanitization core with unit tests.

**Out of scope (slice 2 / deferred):**

- Shot placement (`shots.source='resource'`, picking a resource in the video editor)
  and the compose-prompt binding that surfaces resources to the AI.
- `url` / `audio` / `document` resource kinds (image + video only this slice).
- Writing a `resource_tagging` cost_event on confirm (the noted Phase-5 follow-up —
  left out to keep this slice focused and avoid the Sonnet-pinned accounting).
- Any schema change, migration, or RPC (the table + RLS already exist; writes are
  direct RLS operations).

## Architecture

`channel_resources` is a first-class RLS table, so all writes are **direct RLS
operations** inside server actions (the existing `createResourceUpload` already
inserts this way) — no `security_invoker` RPC, no migration. The slice reuses the
two existing server functions and adds edit/delete actions, a pure core, a page
read, and a client editor.

### Pure core: `src/lib/resources/library.ts` (unit-tested)

Pure (no imports beyond types). Mirrors `src/lib/channels/logos.ts`.

```ts
export type ResourceKind = 'image' | 'video';

// Allowed upload content types → kind + stored extension. The kind is derived
// here (server-side), never trusted from the client.
export const RESOURCE_CONTENT_TYPES: Record<string, { kind: ResourceKind; ext: string }> = {
  'image/jpeg': { kind: 'image', ext: 'jpg' },
  'image/png':  { kind: 'image', ext: 'png' },
  'image/webp': { kind: 'image', ext: 'webp' },
  'video/mp4':  { kind: 'video', ext: 'mp4' },
};

export const MAX_RESOURCE_BYTES = 100 * 1024 * 1024; // 100 MB (videos)

export const MAX_DESCRIPTION_LEN = 500;
export const MAX_TAGS = 20;
export const MAX_TAG_LEN = 40;

// Validate an upload's content type → its kind + ext, or a friendly reason.
export function validateResourceUpload(
  input: { contentType: string },
): { ok: true; kind: ResourceKind; ext: string } | { ok: false; reason: string };

// Normalize editable fields: trim + cap description; tags → trimmed, non-empty,
// deduped, capped in count and per-tag length.
export function sanitizeResourceFields(
  input: { description?: unknown; tags?: unknown },
): { description: string; tags: string[] };
```

`validateResourceUpload` rule: look up `RESOURCE_CONTENT_TYPES[contentType]`; absent
→ `{ ok:false, reason: 'Unsupported file type. Use JPG, PNG, WebP, or MP4.' }`.

`sanitizeResourceFields` rule: `description` → `String(...).trim().slice(0,
MAX_DESCRIPTION_LEN)` (non-string/absent → `''`); `tags` → if an array, map
`String(t).trim()`, drop empties, dedupe (first-seen), each `.slice(0, MAX_TAG_LEN)`,
cap to `MAX_TAGS` (non-array → `[]`).

### Server actions: `src/app/(app)/channels/[id]/resource-actions.ts` (`'use server'`)

Each resolves the account from the session (`accounts.id` via the RLS client),
mirroring `logo-actions.ts`.

- `createResource(channelId, input: { filename: string; contentType: string }):
  Promise<{ ok:true; resourceId: string; uploadUrl: string } | { ok:false; reason }>`
  — `validateResourceUpload(input)` → resolve account (no account → `{ ok:false }`) →
  `createResourceUpload(client, accountId, channelId, { filename, contentType,
  kind: valid.kind })` → return `{ ok:true, resourceId, uploadUrl }`. (The client
  sends the file size; the editor enforces `MAX_RESOURCE_BYTES` before calling.)
- `confirmResource(resourceId): Promise<{ ok:true; description; tags } | { ok:false;
  reason }>` — resolve account → `confirmResourceUpload(client, accountId,
  resourceId)` → return its `{ description, tags }`. Wrapped in try/catch → a friendly
  reason on failure (the vision call can fail; the row still exists with the filename).
- `updateResource(resourceId, fields: unknown): Promise<{ ok:true } | { ok:false;
  reason }>` — `sanitizeResourceFields(fields)` → resolve account →
  `update({ description, tags }).eq('id', resourceId).eq('account_id', accountId)
  .select('id')` → empty/`error` → `{ ok:false, reason }` (`'Resource not found.'`
  on no row); else `{ ok:true }`.
- `deleteResource(resourceId): Promise<{ ok:true } | { ok:false; reason }>` — resolve
  account → select the row's `r2_key` (account-scoped) → if found, `deleteObject(r2Key)`
  best-effort (catch + ignore) → `delete().eq('id', resourceId).eq('account_id',
  accountId).select('id')` → empty → `'Resource not found.'`; else `{ ok:true }`.

### Page read: `channels/[id]/page.tsx`

After the existing reads, select the channel's resources (RLS-scoped) and sign a
preview URL per resource:

```ts
const { data: resourceRows } = await supabase
  .from('channel_resources')
  .select('id, kind, r2_key, original_filename, description, tags, created_at')
  .eq('channel_id', id)
  .order('created_at', { ascending: false });
const resources = await Promise.all(
  (resourceRows ?? []).map(async (r) => ({
    id: r.id as string,
    kind: (r.kind as string) === 'video' ? 'video' : 'image',
    description: (r.description as string | null) ?? '',
    tags: (r.tags as string[] | null) ?? [],
    filename: (r.original_filename as string | null) ?? '',
    previewUrl: r.r2_key ? await signedGetUrl(r.r2_key as string, 60 * 60) : null,
  })),
);
```

Render `<ResourcesEditor channelId={id} initial={resources} />` as a new section
(after `<LogosEditor>`, before/around the other editors — placed after Logos).

### Client: `src/app/(app)/channels/[id]/ResourcesEditor.tsx`

A grid of resource cards + an "Add resource" file input. Patterns mirror
`LogosEditor` (object-URL previews with revoke, per-item busy flags, try/catch/finally
Save). Each card:

- Preview: `<img>` for `image`; for `video` a muted `<video src=...>` (or a "Video"
  badge + filename).
- An editable `description` textarea + a `tags` text input (comma-separated, shown
  joined; on Save split + handed to `updateResource`, which sanitizes).
- A per-card dirty-tracked **Save** (`updateResource`) and **Delete**
  (`deleteResource` → drop the card on `{ ok:true }`).

Add flow: file picker (`accept="image/jpeg,image/png,image/webp,video/mp4"`) → size
check vs `MAX_RESOURCE_BYTES` → `createResource` → `fetch(uploadUrl, { method:'PUT',
body:file, headers:{ 'Content-Type': file.type } })` → on PUT success
`confirmResource(resourceId)` (show "Analyzing…") → append a new card with the
returned `description`/`tags`, a local object-URL preview, and the new id.

`ResourceItem` type is shared between the page and the editor (exported from the
editor or a small shared type).

## Data flow

```
channel page (server) → RLS read channel_resources + signed preview URLs → ResourcesEditor
add:    pick file → createResource (validate→reserve row+signed PUT) → PUT bytes to R2
        → confirmResource (hash + vision auto-tag) → card appears
edit:   description/tags → Save → updateResource (sanitize → RLS update → no-row=not found)
delete: Delete → deleteResource (deleteObject + RLS delete) → card removed
```

## Error handling

- `validateResourceUpload` rejects an unsupported content type with a friendly reason;
  the editor shows it and uploads nothing.
- The editor enforces `MAX_RESOURCE_BYTES` before reserving a row.
- A failed signed-PUT (`!res.ok`) surfaces "Upload failed (status)."; the reserved row
  stays (harmless, no bytes) — acceptable for V1.
- `confirmResource` is wrapped: a vision/network failure → a reason; the row already
  exists with the filename as description, so the operator can edit it manually.
- `updateResource`/`deleteResource` → `{ ok:false }` on RLS error; a no-row result →
  "Resource not found." (no phantom save).
- `deleteObject` is best-effort (catch + ignore) so a stale/absent R2 object never
  blocks removing the row.

## Back-compatibility

- Additive: a new section on the channel page + new actions + a pure module. No
  existing component, schema, or write path changes. `createResourceUpload` /
  `confirmResourceUpload` / `resolveResourceAssets` are reused unchanged.
- Resources created here are inert until slice 2 wires placement — they simply exist
  in the library (consistent with logos being "stored, not yet shown").

## Testing

- **Unit (`src/lib/resources/library.test.ts`):**
  - `validateResourceUpload` — each allowed type → correct `{ kind, ext }`; an
    unsupported type (e.g. `image/gif`, `application/pdf`) → `{ ok:false }`.
  - `sanitizeResourceFields` — trims + caps description; tags trimmed, empties dropped,
    deduped, count + per-tag length capped; non-array tags → `[]`; absent fields →
    `{ description:'', tags:[] }`.
- **Regression:** `npm test` green; `npx tsc --noEmit` + `npm run lint` clean;
  `npm run build` succeeds (the channel page + client editor compile; the editor only
  pulls the pure module + the actions across the client boundary).
- **Manual / app-run e2e:** channel page → upload an image → it auto-describes + tags →
  edit the description + a tag → Save → reload persists → upload an MP4 → it lists with
  the filename → delete a resource → it disappears and the R2 object is gone.

## Open questions

None. Library-first scope, image+video only, direct-RLS writes (no migration), and
reuse of the existing upload/confirm server functions are settled.
