# Multi-channel Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make channels first-class and self-serve — list + create channels, a per-channel detail shell, and a required channel picker in the video-create flow — removing the seeded-channel hardcode from the production create path.

**Architecture:** Plain channel CRUD is Tier 1 (direct Supabase under RLS): list/detail are server components, create is a server action that returns a discriminated union (the client redirects). The existing `startScriptGeneration` action drops its lazy seed and now requires a chosen, RLS-verified `channelId`.

**Tech Stack:** Next.js 16 App Router (React server + client components), Supabase JS under RLS, TypeScript, `node:test` via the project loader.

Design source: `docs/superpowers/specs/2026-06-17-multi-channel-foundation-design.md`.

## Global Constraints

- **No schema migration** — the `channels` table already has `name`, `brand_kit`, `brand_voice`, `voice_tts`, `defaults`, `status`, RLS by `account_id`.
- **`createChannel` MUST NOT call `redirect()`** — it returns `{ ok: true; channelId } | { ok: false; reason }`; only the client (`NewChannelForm`) navigates, on `{ ok: true }`.
- **`startScriptGeneration(prompt, channelId)`** — `channelId` is a required 2nd param. Missing / undefined / empty / non-string → throw `'Pick a channel to generate a video.'` as the FIRST check, before any DB work. A resolved-but-not-visible channel (RLS miss) → throw `'Channel not found.'`. No seed lookup, no auto-create.
- **Voice model is single-source** — channel create defaults use `ELEVENLABS_DEFAULT_MODEL` and `DEFAULT_VOICE_ID` from `@/lib/voice/elevenlabs`, never re-typed literals.
- **Channel create defaults:** `brand_kit: {}`, `brand_voice: {}`, `voice_tts: { voice_id: DEFAULT_VOICE_ID, model: ELEVENLABS_DEFAULT_MODEL }`, `defaults: {}`.
- **Channel names are NOT unique** — `name` is a display label; identity is the id.
- **List ordering is deterministic:** both the `/channels` list and the dashboard picker read order by `created_at desc` then `id desc` (the UUID `id` tiebreaker keeps "most recent" stable).
- **Zero-channels gate:** when the account has no channels, the create UI shows "Create a channel →" linking to `/channels`; no `<select>`, no `channels[0]` dereference on the empty path.
- **`render/actions.ts` is OUT OF SCOPE** — its independent `"Phase 1 Sandbox"` lazy seed (debug-only, behind `/render`) stays untouched.
- RLS via `@/lib/supabase/server`'s `createClient()`. Server actions begin with `'use server'`.
- Tests run via `npm test` (`node --experimental-strip-types --import ./scripts/register-loader.mjs --test "src/**/*.test.ts"`). Test imports use explicit `.ts` extensions (loader requirement).

---

### Task 1: `validateChannelName` pure module

**Files:**
- Create: `src/lib/channels/validate.ts`
- Test: `src/lib/channels/validate.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `MAX_CHANNEL_NAME: number` (= 60)
  - `validateChannelName(name: unknown): { ok: true; value: string } | { ok: false; reason: string }`

- [ ] **Step 1: Write the failing test**

Create `src/lib/channels/validate.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateChannelName, MAX_CHANNEL_NAME } from './validate.ts';

test('validateChannelName: rejects empty / whitespace / non-string', () => {
  assert.equal(validateChannelName('').ok, false);
  assert.equal(validateChannelName('   ').ok, false);
  assert.equal(validateChannelName(undefined).ok, false);
  assert.equal(validateChannelName(42).ok, false);
});

test('validateChannelName: rejects over-long', () => {
  const long = 'a'.repeat(MAX_CHANNEL_NAME + 1);
  assert.equal(validateChannelName(long).ok, false);
});

test('validateChannelName: accepts a name at the length limit', () => {
  const atLimit = 'a'.repeat(MAX_CHANNEL_NAME);
  assert.deepEqual(validateChannelName(atLimit), { ok: true, value: atLimit });
});

test('validateChannelName: trims and returns the trimmed value', () => {
  assert.deepEqual(validateChannelName('  My Channel  '), {
    ok: true,
    value: 'My Channel',
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/channels/validate.test.ts`
Expected: FAIL — cannot find module `./validate.ts`.

- [ ] **Step 3: Write the minimal implementation**

Create `src/lib/channels/validate.ts`:

```ts
// Pure channel-name validation — no react / server-only / network, so the
// node:test loader can import it directly. Length cap matches the spec.

export const MAX_CHANNEL_NAME = 60;

export type ValidateChannelNameResult =
  | { ok: true; value: string }
  | { ok: false; reason: string };

export function validateChannelName(name: unknown): ValidateChannelNameResult {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed) return { ok: false, reason: 'Enter a channel name.' };
  if (trimmed.length > MAX_CHANNEL_NAME) {
    return { ok: false, reason: 'Channel name is too long.' };
  }
  return { ok: true, value: trimmed };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/channels/validate.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/channels/validate.ts src/lib/channels/validate.test.ts
git commit -m "feat(channels): validateChannelName pure module + tests"
```

---

### Task 2: Channels surface — create action, list, detail shell, nav

**Files:**
- Create: `src/app/(app)/channels/actions.ts`
- Create: `src/app/(app)/channels/page.tsx`
- Create: `src/app/(app)/channels/NewChannelForm.tsx`
- Create: `src/app/(app)/channels/[id]/page.tsx`
- Modify: `src/app/(app)/layout.tsx` (add the "Channels" nav link)

**Interfaces:**
- Consumes: `validateChannelName` from `@/lib/channels/validate`; `DEFAULT_VOICE_ID`, `ELEVENLABS_DEFAULT_MODEL` from `@/lib/voice/elevenlabs`; `createClient` from `@/lib/supabase/server`.
- Produces:
  - `createChannel(name: string): Promise<{ ok: true; channelId: string } | { ok: false; reason: string }>` (`src/app/(app)/channels/actions.ts`)
  - The `/channels` and `/channels/[id]` routes.

This task has no unit test (server components + a server action + a client form — verified by the app-run e2e in Task 3's check and below). Build it, typecheck it, lint it, commit it.

- [ ] **Step 1: Create the `createChannel` server action**

Create `src/app/(app)/channels/actions.ts`:

```ts
'use server';

import { createClient } from '@/lib/supabase/server';
import { validateChannelName } from '@/lib/channels/validate';
import { DEFAULT_VOICE_ID, ELEVENLABS_DEFAULT_MODEL } from '@/lib/voice/elevenlabs';

export type CreateChannelResult =
  | { ok: true; channelId: string }
  | { ok: false; reason: string };

// Creates a channel under the signed-in account with safe defaults so it
// renders before the brand editor (slice 2) exists — bakeTheme backfills the
// full DEFAULT_THEME from an empty brand_kit. NEVER calls redirect(): the
// discriminated-union return must survive; the client routes on ok:true.
export async function createChannel(name: string): Promise<CreateChannelResult> {
  const valid = validateChannelName(name);
  if (!valid.ok) return valid;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, reason: 'Not signed in.' };

  // accounts: RLS scopes to owner_user_id = auth.uid() and accounts_owner_idx is
  // UNIQUE on owner_user_id, so a session sees at most one account. maybeSingle()
  // turns the zero-row edge (e.g. signup-trigger race) into a clean null →
  // friendly reason, never a thrown PostgREST error.
  const { data: account } = await supabase
    .from('accounts')
    .select('id')
    .maybeSingle();
  if (!account) return { ok: false, reason: 'No account found.' };

  // The channels INSERT is independently RLS-checked: policy acct_isolation has
  // `with check (auth_owns_account(account_id))`, so account_id must belong to
  // the caller — the insert can't smuggle another account's id.
  const { data, error } = await supabase
    .from('channels')
    .insert({
      account_id: account.id as string,
      name: valid.value,
      brand_kit: {},
      brand_voice: {},
      voice_tts: { voice_id: DEFAULT_VOICE_ID, model: ELEVENLABS_DEFAULT_MODEL },
      defaults: {},
    })
    .select('id')
    .single();
  if (error || !data) {
    return { ok: false, reason: `Could not create channel: ${error?.message ?? 'unknown'}` };
  }

  return { ok: true, channelId: data.id as string };
}
```

- [ ] **Step 2: Create the `NewChannelForm` client component**

Create `src/app/(app)/channels/NewChannelForm.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createChannel } from './actions';

// Inline create: a name → createChannel → route to the new channel's detail
// page on success. On failure, keep the form open and show the reason. The
// redirect lives here (not in the action), so the action's return survives.
export function NewChannelForm() {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function onCreate() {
    setBusy(true);
    setError(null);
    try {
      const res = await createChannel(name);
      if (res.ok) {
        router.push(`/channels/${res.channelId}`);
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
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={busy}
          placeholder="New channel name"
          className="flex-1 rounded-md border border-black/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-black/40 disabled:opacity-50 dark:border-white/15 dark:focus:border-white/40"
        />
        <button
          onClick={onCreate}
          disabled={busy || !name.trim()}
          className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background disabled:opacity-50"
        >
          {busy ? 'Creating…' : 'Create channel'}
        </button>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
```

- [ ] **Step 3: Create the `/channels` list page**

Create `src/app/(app)/channels/page.tsx`:

```tsx
import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { NewChannelForm } from './NewChannelForm';

// Lists the account's channels (RLS-scoped) with inline create. Each row links
// to the detail page (the brand editor is slice 2; today it's a shell). Order
// is created_at desc, id desc so "most recent" is deterministic.
export default async function ChannelsPage() {
  const supabase = await createClient();
  const { data: channels, error } = await supabase
    .from('channels')
    .select('id, name, status, created_at')
    .order('created_at', { ascending: false })
    .order('id', { ascending: false });

  const list = channels ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Channels</h1>
        <p className="text-sm opacity-70">
          Each channel carries its own brand. Pick one when you create a video.
        </p>
      </div>

      <section className="rounded-lg border border-black/10 p-4 dark:border-white/10">
        <NewChannelForm />
      </section>

      <section className="space-y-2">
        {error && (
          <p className="text-sm text-red-600">Could not load channels: {error.message}</p>
        )}
        {list.length === 0 ? (
          <p className="text-sm opacity-70">No channels yet. Create your first one above.</p>
        ) : (
          <ul className="divide-y divide-black/10 rounded-lg border border-black/10 dark:divide-white/10 dark:border-white/10">
            {list.map((c) => (
              <li key={c.id as string}>
                <Link
                  href={`/channels/${c.id}`}
                  className="flex items-center justify-between px-4 py-3 text-sm hover:bg-black/5 dark:hover:bg-white/5"
                >
                  <span className="font-medium">{c.name as string}</span>
                  <span className="opacity-50">{c.status as string}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
```

- [ ] **Step 4: Create the `/channels/[id]` detail shell**

Create `src/app/(app)/channels/[id]/page.tsx` (param access matches `videos/[id]/page.tsx`: `params` is a Promise, awaited):

```tsx
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';

// Channel detail SHELL. Slice 2 fills this with the brand-identity editor
// (colors, font, motion, brand-voice tone, defaults). For now: the name plus
// a placeholder. RLS scopes the read; a miss (not found OR not owned) → 404.
export default async function ChannelDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: channel } = await supabase
    .from('channels')
    .select('id, name')
    .eq('id', id)
    .maybeSingle();

  if (!channel) notFound();

  return (
    <div className="space-y-6">
      <Link href="/channels" className="text-sm underline opacity-70 hover:opacity-100">
        ← Channels
      </Link>
      <div>
        <h1 className="text-2xl font-semibold">{channel.name as string}</h1>
        <p className="text-sm opacity-70">Brand settings — coming next.</p>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Add the "Channels" nav link**

In `src/app/(app)/layout.tsx`, add a link after the Primitives link (inside the `<nav>`, after lines 30-32):

```tsx
          <Link href="/primitives" className="text-sm opacity-70 hover:opacity-100">
            Primitives
          </Link>
          <Link href="/channels" className="text-sm opacity-70 hover:opacity-100">
            Channels
          </Link>
```

- [ ] **Step 6: Typecheck and lint**

Run: `npx tsc --noEmit`
Expected: no errors mentioning the new `channels` files.

Run: `npx eslint "src/app/(app)/channels/actions.ts" "src/app/(app)/channels/page.tsx" "src/app/(app)/channels/NewChannelForm.tsx" "src/app/(app)/channels/[id]/page.tsx" "src/app/(app)/layout.tsx"`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add "src/app/(app)/channels" "src/app/(app)/layout.tsx"
git commit -m "feat(channels): channels list, create action, detail shell, nav link"
```

---

### Task 3: Video-create flow — require a chosen channel

**Files:**
- Modify: `src/app/(app)/videos/actions.ts` (the `startScriptGeneration` signature + seed removal)
- Modify: `src/app/(app)/dashboard/page.tsx` (read channels, pass to `PromptBox`)
- Modify: `src/app/(app)/dashboard/PromptBox.tsx` (picker + zero-channels gate + pass `channelId`)

**Interfaces:**
- Consumes: `createClient` from `@/lib/supabase/server`; the channels created by Task 2.
- Produces: `startScriptGeneration(prompt: string, channelId: string): Promise<{ videoId: string; jobId: string }>`.

No unit test (server action + server/client component wiring — verified by the app-run e2e in Step 5).

- [ ] **Step 1: Rewrite `startScriptGeneration` (signature + seed removal)**

In `src/app/(app)/videos/actions.ts`:

1. Delete the `DEFAULT_VOICE_ID` import (line 10) — it was only used by `SEED_BRAND`.
2. Delete the `SEED_CHANNEL` and `SEED_BRAND` constants (lines 12-19).
3. Replace the function signature, the prompt check, and the seed block (lines 33-72) so the resolved channel comes from the passed `channelId`. The result:

```ts
// Prompt + chosen channel → new video → generation job. Returns the video id so
// the caller can open the editor, where scenes stream in over Realtime. The
// channel is required and RLS-verified — no channel is ever auto-created.
export async function startScriptGeneration(
  prompt: string,
  channelId: string,
): Promise<{ videoId: string; jobId: string }> {
  const trimmed = prompt.trim();
  if (!trimmed) throw new Error('Enter a prompt.');
  // Required-channel contract (also covers a stale client during the rollout):
  if (typeof channelId !== 'string' || !channelId.trim()) {
    throw new Error('Pick a channel to generate a video.');
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in.');

  const { data: account, error: acctErr } = await supabase
    .from('accounts')
    .select('id')
    .single();
  if (acctErr || !account) throw new Error(`No account: ${acctErr?.message ?? 'not found'}`);
  const accountId = account.id as string;

  // Resolve the chosen channel. RLS scopes the read to this account, so a miss
  // covers both not-found and not-owned.
  const { data: channel } = await supabase
    .from('channels')
    .select('id, name, brand_voice')
    .eq('id', channelId)
    .maybeSingle();
  if (!channel) throw new Error('Channel not found.');
  const tone = (channel.brand_voice as { tone?: string } | null)?.tone;
```

4. The video insert keeps using the resolved channel — change `channel_id: channelId` to `channel_id: channel.id as string` (functionally the same id, but sourced from the verified row). The job insert and config block are unchanged.

5. Update the `brand` line (was line 115, `channelName: SEED_CHANNEL`) to:

```ts
  const brand: BrandContext = { channelName: channel.name as string, tone };
```

Leave the `videos` insert (`prompt: trimmed`, `settings: SEED_VIDEO_SETTINGS`), the `jobs` insert, the `config`, and the `inngest.send` exactly as they are. `SEED_VIDEO_SETTINGS` stays (it is the per-video config seed, unrelated to the channel seed).

- [ ] **Step 2: Read channels in the dashboard and pass them to `PromptBox`**

In `src/app/(app)/dashboard/page.tsx`, after the existing `account` read (after line 18), add the channels read, and pass it to `PromptBox` (replace `<PromptBox />` on line 33):

```tsx
  const { data: channels } = await supabase
    .from('channels')
    .select('id, name')
    .order('created_at', { ascending: false })
    .order('id', { ascending: false });

  const channelOptions = (channels ?? []).map((c) => ({
    id: c.id as string,
    name: c.name as string,
  }));
```

```tsx
        <PromptBox channels={channelOptions} />
```

- [ ] **Step 3: Add the picker + gate to `PromptBox`**

Replace `src/app/(app)/dashboard/PromptBox.tsx` entirely:

```tsx
'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { startScriptGeneration } from '../videos/actions';

type ChannelOption = { id: string; name: string };

// The Phase 2 entry point: pick a channel, type a prompt, create a video and
// open its editor. A channel is required; with none, the create flow is gated
// behind "Create a channel →" (no auto-seed).
export function PromptBox({ channels }: { channels: ChannelOption[] }) {
  const [prompt, setPrompt] = useState('');
  const [channelId, setChannelId] = useState(channels[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function onGenerate() {
    setBusy(true);
    setError(null);
    try {
      const { videoId } = await startScriptGeneration(prompt, channelId);
      router.push(`/videos/${videoId}`); // leaves this page; keep busy=true
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  // Zero-channels gate: never dereferences channels[0]; no select rendered.
  if (channels.length === 0) {
    return (
      <p className="text-sm">
        You need a channel first.{' '}
        <Link href="/channels" className="underline">
          Create a channel →
        </Link>
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <select
        value={channelId}
        onChange={(e) => setChannelId(e.target.value)}
        disabled={busy}
        className="w-full rounded-md border border-black/15 bg-transparent p-2 text-sm outline-none focus:border-black/40 disabled:opacity-50 dark:border-white/15 dark:focus:border-white/40"
      >
        {channels.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        disabled={busy}
        rows={3}
        placeholder="Describe the video you want — e.g. “Why your coffee goes cold so fast”"
        className="w-full resize-y rounded-md border border-black/15 bg-transparent p-3 text-sm outline-none focus:border-black/40 disabled:opacity-50 dark:border-white/15 dark:focus:border-white/40"
      />
      <div className="flex items-center gap-3">
        <button
          onClick={onGenerate}
          disabled={busy || !prompt.trim()}
          className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background disabled:opacity-50"
        >
          {busy ? 'Generating…' : 'Generate script'}
        </button>
        {busy && <span className="text-sm opacity-60">Creating your video…</span>}
      </div>
      {error && (
        <pre className="overflow-auto rounded-md border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-600">
          {error}
        </pre>
      )}
    </div>
  );
}
```

Note: all hooks (`useState` ×4, `useRouter`) run before the `channels.length === 0` early return, so the Rules of Hooks hold.

- [ ] **Step 4: Typecheck and lint**

Run: `npx tsc --noEmit`
Expected: no errors. (If anything else in the repo called `startScriptGeneration` with one arg, it would surface here — only `PromptBox` does, and it now passes two.)

Run: `npx eslint "src/app/(app)/videos/actions.ts" "src/app/(app)/dashboard/page.tsx" "src/app/(app)/dashboard/PromptBox.tsx"`
Expected: clean.

- [ ] **Step 5: App-run e2e verification**

Start the dev server (`npm run dev`) and Inngest dev as in prior slices, then verify:

1. **Create + list + detail:** open `/channels` → create a channel → it appears in the list → click it → the detail shell shows the name + "Brand settings — coming next".
2. **Picker + generate:** open `/dashboard` → the channel appears in the picker → type a prompt → Generate → the editor opens and scenes stream. Confirm `videos.channel_id` matches the picked channel and `BrandContext.channelName` is that channel's name (visible in the generation prompt / logs).
3. **Zero-channels gate (reasoned + optional):** the operator's account already has channels, so the gate won't show in normal use. Confirm by reading the path: an empty `channels` array renders the "Create a channel →" link and never reaches the `<select>` / `channels[0]`. A brand-new account exercises it directly.
4. **Stale-client contract:** in the browser console or a quick scratch call, invoke the create with no channel and confirm it throws `'Pick a channel to generate a video.'` rather than crashing or seeding.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(app)/videos/actions.ts" "src/app/(app)/dashboard/page.tsx" "src/app/(app)/dashboard/PromptBox.tsx"
git commit -m "feat(channels): require a chosen channel in the create flow; drop the seed"
```

---

## Verified preconditions (RLS)

Confirmed against `supabase/migrations/20260604184050_init_schema.sql` before planning — do not re-litigate:

- **One account per session.** `accounts_owner_idx` is UNIQUE on `owner_user_id` (schema:102) and policy `accounts_owner` is `using (owner_user_id = auth.uid()) with check (...)` (schema:548-550). A session sees at most one account; `.single()`/`.maybeSingle()` is safe.
- **Channel INSERT scopes `account_id` to the caller.** Policy `acct_isolation on channels for all using (auth_owns_account(account_id)) with check (auth_owns_account(account_id))` (schema:563-564); `auth_owns_account` checks `owner_user_id = auth.uid()` (schema:107-114). The `with check` binds the INSERT, so a wrong `account_id` is rejected — the select→insert is not a trust gap.
- **`ELEVENLABS_DEFAULT_MODEL` exists** at `@/lib/voice/elevenlabs` (`= 'eleven_multilingual_v2'`), exported alongside `DEFAULT_VOICE_ID`. No new export needed.

## Notes for the implementer

- Run each task on its own; commit per task (Task 2 is one multi-file commit, the channels surface).
- Do not touch `src/app/(app)/render/actions.ts` — its `"Phase 1 Sandbox"` seed is intentionally retained (debug-only).
- The `channels` table needs no migration. An INSERT can only RLS-fail if the session is unauthenticated (every `(app)` route is behind the layout's auth gate) — `account_id` is the session's own account, which the `with check` policy permits.
