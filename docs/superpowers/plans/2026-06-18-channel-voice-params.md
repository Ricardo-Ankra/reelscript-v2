# Channel Voice Params Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Voice" editor on `/channels/[id]` to pick a channel's ElevenLabs voice + model (live, on-demand catalog) and tune stability/similarity_boost/style/use_speaker_boost, persisted to `channels.voice_tts` and wired through to synthesis.

**Architecture:** A pure core module (`src/lib/channels/voice.ts`) parses/validates `voice_tts` and extracts tuning params; a focused `set_channel_voice_tts` RPC writes the column wholesale; server-only `listVoices`/`listModels` fetch the catalog behind a `loadVoiceCatalog` server action (the API key never leaves the server); a `VoiceEditor` client component renders instantly from stored values and loads the catalog on demand; the existing synthesis trigger gains the tuning params via a pure extractor.

**Tech Stack:** Next.js App Router (server actions, `'use server'`/`'use client'`), Supabase (Postgres RPC, RLS), Inngest (`voice/synthesize`), ElevenLabs REST, `node:test` + `--experimental-strip-types`.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-06-18-channel-voice-params-design.md`.
- **Security (binding):** the ElevenLabs API key is `server-only` (`serverEnv.elevenlabs.apiKey`). The catalog fetch MUST be a server action; the client receives only `{ id, name }[]`, never the key.
- **Pure-core rule:** `src/lib/channels/voice.ts` imports only pure modules + type-only imports (no `react`/`server`/network). It must NOT import the `server-only` `elevenlabs.ts` — re-declare the two default strings locally with a drift-guard test.
- **Stored `voice_tts` shape (snake_case, what synthesis + ElevenLabs read):** `{ voice_id, model, stability, similarity_boost, style, use_speaker_boost }`.
- **No-phantom-save:** every write RPC is `security invoker`, returns `id`, NULL on zero rows → the action returns `{ ok:false, reason:'Channel not found.' }`.
- **No `deploy:remotion` gate** — synthesis runs on Inngest, not the render Lambda.
- **Tests run with:** `npm test` (all) or single file `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/channels/voice.test.ts`. Test imports use explicit `.ts` extensions.
- **Migrations applied with:** `npm run db:apply -- supabase/migrations/<file>.sql`.
- **Commit message footer:** `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Out of scope:** `voice_profiles`, emotion tags, a test-synthesis preview button, the `speed` param, `api_credentials`.

## File Structure

- `src/lib/channels/voice.ts` (create) — pure: `parseVoiceTts`, `validateVoiceForm`, `voiceSettingsFromTts`, constants.
- `src/lib/channels/voice.test.ts` (create) — unit tests.
- `supabase/migrations/20260618150000_set_channel_voice_tts.sql` (create) — the RPC.
- `src/lib/voice/elevenlabs.ts` (modify) — add `listVoices`, `listModels`, `CatalogVoice`, `CatalogModel`.
- `src/app/(app)/channels/[id]/voice-actions.ts` (create) — `loadVoiceCatalog`, `saveChannelVoiceTts`.
- `src/app/(app)/videos/[id]/voice-actions.ts` (modify) — wire `voiceSettingsFromTts` into the `voice/synthesize` event.
- `src/app/(app)/channels/[id]/VoiceEditor.tsx` (create) — client editor.
- `src/app/(app)/channels/[id]/page.tsx` (modify) — select `voice_tts`, render `<VoiceEditor>`.

---

### Task 1: Pure core `voice.ts` + tests

**Files:**
- Create: `src/lib/channels/voice.ts`
- Test: `src/lib/channels/voice.test.ts`

**Interfaces:**
- Consumes: `VoiceSettings` (type) from `src/lib/voice/alignment.ts` — `{ stability?: number; similarity_boost?: number; style?: number; use_speaker_boost?: boolean }`.
- Produces:
  - `interface VoiceForm { voiceId: string; model: string; stability: number; similarityBoost: number; style: number; useSpeakerBoost: boolean }`
  - `parseVoiceTts(voiceTts: unknown): VoiceForm`
  - `validateVoiceForm(input: unknown): { ok: true; value: Record<string, unknown> } | { ok: false; reason: string }`
  - `voiceSettingsFromTts(voiceTts: unknown): VoiceSettings | undefined`
  - consts `VOICE_PARAM_MIN = 0`, `VOICE_PARAM_MAX = 1`, `DEFAULT_VOICE_FORM_TUNING`, local `DEFAULT_VOICE_ID`, `DEFAULT_VOICE_MODEL`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/channels/voice.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseVoiceTts,
  validateVoiceForm,
  voiceSettingsFromTts,
  DEFAULT_VOICE_FORM_TUNING,
  DEFAULT_VOICE_ID,
  DEFAULT_VOICE_MODEL,
} from './voice.ts';
import {
  DEFAULT_VOICE_ID as CANON_VOICE_ID,
  ELEVENLABS_DEFAULT_MODEL as CANON_MODEL,
} from '../voice/elevenlabs.ts';

test('drift guard: local defaults mirror the canonical elevenlabs constants', () => {
  assert.equal(DEFAULT_VOICE_ID, CANON_VOICE_ID);
  assert.equal(DEFAULT_VOICE_MODEL, CANON_MODEL);
});

test('parseVoiceTts: empty → default voice/model + default tuning', () => {
  const f = parseVoiceTts({});
  assert.equal(f.voiceId, DEFAULT_VOICE_ID);
  assert.equal(f.model, DEFAULT_VOICE_MODEL);
  assert.equal(f.stability, DEFAULT_VOICE_FORM_TUNING.stability);
  assert.equal(f.similarityBoost, DEFAULT_VOICE_FORM_TUNING.similarityBoost);
  assert.equal(f.style, DEFAULT_VOICE_FORM_TUNING.style);
  assert.equal(f.useSpeakerBoost, DEFAULT_VOICE_FORM_TUNING.useSpeakerBoost);
});

test('parseVoiceTts: garbage input → defaults', () => {
  assert.equal(parseVoiceTts(null).voiceId, DEFAULT_VOICE_ID);
  assert.equal(parseVoiceTts('nope').model, DEFAULT_VOICE_MODEL);
});

test('parseVoiceTts: placeholder voice_id → default voice id', () => {
  const f = parseVoiceTts({ voice_id: 'placeholder', model: 'eleven_turbo_v2' });
  assert.equal(f.voiceId, DEFAULT_VOICE_ID);
  assert.equal(f.model, 'eleven_turbo_v2');
});

test('parseVoiceTts: full object round-trips its values', () => {
  const f = parseVoiceTts({
    voice_id: 'abc123',
    model: 'eleven_turbo_v2',
    stability: 0.3,
    similarity_boost: 0.9,
    style: 0.2,
    use_speaker_boost: false,
  });
  assert.deepEqual(f, {
    voiceId: 'abc123',
    model: 'eleven_turbo_v2',
    stability: 0.3,
    similarityBoost: 0.9,
    style: 0.2,
    useSpeakerBoost: false,
  });
});

test('parseVoiceTts: partial tuning backfills missing keys', () => {
  const f = parseVoiceTts({ voice_id: 'abc', model: 'm', stability: 0.1 });
  assert.equal(f.stability, 0.1);
  assert.equal(f.similarityBoost, DEFAULT_VOICE_FORM_TUNING.similarityBoost);
  assert.equal(f.useSpeakerBoost, DEFAULT_VOICE_FORM_TUNING.useSpeakerBoost);
});

test('validateVoiceForm: valid form → snake_case stored object', () => {
  const r = validateVoiceForm({
    voiceId: 'abc',
    model: 'eleven_multilingual_v2',
    stability: 0.5,
    similarityBoost: 0.75,
    style: 0,
    useSpeakerBoost: true,
  });
  assert.equal(r.ok, true);
  assert.ok(r.ok && r.value.voice_id === 'abc');
  assert.ok(r.ok && r.value.similarity_boost === 0.75);
  assert.ok(r.ok && r.value.use_speaker_boost === true);
  assert.ok(r.ok && r.value.model === 'eleven_multilingual_v2');
});

test('validateVoiceForm: rejects empty voiceId / model', () => {
  assert.equal(validateVoiceForm({ voiceId: '', model: 'm', stability: 0.5, similarityBoost: 0.5, style: 0, useSpeakerBoost: true }).ok, false);
  assert.equal(validateVoiceForm({ voiceId: 'a', model: '', stability: 0.5, similarityBoost: 0.5, style: 0, useSpeakerBoost: true }).ok, false);
});

test('validateVoiceForm: rejects out-of-range / non-number sliders', () => {
  const base = { voiceId: 'a', model: 'm', stability: 0.5, similarityBoost: 0.5, style: 0, useSpeakerBoost: true };
  assert.equal(validateVoiceForm({ ...base, stability: -0.1 }).ok, false);
  assert.equal(validateVoiceForm({ ...base, similarityBoost: 1.1 }).ok, false);
  assert.equal(validateVoiceForm({ ...base, style: Number.NaN }).ok, false);
  assert.equal(validateVoiceForm({ ...base, stability: 'x' as unknown as number }).ok, false);
});

test('validateVoiceForm: rejects non-boolean useSpeakerBoost', () => {
  const base = { voiceId: 'a', model: 'm', stability: 0.5, similarityBoost: 0.5, style: 0 };
  assert.equal(validateVoiceForm({ ...base, useSpeakerBoost: 'yes' as unknown as boolean }).ok, false);
});

test('voiceSettingsFromTts: none present → undefined', () => {
  assert.equal(voiceSettingsFromTts({ voice_id: 'a', model: 'm' }), undefined);
  assert.equal(voiceSettingsFromTts(null), undefined);
});

test('voiceSettingsFromTts: subset present → only those keys, typed', () => {
  const s = voiceSettingsFromTts({ stability: 0.2, use_speaker_boost: false, similarity_boost: 'bad' });
  assert.deepEqual(s, { stability: 0.2, use_speaker_boost: false });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/channels/voice.test.ts`
Expected: FAIL — cannot find module `./voice.ts` (not created yet).

- [ ] **Step 3: Write the implementation**

Create `src/lib/channels/voice.ts`:

```ts
// Pure channel voice-params parse + validation (Phase 8 — voice editor). No
// react/server/network: imports only the pure VoiceSettings type. The two
// default strings mirror the server-only elevenlabs.ts (a unit test guards the
// drift) so this module stays importable by tests without pulling in 'server-only'.
import type { VoiceSettings } from '../voice/alignment';

// Mirror of elevenlabs.ts DEFAULT_VOICE_ID / ELEVENLABS_DEFAULT_MODEL. Kept local
// so this pure module never imports the server-only client. voice.test.ts asserts
// these equal the canonical values.
export const DEFAULT_VOICE_ID = '21m00Tcm4TlvDq8ikWAM';
export const DEFAULT_VOICE_MODEL = 'eleven_multilingual_v2';

export const VOICE_PARAM_MIN = 0;
export const VOICE_PARAM_MAX = 1;

// ElevenLabs' own defaults for eleven_multilingual_v2; shown when voice_tts has
// no tuning keys.
export const DEFAULT_VOICE_FORM_TUNING = {
  stability: 0.5,
  similarityBoost: 0.75,
  style: 0,
  useSpeakerBoost: true,
} as const;

export interface VoiceForm {
  voiceId: string;
  model: string;
  stability: number;
  similarityBoost: number;
  style: number;
  useSpeakerBoost: boolean;
}

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

// Build the form model from a stored voice_tts. Backfills voiceId/model to the
// defaults when unset or the Phase-2 'placeholder' (voiceId only), and tuning to
// DEFAULT_VOICE_FORM_TUNING when absent / wrong-typed.
export function parseVoiceTts(voiceTts: unknown): VoiceForm {
  const o = asRecord(voiceTts);
  const rawVoice = typeof o.voice_id === 'string' ? o.voice_id : '';
  const voiceId = rawVoice && rawVoice !== 'placeholder' ? rawVoice : DEFAULT_VOICE_ID;
  const model = typeof o.model === 'string' && o.model ? o.model : DEFAULT_VOICE_MODEL;
  return {
    voiceId,
    model,
    stability: num(o.stability, DEFAULT_VOICE_FORM_TUNING.stability),
    similarityBoost: num(o.similarity_boost, DEFAULT_VOICE_FORM_TUNING.similarityBoost),
    style: num(o.style, DEFAULT_VOICE_FORM_TUNING.style),
    useSpeakerBoost:
      typeof o.use_speaker_boost === 'boolean'
        ? o.use_speaker_boost
        : DEFAULT_VOICE_FORM_TUNING.useSpeakerBoost,
  };
}

function inRange(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= VOICE_PARAM_MIN && v <= VOICE_PARAM_MAX;
}

// Validate a form submission → the snake_case voice_tts object to store. The keys
// match what synthesis reads and ElevenLabs' voice_settings naming.
export function validateVoiceForm(
  input: unknown,
): { ok: true; value: Record<string, unknown> } | { ok: false; reason: string } {
  const o = asRecord(input);
  const voiceId = o.voiceId;
  const model = o.model;
  if (typeof voiceId !== 'string' || !voiceId.trim()) return { ok: false, reason: 'Pick a voice.' };
  if (typeof model !== 'string' || !model.trim()) return { ok: false, reason: 'Pick a model.' };
  if (!inRange(o.stability)) return { ok: false, reason: 'Stability must be between 0 and 1.' };
  if (!inRange(o.similarityBoost)) return { ok: false, reason: 'Similarity boost must be between 0 and 1.' };
  if (!inRange(o.style)) return { ok: false, reason: 'Style must be between 0 and 1.' };
  if (typeof o.useSpeakerBoost !== 'boolean') return { ok: false, reason: 'Speaker boost must be on or off.' };
  return {
    ok: true,
    value: {
      voice_id: voiceId,
      model,
      stability: o.stability,
      similarity_boost: o.similarityBoost,
      style: o.style,
      use_speaker_boost: o.useSpeakerBoost,
    },
  };
}

// Extract the 4 tuning keys from a stored voice_tts as VoiceSettings, omitting any
// key that is absent / wrong-typed. Returns undefined when none are present so the
// synthesis event omits voice_settings entirely (byte-identical to pre-wiring).
export function voiceSettingsFromTts(voiceTts: unknown): VoiceSettings | undefined {
  const o = asRecord(voiceTts);
  const out: VoiceSettings = {};
  if (typeof o.stability === 'number' && Number.isFinite(o.stability)) out.stability = o.stability;
  if (typeof o.similarity_boost === 'number' && Number.isFinite(o.similarity_boost))
    out.similarity_boost = o.similarity_boost;
  if (typeof o.style === 'number' && Number.isFinite(o.style)) out.style = o.style;
  if (typeof o.use_speaker_boost === 'boolean') out.use_speaker_boost = o.use_speaker_boost;
  return Object.keys(out).length > 0 ? out : undefined;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/channels/voice.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/channels/voice.ts src/lib/channels/voice.test.ts
git commit -m "feat: pure voice-params core (parse/validate/extract)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `set_channel_voice_tts` RPC migration

**Files:**
- Create: `supabase/migrations/20260618150000_set_channel_voice_tts.sql`

**Interfaces:**
- Produces: Postgres function `set_channel_voice_tts(p_channel_id uuid, p_value jsonb) returns uuid` — used by `saveChannelVoiceTts` (Task 4) as `supabase.rpc('set_channel_voice_tts', { p_channel_id, p_value })`.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260618150000_set_channel_voice_tts.sql`:

```sql
-- Phase 8 — channel voice params. Writes the whole voice_tts column (the editor
-- owns all its keys: voice_id, model, and the 4 tuning params). SECURITY INVOKER
-- → the caller's RLS on channels applies. RETURNS the updated id (NULL when no row
-- matched) so the action never reports a phantom "Saved".
create or replace function set_channel_voice_tts(
  p_channel_id uuid,
  p_value      jsonb
) returns uuid
language sql
security invoker
as $$
  update channels
  set voice_tts  = p_value,
      updated_at = now()
  where id = p_channel_id
  returning id;
$$;

grant execute on function set_channel_voice_tts(uuid, jsonb) to authenticated;
```

- [ ] **Step 2: Apply the migration**

Run: `npm run db:apply -- supabase/migrations/20260618150000_set_channel_voice_tts.sql`
Expected: applies cleanly (function created); the script reports success.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260618150000_set_channel_voice_tts.sql
git commit -m "feat: set_channel_voice_tts RPC (wholesale voice_tts write)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: ElevenLabs catalog functions (`listVoices` / `listModels`)

**Files:**
- Modify: `src/lib/voice/elevenlabs.ts`

**Interfaces:**
- Consumes: `serverEnv.elevenlabs.apiKey`, `ELEVENLABS_BASE` (existing in the file).
- Produces:
  - `type CatalogVoice = { id: string; name: string }`
  - `type CatalogModel = { id: string; name: string }`
  - `async function listVoices(): Promise<CatalogVoice[]>`
  - `async function listModels(): Promise<CatalogModel[]>`

No unit test (live network + `server-only` import); verified by build/type-check and the manual e2e. The fetch shape is reviewable against the ElevenLabs API.

- [ ] **Step 1: Add the catalog functions**

In `src/lib/voice/elevenlabs.ts`, append after the existing `synthesize` function (keep `import 'server-only'` at the top — these stay server-only):

```ts
export type CatalogVoice = { id: string; name: string };
export type CatalogModel = { id: string; name: string };

// GET /v1/voices → the account's available voices, mapped to { id, name }.
// Server-only (uses the xi-api-key). A non-2xx throws (same posture as synthesize);
// the loadVoiceCatalog action catches it.
export async function listVoices(): Promise<CatalogVoice[]> {
  const res = await fetch(`${ELEVENLABS_BASE}/voices`, {
    headers: { 'xi-api-key': serverEnv.elevenlabs.apiKey },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`ElevenLabs ${res.status}: ${body.slice(0, 500)}`);
  }
  const json = (await res.json()) as { voices?: Array<{ voice_id?: string; name?: string }> };
  return (json.voices ?? [])
    .filter((v): v is { voice_id: string; name?: string } => typeof v.voice_id === 'string')
    .map((v) => ({ id: v.voice_id, name: v.name ?? v.voice_id }));
}

// GET /v1/models → available models, mapped to { id, name }.
export async function listModels(): Promise<CatalogModel[]> {
  const res = await fetch(`${ELEVENLABS_BASE}/models`, {
    headers: { 'xi-api-key': serverEnv.elevenlabs.apiKey },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`ElevenLabs ${res.status}: ${body.slice(0, 500)}`);
  }
  const json = (await res.json()) as Array<{ model_id?: string; name?: string }>;
  return (json ?? [])
    .filter((m): m is { model_id: string; name?: string } => typeof m.model_id === 'string')
    .map((m) => ({ id: m.model_id, name: m.name ?? m.model_id }));
}
```

- [ ] **Step 2: Type-check the change**

Run: `npx tsc --noEmit`
Expected: no new type errors from `elevenlabs.ts` (the file already imported `serverEnv` and `ELEVENLABS_BASE`).

- [ ] **Step 3: Commit**

```bash
git add src/lib/voice/elevenlabs.ts
git commit -m "feat: server-only listVoices/listModels catalog fetch

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Channel server actions (`loadVoiceCatalog`, `saveChannelVoiceTts`)

**Files:**
- Create: `src/app/(app)/channels/[id]/voice-actions.ts`

**Interfaces:**
- Consumes: `createClient` from `@/lib/supabase/server`; `validateVoiceForm` from `@/lib/channels/voice`; `listVoices`, `listModels`, `type CatalogVoice`, `type CatalogModel` from `@/lib/voice/elevenlabs`; the `set_channel_voice_tts` RPC (Task 2).
- Produces:
  - `async function loadVoiceCatalog(): Promise<{ ok: true; voices: CatalogVoice[]; models: CatalogModel[] } | { ok: false; reason: string }>`
  - `async function saveChannelVoiceTts(channelId: string, input: unknown): Promise<{ ok: true } | { ok: false; reason: string }>`

- [ ] **Step 1: Write the actions**

Create `src/app/(app)/channels/[id]/voice-actions.ts`:

```ts
'use server';

import { createClient } from '@/lib/supabase/server';
import { validateVoiceForm } from '@/lib/channels/voice';
import {
  listVoices,
  listModels,
  type CatalogVoice,
  type CatalogModel,
} from '@/lib/voice/elevenlabs';

// Fetch the live ElevenLabs voice + model catalog. Server action so the API key
// (server-only) never reaches the client — the client gets only { id, name }[].
// A network / non-2xx failure → a friendly reason; the editor stays usable.
export async function loadVoiceCatalog(): Promise<
  { ok: true; voices: CatalogVoice[]; models: CatalogModel[] } | { ok: false; reason: string }
> {
  try {
    const [voices, models] = await Promise.all([listVoices(), listModels()]);
    return { ok: true, voices, models };
  } catch {
    return { ok: false, reason: "Couldn't reach ElevenLabs — check the API key and try again." };
  }
}

// Persist the channel's voice params (wholesale voice_tts) via set_channel_voice_tts.
// validateVoiceForm builds the snake_case stored object. The RPC returns the id, or
// null when zero rows matched — a failure, not a phantom "Saved".
export async function saveChannelVoiceTts(
  channelId: string,
  input: unknown,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const valid = validateVoiceForm(input);
  if (!valid.ok) return valid;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc('set_channel_voice_tts', {
    p_channel_id: channelId,
    p_value: valid.value,
  });
  if (error) return { ok: false, reason: error.message };
  if (data == null) return { ok: false, reason: 'Channel not found.' };
  return { ok: true };
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no new type errors.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(app)/channels/[id]/voice-actions.ts"
git commit -m "feat: loadVoiceCatalog + saveChannelVoiceTts server actions

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Wire tuning params into the synthesis trigger

**Files:**
- Modify: `src/app/(app)/videos/[id]/voice-actions.ts:80-98`

**Interfaces:**
- Consumes: `voiceSettingsFromTts` from `@/lib/channels/voice` (Task 1); the `voice/synthesize` event payload already types `voice: { voiceId: string; modelId?: string; settings?: VoiceSettings }` (`src/lib/inngest/client.ts:50`); `synthesize-voice.ts` already passes `voice.settings` as `voiceSettings`.

- [ ] **Step 1: Add the import**

In `src/app/(app)/videos/[id]/voice-actions.ts`, add to the imports near the top (after the existing `elevenlabs` import on line 7):

```ts
import { voiceSettingsFromTts } from '@/lib/channels/voice';
```

- [ ] **Step 2: Compute settings and include on the event**

The current block (lines ~80-98) resolves `voiceTts`, `voiceId`, `modelId`, then sends the event. Replace the event `send` so the tuning params ride along. The `voiceTts` is currently narrowed to `{ voice_id?, model? }`; `voiceSettingsFromTts` takes `unknown` and guards internally, so pass `voiceTts` directly.

Change the existing:

```ts
  await inngest.send({
    name: 'voice/synthesize',
    data: { jobId, videoId, accountId, sceneIds: ids, voice: { voiceId, modelId } },
  });
```

to:

```ts
  const settings = voiceSettingsFromTts(voiceTts);
  await inngest.send({
    name: 'voice/synthesize',
    data: {
      jobId,
      videoId,
      accountId,
      sceneIds: ids,
      voice: { voiceId, modelId, ...(settings ? { settings } : {}) },
    },
  });
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no new type errors. (`voiceSettingsFromTts` returns `VoiceSettings | undefined`, matching the payload's `settings?: VoiceSettings`.)

- [ ] **Step 4: Run the full suite (no regressions)**

Run: `npm test`
Expected: PASS — including the Task 1 `voice.test.ts`. No existing test asserts the old event shape; this is additive.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/videos/[id]/voice-actions.ts"
git commit -m "feat: wire voice_tts tuning params into synthesis event

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: `VoiceEditor` component + page wiring

**Files:**
- Create: `src/app/(app)/channels/[id]/VoiceEditor.tsx`
- Modify: `src/app/(app)/channels/[id]/page.tsx`

**Interfaces:**
- Consumes: `parseVoiceTts`, `type VoiceForm`, `VOICE_PARAM_MIN`, `VOICE_PARAM_MAX` from `@/lib/channels/voice`; `loadVoiceCatalog`, `saveChannelVoiceTts` from `./voice-actions`; `type CatalogVoice`, `type CatalogModel` from `@/lib/voice/elevenlabs`.
- Produces: `<VoiceEditor channelId={string} initial={VoiceForm} />` rendered on the channel page.

- [ ] **Step 1: Write the component**

Create `src/app/(app)/channels/[id]/VoiceEditor.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { loadVoiceCatalog, saveChannelVoiceTts } from './voice-actions';
import { VOICE_PARAM_MIN, VOICE_PARAM_MAX, type VoiceForm } from '@/lib/channels/voice';
import type { CatalogVoice, CatalogModel } from '@/lib/voice/elevenlabs';

// Channel voice editor (Phase 8 slice 5). Renders instantly from stored voice_tts;
// "Load voices & models" fetches the live catalog (server action — the API key
// stays server-side) and turns the voice/model fields into selects. The current
// stored id is always kept selectable. Tuning sliders work without a fetch.
const SLIDERS: Array<{ key: 'stability' | 'similarityBoost' | 'style'; label: string }> = [
  { key: 'stability', label: 'Stability' },
  { key: 'similarityBoost', label: 'Similarity boost' },
  { key: 'style', label: 'Style' },
];

export function VoiceEditor({ channelId, initial }: { channelId: string; initial: VoiceForm }) {
  const [form, setForm] = useState<VoiceForm>(initial);
  const [voices, setVoices] = useState<CatalogVoice[] | null>(null);
  const [models, setModels] = useState<CatalogModel[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function patch(p: Partial<VoiceForm>) {
    setForm((f) => ({ ...f, ...p }));
    setDirty(true);
    setSaved(false);
  }

  async function onLoadCatalog() {
    setLoading(true);
    setError(null);
    try {
      const res = await loadVoiceCatalog();
      if (res.ok) {
        setVoices(res.voices);
        setModels(res.models);
      } else {
        setError(res.reason);
      }
    } catch {
      setError('Something went wrong loading the catalog.');
    } finally {
      setLoading(false);
    }
  }

  async function onSave() {
    setBusy(true);
    setError(null);
    try {
      const res = await saveChannelVoiceTts(channelId, form);
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

  // The options for a picker: the catalog if loaded, with the current id prepended
  // as "(current)" when the catalog doesn't already include it (so a custom/cloned
  // voice or model is never lost).
  function optionsWithCurrent(
    catalog: Array<{ id: string; name: string }> | null,
    currentId: string,
  ): Array<{ id: string; name: string }> | null {
    if (!catalog) return null;
    if (catalog.some((o) => o.id === currentId)) return catalog;
    return [{ id: currentId, name: `${currentId} (current)` }, ...catalog];
  }

  const voiceOptions = optionsWithCurrent(voices, form.voiceId);
  const modelOptions = optionsWithCurrent(models, form.model);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Voice</h2>
        <p className="text-sm opacity-70">
          The ElevenLabs voice, model, and tuning used to narrate this channel&apos;s videos.
        </p>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onLoadCatalog}
          disabled={loading}
          className="rounded-md border border-black/15 px-3 py-1.5 text-sm dark:border-white/15 disabled:opacity-50"
        >
          {loading ? 'Loading…' : 'Load voices & models'}
        </button>
        {voices && <span className="text-xs opacity-60">Catalog loaded.</span>}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="space-y-1">
          <span className="text-sm font-medium">Voice</span>
          {voiceOptions ? (
            <select
              value={form.voiceId}
              onChange={(e) => patch({ voiceId: e.target.value })}
              className="block w-full rounded border border-black/15 bg-transparent px-2 py-1.5 text-sm dark:border-white/15"
            >
              {voiceOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          ) : (
            <span className="block truncate rounded border border-black/10 px-2 py-1.5 text-sm opacity-70 dark:border-white/10">
              {form.voiceId}
            </span>
          )}
        </label>

        <label className="space-y-1">
          <span className="text-sm font-medium">Model</span>
          {modelOptions ? (
            <select
              value={form.model}
              onChange={(e) => patch({ model: e.target.value })}
              className="block w-full rounded border border-black/15 bg-transparent px-2 py-1.5 text-sm dark:border-white/15"
            >
              {modelOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          ) : (
            <span className="block truncate rounded border border-black/10 px-2 py-1.5 text-sm opacity-70 dark:border-white/10">
              {form.model}
            </span>
          )}
        </label>
      </div>

      <div className="space-y-3">
        {SLIDERS.map(({ key, label }) => (
          <label key={key} className="block space-y-1">
            <span className="text-sm font-medium">
              {label}: {form[key].toFixed(2)}
            </span>
            <input
              type="range"
              min={VOICE_PARAM_MIN}
              max={VOICE_PARAM_MAX}
              step={0.05}
              value={form[key]}
              onChange={(e) => patch({ [key]: Number(e.target.value) } as Partial<VoiceForm>)}
              className="block w-full"
            />
          </label>
        ))}
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.useSpeakerBoost}
            onChange={(e) => patch({ useSpeakerBoost: e.target.checked })}
          />
          <span className="font-medium">Speaker boost</span>
        </label>
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

- [ ] **Step 2: Wire it into the page**

In `src/app/(app)/channels/[id]/page.tsx`:

(a) Add imports near the other channel imports:

```ts
import { parseVoiceTts } from '@/lib/channels/voice';
import { VoiceEditor } from './VoiceEditor';
```

(b) Add `voice_tts` to the select. Change:

```ts
    .select('id, name, brand_kit, brand_voice, defaults')
```

to:

```ts
    .select('id, name, brand_kit, brand_voice, defaults, voice_tts')
```

(c) After the `logoPreviewUrls` loop (just before the `return`), parse the voice form:

```ts
  const voiceInitial = parseVoiceTts(channel.voice_tts);
```

(d) Add the section at the end of the JSX, after the `<LogosEditor ... />` block:

```tsx
      <hr className="border-black/10 dark:border-white/10" />

      <VoiceEditor channelId={channel.id as string} initial={voiceInitial} />
```

- [ ] **Step 3: Type-check + build the page**

Run: `npx tsc --noEmit`
Expected: no new type errors.

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS (no test regressions; the editor is exercised manually).

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/channels/[id]/VoiceEditor.tsx" "src/app/(app)/channels/[id]/page.tsx"
git commit -m "feat: VoiceEditor section on the channel page

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Manual / app-run e2e (operator, after Task 6)

Not an automated task — the operator's review pass (per the studio-UI deferral posture):

1. Open `/channels/[id]` → the Voice section shows the current voice/model (ids) + default tuning sliders.
2. Click **Load voices & models** → the pickers populate; the current id is selectable (or "(current)" if not in the list).
3. Change voice, model, two sliders, toggle speaker boost → **Save** → reload: all persist.
4. Trigger a synthesis on a video in that channel → confirm the request carries `voice_settings` (the tuning reaches ElevenLabs).
5. Confirm the brand / caption-emphasis / logos sections still save independently.
6. Simulate a catalog-load failure (e.g. a bad key) → the reason shows and the section stays usable (current values still saveable).

---

## Self-Review

**1. Spec coverage:**
- On-demand catalog load + current-id-kept → Task 3 (`listVoices`/`listModels`), Task 4 (`loadVoiceCatalog`), Task 6 (`optionsWithCurrent`, render-from-stored). ✅
- Tuning sliders + toggle → Task 1 (form/validate), Task 6 (UI). ✅
- Synthesis wiring → Task 1 (`voiceSettingsFromTts`), Task 5 (event). ✅
- Wholesale `voice_tts` write + no-phantom-save → Task 2 (RPC), Task 4 (action). ✅
- Server-only key constraint → Task 3 (`server-only` client), Task 4 (action, client gets only `{id,name}[]`). ✅
- Back-compat (empty `voice_tts` → defaults; `undefined` settings omit) → Task 1 (`parseVoiceTts`, `voiceSettingsFromTts`). ✅
- Drift guard for local default constants → Task 1 test. ✅

**2. Placeholder scan:** none — every code step has complete code; commands have expected output.

**3. Type consistency:** `VoiceForm` keys (`voiceId/model/stability/similarityBoost/style/useSpeakerBoost`) are consistent across Tasks 1 and 6; the stored snake_case object (`voice_id/model/.../use_speaker_boost`) is consistent across Task 1 (`validateVoiceForm`), Task 2 (column), and the read in `parseVoiceTts`. `CatalogVoice`/`CatalogModel` (`{id,name}`) consistent across Tasks 3, 4, 6. RPC name `set_channel_voice_tts` consistent across Tasks 2 and 4. `voiceSettingsFromTts` signature consistent across Tasks 1 and 5.
