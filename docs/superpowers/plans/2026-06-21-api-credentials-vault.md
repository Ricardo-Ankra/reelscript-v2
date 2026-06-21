# API credentials vault Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator store, encrypt-at-rest, validate, and remove per-account API keys for anthropic/elevenlabs/pexels/pixabay on `/settings`, and have the pipeline use a stored key when present (env var fallback otherwise).

**Architecture:** A pure AES-256-GCM crypto module (key injected) + a server-only store/resolver/validators over the deployed `api_credentials` table (direct RLS writes, no migration) + `/settings` actions and a write-only editor + consumption wiring for all four providers with env fallback (`anthropic(apiKey?)` becomes per-account; elevenlabs/pexels/pixabay clients gain an optional `apiKey`).

**Tech Stack:** TypeScript, `node:crypto` (AES-256-GCM), Next.js App Router (RSC + `'use server'` actions + a client editor), Supabase (RLS), Inngest (render/synth workers), `node:test`.

## Global Constraints

- No schema change/migration — `api_credentials` + RLS exist. Writes are direct RLS ops scoped by `account_id`; delete uses `.select('id')` (no row → friendly not-found, no phantom save).
- The crypto module `src/lib/credentials/crypto.ts` is PURE: imports only `node:crypto`; the key is a function PARAMETER (never read from env inside it).
- Encryption: AES-256-GCM. `encryptSecret` returns `"iv.ciphertext.tag"` (each part base64; random 12-byte iv per call). `decryptSecret` throws on a malformed payload or failed auth tag.
- New env `CREDENTIALS_ENCRYPTION_KEY` (64 hex chars = 32 bytes) via `serverEnv.credentials.encryptionKey` (required getter). Add to `.env.example`.
- Providers in scope (a single source of truth list): `CREDENTIAL_PROVIDERS = ['anthropic','elevenlabs','pexels','pixabay']`. NOT openai/google (no consumer).
- `resolveProviderKey` returns the decrypted stored key when a row exists AND `status !== 'invalid'`; otherwise `undefined`. A decrypt failure is caught → `undefined`. Consumers fall back to the env var on `undefined`.
- The decrypted key is NEVER returned from an Inngest `step.run` (step state is serialized/stored). Resolve it inside the scope that uses it.
- `encrypted_value` is NEVER sent to the client — the page reads only `provider, status, last_validated_at`; the key input is write-only.
- `saveCredential` stores `label = ''` (sentinel) and upserts on `onConflict: 'account_id,provider,label'` (NULL labels are distinct in Postgres, so a sentinel enforces one key per provider).
- Env-fallback parity: an account with no stored key must behave byte-identically to today; `anthropic()` with no argument is unchanged (env-cached singleton).
- Test command (single file): `node --experimental-strip-types --import ./scripts/register-loader.mjs --test <path>`. Full suite: `npm test`. Test imports use explicit `.ts` extensions.
- Commit footer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Stage only the files each task names — there is unrelated `package-lock.json` drift; never `git add -A`.

---

## File Structure

- `src/lib/credentials/crypto.ts` (create) + `crypto.test.ts` — pure AES-256-GCM.
- `src/lib/env.server.ts` (modify) — `credentials.encryptionKey` getter.
- `.env.example` (modify) — `CREDENTIALS_ENCRYPTION_KEY`.
- `src/lib/credentials/store.ts` (create) — `CREDENTIAL_PROVIDERS`, `saveCredential`, `resolveProviderKey`, `validateProviderKey`.
- `src/app/(app)/settings/credential-actions.ts` (create) — save/test/delete actions.
- `src/app/(app)/settings/CredentialsEditor.tsx` (create) + `page.tsx` (modify) — UI.
- `src/lib/voice/elevenlabs.ts` (modify) + `synthesize-voice.ts` + `channels/[id]/voice-actions.ts` + `settings/voice-profile-actions.ts` — elevenlabs consumption.
- `src/lib/assets/{pexels,pixabay,search}.ts` (modify) + `render.ts` — stock consumption.
- `src/lib/ai/anthropic.ts` (modify) + the 8 anthropic call sites — anthropic consumption.

---

## Task 1: Pure AES-256-GCM crypto

**Files:**
- Create: `src/lib/credentials/crypto.ts`
- Test: `src/lib/credentials/crypto.test.ts`

**Interfaces:**
- Consumes: `node:crypto`.
- Produces: `encryptSecret(plaintext: string, keyHex: string): string`; `decryptSecret(payload: string, keyHex: string): string`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/credentials/crypto.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encryptSecret, decryptSecret } from './crypto.ts';

// A fixed 32-byte key (64 hex chars) for deterministic tests.
const KEY = '0'.repeat(64);

test('encryptSecret/decryptSecret: round-trips', () => {
  const plain = 'sk-ant-secret-value-123';
  const enc = encryptSecret(plain, KEY);
  assert.equal(decryptSecret(enc, KEY), plain);
});

test('encryptSecret: two encryptions differ (random iv) but both decrypt', () => {
  const a = encryptSecret('same', KEY);
  const b = encryptSecret('same', KEY);
  assert.notEqual(a, b);
  assert.equal(decryptSecret(a, KEY), 'same');
  assert.equal(decryptSecret(b, KEY), 'same');
});

test('decryptSecret: throws on a tampered payload', () => {
  const enc = encryptSecret('secret', KEY);
  const [iv, ct, tag] = enc.split('.');
  // Flip the last char of the ciphertext.
  const flipped = ct.slice(0, -1) + (ct.slice(-1) === 'A' ? 'B' : 'A');
  assert.throws(() => decryptSecret([iv, flipped, tag].join('.'), KEY));
});

test('decryptSecret: throws on a malformed payload', () => {
  assert.throws(() => decryptSecret('not-a-valid-payload', KEY));
});

test('decryptSecret: wrong key throws', () => {
  const enc = encryptSecret('secret', KEY);
  assert.throws(() => decryptSecret(enc, 'f'.repeat(64)));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/credentials/crypto.test.ts`
Expected: FAIL — module/exports do not exist.

- [ ] **Step 3: Implement**

Create `src/lib/credentials/crypto.ts`:

```ts
// App-layer secret encryption (Phase 8). AES-256-GCM via node:crypto. PURE: the key
// is injected as a 64-hex-char string (32 bytes) so this is unit-testable with a
// fixed key and never reads env. Payload format: "iv.ciphertext.tag" (each base64).
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12; // GCM standard nonce length

function keyBuffer(keyHex: string): Buffer {
  const buf = Buffer.from(keyHex, 'hex');
  if (buf.length !== 32) {
    throw new Error('Encryption key must be 64 hex characters (32 bytes).');
  }
  return buf;
}

export function encryptSecret(plaintext: string, keyHex: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, keyBuffer(keyHex), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), ciphertext.toString('base64'), tag.toString('base64')].join('.');
}

export function decryptSecret(payload: string, keyHex: string): string {
  const parts = payload.split('.');
  if (parts.length !== 3) throw new Error('Malformed encrypted payload.');
  const [ivB64, ctB64, tagB64] = parts;
  const iv = Buffer.from(ivB64, 'base64');
  const ciphertext = Buffer.from(ctB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  if (iv.length !== IV_BYTES) throw new Error('Malformed encrypted payload (iv).');
  const decipher = createDecipheriv(ALGO, keyBuffer(keyHex), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/credentials/crypto.test.ts`
Expected: PASS (all 5).

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/credentials/crypto.ts src/lib/credentials/crypto.test.ts
git commit -m "feat(credentials): pure AES-256-GCM secret encryption

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Credential store, resolver, validators + env getter

**Files:**
- Create: `src/lib/credentials/store.ts`
- Modify: `src/lib/env.server.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes (Task 1): `encryptSecret`, `decryptSecret` from `./crypto`. Existing: `serverEnv`.
- Produces:
  - `CREDENTIAL_PROVIDERS` (`readonly ['anthropic','elevenlabs','pexels','pixabay']`), `type CredentialProvider`.
  - `saveCredential(client, accountId, provider, plaintext): Promise<string | null>`
  - `resolveProviderKey(client, accountId, provider): Promise<string | undefined>`
  - `validateProviderKey(provider, apiKey): Promise<boolean>`
  - `serverEnv.credentials.encryptionKey`.

- [ ] **Step 1: Add the env getter**

In `src/lib/env.server.ts`, add a `credentials` group to the `serverEnv` object (after `elevenlabs`):

```ts
  // App-layer encryption key for stored provider credentials (Phase 8). 64 hex
  // chars (32 bytes). Only read when the credentials feature is used — an account
  // on env-var keys never needs it.
  credentials: {
    get encryptionKey() {
      return required('CREDENTIALS_ENCRYPTION_KEY');
    },
  },
```

- [ ] **Step 2: Document the env var**

In `.env.example`, add a line:

```
# App-layer encryption key for stored API credentials (Phase 8). Generate with:
#   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
CREDENTIALS_ENCRYPTION_KEY=
```

- [ ] **Step 3: Implement the store**

Create `src/lib/credentials/store.ts`:

```ts
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { serverEnv } from '../env.server';
import { encryptSecret, decryptSecret } from './crypto';

// Per-account API credential store (Phase 8). Encrypt-at-rest over the deployed
// api_credentials table (RLS-scoped). resolveProviderKey gives a consumer the
// account's key, falling back (caller-side) to the env var on undefined.

export const CREDENTIAL_PROVIDERS = ['anthropic', 'elevenlabs', 'pexels', 'pixabay'] as const;
export type CredentialProvider = (typeof CREDENTIAL_PROVIDERS)[number];

// Single key per provider: a fixed sentinel label (NULLs are distinct under the
// unique constraint, so we use '' to make "one per provider" enforceable).
const LABEL = '';

// Encrypt + upsert (status reset to 'unverified'); returns the row id, or null when
// no account matched. Never returns the plaintext.
export async function saveCredential(
  client: SupabaseClient,
  accountId: string,
  provider: CredentialProvider,
  plaintext: string,
): Promise<string | null> {
  const encrypted = encryptSecret(plaintext, serverEnv.credentials.encryptionKey);
  const { data, error } = await client
    .from('api_credentials')
    .upsert(
      {
        account_id: accountId,
        provider,
        label: LABEL,
        encrypted_value: encrypted,
        status: 'unverified',
        last_validated_at: null,
      },
      { onConflict: 'account_id,provider,label' },
    )
    .select('id')
    .single();
  if (error || !data) return null;
  return data.id as string;
}

// The account's stored key for a provider, decrypted, when a row exists AND its
// status is not 'invalid'. Any failure (no row, missing env key, decrypt error) →
// undefined, so a consumer cleanly falls back to its env var.
export async function resolveProviderKey(
  client: SupabaseClient,
  accountId: string,
  provider: CredentialProvider,
): Promise<string | undefined> {
  try {
    const { data } = await client
      .from('api_credentials')
      .select('encrypted_value, status')
      .eq('account_id', accountId)
      .eq('provider', provider)
      .eq('label', LABEL)
      .maybeSingle();
    if (!data || data.status === 'invalid' || !data.encrypted_value) return undefined;
    return decryptSecret(data.encrypted_value as string, serverEnv.credentials.encryptionKey);
  } catch {
    return undefined;
  }
}

// One cheap authenticated call per provider → is the key live? Network/non-2xx → false.
export async function validateProviderKey(
  provider: CredentialProvider,
  apiKey: string,
): Promise<boolean> {
  try {
    if (provider === 'anthropic') {
      const res = await fetch('https://api.anthropic.com/v1/models?limit=1', {
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      });
      return res.ok;
    }
    if (provider === 'elevenlabs') {
      const res = await fetch('https://api.elevenlabs.io/v1/models', {
        headers: { 'xi-api-key': apiKey },
      });
      return res.ok;
    }
    if (provider === 'pexels') {
      const res = await fetch('https://api.pexels.com/v1/search?query=test&per_page=1', {
        headers: { Authorization: apiKey },
      });
      return res.ok;
    }
    // pixabay
    const res = await fetch(
      `https://pixabay.com/api/?key=${encodeURIComponent(apiKey)}&q=test&per_page=3`,
    );
    return res.ok;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Type-check + lint**

Run: `npx tsc --noEmit` then `npm run lint`
Expected: both clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/credentials/store.ts src/lib/env.server.ts .env.example
git commit -m "feat(credentials): store, resolver, and per-provider validators

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Credential server actions

**Files:**
- Create: `src/app/(app)/settings/credential-actions.ts`

**Interfaces:**
- Consumes (Task 2): `CREDENTIAL_PROVIDERS`, `type CredentialProvider`, `saveCredential`, `resolveProviderKey`, `validateProviderKey` from `@/lib/credentials/store`. Existing: `createClient` from `@/lib/supabase/server`.
- Produces:
  - `saveProviderCredential(provider, plaintext): Promise<{ ok: true } | { ok: false; reason: string }>`
  - `testProviderCredential(provider): Promise<{ ok: true; status: 'valid' | 'invalid' } | { ok: false; reason: string }>`
  - `deleteProviderCredential(provider): Promise<{ ok: true } | { ok: false; reason: string }>`

- [ ] **Step 1: Write the actions**

Create `src/app/(app)/settings/credential-actions.ts`:

```ts
'use server';

import { createClient } from '@/lib/supabase/server';
import {
  CREDENTIAL_PROVIDERS,
  saveCredential,
  resolveProviderKey,
  validateProviderKey,
  type CredentialProvider,
} from '@/lib/credentials/store';

function isProvider(p: string): p is CredentialProvider {
  return (CREDENTIAL_PROVIDERS as readonly string[]).includes(p);
}

async function accountId(supabase: Awaited<ReturnType<typeof createClient>>): Promise<string | null> {
  const { data } = await supabase.from('accounts').select('id').maybeSingle();
  return (data?.id as string | undefined) ?? null;
}

// Encrypt + store a provider key (status reset to 'unverified').
export async function saveProviderCredential(
  provider: string,
  plaintext: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!isProvider(provider)) return { ok: false, reason: 'Unknown provider.' };
  if (typeof plaintext !== 'string' || plaintext.trim() === '') {
    return { ok: false, reason: 'Enter a key.' };
  }
  const supabase = await createClient();
  const id = await accountId(supabase);
  if (!id) return { ok: false, reason: 'No account found.' };
  try {
    const saved = await saveCredential(supabase, id, provider, plaintext.trim());
    if (!saved) return { ok: false, reason: 'Could not save the credential.' };
    return { ok: true };
  } catch {
    return { ok: false, reason: 'Encryption is not configured (CREDENTIALS_ENCRYPTION_KEY).' };
  }
}

// Decrypt the stored key, validate it against the provider, persist the verdict.
export async function testProviderCredential(
  provider: string,
): Promise<{ ok: true; status: 'valid' | 'invalid' } | { ok: false; reason: string }> {
  if (!isProvider(provider)) return { ok: false, reason: 'Unknown provider.' };
  const supabase = await createClient();
  const id = await accountId(supabase);
  if (!id) return { ok: false, reason: 'No account found.' };

  const key = await resolveProviderKey(supabase, id, provider);
  if (!key) return { ok: false, reason: 'No stored key to test (or it could not be decrypted).' };

  const valid = await validateProviderKey(provider, key);
  const status: 'valid' | 'invalid' = valid ? 'valid' : 'invalid';
  const { data, error } = await supabase
    .from('api_credentials')
    .update({ status, last_validated_at: new Date().toISOString() })
    .eq('account_id', id)
    .eq('provider', provider)
    .select('id');
  if (error || !data || data.length === 0) return { ok: false, reason: 'Credential not found.' };
  return { ok: true, status };
}

// Remove a stored credential.
export async function deleteProviderCredential(
  provider: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!isProvider(provider)) return { ok: false, reason: 'Unknown provider.' };
  const supabase = await createClient();
  const id = await accountId(supabase);
  if (!id) return { ok: false, reason: 'No account found.' };
  const { data, error } = await supabase
    .from('api_credentials')
    .delete()
    .eq('account_id', id)
    .eq('provider', provider)
    .select('id');
  if (error) return { ok: false, reason: error.message };
  if (!data || data.length === 0) return { ok: false, reason: 'Credential not found.' };
  return { ok: true };
}
```

Note: `resolveProviderKey` skips a key whose status is `'invalid'`, so re-testing a previously-invalid key would always fail to load. Since `saveProviderCredential` resets status to `'unverified'` on every save, the operator re-saves to re-test — acceptable for V1. (Do NOT change `resolveProviderKey` here.)

- [ ] **Step 2: Type-check + lint**

Run: `npx tsc --noEmit` then `npm run lint`
Expected: both clean.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(app)/settings/credential-actions.ts"
git commit -m "feat(credentials): settings actions (save/test/delete)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Credentials editor UI

**Files:**
- Create: `src/app/(app)/settings/CredentialsEditor.tsx`
- Modify: `src/app/(app)/settings/page.tsx`

**Interfaces:**
- Consumes (Task 2): `CREDENTIAL_PROVIDERS` from `@/lib/credentials/store`. (Task 3): `saveProviderCredential`, `testProviderCredential`, `deleteProviderCredential` from `./credential-actions`.
- Produces: `type CredentialRow = { provider: string; status: string; lastValidatedAt: string | null }`; `export function CredentialsEditor({ initial }: { initial: CredentialRow[] })`.

- [ ] **Step 1: Create the editor**

Create `src/app/(app)/settings/CredentialsEditor.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { CREDENTIAL_PROVIDERS } from '@/lib/credentials/store';
import {
  saveProviderCredential,
  testProviderCredential,
  deleteProviderCredential,
} from './credential-actions';

export type CredentialRow = { provider: string; status: string; lastValidatedAt: string | null };

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  elevenlabs: 'ElevenLabs',
  pexels: 'Pexels',
  pixabay: 'Pixabay',
};

function statusBadge(status: string): { label: string; className: string } {
  switch (status) {
    case 'valid':
      return { label: 'Valid', className: 'text-green-600' };
    case 'invalid':
      return { label: 'Invalid', className: 'text-red-600' };
    case 'unverified':
      return { label: 'Unverified', className: 'text-amber-600' };
    default:
      return { label: 'Not set', className: 'opacity-50' };
  }
}

function ProviderRow({ provider, initialStatus }: { provider: string; initialStatus: string }) {
  const [status, setStatus] = useState(initialStatus);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const badge = statusBadge(status);

  async function onSave() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await saveProviderCredential(provider, value);
      if (res.ok) {
        setValue('');
        setStatus('unverified');
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

  async function onTest() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await testProviderCredential(provider);
      if (res.ok) setStatus(res.status);
      else setError(res.reason);
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  async function onRemove() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await deleteProviderCredential(provider);
      if (res.ok) setStatus('not_set');
      else setError(res.reason);
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-black/10 p-3 dark:border-white/10">
      <span className="w-28 text-sm font-medium">{PROVIDER_LABELS[provider] ?? provider}</span>
      <span className={`text-xs ${badge.className}`}>{badge.label}</span>
      <input
        type="password"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setSaved(false);
        }}
        placeholder="Enter API key"
        autoComplete="off"
        className="min-w-[12rem] flex-1 rounded border border-black/15 bg-transparent px-2 py-1 text-sm dark:border-white/15"
      />
      <button
        type="button"
        onClick={onSave}
        disabled={busy || value.trim() === ''}
        className="rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background disabled:opacity-50"
      >
        {busy ? '…' : 'Save'}
      </button>
      <button
        type="button"
        onClick={onTest}
        disabled={busy || status === 'not_set'}
        className="rounded border border-black/15 px-3 py-1.5 text-sm disabled:opacity-50 dark:border-white/15"
      >
        Test
      </button>
      <button
        type="button"
        onClick={onRemove}
        disabled={busy || status === 'not_set'}
        className="text-sm text-red-600 disabled:opacity-40"
      >
        Remove
      </button>
      {saved && <span className="text-sm text-green-600">Saved</span>}
      {error && <span className="w-full text-sm text-red-600">{error}</span>}
    </div>
  );
}

export function CredentialsEditor({ initial }: { initial: CredentialRow[] }) {
  const byProvider = new Map(initial.map((r) => [r.provider, r]));
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">API credentials</h2>
        <p className="text-sm opacity-70">
          Your own provider keys, encrypted at rest. When set, they override the server defaults;
          when empty, the server keys are used.
        </p>
      </div>
      <div className="space-y-2">
        {CREDENTIAL_PROVIDERS.map((provider) => (
          <ProviderRow key={provider} provider={provider} initialStatus={byProvider.get(provider)?.status ?? 'not_set'} />
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire the page**

In `src/app/(app)/settings/page.tsx`, add the import (with the other editor imports):

```ts
import { CredentialsEditor, type CredentialRow } from './CredentialsEditor';
```

After the existing reads (e.g. after the `profiles` read), add the credentials read:

```ts
  const { data: credentialRows } = await supabase
    .from('api_credentials')
    .select('provider, status, last_validated_at');
  const credentials: CredentialRow[] = (credentialRows ?? []).map((r) => ({
    provider: r.provider as string,
    status: r.status as string,
    lastValidatedAt: (r.last_validated_at as string | null) ?? null,
  }));
```

Render `<CredentialsEditor>` in the returned JSX after the other editors (e.g. after `<VoiceProfilesEditor>`):

```tsx
      <CredentialsEditor initial={credentials} />
```

- [ ] **Step 3: Type-check + lint + build**

Run: `npx tsc --noEmit`, then `npm run lint`, then `npm run build`
Expected: all clean/succeed (the client editor only pulls the pure `CREDENTIAL_PROVIDERS` const + the actions across the boundary).

- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/settings/CredentialsEditor.tsx" "src/app/(app)/settings/page.tsx"
git commit -m "feat(credentials): write-only credentials editor on /settings

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: ElevenLabs consumption (env fallback)

**Files:**
- Modify: `src/lib/voice/elevenlabs.ts`
- Modify: `src/lib/inngest/functions/synthesize-voice.ts`
- Modify: `src/app/(app)/channels/[id]/voice-actions.ts`
- Modify: `src/app/(app)/settings/voice-profile-actions.ts`

**Interfaces:**
- Consumes (Task 2): `resolveProviderKey` from `@/lib/credentials/store`.
- Produces: `synthesize`/`listVoices`/`listModels` accept an optional `apiKey`.

- [ ] **Step 1: Thread `apiKey` through the elevenlabs client**

In `src/lib/voice/elevenlabs.ts`:

Add `apiKey?: string` to `SynthesizeParams`:

```ts
export type SynthesizeParams = {
  text: string;
  voiceId: string;
  modelId?: string;
  voiceSettings?: VoiceSettings;
  apiKey?: string;
};
```

In `synthesize`, resolve the key with a fallback and use it (replace the destructure + the header):

```ts
  const { text, voiceId, modelId = ELEVENLABS_DEFAULT_MODEL, voiceSettings, apiKey } = params;
  const key = apiKey ?? serverEnv.elevenlabs.apiKey;
```
and change the header `'xi-api-key': serverEnv.elevenlabs.apiKey` to `'xi-api-key': key`.

In `listVoices` and `listModels`, add an `apiKey?: string` param and use it:

```ts
export async function listVoices(apiKey?: string): Promise<CatalogVoice[]> {
  const res = await fetch(`${ELEVENLABS_BASE}/voices`, {
    headers: { 'xi-api-key': apiKey ?? serverEnv.elevenlabs.apiKey },
  });
  // ...unchanged...
}

export async function listModels(apiKey?: string): Promise<CatalogModel[]> {
  const res = await fetch(`${ELEVENLABS_BASE}/models`, {
    headers: { 'xi-api-key': apiKey ?? serverEnv.elevenlabs.apiKey },
  });
  // ...unchanged...
}
```

- [ ] **Step 2: Resolve + pass in the synth worker**

In `src/lib/inngest/functions/synthesize-voice.ts`, add the import:

```ts
import { resolveProviderKey } from '@/lib/credentials/store';
```

Before the per-scene chunk loop (near the existing `load-voice-profile` step), add a memoized resolution. The resolved key is used INSIDE the per-scene steps (it is a local closure var, NOT returned from a step) — that's fine because the resolution itself runs in its own `step.run` that returns nothing sensitive:

```ts
    const elevenLabsKey = await step.run('resolve-elevenlabs-key', async () => {
      const key = await resolveProviderKey(admin, accountId, 'elevenlabs');
      return key ?? null; // null = use the env default; never the key in step state
    });
```

Wait — this returns the key into step state. Instead, resolve it WITHOUT a step (a plain await), so the decrypted key never enters Inngest's serialized state:

```ts
    // Resolve the account's ElevenLabs key once (plain await — NOT a step.run, so the
    // decrypted key never lands in Inngest step state). undefined → env fallback.
    const elevenLabsKey = await resolveProviderKey(admin, accountId, 'elevenlabs');
```

In the per-scene `synthesize({...})` call, add `apiKey: elevenLabsKey`:

```ts
            const { audio, alignment, durationSeconds } = await synthesize({
              text,
              voiceId: voice.voiceId,
              modelId: voice.modelId,
              voiceSettings: settings,
              apiKey: elevenLabsKey,
            });
```

(Re-resolving on a retry is fine and cheap; correctness doesn't depend on memoization here.)

- [ ] **Step 3: Resolve + pass in the catalog actions**

In `src/app/(app)/channels/[id]/voice-actions.ts`, in `loadVoiceCatalog`, resolve the session account's key and pass it to both calls:

```ts
  try {
    const supabase = await createClient();
    const { data: account } = await supabase.from('accounts').select('id').maybeSingle();
    const key = account ? await resolveProviderKey(supabase, account.id as string, 'elevenlabs') : undefined;
    const [voices, models] = await Promise.all([listVoices(key), listModels(key)]);
    return { ok: true, voices, models };
  } catch {
    return { ok: false, reason: "Couldn't reach ElevenLabs — check the API key and try again." };
  }
```

Add the imports at the top: `import { createClient } from '@/lib/supabase/server';` (if not already present) and `import { resolveProviderKey } from '@/lib/credentials/store';`.

In `src/app/(app)/settings/voice-profile-actions.ts`, in `loadModelCatalog`, do the same:

```ts
  try {
    const supabase = await createClient();
    const { data: account } = await supabase.from('accounts').select('id').maybeSingle();
    const key = account ? await resolveProviderKey(supabase, account.id as string, 'elevenlabs') : undefined;
    const models = await listModels(key);
    return { ok: true, models };
  } catch {
    return { ok: false, reason: "Couldn't reach ElevenLabs — check the API key and try again." };
  }
```

Add the imports: `createClient` from `@/lib/supabase/server` (if not present) and `resolveProviderKey` from `@/lib/credentials/store`.

- [ ] **Step 4: Type-check + lint**

Run: `npx tsc --noEmit` then `npm run lint`
Expected: both clean.

- [ ] **Step 5: Run the voice engine tests (regression guard)**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/voice/profile.test.ts`
Expected: PASS (unchanged — only the key plumbing changed).

- [ ] **Step 6: Commit**

```bash
git add src/lib/voice/elevenlabs.ts src/lib/inngest/functions/synthesize-voice.ts "src/app/(app)/channels/[id]/voice-actions.ts" "src/app/(app)/settings/voice-profile-actions.ts"
git commit -m "feat(credentials): ElevenLabs consumes a stored key (env fallback)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Stock (Pexels/Pixabay) consumption (env fallback)

**Files:**
- Modify: `src/lib/assets/pexels.ts`
- Modify: `src/lib/assets/pixabay.ts`
- Modify: `src/lib/assets/search.ts`
- Modify: `src/lib/inngest/functions/render.ts`

**Interfaces:**
- Consumes (Task 2): `resolveProviderKey` from `@/lib/credentials/store`.
- Produces: `searchPexels`/`searchPixabay` accept an optional `apiKey`; `resolveStockKeys(client, accountId): Promise<{ pexels?: string; pixabay?: string }>`; `searchStock` accepts resolved keys.

- [ ] **Step 1: Thread `apiKey` into the provider adapters**

In `src/lib/assets/pexels.ts`, change the signature + the key line:

```ts
export async function searchPexels(params: StockSearchParams, apiKey?: string): Promise<StockCandidate[]> {
  const key = apiKey ?? serverEnv.pexels.apiKey;
  if (!key) return [];
  // ...rest unchanged (it already uses `key`)...
```

In `src/lib/assets/pixabay.ts`, the same:

```ts
export async function searchPixabay(params: StockSearchParams, apiKey?: string): Promise<StockCandidate[]> {
  const key = apiKey ?? serverEnv.pixabay.apiKey;
  if (!key) return [];
  // ...rest unchanged (it already uses `key`)...
```

- [ ] **Step 2: Add `resolveStockKeys` + thread into `searchStock`**

In `src/lib/assets/search.ts`, add the import:

```ts
import { resolveProviderKey } from '../credentials/store';
```

Add the resolver (after `hasStockKeys`):

```ts
// Per-account stock keys: a stored credential (non-invalid) else the env var. Used to
// decide whether stock is available AND which key each provider call uses.
export async function resolveStockKeys(
  client: SupabaseClient,
  accountId: string,
): Promise<{ pexels?: string; pixabay?: string }> {
  const [pexels, pixabay] = await Promise.all([
    resolveProviderKey(client, accountId, 'pexels'),
    resolveProviderKey(client, accountId, 'pixabay'),
  ]);
  return {
    pexels: pexels ?? serverEnv.pexels.apiKey,
    pixabay: pixabay ?? serverEnv.pixabay.apiKey,
  };
}
```

Change `searchStock` to accept the resolved keys and pass them to the adapters:

```ts
export async function searchStock(
  admin: SupabaseClient,
  accountId: string,
  params: StockSearchParams,
  keys: { pexels?: string; pixabay?: string },
): Promise<StockCandidate[]> {
  // ...cache lookup unchanged...
  const [pex, pix] = await Promise.all([
    searchPexels(params, keys.pexels).catch(() => [] as StockCandidate[]),
    searchPixabay(params, keys.pixabay).catch(() => [] as StockCandidate[]),
  ]);
  // ...rest unchanged...
}
```

- [ ] **Step 3: Use resolved keys in render**

In `src/lib/inngest/functions/render.ts`:

Change the `hasStockKeys` import to add `resolveStockKeys`:

```ts
import { hasStockKeys, searchStock, resolveStockKeys } from '@/lib/assets/search';
```

In the compose step, replace the `useStock` decision (currently `const useStock = hasStockKeys() && brief.needsStock;`) with a resolved-keys version (plain await — keys are local, never returned from the step):

```ts
      const stockKeys = await resolveStockKeys(admin, brief.accountId);
      const useStock = Boolean(stockKeys.pexels || stockKeys.pixabay) && brief.needsStock;
```

`agenticCompose` calls `searchStock` internally via the injected dep. Find where `searchStock(admin, accountId, ...)` is invoked inside the agentic helper (the `searchStock` dependency passed to `runAgenticComposition`) and thread `stockKeys` to it. Pass `stockKeys` into `agenticCompose`:

```ts
      let outcome = useStock
        ? await agenticCompose(briefWithResources, admin, brief.accountId, models.video_composition, stockKeys)
        : await proceduralCompose(briefWithResources, models.video_composition);
```

In `agenticCompose`'s signature add the param and use it where it calls `searchStock`:

```ts
async function agenticCompose(
  brief: CompositionBrief,
  admin: ReturnType<typeof createAdminClient>,
  accountId: string,
  model: string,
  stockKeys: { pexels?: string; pixabay?: string },
): Promise<ComposeOutcome> {
```
and at the `searchStock(...)` call inside it (the `searchStock` injected dep), pass `stockKeys` as the 4th argument: `searchStock(admin, accountId, params, stockKeys)`.

(`hasStockKeys` may now be unused in render.ts — remove it from the import if so to keep lint clean; it stays exported for any other caller.)

- [ ] **Step 4: Type-check + lint**

Run: `npx tsc --noEmit` then `npm run lint`
Expected: both clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/assets/pexels.ts src/lib/assets/pixabay.ts src/lib/assets/search.ts src/lib/inngest/functions/render.ts
git commit -m "feat(credentials): stock providers consume stored keys (env fallback)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Anthropic consumption (env fallback)

**Files:**
- Modify: `src/lib/ai/anthropic.ts`
- Modify: `src/lib/inngest/functions/generate-script.ts`
- Modify: `src/lib/inngest/functions/render.ts`
- Modify: `src/lib/composition/gate2.ts`
- Modify: `src/lib/captions/emphasis-annotate.ts`
- Modify: `src/lib/primitives/gates.ts`
- Modify: `src/app/(app)/primitives/actions.ts`
- Modify: `src/lib/resources/upload.ts`

**Interfaces:**
- Consumes (Task 2): `resolveProviderKey` from `@/lib/credentials/store`.
- Produces: `anthropic(apiKey?: string)`; `runGate2`/`annotateSceneEmphasis`/`runGates`(+`visionQa`) accept an optional `apiKey`.

- [ ] **Step 1: Make `anthropic()` per-account**

In `src/lib/ai/anthropic.ts`, replace the `anthropic()` function:

```ts
let cached: Anthropic | null = null;
// Returns the env-keyed cached client by default. When an explicit apiKey is given
// (an account's stored credential), returns a fresh UNCACHED client for that key —
// never caching a per-account key into the shared singleton.
export function anthropic(apiKey?: string): Anthropic {
  if (apiKey) return new Anthropic({ apiKey });
  if (cached) return cached;
  cached = new Anthropic({ apiKey: serverEnv.anthropic.apiKey });
  return cached;
}
```

- [ ] **Step 2: generate-script worker**

In `src/lib/inngest/functions/generate-script.ts`, add the import:

```ts
import { resolveProviderKey } from '@/lib/credentials/store';
```

Where `models` is resolved (the existing model-routing resolution in this function), resolve the anthropic key too (plain await — not in a step; the key must not enter step state). Then at the `anthropic().messages.stream({` call (line ~96) pass it:

```ts
      const anthropicKey = await resolveProviderKey(admin, accountId, 'anthropic');
      const stream = anthropic(anthropicKey).messages.stream({
```

(Place the `anthropicKey` resolution in the same scope as the stream call — inside the `step.run` body that streams, as a plain `await` before `anthropic(...)`. `admin` + `accountId` are already in scope.)

- [ ] **Step 3: render — compose helpers + gate2 + caption emphasis**

In `src/lib/inngest/functions/render.ts`:

Add the import:

```ts
import { resolveProviderKey } from '@/lib/credentials/store';
```

In the compose `step.run` (where `models` is resolved at line ~101), resolve the key (plain await; local var, never returned from the step):

```ts
      const anthropicKey = await resolveProviderKey(admin, brief.accountId, 'anthropic');
```

Thread `anthropicKey` into the compose helpers and the caption emphasis call (all inside the compose step where `anthropicKey` is in scope):

- `proceduralCompose(briefWithResources, models.video_composition, anthropicKey)` (both call sites — the main one and the fallback).
- `agenticCompose(briefWithResources, admin, brief.accountId, models.video_composition, stockKeys, anthropicKey)` (extends Task 6's signature).
- `annotateSceneEmphasis({ ..., model: models.caption_emphasis, apiKey: anthropicKey })`.

Update `proceduralCompose`'s signature + its `anthropic()` call:

```ts
async function proceduralCompose(brief: CompositionBrief, model: string, apiKey?: string): Promise<ComposeOutcome> {
  // ...
    const stream = anthropic(apiKey).messages.stream({
```

Update `agenticCompose`'s signature + its `anthropic()` call (the `callModel` closure):

```ts
async function agenticCompose(
  brief: CompositionBrief,
  admin: ReturnType<typeof createAdminClient>,
  accountId: string,
  model: string,
  stockKeys: { pexels?: string; pixabay?: string },
  apiKey?: string,
): Promise<ComposeOutcome> {
  // ...
      callModel: async (system, msgs) => {
        const stream = anthropic(apiKey).messages.stream({
```

For the **gate2 step** (a SEPARATE `step.run` at line ~242): it must resolve the key in its own scope (the compose-step's `anthropicKey` is out of scope, and the key must not be carried via `composed`/step state). The gate2 step has `videoId` in scope; resolve the account from the render row is unnecessary — `brief.accountId` is not in scope here, but the compose step already returned `composed`. Add `accountId` (NON-secret) to what `loadBrief`/`composed` exposes is overkill; instead resolve the account id from the render row inside the gate2 step and then the key:

```ts
    const gate2 = await step.run('gate2', async () => {
      const { data: rrow } = await admin.from('renders').select('account_id').eq('id', renderId).single();
      const gate2Key = rrow?.account_id
        ? await resolveProviderKey(admin, rrow.account_id as string, 'anthropic')
        : undefined;
      const specUrl = await signedGetUrl(renderSpecKey, 60 * 60);
      const midFrame = Math.floor(durableSpec.metadata.durationInFrames / 2);
      const result = await runGate2({
        region,
        functionName,
        serveUrl: serverEnv.remotion.serveUrl,
        specUrl,
        midFrame,
        sceneIntent: composed.midSceneIntent,
        model: composed.videoModel,
        apiKey: gate2Key,
      });
      // ...unchanged...
```

- [ ] **Step 4: gate2 + emphasis-annotate + gates accept `apiKey`**

In `src/lib/composition/gate2.ts`: add `apiKey?: string` to `Gate2Params`, and change the `anthropic().messages.create(` at line ~61 to `anthropic(params.apiKey).messages.create(` (use the param name the function uses for its params object — if destructured, destructure `apiKey` too).

In `src/lib/captions/emphasis-annotate.ts`: add `apiKey?: string` to the options object the function accepts, and change `anthropic().messages.create(` at line ~32 to `anthropic(apiKey).messages.create(` (destructure `apiKey` from the options).

In `src/lib/primitives/gates.ts`: thread an optional `apiKey?: string` through `runGates` (and any inner `runBrandGate`/`visionQa`) down to the `anthropic().messages.create(` at line ~133 → `anthropic(apiKey).messages.create(`. Mirror how the existing `model` param is threaded (the model-routing slice already passes `model` through these — add `apiKey` alongside it with the same plumbing).

- [ ] **Step 5: primitives action + resource upload**

In `src/app/(app)/primitives/actions.ts`: this file already resolves the account (it uses `requireAccountId`/model routing per the model-routing slice). Resolve the anthropic key and (a) pass it to the `anthropic().messages.create(` at line ~53 → `anthropic(anthropicKey).messages.create(`, and (b) pass it into the `runGates(...)` call as the new `apiKey` arg. Add `import { resolveProviderKey } from '@/lib/credentials/store';` and resolve with the account id already in scope.

In `src/lib/resources/upload.ts`: `confirmResourceUpload` already has `client` + `accountId` and calls `loadModelRouting`. Add `import { resolveProviderKey } from '@/lib/credentials/store';`, resolve `const anthropicKey = await resolveProviderKey(client, accountId, 'anthropic');` next to the `loadModelRouting` call, and change `anthropic().messages.create(` at line ~91 to `anthropic(anthropicKey).messages.create(`.

- [ ] **Step 6: Type-check + lint + build**

Run: `npx tsc --noEmit`, then `npm run lint`, then `npm run build`
Expected: all clean/succeed. (No new unit test — this is provider-client plumbing; the env-fallback default path is exercised by the full suite + build.)

- [ ] **Step 7: Run the full suite (regression)**

Run: `npm test`
Expected: green (the default `anthropic()` path is unchanged, so compose/gate/emphasis tests still pass).

- [ ] **Step 8: Commit**

```bash
git add src/lib/ai/anthropic.ts src/lib/inngest/functions/generate-script.ts src/lib/inngest/functions/render.ts src/lib/composition/gate2.ts src/lib/captions/emphasis-annotate.ts src/lib/primitives/gates.ts "src/app/(app)/primitives/actions.ts" src/lib/resources/upload.ts
git commit -m "feat(credentials): Anthropic consumes a stored key per account (env fallback)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final verification (whole branch)

- [ ] `npm test` — full suite green.
- [ ] `npx tsc --noEmit` — clean.
- [ ] `npm run lint` — clean.
- [ ] `npm run build` — succeeds.
- [ ] **Security sweep:** no decrypted key is returned from a `step.run` (all key resolutions are plain `await`s); `encrypted_value` is never selected into a client component; the key input is `type="password"` write-only.
- [ ] **Manual / app-run e2e (operator):** set `CREDENTIALS_ENCRYPTION_KEY` → `/settings` → enter each provider key → Test → Valid → exercise each path (generate a script, synthesize, render with stock) and confirm it uses the stored key → Remove → the path falls back to the env var. A wrong key → Test → Invalid → the path still works on the env fallback.

## Post-merge bookkeeping (controller, after merge)

- Update `CLAUDE.md` Phase-3/Phase-8 notes: the ElevenLabs-key-as-env-var deferral and the "api_credentials encryption" Phase-8 item are now shipped for anthropic/elevenlabs/pexels/pixabay (per-account encrypted keys with env fallback); openai/google remain out (no consumer).
- Update memory: add a `api-credentials-vault` note (AES-256-GCM app-layer, store/resolver/validators, `anthropic(apiKey?)` per-account, env fallback, key-never-in-step-state rule); cross-link [[model-routing]].
- Operator: set `CREDENTIALS_ENCRYPTION_KEY` in the deploy env before using the feature.
