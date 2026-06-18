# Channel Logo Uploads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Logos" section to `/channels/[id]` that uploads the 4 `brand_kit.logos` slots to R2 and stores their keys (upload + store + preview; not consumed by the renderer yet).

**Architecture:** A pure core (`logos.ts`) validates an upload's type/slot and sanitizes a stored logos object. A `createLogoUpload` action returns a signed PUT URL + R2 key (client PUTs the bytes directly); a `saveChannelLogos` action persists the slot→key map via a focused `set_channel_logos` RPC (`jsonb_set`, returns id, no phantom save). A `LogosEditor` client section with per-slot upload/remove + one Save renders below the caption-emphasis section. No renderer change.

**Tech Stack:** Next.js 16 App Router (server + client components), Supabase under RLS, Cloudflare R2 (S3-compatible signed URLs), TypeScript, `node:test` via the project loader.

Design source: `docs/superpowers/specs/2026-06-18-channel-logos-design.md`.

## Global Constraints

- **4 slots:** `LOGO_SLOTS = ['primary','monoLight','monoDark','icon']`. Logos stored in `brand_kit.logos` as R2 KEYS (strings), not in `channel_resources`.
- **Accepted types:** `image/png`→`png`, `image/jpeg`→`jpg`, `image/webp`→`webp`, `image/svg+xml`→`svg`. Reject anything else.
- **`MAX_LOGO_BYTES = 2 * 1024 * 1024`** — client-side size guard before upload (a signed PUT goes straight to R2; size can't be server-enforced).
- **R2 key:** `logos/${accountId}/${channelId}/${slot}-${randomUUID()}.${ext}` — generated in the action (uuid is not pure).
- **`set_channel_logos` RPC** is `security invoker`, writes ONLY `brand_kit.logos` via `jsonb_set(brand_kit, '{logos}', p_logos, true)` (preserves `colors`/`typography`/`motion_preset`/`caption_emphasis`), `RETURNING id` (NULL on zero rows).
- **No phantom save:** `saveChannelLogos` returns `{ ok:false, reason:'Channel not found.' }` when the RPC returns null.
- **No renderer change, NO `deploy:remotion` gate** — `bakeTheme` keeps emitting `logos: {}`; logos are not consumed this slice.
- **Upload-before-save orphan debt is accepted** — a PUT'd-but-unsaved object is left in R2 (no reaper); single-operator, flagged in the spec.
- **Pure boundary:** `logos.ts` imports nothing (no react/server/network). Test imports use explicit `.ts`.
- RLS via `@/lib/supabase/server`'s `createClient()`. Server actions begin with `'use server'`. Tests run via `npm test`.

---

### Task 1: Pure logos core (`validateLogoUpload` + `sanitizeLogos`)

**Files:**
- Create: `src/lib/channels/logos.ts`
- Test: `src/lib/channels/logos.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `LOGO_SLOTS` (readonly tuple), `LogoSlot`, `Logos` types; `MAX_LOGO_BYTES`; `isLogoSlot(v): v is LogoSlot`; `validateLogoUpload(input): { ok:true; ext:string } | { ok:false; reason:string }`; `sanitizeLogos(input): Logos`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/channels/logos.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateLogoUpload, sanitizeLogos, LOGO_SLOTS, MAX_LOGO_BYTES } from './logos.ts';

test('validateLogoUpload: accepts png/jpeg/webp/svg → correct ext', () => {
  assert.deepEqual(validateLogoUpload({ slot: 'primary', contentType: 'image/png' }), { ok: true, ext: 'png' });
  assert.deepEqual(validateLogoUpload({ slot: 'icon', contentType: 'image/jpeg' }), { ok: true, ext: 'jpg' });
  assert.deepEqual(validateLogoUpload({ slot: 'monoLight', contentType: 'image/webp' }), { ok: true, ext: 'webp' });
  assert.deepEqual(validateLogoUpload({ slot: 'monoDark', contentType: 'image/svg+xml' }), { ok: true, ext: 'svg' });
});

test('validateLogoUpload: rejects unknown content type', () => {
  assert.equal(validateLogoUpload({ slot: 'primary', contentType: 'image/gif' }).ok, false);
  assert.equal(validateLogoUpload({ slot: 'primary', contentType: 'application/pdf' }).ok, false);
});

test('validateLogoUpload: rejects unknown slot', () => {
  assert.equal(validateLogoUpload({ slot: 'banner', contentType: 'image/png' }).ok, false);
  assert.equal(validateLogoUpload({ contentType: 'image/png' }).ok, false);
});

test('sanitizeLogos: keeps known string slots, drops unknown/non-string/empty', () => {
  assert.deepEqual(
    sanitizeLogos({
      primary: 'logos/a.png',
      icon: '',
      monoLight: 42,
      banner: 'x.png',
      monoDark: 'logos/d.svg',
    }),
    { primary: 'logos/a.png', monoDark: 'logos/d.svg' },
  );
});

test('sanitizeLogos: empty / garbage input → {}', () => {
  assert.deepEqual(sanitizeLogos(null), {});
  assert.deepEqual(sanitizeLogos('nope'), {});
  assert.deepEqual(sanitizeLogos({}), {});
});

test('LOGO_SLOTS + MAX_LOGO_BYTES: the four slots and the 2 MB guard', () => {
  assert.deepEqual([...LOGO_SLOTS], ['primary', 'monoLight', 'monoDark', 'icon']);
  assert.equal(MAX_LOGO_BYTES, 2 * 1024 * 1024);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/channels/logos.test.ts`
Expected: FAIL — cannot find module `./logos.ts`.

- [ ] **Step 3: Write `logos.ts`**

Create `src/lib/channels/logos.ts`:

```ts
// Pure channel-logo validation (Phase 8 — logo uploads). No react/server/network.
// brand_kit.logos is a 4-slot map of R2 keys; this validates an upload's type +
// slot and sanitizes a stored logos object. Key generation (uuid) lives in the
// server action, not here.

export const LOGO_SLOTS = ['primary', 'monoLight', 'monoDark', 'icon'] as const;
export type LogoSlot = (typeof LOGO_SLOTS)[number];
export type Logos = Partial<Record<LogoSlot, string>>; // slot → R2 key

export const MAX_LOGO_BYTES = 2 * 1024 * 1024; // 2 MB (client-side guard)

// Accepted upload content types → file extension.
const EXT_FOR_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};

export function isLogoSlot(value: unknown): value is LogoSlot {
  return typeof value === 'string' && (LOGO_SLOTS as readonly string[]).includes(value);
}

export function validateLogoUpload(
  input: unknown,
): { ok: true; ext: string } | { ok: false; reason: string } {
  if (!input || typeof input !== 'object') return { ok: false, reason: 'Invalid upload.' };
  const { slot, contentType } = input as { slot?: unknown; contentType?: unknown };
  if (!isLogoSlot(slot)) return { ok: false, reason: 'Unknown logo slot.' };
  const ext = typeof contentType === 'string' ? EXT_FOR_TYPE[contentType] : undefined;
  if (!ext) return { ok: false, reason: 'Use a PNG, JPEG, WebP, or SVG.' };
  return { ok: true, ext };
}

// Keep only the 4 known slots whose value is a non-empty string (R2 key).
export function sanitizeLogos(input: unknown): Logos {
  const out: Logos = {};
  if (!input || typeof input !== 'object') return out;
  const o = input as Record<string, unknown>;
  for (const slot of LOGO_SLOTS) {
    const v = o[slot];
    if (typeof v === 'string' && v) out[slot] = v;
  }
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/channels/logos.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/channels/logos.ts src/lib/channels/logos.test.ts
git commit -m "feat(channels): pure logo upload validation + sanitize + tests"
```

---

### Task 2: `set_channel_logos` migration

**Files:**
- Create: `supabase/migrations/20260618140000_set_channel_logos.sql`

**Interfaces:**
- Produces: SQL function `set_channel_logos(p_channel_id uuid, p_logos jsonb) returns uuid`.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260618140000_set_channel_logos.sql`:

```sql
-- Phase 8 — channel logos. Writes ONLY brand_kit.logos via jsonb_set
-- (create_missing=true), preserving sibling keys (colors, typography,
-- motion_preset, caption_emphasis) that other slices own. SECURITY INVOKER → the
-- caller's RLS on channels applies (acct_isolation with check
-- (auth_owns_account(account_id))). RETURNS the updated id (NULL when no row
-- matched) so the action never reports a phantom "Saved".
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

- [ ] **Step 2: Apply the migration**

Run: `npm run db:apply -- supabase/migrations/20260618140000_set_channel_logos.sql`
Expected: "Recorded migration 20260618140000 …" + "Applied …". If it reports BLOCKED (creds/duplicate), report the exact error rather than guessing.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260618140000_set_channel_logos.sql
git commit -m "feat(channels): set_channel_logos RPC (jsonb_set, returns id)"
```

---

### Task 3: Logo server actions (`createLogoUpload` + `saveChannelLogos`)

**Files:**
- Create: `src/app/(app)/channels/[id]/logo-actions.ts`

**Interfaces:**
- Consumes: `validateLogoUpload`, `sanitizeLogos`, `Logos` from `@/lib/channels/logos`; `signedPutUrl` from `@/lib/r2`; `createClient` from `@/lib/supabase/server`; the `set_channel_logos` RPC (Task 2); `randomUUID` from `node:crypto`.
- Produces:
  - `createLogoUpload(channelId: string, slot: string, input: { filename: string; contentType: string }): Promise<{ ok: true; uploadUrl: string; key: string } | { ok: false; reason: string }>`
  - `saveChannelLogos(channelId: string, logos: unknown): Promise<{ ok: true } | { ok: false; reason: string }>`

No unit test (thin orchestration; the logic is the tested `validateLogoUpload`/`sanitizeLogos`).

- [ ] **Step 1: Write the actions**

Create `src/app/(app)/channels/[id]/logo-actions.ts`:

```ts
'use server';

import { randomUUID } from 'node:crypto';
import { createClient } from '@/lib/supabase/server';
import { signedPutUrl } from '@/lib/r2';
import { validateLogoUpload, sanitizeLogos } from '@/lib/channels/logos';

// Reserve a signed PUT URL + R2 key for a logo upload. Does NOT touch brand_kit;
// the client PUTs the file bytes, then saveChannelLogos persists the keys. The
// account id is resolved from the session for the key path; ownership is enforced
// by the save RPC's RLS (and the page already 404s a non-owned channel).
export async function createLogoUpload(
  channelId: string,
  slot: string,
  input: { filename: string; contentType: string },
): Promise<{ ok: true; uploadUrl: string; key: string } | { ok: false; reason: string }> {
  const valid = validateLogoUpload({ slot, contentType: input.contentType });
  if (!valid.ok) return valid;

  const supabase = await createClient();
  const { data: account } = await supabase.from('accounts').select('id').maybeSingle();
  if (!account) return { ok: false, reason: 'No account found.' };

  const key = `logos/${account.id as string}/${channelId}/${slot}-${randomUUID()}.${valid.ext}`;
  const uploadUrl = await signedPutUrl(key, input.contentType);
  return { ok: true, uploadUrl, key };
}

// Persist the channel's logo set (slot → R2 key) via the set_channel_logos RPC.
// sanitizeLogos keeps only the 4 known slots with string keys. The RPC returns
// the id, or null when zero rows matched — a failure, not a phantom "Saved".
export async function saveChannelLogos(
  channelId: string,
  logos: unknown,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const clean = sanitizeLogos(logos);
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('set_channel_logos', {
    p_channel_id: channelId,
    p_logos: clean,
  });
  if (error) return { ok: false, reason: error.message };
  if (data == null) return { ok: false, reason: 'Channel not found.' };
  return { ok: true };
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors mentioning `logo-actions.ts`.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(app)/channels/[id]/logo-actions.ts"
git commit -m "feat(channels): logo upload actions (signed PUT + save via RPC)"
```

---

### Task 4: `LogosEditor` UI + page wiring

**Files:**
- Create: `src/app/(app)/channels/[id]/LogosEditor.tsx`
- Modify: `src/app/(app)/channels/[id]/page.tsx` (sign present logo keys, render the section)

**Interfaces:**
- Consumes: `createLogoUpload`, `saveChannelLogos` from `./logo-actions`; `LOGO_SLOTS`, `MAX_LOGO_BYTES`, `sanitizeLogos`, and the `Logos`/`LogoSlot` types from `@/lib/channels/logos`; `signedGetUrl` from `@/lib/r2`.
- Produces: the working Logos section.

No unit test (client form + server component — verified by the app-run).

- [ ] **Step 1: Create `LogosEditor.tsx`**

Create `src/app/(app)/channels/[id]/LogosEditor.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { createLogoUpload, saveChannelLogos } from './logo-actions';
import { LOGO_SLOTS, MAX_LOGO_BYTES, type Logos, type LogoSlot } from '@/lib/channels/logos';

const SLOT_LABELS: Record<LogoSlot, string> = {
  primary: 'Primary',
  monoLight: 'Mono (light)',
  monoDark: 'Mono (dark)',
  icon: 'Icon',
};
const ACCEPT = 'image/png,image/jpeg,image/webp,image/svg+xml';

// Channel logos editor (Phase 8 slice 4). Per-slot upload (client PUTs to a signed
// URL) + remove; one dirty-tracked Save persists the slot→key map. Stored only —
// not yet shown in videos. The "monoDark" preview sits on a dark swatch so a
// light/transparent mark stays visible.
export function LogosEditor({
  channelId,
  initial,
  initialPreviewUrls,
}: {
  channelId: string;
  initial: Logos;
  initialPreviewUrls: Partial<Record<LogoSlot, string>>;
}) {
  const [keys, setKeys] = useState<Logos>(initial);
  const [previews, setPreviews] = useState<Partial<Record<LogoSlot, string>>>(initialPreviewUrls);
  const [slotBusy, setSlotBusy] = useState<Partial<Record<LogoSlot, boolean>>>({});
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function onPick(slot: LogoSlot, file: File | undefined) {
    if (!file) return;
    setError(null);
    setSaved(false);
    if (file.size > MAX_LOGO_BYTES) {
      setError('Logo must be under 2 MB.');
      return;
    }
    setSlotBusy((b) => ({ ...b, [slot]: true }));
    try {
      const res = await createLogoUpload(channelId, slot, {
        filename: file.name,
        contentType: file.type,
      });
      if (!res.ok) {
        setError(res.reason);
        return;
      }
      const put = await fetch(res.uploadUrl, {
        method: 'PUT',
        body: file,
        headers: { 'Content-Type': file.type },
      });
      if (!put.ok) {
        setError(`Upload failed (${put.status}).`);
        return;
      }
      setKeys((k) => ({ ...k, [slot]: res.key }));
      setPreviews((p) => ({ ...p, [slot]: URL.createObjectURL(file) }));
      setDirty(true);
    } catch {
      setError('Upload failed. Please try again.');
    } finally {
      setSlotBusy((b) => ({ ...b, [slot]: false }));
    }
  }

  function onRemove(slot: LogoSlot) {
    setKeys((k) => {
      const next = { ...k };
      delete next[slot];
      return next;
    });
    setPreviews((p) => {
      const next = { ...p };
      delete next[slot];
      return next;
    });
    setDirty(true);
    setSaved(false);
  }

  async function onSave() {
    setBusy(true);
    setError(null);
    try {
      const res = await saveChannelLogos(channelId, keys);
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

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Logos</h2>
        <p className="text-sm opacity-70">
          Brand marks for this channel. Stored for now — not yet shown in videos.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {LOGO_SLOTS.map((slot) => {
          const url = previews[slot];
          return (
            <div
              key={slot}
              className="flex items-center gap-3 rounded-lg border border-black/10 p-3 dark:border-white/10"
            >
              <div
                className={`flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded border border-black/10 dark:border-white/10 ${
                  slot === 'monoDark' ? 'bg-neutral-800' : 'bg-black/5 dark:bg-white/5'
                }`}
              >
                {url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={url} alt={`${SLOT_LABELS[slot]} logo`} className="max-h-full max-w-full object-contain" />
                ) : (
                  <span className="text-xs opacity-40">none</span>
                )}
              </div>
              <div className="min-w-0 flex-1 space-y-1">
                <span className="text-sm font-medium">{SLOT_LABELS[slot]}</span>
                <div className="flex items-center gap-2">
                  <input
                    type="file"
                    accept={ACCEPT}
                    disabled={slotBusy[slot] || busy}
                    onChange={(e) => onPick(slot, e.target.files?.[0])}
                    className="block w-full text-xs file:mr-2 file:rounded file:border-0 file:bg-foreground file:px-2 file:py-1 file:text-background disabled:opacity-50"
                  />
                  {url && (
                    <button
                      type="button"
                      onClick={() => onRemove(slot)}
                      disabled={slotBusy[slot] || busy}
                      className="shrink-0 text-xs underline opacity-70 hover:opacity-100 disabled:opacity-40"
                    >
                      Remove
                    </button>
                  )}
                </div>
                {slotBusy[slot] && <span className="text-xs opacity-60">Uploading…</span>}
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={onSave}
          disabled={busy || !dirty}
          className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
        {saved && !dirty && <span className="text-sm text-green-600">Saved</span>}
        {error && <span className="text-sm text-red-600">{error}</span>}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire the section into `page.tsx`**

Edit `src/app/(app)/channels/[id]/page.tsx`. Add the imports, derive the sanitized logo keys, sign each present key into preview URLs, and render `<LogosEditor>` below the caption-emphasis section. Add these imports at the top (alongside the existing ones):

```tsx
import { signedGetUrl } from '@/lib/r2';
import { sanitizeLogos, type LogoSlot } from '@/lib/channels/logos';
import { LogosEditor } from './LogosEditor';
```

After the `emphasisInitial` line (before the `return`), add:

```tsx
  const logos = sanitizeLogos((channel.brand_kit as { logos?: unknown } | null)?.logos);
  const logoPreviewUrls: Partial<Record<LogoSlot, string>> = {};
  for (const [slot, key] of Object.entries(logos)) {
    logoPreviewUrls[slot as LogoSlot] = await signedGetUrl(key, 60 * 60);
  }
```

Then, inside the returned JSX, after the `<CaptionEmphasisEditor … />` element, add a divider + the section:

```tsx
      <hr className="border-black/10 dark:border-white/10" />

      <LogosEditor channelId={channel.id as string} initial={logos} initialPreviewUrls={logoPreviewUrls} />
```

(Leave the existing `<BrandEditor>` and `<CaptionEmphasisEditor>` wiring unchanged.)

- [ ] **Step 3: Typecheck + lint**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npx eslint "src/app/(app)/channels/[id]/LogosEditor.tsx" "src/app/(app)/channels/[id]/page.tsx"`
Expected: clean.

- [ ] **Step 4: App-run e2e (manual)**

Start the dev server. Verify:
1. Open `/channels/[id]` → the Logos section shows 4 empty slots ("none").
2. Upload a PNG to `primary` (preview appears) and an SVG to `icon` → Save → "Saved"; reload → both persist and preview from signed URLs.
3. Remove `primary` → Save → reload: `primary` empty, `icon` still there.
4. Pick an oversize file (>2 MB) → the "Logo must be under 2 MB." error shows and nothing uploads.
5. Pick a non-image (e.g. a `.pdf` if the picker allows) → `createLogoUpload` rejects with the type reason.
6. The slice-2 brand editor and slice-3 caption-emphasis section still save independently (a logo Save doesn't disturb colours/emphasis, and vice versa).

No render gate — logos are not consumed by the renderer.

**Likely gotcha — R2 CORS.** This is the FIRST browser-side PUT to R2 in the app (the Phase-5 resource flow only ran server-side). If the upload fails with a CORS error in the browser console (not an HTTP error from R2), the R2 bucket needs a CORS rule allowing `PUT` (and the `OPTIONS` preflight) + `Content-Type` header from the app origin (`http://localhost:3000` in dev, the Vercel origin in prod). This is an operator/bucket-config step, not a code change — surface it clearly if the PUT is blocked; do not work around it in code.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/channels/[id]/LogosEditor.tsx" "src/app/(app)/channels/[id]/page.tsx"
git commit -m "feat(channels): logos editor UI (per-slot upload + preview) + page wiring"
```

---

## Notes for the implementer

- Commit per task. Task 1 is TDD (RED→GREEN); 2 is the migration; 3–4 are build + typecheck/lint (verified by the manual app-run, no unit test).
- No renderer change and NO `deploy:remotion` gate — `bakeTheme` still emits `logos: {}`.
- The client PUT must send `Content-Type: file.type` — it must match the type `createLogoUpload` signed the URL with, or R2 rejects the PUT.
- The three channel-page sections (`BrandEditor`, `CaptionEmphasisEditor`, `LogosEditor`) save through different RPCs touching disjoint `brand_kit` keys; they are independent.
