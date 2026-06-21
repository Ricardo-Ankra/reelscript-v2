# API credentials vault — design

**Date:** 2026-06-21
**Phase:** 8 (Full surfaces) — account credentials
**Status:** design approved, ready for implementation plan

## Context

Every provider key is currently an env var read through `serverEnv`
(`src/lib/env.server.ts`): `ANTHROPIC_API_KEY`, `ELEVENLABS_API_KEY`,
`PEXELS_API_KEY`, `PIXABAY_API_KEY` (plus infra: Supabase, R2, AWS). The
`api_credentials` table is deployed but **unread/unwritten**:

```sql
create table api_credentials (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts (id) on delete cascade,
  provider credential_provider not null,   -- anthropic|openai|google|elevenlabs|pexels|pixabay
  label text,
  encrypted_value text not null,
  status text not null default 'unverified', -- unverified|valid|invalid
  last_validated_at timestamptz,
  created_at timestamptz not null default now(),
  unique (account_id, provider, label)
);
-- RLS: acct_isolation (auth_owns_account(account_id))
```

The schema note says encryption is the app layer's job (or Supabase Vault); the
table stores ciphertext only. This slice lets an operator store per-account
provider keys (encrypted), validate them, and have the pipeline use them — a step
toward true multi-tenant (each account brings its own keys).

**Providers in scope: `anthropic`, `elevenlabs`, `pexels`, `pixabay`** — the four
the codebase actually consumes. `openai` and `google` are in the enum but the app
has **no client** for them, so storing those keys would be a dead control; they
wait until a consumer exists.

Anthropic is consumed via a cached singleton `anthropic()` (`src/lib/ai/anthropic.ts`)
hit from 8 sites: `generate-script.ts`, `render.ts` (×2 — compose stream + the
procedural/agentic helpers), `composition/gate2.ts`, `captions/emphasis-annotate.ts`,
`primitives/gates.ts`, `app/(app)/primitives/actions.ts`, `resources/upload.ts`.
ElevenLabs via `synthesize`/`listVoices`/`listModels` (`voice/elevenlabs.ts`).
Stock via `searchPexels`/`searchPixabay` + `hasStockKeys()` (`assets/search.ts`,
called in `render.ts`).

## Goal

An operator can enter, encrypt-at-rest, validate, and remove a per-account API key
for each of the four providers on `/settings`, and the pipeline uses a stored key
when present (falling back to the env var when absent or invalid).

## Scope

**In scope:**

- App-layer AES-256-GCM encryption (pure, unit-tested) with a master key from a
  new env var.
- A credential store + resolver + per-provider validators (server-only).
- `/settings` credentials UI (four providers: enter / Test / remove; status shown).
- Consumption wiring for all four providers with **env fallback**.

**Out of scope (future):**

- `openai` / `google` (no client consumes them yet).
- Key rotation; multiple keys per provider (`label` stays a single default).
- Per-channel (vs per-account) credentials.
- Migrating infra secrets (Supabase/R2/AWS/remux) — those stay env vars.
- Music-seeding's ElevenLabs use (a one-off operator script) — stays on env.
- Any schema change (the table + RLS already exist; writes are direct RLS ops).

## Architecture

### Encryption: `src/lib/credentials/crypto.ts` (pure, unit-tested)

`node:crypto` AES-256-GCM. The key is **injected** as a hex string so the module is
testable with a fixed key (no env coupling).

```ts
// Encrypt plaintext with a 32-byte key (64 hex chars). Returns "iv.ciphertext.tag",
// each part base64. A random 12-byte iv per call (so equal plaintexts differ).
export function encryptSecret(plaintext: string, keyHex: string): string;

// Inverse. Throws if the payload is malformed or the auth tag fails (tamper/wrong key).
export function decryptSecret(payload: string, keyHex: string): string;
```

New env: `CREDENTIALS_ENCRYPTION_KEY` (64 hex chars). `serverEnv.credentials.encryptionKey`
(required getter — but only read when the feature is exercised, so an operator who
never stores a key never needs it). Added to `.env.example`.

### Store + resolver + validators: `src/lib/credentials/store.ts` (server-only)

```ts
export const CREDENTIAL_PROVIDERS = ['anthropic', 'elevenlabs', 'pexels', 'pixabay'] as const;
export type CredentialProvider = (typeof CREDENTIAL_PROVIDERS)[number];

// Encrypt + upsert (status reset to 'unverified'); returns the row id or null when no
// account matched. Never returns the plaintext.
export function saveCredential(
  client: SupabaseClient, accountId: string, provider: CredentialProvider, plaintext: string,
): Promise<string | null>;

// The account's stored key for a provider, decrypted, when a row exists AND
// status !== 'invalid'; else undefined. A decrypt failure → undefined (never throws).
export function resolveProviderKey(
  client: SupabaseClient, accountId: string, provider: CredentialProvider,
): Promise<string | undefined>;

// One cheap authenticated call per provider → is the key live?
//   anthropic  → GET https://api.anthropic.com/v1/models (x-api-key, anthropic-version)
//   elevenlabs → GET https://api.elevenlabs.io/v1/models (xi-api-key)
//   pexels     → GET https://api.pexels.com/v1/search?query=x&per_page=1 (Authorization)
//   pixabay    → GET https://pixabay.com/api/?key=...&per_page=3&q=x
export function validateProviderKey(provider: CredentialProvider, apiKey: string): Promise<boolean>;
```

`saveCredential` uses `unique (account_id, provider, label)` with `label` left null
(single default key per provider) → `onConflict: 'account_id,provider,label'`. (Note:
in Postgres a unique constraint treats NULL labels as distinct, so the upsert keys on
a fixed sentinel label `''` instead of null to make "one per provider" enforceable —
`label` is stored as `''`.)

### Server actions: `src/app/(app)/settings/credential-actions.ts` (`'use server'`)

- `saveProviderCredential(provider, plaintext)` → guard provider ∈ `CREDENTIAL_PROVIDERS`
  + non-empty plaintext → resolve account → `saveCredential` → `{ ok } | { ok:false, reason }`
  (a missing `CREDENTIALS_ENCRYPTION_KEY` surfaces as a friendly reason, not a crash).
- `testProviderCredential(provider)` → resolve account → load+decrypt the row →
  `validateProviderKey` → update `status` (`valid`/`invalid`) + `last_validated_at` →
  `{ ok, status } | { ok:false, reason }`.
- `deleteProviderCredential(provider)` → RLS delete scoped by account + provider →
  `.select('id')` no-row → "Credential not found." → `{ ok } | { ok:false, reason }`.

### Consumption (env fallback)

A shared rule: resolve the account's key; if `undefined`, use the env var. An account
with no stored key is byte-identical to today.

- **anthropic** (`src/lib/ai/anthropic.ts`): `anthropic(apiKey?: string)` — when `apiKey`
  is provided, return `new Anthropic({ apiKey })` (NOT cached); when absent, the existing
  env-keyed cached singleton. Each of the 8 call sites resolves the account's key (once
  per job/action — in the workers, alongside the existing memoized model-routing step;
  in the actions, from the session account) and passes it. Functions that already take a
  `model` param (compose/gate2/emphasis/gates) gain an optional `apiKey` threaded the
  same way.
- **elevenlabs** (`src/lib/voice/elevenlabs.ts`): `synthesize`/`listVoices`/`listModels`
  gain an optional `apiKey` (default `serverEnv.elevenlabs.apiKey`). The synth worker
  resolves once (memoized step) + passes; the catalog actions (`loadVoiceCatalog`,
  `loadModelCatalog`) resolve from the session account + pass.
- **pexels/pixabay** (`src/lib/assets/{pexels,pixabay,search}.ts`): `searchPexels`/
  `searchPixabay` gain an optional `apiKey`. A `resolveStockKeys(client, accountId):
  Promise<{ pexels?: string; pixabay?: string }>` (stored ?? env per provider) feeds
  `searchStock`. `render.ts`'s `useStock` is computed from the resolved keys (presence)
  instead of `hasStockKeys()`; the resolved keys thread into the agentic `searchStock`.

### UI: `src/app/(app)/settings/CredentialsEditor.tsx` + `page.tsx`

`/settings/page.tsx` reads `api_credentials` (RLS: `provider, status, last_validated_at`
— **never `encrypted_value`**) and renders `<CredentialsEditor initial={...} />` below
the existing sections. `CredentialsEditor` (client): one row per provider in
`CREDENTIAL_PROVIDERS` — a label, a status badge (Not set / Unverified / Valid / Invalid
+ relative `last_validated_at`), a password `<input>` to enter a new key, **Save**,
**Test**, **Remove**. Save/Test/Remove call the actions; the stored value is never sent
to the client (the input is write-only). Mirrors the existing dirty-track + try/catch/
finally editor pattern.

## Data flow

```
/settings (server) → read api_credentials {provider,status,last_validated_at} → CredentialsEditor
enter key → Save → saveProviderCredential → encryptSecret → upsert (status 'unverified')
Test → testProviderCredential → decryptSecret → validateProviderKey → status valid|invalid
pipeline (per job/action):
  resolveProviderKey(account, provider) → decrypted key  (status != 'invalid')
    ?? serverEnv.<provider>.apiKey                         (fallback)
  → anthropic(apiKey) / synthesize({apiKey}) / searchPexels(params, apiKey) / ...
```

## Error handling

- Missing `CREDENTIALS_ENCRYPTION_KEY`: `saveProviderCredential`/`testProviderCredential`
  return a friendly reason; `resolveProviderKey` returns `undefined` (→ env fallback), so
  the pipeline keeps working on env keys.
- `validateProviderKey` network/non-2xx → `false` → status `invalid` (and resolution then
  skips that key → env fallback).
- A corrupt/undecryptable stored row → `resolveProviderKey` returns `undefined` (caught) →
  env fallback; never crashes a render/synthesis.
- `deleteProviderCredential` / `saveCredential` no-row → friendly not-found / no phantom save.

## Back-compatibility

- Additive. No account has stored keys at ship → every resolver returns `undefined` →
  every consumer uses the env var exactly as before (the live render/synth path is
  unchanged). `anthropic()` with no argument is byte-identical to today.
- No schema change; the unused enum values (`openai`/`google`) and `label` multi-key
  capability are left dormant.

## Testing

- **Unit (`src/lib/credentials/crypto.test.ts`):** encrypt→decrypt round-trips with a
  fixed key; two encryptions of the same plaintext differ (random iv) but both decrypt;
  decrypt of a tampered payload (flipped tag/ciphertext) throws; decrypt of a known
  fixed payload yields the expected plaintext.
- **Regression:** `npm test` green; `npx tsc --noEmit` + `npm run lint` clean;
  `npm run build` succeeds (the singleton change + the client editor compile).
- **Manual / app-run e2e:** `/settings` → for each provider, enter a real key → Test →
  Valid → exercise the path (generate a script / synthesize / render with stock) and
  confirm it uses the stored key → Remove → the path falls back to the env var. A wrong
  key → Test → Invalid → the path still works on the env fallback.
- The provider validators, the `anthropic()` threading, and the consumption sites are not
  unit-tested (network/integration), consistent with the codebase's treatment of the
  server-only provider clients.

## Open questions

None. App-layer AES-256-GCM, four real providers end-to-end with env fallback, a
write-only credentials UI, and no schema change are settled.
