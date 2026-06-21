# Voice profiles editor (slice 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the deployed `voice_profiles` table editable per ElevenLabs model and have synthesis consult it (overriding the built-in default profile), plus stop v3 audio tags from surfacing as caption words.

**Architecture:** The slice-1 built-in profile becomes the *default mapping* of a now-general engine (`applyStoredProfile`). Synthesis loads the account's stored `tag_mappings` for the channel's chosen model (or falls back to `defaultTagMappings`) and applies it per scene. A `/settings` editor (account-scoped, RLS read + two `security invoker` plpgsql RPCs) edits the per-model 7-tag table. The caption tokenizer drops fully-bracketed `[audio-tag]` tokens.

**Tech Stack:** TypeScript, Next.js App Router (RSC + `'use server'` actions + client components), Supabase/Postgres (RLS + plpgsql RPCs), Inngest (synthesis worker), `node:test` via `--experimental-strip-types`.

## Global Constraints

- The pure engine lives in `src/lib/voice/profile.ts` and must stay free of `server-only`, react, and network imports (it is imported by both the Inngest worker and a client component). Its only imports are `./emotion` and the `VoiceSettings` type from `./alignment`.
- **Slice-1 behavior is frozen:** `applyVoiceProfile(narration, modelId, base)` keeps its exact signature and output. The existing `src/lib/voice/profile.test.ts` cases are the guardrail and must stay byte-for-byte green after the refactor.
- The 7-tag vocabulary is fixed: `<excited> <pause> <whisper> <emphatic> <calm> <curious> <serious>` (from `EMOTION_TAGS` in `./emotion`). No new tags.
- `tag_mappings` JSON shape: `{ "<tag>": { "mode": "audio_tag"|"ssml_break"|"strip", "value"?: string, "nudge"?: { "stability"?: number, "style"?: number } } }`.
- Account scoping is server-side only: RPCs resolve the account via `auth.uid()` (`security invoker`); the client never supplies an account id. RPCs return the affected `uuid`, or `NULL` when no account/row matched (→ a failure, never a phantom "Saved").
- The ElevenLabs API key is server-only (`serverEnv.elevenlabs.apiKey`); the model catalog reaches the client only via the `loadModelCatalog` server action as `{ id, name }[]`.
- Run a single test file with: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test <path>`. Full suite: `npm test`. Test imports use explicit `.ts` extensions.
- Migrations apply with: `npm run db:apply -- <path>`.
- Commit footer on every commit: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- `is_fallback` stays unused. No schema change (the table is already deployed). No per-channel assignment, no test-synthesis preview, no `api_credentials`.

---

## File Structure

- `src/lib/voice/profile.ts` (modify) — add `TagMode`/`TagMapping`/`TagMappings` types, `applyStoredProfile`, `defaultTagMappings`, `validateTagMappings`; refactor `applyVoiceProfile` to delegate. The engine.
- `src/lib/voice/profile.test.ts` (modify) — keep slice-1 cases; add `applyStoredProfile` / `defaultTagMappings` / `validateTagMappings` / equivalence cases.
- `src/lib/captions/tokenize.ts` (modify) — drop fully-bracketed audio-tag tokens.
- `src/lib/captions/tokenize.test.ts` (modify) — assert the drop + that normal words/timings are untouched.
- `supabase/migrations/20260621120000_voice_profiles_rpcs.sql` (create) — `upsert_voice_profile` + `delete_voice_profile`.
- `src/app/(app)/settings/voice-profile-actions.ts` (create) — `loadModelCatalog`, `saveVoiceProfile`, `deleteVoiceProfile`.
- `src/lib/inngest/functions/synthesize-voice.ts` (modify) — load the stored mapping once, apply per scene via `applyStoredProfile`.
- `src/app/(app)/settings/VoiceProfilesEditor.tsx` (create) — the client editor.
- `src/app/(app)/settings/page.tsx` (modify) — read profiles, render the editor below model routing.

---

## Task 1: Pure engine — stored-profile types, `applyStoredProfile`, `defaultTagMappings`, `validateTagMappings`, delegate `applyVoiceProfile`

**Files:**
- Modify: `src/lib/voice/profile.ts`
- Test: `src/lib/voice/profile.test.ts`

**Interfaces:**
- Consumes: `EMOTION_TAGS`, `type EmotionTag`, `applyFallbackProfile` from `./emotion`; `type VoiceSettings` from `./alignment`. Existing module-private helpers `tidy`, `clamp01`, `DEFAULT_VOICE_SETTINGS`, `PAUSE_BREAK`, and the exports `EMOTION_NUDGES`, `AUDIO_TAGS`, `modelSupportsAudioTags`.
- Produces:
  - `export type TagMode = 'audio_tag' | 'ssml_break' | 'strip'`
  - `export interface TagMapping { mode: TagMode; value?: string; nudge?: { stability?: number; style?: number } }`
  - `export type TagMappings = Partial<Record<EmotionTag, TagMapping>>`
  - `export function applyStoredProfile(narration: string, mapping: TagMappings, base: VoiceSettings | undefined): { text: string; settings: VoiceSettings | undefined }`
  - `export function defaultTagMappings(modelId: string): TagMappings`
  - `export function validateTagMappings(input: unknown): { ok: true; value: TagMappings } | { ok: false; reason: string }`
  - `applyVoiceProfile` keeps the same signature, now delegating.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/voice/profile.test.ts`. First extend the import line at the top so it reads:

```ts
import {
  modelSupportsAudioTags,
  applyVoiceProfile,
  stripEmotionTags,
  EMOTION_NUDGES,
  applyStoredProfile,
  defaultTagMappings,
  validateTagMappings,
  type TagMappings,
} from './profile.ts';
```

Then append these tests at the end of the file:

```ts
test('defaultTagMappings v2: emotion tags strip+nudge, pause ssml_break', () => {
  const m = defaultTagMappings('eleven_multilingual_v2');
  assert.deepEqual(m['<pause>'], { mode: 'ssml_break' });
  assert.deepEqual(m['<excited>'], { mode: 'strip', nudge: { style: 0.2, stability: -0.1 } });
  assert.deepEqual(m['<emphatic>'], { mode: 'strip', nudge: { style: 0.15 } });
});

test('defaultTagMappings v3: emotion tags audio_tag, pause ssml_break', () => {
  const m = defaultTagMappings('eleven_v3');
  assert.deepEqual(m['<pause>'], { mode: 'ssml_break' });
  assert.deepEqual(m['<excited>'], { mode: 'audio_tag', value: '[excited]' });
  assert.deepEqual(m['<whisper>'], { mode: 'audio_tag', value: '[whispers]' });
});

test('applyStoredProfile: audio_tag inserts value, ssml_break inserts break, strip removes', () => {
  const mapping: TagMappings = {
    '<excited>': { mode: 'audio_tag', value: '[excited]' },
    '<pause>': { mode: 'ssml_break' },
    '<whisper>': { mode: 'strip' },
  };
  const r = applyStoredProfile('A <excited> b <pause> c <whisper> d', mapping, undefined);
  assert.ok(r.text.includes('[excited]'));
  assert.ok(r.text.includes('<break time="0.4s"/>'));
  assert.ok(!r.text.includes('<whisper>'));
  assert.ok(!r.text.includes('[whispers]'));
});

test('applyStoredProfile: a tag absent from the mapping is stripped', () => {
  const r = applyStoredProfile('keep <serious> this', {}, undefined);
  assert.equal(r.text, 'keep this');
  assert.equal(r.settings, undefined);
});

test('applyStoredProfile: strip nudges average + clamp; no nudges → settings undefined', () => {
  // <excited> style +0.2, <calm> style -0.15 → avg +0.025; base undefined → seed style 0
  const mapping: TagMappings = {
    '<excited>': { mode: 'strip', nudge: { style: 0.2, stability: -0.1 } },
    '<calm>': { mode: 'strip', nudge: { style: -0.15, stability: 0.1 } },
  };
  const r = applyStoredProfile('<excited> x <calm> y', mapping, undefined);
  assert.equal(Math.round(r.settings!.style * 1000) / 1000, 0.025);
  assert.equal(r.settings?.stability, 0.5); // -0.1 +0.1 avg 0, seed 0.5
  // ssml_break / audio_tag tags carry no nudge → settings stays the base (undefined).
  const none = applyStoredProfile('a <pause> b', { '<pause>': { mode: 'ssml_break' } }, undefined);
  assert.equal(none.settings, undefined);
});

test('validateTagMappings: accepts a valid mapping', () => {
  const res = validateTagMappings({
    '<excited>': { mode: 'audio_tag', value: '[excited]' },
    '<calm>': { mode: 'strip', nudge: { style: -0.15, stability: 0.1 } },
    '<pause>': { mode: 'ssml_break' },
  });
  assert.equal(res.ok, true);
});

test('validateTagMappings: rejects bad mode, empty audio value, out-of-range nudge, unknown key', () => {
  assert.equal(validateTagMappings({ '<calm>': { mode: 'nope' } }).ok, false);
  assert.equal(validateTagMappings({ '<excited>': { mode: 'audio_tag', value: '' } }).ok, false);
  assert.equal(validateTagMappings({ '<calm>': { mode: 'strip', nudge: { style: 1.1 } } }).ok, false);
  assert.equal(validateTagMappings({ '<calm>': { mode: 'strip', nudge: { stability: -1.1 } } }).ok, false);
  assert.equal(validateTagMappings({ '<bogus>': { mode: 'strip' } }).ok, false);
});

test('equivalence: applyVoiceProfile == applyStoredProfile(defaultTagMappings) for v2 and v3', () => {
  const base = { stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: true };
  const n = 'A <excited> b <pause> c <calm> d';
  for (const model of ['eleven_multilingual_v2', 'eleven_v3']) {
    assert.deepEqual(
      applyVoiceProfile(n, model, base),
      applyStoredProfile(n, defaultTagMappings(model), base),
    );
  }
  // also the undefined-base path
  assert.deepEqual(
    applyVoiceProfile(n, 'eleven_multilingual_v2', undefined),
    applyStoredProfile(n, defaultTagMappings('eleven_multilingual_v2'), undefined),
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/voice/profile.test.ts`
Expected: FAIL — `applyStoredProfile` / `defaultTagMappings` / `validateTagMappings` are not exported (import error or "is not a function").

- [ ] **Step 3: Implement the engine**

In `src/lib/voice/profile.ts`, add the types and three functions, and refactor `applyVoiceProfile` to delegate. Place the new types near the top (after the imports) and the functions before `applyVoiceProfile`. Replace the existing `applyVoiceProfile` body with the delegation.

Add after the `import type { VoiceSettings }` line:

```ts
export type TagMode = 'audio_tag' | 'ssml_break' | 'strip';
export interface TagMapping {
  mode: TagMode;
  value?: string; // audio_tag text
  nudge?: { stability?: number; style?: number }; // strip deltas
}
export type TagMappings = Partial<Record<EmotionTag, TagMapping>>;
```

Add these functions just above `export function applyVoiceProfile`:

```ts
// Apply a tag_mappings to narration → the exact text to synthesize + the per-scene
// voice_settings. Per tag (absent from the mapping ⇒ treated as strip): audio_tag →
// insert value (missing/empty ⇒ ''); ssml_break → insert the SSML break; strip →
// remove. settings = base ⊕ AVERAGE of present strip-tags-that-carry-a-nudge deltas
// (stability/style), clamped [0,1]; none ⇒ settings = base (undefined stays
// undefined → voice_settings omitted). Same averaging/clamp rule as slice 1.
export function applyStoredProfile(
  narration: string,
  mapping: TagMappings,
  base: VoiceSettings | undefined,
): { text: string; settings: VoiceSettings | undefined } {
  let out = narration;
  for (const tag of EMOTION_TAGS) {
    const m = mapping[tag] ?? { mode: 'strip' as const };
    const replacement =
      m.mode === 'audio_tag' ? m.value ?? '' : m.mode === 'ssml_break' ? PAUSE_BREAK : '';
    out = out.split(tag).join(replacement);
  }
  const text = tidy(out);

  const contributing = EMOTION_TAGS.filter((tag) => {
    const m = mapping[tag];
    return m != null && m.mode === 'strip' && m.nudge != null && narration.includes(tag);
  });
  if (contributing.length === 0) return { text, settings: base };

  const seed: Required<VoiceSettings> = { ...DEFAULT_VOICE_SETTINGS, ...(base ?? {}) };
  let dStability = 0;
  let dStyle = 0;
  for (const tag of contributing) {
    const n = mapping[tag]!.nudge!;
    dStability += n.stability ?? 0;
    dStyle += n.style ?? 0;
  }
  dStability /= contributing.length;
  dStyle /= contributing.length;

  return {
    text,
    settings: {
      stability: clamp01(seed.stability + dStability),
      similarity_boost: seed.similarity_boost,
      style: clamp01(seed.style + dStyle),
      use_speaker_boost: seed.use_speaker_boost,
    },
  };
}

// The built-in behavior expressed as data — seeds a new profile and is the fallback
// when no stored row exists. v2 (non-audio): emotion tags { mode:'strip',
// nudge: EMOTION_NUDGES[tag] }, <pause> { mode:'ssml_break' }. v3 (audio): emotion
// tags { mode:'audio_tag', value: AUDIO_TAGS[tag] }, <pause> { mode:'ssml_break' }.
export function defaultTagMappings(modelId: string): TagMappings {
  const audio = modelSupportsAudioTags(modelId);
  const out: TagMappings = {};
  for (const tag of EMOTION_TAGS) {
    if (tag === '<pause>') {
      out[tag] = { mode: 'ssml_break' };
      continue;
    }
    if (audio) {
      out[tag] = { mode: 'audio_tag', value: AUDIO_TAGS[tag] };
    } else {
      const n = EMOTION_NUDGES[tag];
      const nudge: { stability?: number; style?: number } = {};
      if (n.stability !== undefined) nudge.stability = n.stability;
      if (n.style !== undefined) nudge.style = n.style;
      out[tag] = { mode: 'strip', nudge };
    }
  }
  return out;
}

const TAG_MODES: readonly TagMode[] = ['audio_tag', 'ssml_break', 'strip'];
const EMOTION_TAG_SET = new Set<string>(EMOTION_TAGS);

// Validate an editor submission → storable tag_mappings. Rejects: an unknown key; a
// non-object entry; a mode not in the 3; an audio_tag with an empty/missing value; a
// nudge that is not an object or whose stability/style is non-numeric / outside [-1,1].
export function validateTagMappings(
  input: unknown,
): { ok: true; value: TagMappings } | { ok: false; reason: string } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, reason: 'Profile must be an object.' };
  }
  const out: TagMappings = {};
  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    if (!EMOTION_TAG_SET.has(key)) return { ok: false, reason: `Unknown tag: ${key}` };
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return { ok: false, reason: `Mapping for ${key} must be an object.` };
    }
    const m = raw as Record<string, unknown>;
    if (!TAG_MODES.includes(m.mode as TagMode)) {
      return { ok: false, reason: `Invalid mode for ${key}.` };
    }
    const mode = m.mode as TagMode;
    const entry: TagMapping = { mode };
    if (mode === 'audio_tag') {
      if (typeof m.value !== 'string' || m.value.trim() === '') {
        return { ok: false, reason: `${key}: audio tag text is required.` };
      }
      entry.value = m.value;
    }
    if (m.nudge !== undefined) {
      if (typeof m.nudge !== 'object' || m.nudge === null || Array.isArray(m.nudge)) {
        return { ok: false, reason: `${key}: nudge must be an object.` };
      }
      const n = m.nudge as Record<string, unknown>;
      const nudge: { stability?: number; style?: number } = {};
      for (const axis of ['stability', 'style'] as const) {
        if (n[axis] !== undefined) {
          const v = n[axis];
          if (typeof v !== 'number' || Number.isNaN(v) || v < -1 || v > 1) {
            return { ok: false, reason: `${key}: ${axis} must be between -1 and 1.` };
          }
          nudge[axis] = v;
        }
      }
      entry.nudge = nudge;
    }
    out[key as EmotionTag] = entry;
  }
  return { ok: true, value: out };
}
```

Replace the entire existing `applyVoiceProfile` function body with the delegation (keep the doc comment above it, or update it to note delegation):

```ts
// The built-in profile, expressed via the general engine: apply the model's default
// tag mapping. Signature/behavior unchanged from slice 1 (the slice-1 tests guard it).
export function applyVoiceProfile(
  narration: string,
  modelId: string,
  base: VoiceSettings | undefined,
): { text: string; settings: VoiceSettings | undefined } {
  return applyStoredProfile(narration, defaultTagMappings(modelId), base);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/voice/profile.test.ts`
Expected: PASS — all slice-1 cases AND the new cases green (the slice-1 cases prove the delegation is byte-identical).

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/voice/profile.ts src/lib/voice/profile.test.ts
git commit -m "feat(voice): general stored-profile engine + delegating applyVoiceProfile

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Caption tokenizer drops bracketed audio-tag tokens

**Files:**
- Modify: `src/lib/captions/tokenize.ts`
- Test: `src/lib/captions/tokenize.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `tokenizeSpokenWords` unchanged signature; now omits any token whose text fully matches `/^\[[^\]]+\]$/`.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/captions/tokenize.test.ts` (the `align` helper and `texts` helper already exist in the file):

```ts
test('tokenizeSpokenWords: drops a bracketed audio-tag token, keeps real words + timings', () => {
  const a = align([
    { t: 'hello', s: 0, e: 1 },
    { t: '[excited]', s: 1, e: 1.4 },
    { t: 'world', s: 1.4, e: 2 },
  ]);
  const ws = tokenizeSpokenWords(a);
  assert.deepEqual(texts(ws), ['hello', 'world']);
  assert.equal(ws[0].startSec, 0);
  assert.equal(ws[1].startSec, 1.4);
  assert.equal(ws[1].endSec, 2);
});

test('tokenizeSpokenWords: a word with internal brackets is NOT dropped', () => {
  const a = align([{ t: 'a[b]c', s: 0, e: 1 }]);
  assert.deepEqual(texts(tokenizeSpokenWords(a)), ['a[b]c']);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/captions/tokenize.test.ts`
Expected: FAIL — the first new test fails because `[excited]` is currently returned as a token.

- [ ] **Step 3: Implement the filter**

In `src/lib/captions/tokenize.ts`, add the regex constant above `tokenizeSpokenWords`:

```ts
// A token that is *entirely* a bracketed audio tag (e.g. "[excited]") is an
// ElevenLabs v3 delivery directive that the model may echo into the verbatim
// alignment. It is never a spoken word, so it must not become a caption. Normal
// narration words are never fully bracketed, so v2 captions are unaffected.
const AUDIO_TAG_TOKEN = /^\[[^\]]+\]$/;
```

Change the final two lines of `tokenizeSpokenWords` from:

```ts
  if (cur) words.push(cur);
  return words;
```

to:

```ts
  if (cur) words.push(cur);
  return words.filter((w) => !AUDIO_TAG_TOKEN.test(w.text));
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/captions/tokenize.test.ts`
Expected: PASS — including all pre-existing tokenizer cases.

- [ ] **Step 5: Commit**

```bash
git add src/lib/captions/tokenize.ts src/lib/captions/tokenize.test.ts
git commit -m "feat(captions): drop bracketed audio-tag tokens from spoken words

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Migration — `upsert_voice_profile` + `delete_voice_profile` RPCs

**Files:**
- Create: `supabase/migrations/20260621120000_voice_profiles_rpcs.sql`

**Interfaces:**
- Consumes: the deployed `voice_profiles` table (`account_id, elevenlabs_model_id, model_name, tag_mappings`, `unique (account_id, elevenlabs_model_id)`, RLS `acct_isolation`) and `accounts.owner_user_id`.
- Produces:
  - `upsert_voice_profile(p_model_id text, p_model_name text, p_tag_mappings jsonb) returns uuid`
  - `delete_voice_profile(p_model_id text) returns uuid`

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260621120000_voice_profiles_rpcs.sql`:

```sql
-- Phase 8 slice 2 — voice profiles editor. Two account-scoped RPCs over the already
-- deployed voice_profiles table. SECURITY INVOKER → the table's RLS (acct_isolation)
-- still applies on the inner statements, and the account is resolved from auth.uid()
-- so the client cannot supply an account id. Each RETURNS the affected id, or NULL
-- when no account/row matched (→ a failure, never a phantom "Saved"). Mirrors
-- set_account_model_routing.

-- Upsert the caller's profile for one ElevenLabs model (the editor owns the whole
-- 7-tag mapping for that model).
create or replace function upsert_voice_profile(
  p_model_id     text,
  p_model_name   text,
  p_tag_mappings jsonb
) returns uuid
language plpgsql
security invoker
as $$
declare
  v_account uuid;
  v_id uuid;
begin
  select id into v_account from accounts where owner_user_id = auth.uid();
  if v_account is null then return null; end if;

  insert into voice_profiles (account_id, elevenlabs_model_id, model_name, tag_mappings)
  values (v_account, p_model_id, p_model_name, p_tag_mappings)
  on conflict (account_id, elevenlabs_model_id)
  do update set model_name = excluded.model_name, tag_mappings = excluded.tag_mappings
  returning id into v_id;

  return v_id;
end;
$$;

grant execute on function upsert_voice_profile(text, text, jsonb) to authenticated;

-- Delete the caller's profile for one model.
create or replace function delete_voice_profile(p_model_id text) returns uuid
language plpgsql
security invoker
as $$
declare
  v_account uuid;
  v_id uuid;
begin
  select id into v_account from accounts where owner_user_id = auth.uid();
  if v_account is null then return null; end if;

  delete from voice_profiles
  where account_id = v_account and elevenlabs_model_id = p_model_id
  returning id into v_id;

  return v_id;
end;
$$;

grant execute on function delete_voice_profile(text) to authenticated;
```

- [ ] **Step 2: Apply the migration**

Run: `npm run db:apply -- supabase/migrations/20260621120000_voice_profiles_rpcs.sql`
Expected: applies cleanly (functions created). No error output.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260621120000_voice_profiles_rpcs.sql
git commit -m "feat(db): upsert_voice_profile + delete_voice_profile RPCs

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Server actions — `loadModelCatalog`, `saveVoiceProfile`, `deleteVoiceProfile`

**Files:**
- Create: `src/app/(app)/settings/voice-profile-actions.ts`

**Interfaces:**
- Consumes: `validateTagMappings` from `@/lib/voice/profile`; `listModels`, `type CatalogModel` from `@/lib/voice/elevenlabs`; `createClient` from `@/lib/supabase/server`; the RPCs from Task 3.
- Produces:
  - `loadModelCatalog(): Promise<{ ok: true; models: CatalogModel[] } | { ok: false; reason: string }>`
  - `saveVoiceProfile(modelId: string, modelName: string, input: unknown): Promise<{ ok: true } | { ok: false; reason: string }>`
  - `deleteVoiceProfile(modelId: string): Promise<{ ok: true } | { ok: false; reason: string }>`

- [ ] **Step 1: Write the actions**

Create `src/app/(app)/settings/voice-profile-actions.ts`:

```ts
'use server';

import { createClient } from '@/lib/supabase/server';
import { validateTagMappings } from '@/lib/voice/profile';
import { listModels, type CatalogModel } from '@/lib/voice/elevenlabs';

// Fetch the live ElevenLabs model catalog (on demand, like the channel voice editor).
// Server action so the API key (server-only) never reaches the client — the client
// gets only { id, name }[]. A network / non-2xx failure → a friendly reason.
export async function loadModelCatalog(): Promise<
  { ok: true; models: CatalogModel[] } | { ok: false; reason: string }
> {
  try {
    const models = await listModels();
    return { ok: true, models };
  } catch {
    return { ok: false, reason: "Couldn't reach ElevenLabs — check the API key and try again." };
  }
}

// Upsert the caller's voice profile for a model. validateTagMappings rejects a bad
// submission before it reaches the DB. The RPC returns the id, or null when no
// account matched — a failure, not a phantom "Saved".
export async function saveVoiceProfile(
  modelId: string,
  modelName: string,
  input: unknown,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const valid = validateTagMappings(input);
  if (!valid.ok) return valid;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc('upsert_voice_profile', {
    p_model_id: modelId,
    p_model_name: modelName,
    p_tag_mappings: valid.value,
  });
  if (error) return { ok: false, reason: error.message };
  if (data == null) return { ok: false, reason: 'Account not found.' };
  return { ok: true };
}

// Delete the caller's voice profile for a model. The RPC returns the id, or null when
// no row matched.
export async function deleteVoiceProfile(
  modelId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('delete_voice_profile', {
    p_model_id: modelId,
  });
  if (error) return { ok: false, reason: error.message };
  if (data == null) return { ok: false, reason: 'Profile not found.' };
  return { ok: true };
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors. (Confirms `validateTagMappings`, `listModels`, and the RPC calls type-check; the RPCs are untyped in the generated client, which the existing `set_account_model_routing` call also relies on.)

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: clean (no unused imports, no `any` violations).

- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/settings/voice-profile-actions.ts"
git commit -m "feat(settings): voice-profile server actions (catalog + upsert + delete)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Synthesis resolves the stored profile

**Files:**
- Modify: `src/lib/inngest/functions/synthesize-voice.ts`

**Interfaces:**
- Consumes: `applyStoredProfile`, `defaultTagMappings`, `type TagMappings` from `@/lib/voice/profile`; existing `admin` client, `accountId`, `voice` from the event.
- Produces: no new exports; the worker now applies the account's stored mapping (or the default) per scene.

- [ ] **Step 1: Swap the import**

In `src/lib/inngest/functions/synthesize-voice.ts`, change:

```ts
import { applyVoiceProfile } from '@/lib/voice/profile';
```

to:

```ts
import { applyStoredProfile, defaultTagMappings, type TagMappings } from '@/lib/voice/profile';
```

- [ ] **Step 2: Load the mapping once, before the per-scene loop**

After `let synthesized = 0;` / `let skipped = 0;` and **before** the `for` loop that chunks `sceneIds`, insert:

```ts
    // Resolve the account's stored profile for the chosen model once (memoized as a
    // durable step → re-runs reuse it). Falls back to the built-in default mapping
    // when no row exists — identical to slice 1. The returned plain object is
    // Inngest-serializable.
    const mapping = (await step.run('load-voice-profile', async () => {
      const { data } = await admin
        .from('voice_profiles')
        .select('tag_mappings')
        .eq('account_id', accountId)
        .eq('elevenlabs_model_id', voice.modelId ?? '')
        .maybeSingle();
      return (data?.tag_mappings as TagMappings) ?? defaultTagMappings(voice.modelId ?? '');
    })) as TagMappings;
```

- [ ] **Step 3: Apply the stored mapping per scene**

Inside the `step.run(`synth-${sceneId}`, ...)` body, change:

```ts
            const { text, settings } = applyVoiceProfile(captured, voice.modelId ?? '', voice.settings);
```

to:

```ts
            const { text, settings } = applyStoredProfile(captured, mapping, voice.settings);
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Run the voice engine tests (regression guard)**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/voice/profile.test.ts`
Expected: PASS — the engine the worker now calls is unchanged behavior for the default path.

- [ ] **Step 6: Commit**

```bash
git add src/lib/inngest/functions/synthesize-voice.ts
git commit -m "feat(voice): synthesis applies the account's stored profile per model

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: `/settings` editor — `VoiceProfilesEditor` + page wiring

**Files:**
- Create: `src/app/(app)/settings/VoiceProfilesEditor.tsx`
- Modify: `src/app/(app)/settings/page.tsx`

**Interfaces:**
- Consumes: `EMOTION_TAGS`, `type EmotionTag` from `@/lib/voice/emotion`; `defaultTagMappings`, `type TagMappings`, `type TagMode` from `@/lib/voice/profile`; `loadModelCatalog`, `saveVoiceProfile`, `deleteVoiceProfile` from `./voice-profile-actions`; `type CatalogModel` from `@/lib/voice/elevenlabs`.
- Produces: `export function VoiceProfilesEditor({ initial }: { initial: ProfileBlock[] })`, where `ProfileBlock = { modelId: string; modelName: string; mapping: TagMappings }`.

- [ ] **Step 1: Write the editor component**

Create `src/app/(app)/settings/VoiceProfilesEditor.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { EMOTION_TAGS, type EmotionTag } from '@/lib/voice/emotion';
import { defaultTagMappings, type TagMappings, type TagMode } from '@/lib/voice/profile';
import type { CatalogModel } from '@/lib/voice/elevenlabs';
import { loadModelCatalog, saveVoiceProfile, deleteVoiceProfile } from './voice-profile-actions';

export type ProfileBlock = { modelId: string; modelName: string; mapping: TagMappings };

const MODES: { value: TagMode; label: string }[] = [
  { value: 'strip', label: 'Strip (+ nudge)' },
  { value: 'audio_tag', label: 'Audio tag' },
  { value: 'ssml_break', label: 'SSML break' },
];

// One model's editable 7-tag table + Save / Delete. Dirty-tracked; mirrors the
// other account/channel editors.
function ProfileCard({
  block,
  onDeleted,
}: {
  block: ProfileBlock;
  onDeleted: (modelId: string) => void;
}) {
  const [mapping, setMapping] = useState<TagMappings>(block.mapping);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function patch(tag: EmotionTag, next: Partial<{ mode: TagMode; value: string; nudge: { stability?: number; style?: number } }>) {
    setMapping((m) => {
      const cur = m[tag] ?? { mode: 'strip' as TagMode };
      return { ...m, [tag]: { ...cur, ...next } };
    });
    setDirty(true);
    setSaved(false);
  }

  function patchNudge(tag: EmotionTag, axis: 'stability' | 'style', raw: string) {
    const cur = mapping[tag] ?? { mode: 'strip' as TagMode };
    const nudge = { ...(cur.nudge ?? {}) };
    if (raw === '') delete nudge[axis];
    else nudge[axis] = Number(raw);
    patch(tag, { nudge });
  }

  async function onSave() {
    setBusy(true);
    setError(null);
    try {
      const res = await saveVoiceProfile(block.modelId, block.modelName, mapping);
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
      const res = await deleteVoiceProfile(block.modelId);
      if (res.ok) onDeleted(block.modelId);
      else setError(res.reason);
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-black/10 p-4 dark:border-white/10">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold">{block.modelName}</div>
          <div className="text-xs opacity-60">{block.modelId}</div>
        </div>
        <button
          type="button"
          onClick={onDelete}
          disabled={busy}
          className="text-sm text-red-600 disabled:opacity-50"
        >
          Delete
        </button>
      </div>

      <div className="space-y-2">
        {EMOTION_TAGS.map((tag) => {
          const m = mapping[tag] ?? { mode: 'strip' as TagMode };
          return (
            <div key={tag} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="w-24 font-mono text-xs">{tag}</span>
              <select
                value={m.mode}
                onChange={(e) => patch(tag, { mode: e.target.value as TagMode })}
                className="rounded border border-black/15 bg-transparent px-2 py-1 text-sm dark:border-white/15"
              >
                {MODES.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>

              {m.mode === 'audio_tag' && (
                <input
                  type="text"
                  value={m.value ?? ''}
                  onChange={(e) => patch(tag, { value: e.target.value })}
                  placeholder="[excited]"
                  className="w-32 rounded border border-black/15 bg-transparent px-2 py-1 text-sm dark:border-white/15"
                />
              )}

              {m.mode === 'strip' && (
                <>
                  <label className="flex items-center gap-1 text-xs opacity-70">
                    stab
                    <input
                      type="number"
                      step="0.05"
                      min="-1"
                      max="1"
                      value={m.nudge?.stability ?? ''}
                      onChange={(e) => patchNudge(tag, 'stability', e.target.value)}
                      className="w-16 rounded border border-black/15 bg-transparent px-1 py-1 dark:border-white/15"
                    />
                  </label>
                  <label className="flex items-center gap-1 text-xs opacity-70">
                    style
                    <input
                      type="number"
                      step="0.05"
                      min="-1"
                      max="1"
                      value={m.nudge?.style ?? ''}
                      onChange={(e) => patchNudge(tag, 'style', e.target.value)}
                      className="w-16 rounded border border-black/15 bg-transparent px-1 py-1 dark:border-white/15"
                    />
                  </label>
                </>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
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

export function VoiceProfilesEditor({ initial }: { initial: ProfileBlock[] }) {
  const [blocks, setBlocks] = useState<ProfileBlock[]>(initial);
  const [models, setModels] = useState<CatalogModel[] | null>(null);
  const [picked, setPicked] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onLoadModels() {
    setBusy(true);
    setError(null);
    try {
      const res = await loadModelCatalog();
      if (res.ok) setModels(res.models);
      else setError(res.reason);
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  function onAdd() {
    if (!picked || !models) return;
    if (blocks.some((b) => b.modelId === picked)) {
      setError('A profile for that model already exists below.');
      return;
    }
    const model = models.find((m) => m.id === picked);
    if (!model) return;
    setError(null);
    setBlocks((bs) => [
      ...bs,
      { modelId: model.id, modelName: model.name, mapping: defaultTagMappings(model.id) },
    ]);
    setPicked('');
  }

  function onDeleted(modelId: string) {
    setBlocks((bs) => bs.filter((b) => b.modelId !== modelId));
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Voice profiles</h2>
        <p className="text-sm opacity-70">
          How each emotion tag is rendered, per ElevenLabs model. A model with no profile uses the
          built-in defaults.
        </p>
      </div>

      {blocks.length === 0 && <p className="text-sm opacity-60">No custom profiles yet.</p>}

      <div className="space-y-4">
        {blocks.map((b) => (
          <ProfileCard key={b.modelId} block={b} onDeleted={onDeleted} />
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-black/10 pt-4 dark:border-white/10">
        {models === null ? (
          <button
            type="button"
            onClick={onLoadModels}
            disabled={busy}
            className="rounded border border-black/15 px-3 py-1.5 text-sm disabled:opacity-50 dark:border-white/15"
          >
            {busy ? 'Loading…' : 'Add profile'}
          </button>
        ) : (
          <>
            <select
              value={picked}
              onChange={(e) => setPicked(e.target.value)}
              className="rounded border border-black/15 bg-transparent px-2 py-1.5 text-sm dark:border-white/15"
            >
              <option value="">Select a model…</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={onAdd}
              disabled={!picked}
              className="rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background disabled:opacity-50"
            >
              Add
            </button>
          </>
        )}
        {error && <span className="text-sm text-red-600">{error}</span>}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire the page**

Replace `src/app/(app)/settings/page.tsx` with:

```tsx
import { createClient } from '@/lib/supabase/server';
import { parseModelRouting } from '@/lib/ai/model-routing';
import { ModelRoutingEditor } from './ModelRoutingEditor';
import { VoiceProfilesEditor, type ProfileBlock } from './VoiceProfilesEditor';
import type { TagMappings } from '@/lib/voice/profile';

// Account settings (Phase 8). Model routing + voice profiles. RLS scopes both reads
// to the caller's own account.
export default async function SettingsPage() {
  const supabase = await createClient();

  const { data: account } = await supabase.from('accounts').select('model_routing').maybeSingle();
  const initialRouting = parseModelRouting(account?.model_routing);

  const { data: profiles } = await supabase
    .from('voice_profiles')
    .select('elevenlabs_model_id, model_name, tag_mappings');
  const initialProfiles: ProfileBlock[] = (profiles ?? []).map((p) => ({
    modelId: p.elevenlabs_model_id as string,
    modelName: p.model_name as string,
    mapping: (p.tag_mappings as TagMappings) ?? {},
  }));

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Account settings</h1>
        <p className="text-sm opacity-70">Defaults that apply across your channels.</p>
      </div>
      <ModelRoutingEditor initial={initialRouting} />
      <VoiceProfilesEditor initial={initialProfiles} />
    </div>
  );
}
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Lint**

Run: `npm run lint`
Expected: clean.

- [ ] **Step 5: Build the app (RSC + client boundary check)**

Run: `npm run build`
Expected: build succeeds — confirms `VoiceProfilesEditor` (client) only pulls pure modules (`@/lib/voice/profile`, `@/lib/voice/emotion`, the `CatalogModel` type) across the client boundary, and the page's server read compiles.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(app)/settings/VoiceProfilesEditor.tsx" "src/app/(app)/settings/page.tsx"
git commit -m "feat(settings): voice profiles editor on /settings

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final verification (whole branch)

- [ ] `npm test` — full suite green.
- [ ] `npx tsc --noEmit` — clean.
- [ ] `npm run lint` — clean.
- [ ] **Manual / app-run e2e (operator):** `/settings` → "Add profile" → pick the default model → tune a `<calm>` strip nudge → Save → reload persists → synthesize a `<calm>` scene → audio reflects the stored nudge (differs from the built-in) → Delete → reverts to the built-in → (if a v3 model is available) profile it → captions show no `[tag]` text.

## Post-merge bookkeeping (controller, after merge)

- Update `CLAUDE.md`: the Phase-3 deferral note "the editable per-model `voice_profiles` table/UI is still Phase 8 (slice 2)" becomes shipped; the slice-1 v3 caption-leak limitation is resolved.
- Update memory `voice-emotion-tags.md`: slice 2 done; the caption `[tag]` filter shipped.
