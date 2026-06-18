# Channel logo uploads — design

**Date:** 2026-06-18
**Phase:** 8 (Full surfaces) — channel settings, sub-slice 4 of 5
**Status:** design approved, ready for implementation plan

## Context

`brand_kit.logos` is a 4-slot map (`primary`, `monoLight`, `monoDark`, `icon`)
in the brand contract (`src/lib/primitives/contract.ts`). Today nothing writes
it (no UI) and nothing reads it at render: `bakeTheme` deliberately emits
`logos: {}` (a test asserts this). This slice (4 of 5: 1 ✅ foundation, 2 ✅
brand editor, 3 ✅ caption-emphasis tables) adds the **upload + store + preview**
UI for those four slots.

**No render consumption / no renderer change.** Where a logo would appear in a
video is an unmade creative decision and no logo-displaying primitive exists, so
this slice stores logos and previews them in the editor only — clearly labelled
"not yet shown in videos." A later slice will design placement and wire
`bakeTheme`/`signSpecAssets`/a primitive. **No `deploy:remotion` gate.**

## Goal

Let an operator upload a channel's brand logos (4 slots), see them, and remove
them — persisted as R2 keys in `brand_kit.logos`.

## Scope

**In scope** — a "Logos" section on `/channels/[id]`, below the caption-emphasis
section, own Save:

- The 4 slots `primary`, `monoLight`, `monoDark`, `icon`. Each: upload an image,
  preview it, or remove it.
- Accepted types: **PNG, JPEG, WebP, SVG** (`image/png`, `image/jpeg`,
  `image/webp`, `image/svg+xml`). A **2 MB client-side size guard** before upload
  (a signed PUT goes straight to R2, so size cannot be server-enforced —
  best-effort).
- Stored as **R2 keys** in `brand_kit.logos`; previewed via signed GET URLs.
- A clear label: "Stored for now; not yet shown in videos."

**Out of scope (later sub-slices / not this slice)**

- Render consumption / placement of logos (`bakeTheme` keeps emitting `logos:
  {}`; no `signSpecAssets` change; no primitive). A future slice.
- Voice params (slice 5).
- SVG sanitization — logos preview via `<img src>`, which never executes
  embedded SVG scripts; safe without sanitizing.
- A background reaper for orphaned R2 objects (see Known debt).
- Drag-and-drop, cropping, multi-file — a plain file input per slot.

## Architecture

Logos need their **own path** — they live in `brand_kit.logos` (JSONB), not the
`channel_resources` table that `createResourceUpload` writes. The flow:

1. **`createLogoUpload(channelId, slot, { filename, contentType })`** server
   action → `validateLogoUpload` (type + slot) → generate an R2 key
   `logos/${accountId}/${channelId}/${slot}-${uuid}.${ext}` →
   `signedPutUrl(key, contentType)` → return `{ ok: true; uploadUrl; key } |
   { ok: false; reason }`. Does NOT touch `brand_kit`. The `channelId` is used
   to derive the key; ownership is enforced by the Save RPC's RLS (and the page
   read 404s a non-owned channel before the editor renders).
2. **Client PUT** — `fetch(uploadUrl, { method: 'PUT', body: file, headers: {
   'Content-Type': file.type } })`. On success the slot's new key enters the
   editor's local state (dirty); the slot previews the local `File` via
   `URL.createObjectURL` immediately.
3. **`saveChannelLogos(channelId, logos)`** server action → `sanitizeLogos`
   (keep only the 4 known slots with string keys) → `set_channel_logos` RPC →
   `{ ok: true } | { ok: false; reason }`. Removing a slot drops its key from the
   set before Save.

### Data model

No schema change. One **migration** adds a focused RPC (slice-3 pattern):

```sql
-- Phase 8 — channel logos. Writes ONLY brand_kit.logos via jsonb_set
-- (create_missing=true), preserving sibling keys (colors, typography,
-- motion_preset, caption_emphasis). SECURITY INVOKER → caller RLS on channels
-- applies. RETURNS the updated id (NULL when no row matched) → no phantom save.
create or replace function set_channel_logos(
  p_channel_id uuid,
  p_logos      jsonb
) returns uuid
language sql
security invoker
as $$
  update channels
  set brand_kit  = jsonb_set(brand_kit, '{logos}', p_logos, true),
      updated_at = now()
  where id = p_channel_id
  returning id;
$$;

grant execute on function set_channel_logos(uuid, jsonb) to authenticated;
```

This and the slice-2 `||` merge / slice-3 `caption_emphasis` `jsonb_set` touch
disjoint `brand_kit` keys — independent, no clobber.

## Components

### Pure core (`src/lib/channels/logos.ts`, unit-tested)

```ts
export const LOGO_SLOTS = ['primary', 'monoLight', 'monoDark', 'icon'] as const;
export type LogoSlot = (typeof LOGO_SLOTS)[number];
export type Logos = Partial<Record<LogoSlot, string>>; // slot → R2 key

// Accepted upload types → file extension. Validates the slot too.
export function validateLogoUpload(input: unknown):
  | { ok: true; ext: string }
  | { ok: false; reason: string };
// reject: unknown slot ('Unknown logo slot.'); contentType ∉
// {png,jpeg,webp,svg+xml} ('Use a PNG, JPEG, WebP, or SVG.').

// Keep only the 4 known slots whose value is a non-empty string (R2 key); drop
// everything else. Pure filter — always returns a clean Logos.
export function sanitizeLogos(input: unknown): Logos;
```

`MAX_LOGO_BYTES = 2 * 1024 * 1024` is also exported (the client guard reads it).

### Server actions (`src/app/(app)/channels/[id]/logo-actions.ts`, `'use server'`)

- `createLogoUpload(channelId, slot, { filename, contentType }): Promise<{ ok:
  true; uploadUrl: string; key: string } | { ok: false; reason: string }>` —
  validates via `validateLogoUpload`; resolves the session account
  (`maybeSingle` + null check, like `createChannel`); builds the key with
  `randomUUID()`; returns `signedPutUrl(key, contentType)`.
- `saveChannelLogos(channelId, logos): Promise<{ ok: true } | { ok: false;
  reason: string }>` — `sanitizeLogos` → `supabase.rpc('set_channel_logos', {
  p_channel_id, p_logos })` → RPC error → `{ ok:false, reason }`; `data == null`
  → `{ ok:false, reason:'Channel not found.' }`; else `{ ok:true }`.

### UI

`/channels/[id]/page.tsx` reads `brand_kit` (already), extracts
`sanitizeLogos(brand_kit.logos)` for the initial keys, and signs each present
key (`signedGetUrl`, server-side) into `initialPreviewUrls: Partial<Record<
LogoSlot, string>>`. It renders `<LogosEditor channelId initial={keys}
initialPreviewUrls={urls} />` below the caption-emphasis section.

`LogosEditor` (client): a row per slot with the slot label, a preview
(`<img>` of the signed URL or the local object URL, or an empty placeholder), an
**Upload** file input (`accept="image/png,image/jpeg,image/webp,image/svg+xml"`),
and a **Remove** button. Picking a file: client-size-guards (`MAX_LOGO_BYTES`,
friendly error if over) → `createLogoUpload` → PUT to `uploadUrl` → on success,
set the slot key + an object-URL preview, mark dirty. A single dirty-tracked
**Save** calls `saveChannelLogos(channelId, currentKeys)` (try/catch/finally;
`{ ok:false }` keeps state + shows reason; `{ ok:true }` clears dirty + "Saved").
A per-slot busy state disables that slot's input while its PUT is in flight.

## Data flow

```
/channels/[id] (server) → read brand_kit.logos → sanitizeLogos + sign each key → keys + previewUrls
LogosEditor (client) → pick file → createLogoUpload → PUT to R2 → slot key in state (dirty)
                     → Save → saveChannelLogos(id, keys)
saveChannelLogos → sanitizeLogos → set_channel_logos RPC (RLS) → { ok }
render → bakeTheme still emits logos:{} (unchanged); not consumed this slice
```

## Error handling

- `validateLogoUpload` → friendly reason for a bad type / unknown slot;
  `createLogoUpload` returns it.
- Client size guard → "Logo must be under 2 MB." before any upload.
- A failed PUT (network / R2) → the editor shows a per-slot error, leaves the
  slot unchanged.
- `saveChannelLogos` → `{ ok:false, reason }` on RPC error; `data == null` →
  `'Channel not found.'` (no phantom save).
- The page `notFound()`s a missing/non-owned channel before the editor.

## Back-compatibility

- A channel with no `brand_kit.logos` → all slots empty; nothing breaks.
- `jsonb_set` preserves slices 2–3 keys; their writers preserve `logos`.
- Old renders unaffected (logos were and remain unconsumed).

## Known debt (accepted)

- **Orphaned R2 objects:** a file PUT to R2 before Save that is then never saved
  (or replaced by a re-upload to the same slot) leaves an object whose key is not
  in `brand_kit.logos`. Best-effort, no reaper — same posture as the
  regenerate-in-place audio orphans (single-operator). Flagged here, not fixed.

## Testing

- **Unit (`src/lib/channels/logos.test.ts`):** `validateLogoUpload` — accepts
  png/jpeg/webp/svg (→ correct ext), rejects an unknown content type and an
  unknown slot. `sanitizeLogos` — keeps the 4 known slots with string values,
  drops unknown keys / non-string / empty-string values, and an empty/garbage
  input → `{}`.
- **Migration:** `npm run db:apply` the RPC; confirm recorded + applied.
- **Manual / app-run e2e:** open `/channels/[id]` → Logos section shows 4 empty
  slots → upload a PNG to `primary` (preview appears) and an SVG to `icon` →
  Save → reload: both persist and preview from signed URLs → Remove `primary` →
  Save → reload: `primary` gone, `icon` stays → upload an oversize file → the
  2 MB guard shows the error and nothing uploads → a non-image type is rejected.
  Confirm the slice-2/3 sections still save independently. **No render gate** —
  logos are not consumed by the renderer.

## Open questions

None. Four slots, accepted types incl. SVG + 2 MB guard, per-slot upload +
single Save, upload-before-save orphan debt accepted, and no render consumption
are all settled.
