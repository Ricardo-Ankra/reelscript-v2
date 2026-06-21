# Voice profiles editor — design (slice 2)

**Date:** 2026-06-21
**Phase:** 8 (Full surfaces) — voice expressivity, slice 2 of 2
**Status:** design approved, ready for implementation plan

## Context

Slice 1 (2026-06-21) activated emotion tags end-to-end with a **built-in,
model-aware profile** in `src/lib/voice/profile.ts`
(`applyVoiceProfile(narration, modelId, base)`: v2 strips tags + `<pause>`→SSML +
a scene-level `voice_settings` nudge; v3 inserts inline `[audio tags]`). The
deployed `voice_profiles` table (account-scoped, per-ElevenLabs-model
`tag_mappings`) is still unread/unwritten.

Slice 2 makes those profiles **editable** and has synthesis **consult them**
(overriding the built-in), and closes the slice-1 deferral that v3 audio tags
could surface in captions.

`voice_profiles` (already deployed, init migration):

```sql
create table voice_profiles (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts (id) on delete cascade,
  elevenlabs_model_id text not null,
  model_name text not null,
  tag_mappings jsonb not null default '{}'::jsonb,
  is_fallback boolean not null default false,
  created_at timestamptz not null default now(),
  unique (account_id, elevenlabs_model_id)
);
-- RLS: acct_isolation for all using/with check (auth_owns_account(account_id))
```

`tag_mappings` shape: `{ "<tag>": { "mode": "audio_tag"|"ssml_break"|"strip",
"value"?: string, "nudge"?: { "stability"?: number, "style"?: number } } }`.

## Goal

Let the operator edit, per ElevenLabs model, how each of the 7 emotion tags is
rendered (mode + audio-tag text + voice_settings nudge); have synthesis apply the
stored profile when one exists (else the built-in default); and ensure v3 audio
tags never appear as caption words.

## Scope

**In scope:**

- A "Voice profiles" section on `/settings` (account-scoped): list the account's
  per-model profiles; add a profile for a model (picked from the live ElevenLabs
  model catalog, seeded from the built-in defaults); edit each model's 7-tag
  table; save; delete.
- Per-tag controls (full, matching `tag_mappings`): **mode** (`audio_tag` /
  `ssml_break` / `strip`), an **audio-tag text** value (for `audio_tag`), and a
  **voice_settings nudge** (`stability`/`style` deltas, for `strip`).
- Synthesis resolves the account's `voice_profiles` row for the channel's chosen
  model and applies it; falls back to the built-in default mapping when none.
- Caption tokenizer drops pure bracketed audio-tag tokens (`[excited]`).

**Out of scope:**

- `is_fallback` editing (resolution is exact-model row → code default; the column
  stays unused).
- Per-channel profile assignment (profiles are account+model-scoped; the channel's
  chosen model selects which profile applies).
- A test-synthesis preview; `api_credentials` for the ElevenLabs key.

## Architecture

The built-in profile becomes the **default mapping** of a now-general engine. A
stored row is applied if present, else the default. No schema change.

### Pure core: `src/lib/voice/profile.ts` (extended, unit-tested)

```ts
export type TagMode = 'audio_tag' | 'ssml_break' | 'strip';
export interface TagMapping {
  mode: TagMode;
  value?: string;                                  // audio_tag text
  nudge?: { stability?: number; style?: number };  // strip deltas
}
export type TagMappings = Partial<Record<EmotionTag, TagMapping>>;

// Apply a tag_mappings to narration → the exact text to synthesize + per-scene
// voice_settings. Per present tag: audio_tag → insert value (''); ssml_break →
// insert the SSML break; strip → remove. A tag absent from the mapping defaults
// to strip. settings = base ⊕ AVERAGE of present strip-tags-with-a-nudge deltas
// (stability/style), clamped [0,1]; no such nudges → settings = base (undefined
// stays undefined → voice_settings omitted). Same averaging/clamp rule as slice 1.
export function applyStoredProfile(
  narration: string,
  mapping: TagMappings,
  base: VoiceSettings | undefined,
): { text: string; settings: VoiceSettings | undefined };

// The built-in behavior expressed as data — used to SEED a new profile and as the
// fallback when no row exists. v2 (non-audio): emotion tags {mode:'strip',
// nudge: EMOTION_NUDGES[tag]}, <pause> {mode:'ssml_break'}. v3 (audio): all
// {mode:'audio_tag', value: AUDIO_TAGS[tag]}, <pause> {mode:'ssml_break'}.
export function defaultTagMappings(modelId: string): TagMappings;

// Validate an editor submission → storable tag_mappings. Rejects: a mode not in
// the 3; an audio_tag entry with an empty/missing value; a nudge stability/style
// outside [-1,1]; any key not in EMOTION_TAGS.
export function validateTagMappings(input: unknown):
  | { ok: true; value: TagMappings }
  | { ok: false; reason: string };
```

`applyVoiceProfile(narration, modelId, base)` is **refactored to delegate**:
`applyStoredProfile(narration, defaultTagMappings(modelId), base)`. Its signature
and behavior are unchanged — the **slice-1 `profile.test.ts` cases are the
guardrail** (they must stay green, proving the default-mapping path reproduces the
built-in byte-for-byte, including the nudge averaging/clamp).

### Data model

No schema change. One **migration** adds two account-scoped RPCs (mirroring
`set_account_model_routing`):

```sql
-- Upsert the caller's profile for a model. SECURITY INVOKER → RLS (acct_isolation)
-- applies; account resolved from auth.uid(). RETURNS id (NULL when no account).
create or replace function upsert_voice_profile(
  p_model_id      text,
  p_model_name    text,
  p_tag_mappings  jsonb
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

create or replace function delete_voice_profile(p_model_id text) returns uuid
language plpgsql
security invoker
as $$
declare v_account uuid; v_id uuid;
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

(plpgsql + `security invoker`: RLS still applies on the inner statements, and
resolving the account via `auth.uid()` keeps the client from supplying an
account id — same safety posture as `set_account_model_routing`.)

### Server actions: `src/app/(app)/settings/voice-profile-actions.ts` (`'use server'`)

- `loadModelCatalog(): Promise<{ ok:true; models: CatalogModel[] } | { ok:false;
  reason }>` — wraps `listModels()` in try/catch (on-demand, like the channel
  editor's catalog load).
- `saveVoiceProfile(modelId, modelName, input): Promise<{ ok:true } | { ok:false;
  reason }>` — `validateTagMappings(input)` → `rpc('upsert_voice_profile', {
  p_model_id, p_model_name, p_tag_mappings })` → error → `{ ok:false }`; `data ==
  null` → `'Account not found.'`; else `{ ok:true }`.
- `deleteVoiceProfile(modelId): Promise<{ ok:true } | { ok:false; reason }>` —
  `rpc('delete_voice_profile', { p_model_id })` → `data == null` → `'Profile not
  found.'`; else `{ ok:true }`.

### Synthesis resolution: `src/lib/inngest/functions/synthesize-voice.ts`

A memoized step (before the per-scene loop) loads the account's profile row for
the chosen model:

```ts
const mapping = await step.run('load-voice-profile', async () => {
  const { data } = await admin
    .from('voice_profiles')
    .select('tag_mappings')
    .eq('account_id', accountId)
    .eq('elevenlabs_model_id', voice.modelId ?? '')
    .maybeSingle();
  return (data?.tag_mappings as TagMappings) ?? defaultTagMappings(voice.modelId ?? '');
});
```

Per scene: `const { text, settings } = applyStoredProfile(captured, mapping,
voice.settings)` (replaces the direct `applyVoiceProfile` call; identical result
when no row exists). `step.run` returns a plain JSON object (the mapping) →
Inngest-serializable.

### Caption filter: `src/lib/captions/tokenize.ts`

`tokenizeSpokenWords` drops any token whose text fully matches `/^\[[^\]]+\]$/`
(a bracketed audio tag) before returning, so a v3 `[excited]` never becomes a
caption word. Normal narration words are never bracketed, so v2 is unaffected.

### UI: `src/app/(app)/settings/VoiceProfilesEditor.tsx` + `page.tsx`

`/settings/page.tsx` additionally reads the account's profiles (RLS `select id,
elevenlabs_model_id, model_name, tag_mappings`) and renders
`<VoiceProfilesEditor initial={profiles} />` below `<ModelRoutingEditor>`.

`VoiceProfilesEditor` (client): one editable block per profiled model — a 7-row
table (tag label; **mode** `<select>`; conditional **value** text input when
`audio_tag`; conditional **stability**/**style** number inputs when `strip`) +
**Save** + **Delete** (each block dirty-tracked, mirroring the prior editors).
An **"Add profile"** control: a "Load models" button (`loadModelCatalog`) → a
model `<select>` → adds an in-memory block seeded from `defaultTagMappings(modelId)`
(not yet persisted until Save). Saving a block calls `saveVoiceProfile`; Delete
calls `deleteVoiceProfile` and drops the block.

## Data flow

```
/settings (server) → read voice_profiles (RLS) → [{ modelId, modelName, mapping }] → VoiceProfilesEditor
editor → Add (loadModelCatalog → pick model → seed defaultTagMappings) / edit table
       → Save → saveVoiceProfile(modelId, name, mapping) → upsert_voice_profile RPC
       → Delete → deleteVoiceProfile(modelId) → delete_voice_profile RPC
synthesis → load-voice-profile step → row.tag_mappings ?? defaultTagMappings(modelId)
          → per scene applyStoredProfile(narration, mapping, base)
captions → tokenizeSpokenWords drops [audio-tag] tokens
```

## Error handling

- `validateTagMappings` → friendly reason for a bad mode / empty audio-tag value /
  out-of-range nudge / unknown key; the editor shows it and keeps edits.
- `saveVoiceProfile` / `deleteVoiceProfile` → `{ ok:false, reason }` on RPC error;
  `data == null` → "Account not found." / "Profile not found." (no phantom save).
- `applyStoredProfile` is defensive: an absent or malformed tag entry → strip;
  nudges clamped — synthesis never breaks on a bad stored mapping.
- `loadModelCatalog` failure → reason shown; the section stays usable; existing
  profiles still editable/saveable.

## Back-compatibility

- No `voice_profiles` row for a model → `defaultTagMappings` → identical to slice 1
  (and to today for plain narration). `applyVoiceProfile` keeps its signature +
  behavior (delegation; slice-1 tests guard it).
- The caption filter only drops fully-bracketed tokens — normal narration is never
  bracketed, so v2 captions are byte-identical.
- `is_fallback` column untouched; no schema change; old renders/synth unaffected.

## Testing

- **Unit (`src/lib/voice/profile.test.ts`):**
  - Slice-1 cases stay green (the delegation guardrail).
  - `applyStoredProfile` — `audio_tag` inserts the value; `ssml_break` inserts the
    break; `strip` removes + nudges (assert averaged+clamped value for a known
    case); a tag absent from the mapping → stripped; no nudges → settings undefined
    when base undefined.
  - `defaultTagMappings` — v2 emotion tag → `{mode:'strip', nudge}`, `<pause>` →
    `{mode:'ssml_break'}`; v3 → `{mode:'audio_tag', value}`.
  - `validateTagMappings` — accepts a valid mapping; rejects a bad mode, an
    `audio_tag` with empty value, a nudge at `-1.1` / `1.1`, and an unknown key.
  - Equivalence: `applyVoiceProfile(n, m, b)` deep-equals
    `applyStoredProfile(n, defaultTagMappings(m), b)` for a v2 and a v3 case.
- **Unit (`src/lib/captions/tokenize.test.ts`):** a `[excited]` token is dropped;
  normal words (including ones with internal punctuation) are kept; timings of
  kept words unchanged.
- **Migration:** `npm run db:apply` the RPCs; confirm applied.
- **Regression:** `npm test` green; `npx tsc --noEmit` + `npm run lint` clean.
- **Manual / app-run e2e:** `/settings` → Add profile for the default model →
  tune a `<calm>` nudge → Save → reload persists → synthesize a `<calm>` scene →
  audio reflects the stored nudge (differs from the built-in) → Delete → reverts
  to the built-in → (if a v3 model is available) profile it → captions show no
  `[tag]` text.

## Open questions

None. Full per-tag editor (mode + value + nudge), exact-model-row→code-default
resolution (no `is_fallback`), the caption filter folded in, and the
`applyVoiceProfile`→`applyStoredProfile` delegation are all settled.
