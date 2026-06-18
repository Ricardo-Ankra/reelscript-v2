# Channel voice params — design

**Date:** 2026-06-18
**Phase:** 8 (Full surfaces) — channel settings, sub-slice 5 of 5 (final)
**Status:** design approved, ready for implementation plan

## Context

`channels.voice_tts` is the channel's own JSONB column (`not null default
'{}'`), shape `{ voice_id, model, stability?, similarity_boost?, style?,
use_speaker_boost? }`. Today only `voice_id` + `model` are read at synthesis
time (`videos/[id]/voice-actions.ts` → `synthesizeScenes`), and **no UI writes
it** — a channel synthesizes with the hardcoded default public voice ("Rachel",
`DEFAULT_VOICE_ID`) and `ELEVENLABS_DEFAULT_MODEL` unless `voice_tts` already
holds values from elsewhere.

This slice (5 of 5: 1 ✅ foundation, 2 ✅ brand editor, 3 ✅ caption-emphasis,
4 ✅ logos) adds the **Voice** editor — a fourth section on `/channels/[id]` —
and wires the tuning params through to synthesis so the controls aren't dead.
It closes the channel-settings stack.

**No `deploy:remotion` gate.** Synthesis runs on Inngest (the `voice/synthesize`
function), not the Remotion render Lambda. The only runtime change is server-side
(the synthesis trigger), picked up by the running app/Inngest dev runtime.

## Goal

Let an operator pick a channel's ElevenLabs **voice** and **model** from the
live catalog, tune **stability / similarity_boost / style / use_speaker_boost**,
and have all of it persist to `voice_tts` and reach synthesis.

## Scope

**In scope** — a "Voice" section on `/channels/[id]`, below the Logos section,
with its **own Save**:

- **Voice** + **Model** pickers, populated **on demand** from the live
  ElevenLabs catalog (a "Load voices & models" button). The section renders
  instantly from the stored `voice_tts` without fetching; the current stored
  `voice_id`/`model` are always shown and saveable even before (or without) a
  fetch. After a successful load the two fields become `<select>`s; if the
  current stored id is not in the fetched list it is **prepended as a
  "(current)" option** so a custom/cloned voice is never lost.
- **Tuning** (always editable, no fetch required):
  - `stability`, `similarity_boost`, `style` — 0–1 sliders.
  - `use_speaker_boost` — a toggle.
- A fetch failure shows the reason and leaves the section fully usable (current
  values still saveable; tuning still editable).

**Synthesis wiring (in scope — so the tuning controls aren't dead):**
`synthesizeScenes` already extracts `voice_id`/`model` from `voice_tts` and
sends `voice: { voiceId, modelId }` on the `voice/synthesize` event. This slice
also extracts the 4 tuning keys (via a pure `voiceSettingsFromTts`) and sends
them as `voice.settings`. The event payload already types `settings?:
VoiceSettings`, and `synthesize-voice.ts` already passes `voice.settings` to the
ElevenLabs client as `voice_settings` — so this is a one-call change in
`voice-actions.ts` plus the pure extractor.

**Out of scope (not this slice / later)**

- The `voice_profiles` table and per-model emotion-tag mappings
  (`src/lib/voice/emotion.ts`) — a separate dormant Phase-8 feature; untouched.
- A test-synthesis / "hear it" preview button — adds synthesis cost + audio
  playback; defer.
- The `speed` param — not in the existing `VoiceSettings` type; not exposed.
- `api_credentials` for the ElevenLabs key — it stays an env var
  (`ELEVENLABS_API_KEY`); the encrypted-credentials table is a separate
  deferred Phase-8 item.

## Security constraint (binding)

The ElevenLabs API key is **server-only** (`serverEnv.elevenlabs.apiKey` in
`src/lib/env.server.ts`, which is `import 'server-only'`). The live catalog
fetch **MUST** go through a server action — never a client-side `fetch` to
ElevenLabs. The client receives only the mapped `{ id, name }[]` lists, never
the key.

## Data model

No schema change. `voice_tts` is its own column (not a `brand_kit` sub-key), so
the write is **wholesale** — the editor owns every key in the object. One
**migration** adds a focused RPC (slice-2…4 pattern):

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

This touches a different column than slices 2–4 (which write `brand_kit`), so
there is no clobber concern at all.

## Components

### Pure core (`src/lib/channels/voice.ts`, unit-tested)

Imports only pure modules + type-only: `VoiceSettings` (type) from
`../voice/alignment`; `DEFAULT_VOICE_ID`, `ELEVENLABS_DEFAULT_MODEL` are
**string constants** but live in the `server-only` `elevenlabs.ts` — to keep
`voice.ts` pure and importable by tests, **re-declare the two default strings as
local consts here** (with a comment that they mirror `elevenlabs.ts`), rather
than importing the server-only module. A unit test asserts the two local
constants equal the canonical values so they can't drift silently.

```ts
export interface VoiceForm {
  voiceId: string;
  model: string;
  stability: number;        // 0–1
  similarityBoost: number;  // 0–1
  style: number;            // 0–1
  useSpeakerBoost: boolean;
}

export const VOICE_PARAM_MIN = 0, VOICE_PARAM_MAX = 1;

// Default tuning shown when voice_tts has no tuning keys. ElevenLabs' own
// defaults for eleven_multilingual_v2.
export const DEFAULT_VOICE_FORM_TUNING = {
  stability: 0.5,
  similarityBoost: 0.75,
  style: 0,
  useSpeakerBoost: true,
} as const;

// Build the form model from the stored voice_tts. Backfills voiceId/model to the
// defaults when unset or the Phase-2 'placeholder' (voiceId only), and tuning to
// DEFAULT_VOICE_FORM_TUNING when absent. Always returns a complete VoiceForm.
export function parseVoiceTts(voiceTts: unknown): VoiceForm;

// Validate a form submission → the voice_tts object to store (snake_case keys,
// matching what synthesis reads + ElevenLabs voice_settings naming):
//   { voice_id, model, stability, similarity_boost, style, use_speaker_boost }
// Rejects: voice_id/model not a non-empty string; any of the 3 sliders not a
// finite number in [0,1]; use_speaker_boost non-boolean.
export function validateVoiceForm(input: unknown):
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; reason: string };

// Extract the 4 tuning keys from a stored voice_tts as a VoiceSettings (omitting
// any key that is absent / not the right type). Used by the synthesis trigger so
// the tuning params reach ElevenLabs. Returns undefined when none are present
// (so synthesize() omits voice_settings entirely, as today).
export function voiceSettingsFromTts(voiceTts: unknown): VoiceSettings | undefined;
```

### Live catalog — server-only client (`src/lib/voice/elevenlabs.ts`)

Add two server-only functions next to `synthesize`:

```ts
export type CatalogVoice = { id: string; name: string };
export type CatalogModel = { id: string; name: string };

// GET /v1/voices → map each to { id: voice_id, name }.
export async function listVoices(): Promise<CatalogVoice[]>;

// GET /v1/models → map each to { id: model_id, name }.
export async function listModels(): Promise<CatalogModel[]>;
```

Both use `'xi-api-key': serverEnv.elevenlabs.apiKey` and the existing
`ELEVENLABS_BASE`. A non-2xx throws with status + body (same posture as
`synthesize`). These are not unit-tested (live network) — exercised via the
manual e2e and the action's error path.

### Server actions

`src/app/(app)/channels/[id]/voice-actions.ts` (`'use server'`):

- `loadVoiceCatalog(): Promise<{ ok: true; voices: CatalogVoice[]; models:
  CatalogModel[] } | { ok: false; reason: string }>` — `Promise.all([listVoices(),
  listModels()])` in a try/catch; on throw → `{ ok:false, reason }` with a
  friendly message (e.g. "Couldn't reach ElevenLabs — check the API key."). No
  channel argument needed; it only reads the catalog.
- `saveChannelVoiceTts(channelId, input): Promise<{ ok: true } | { ok: false;
  reason: string }>` — `validateVoiceForm(input)` (return its `reason` on
  failure) → `supabase.rpc('set_channel_voice_tts', { p_channel_id: channelId,
  p_value })` → RPC error → `{ ok:false, reason }`; `data == null` → `{ ok:false,
  reason:'Channel not found.' }`; else `{ ok:true }`. RLS-scoped client; mirrors
  `saveChannelLogos`.

> **Note on file naming.** There is already a `videos/[id]/voice-actions.ts`
> (the synthesis trigger). This new file is `channels/[id]/voice-actions.ts` —
> a different directory; no conflict.

### Synthesis wiring (`src/app/(app)/videos/[id]/voice-actions.ts`)

In `synthesizeScenes`, after resolving `voiceTts`, also compute
`const settings = voiceSettingsFromTts(voiceTts);` and include it on the event:

```ts
await inngest.send({
  name: 'voice/synthesize',
  data: { jobId, videoId, accountId, sceneIds: ids,
          voice: { voiceId, modelId, ...(settings ? { settings } : {}) } },
});
```

The current `voiceTts` typing there is narrowed to `{ voice_id?, model? }`;
widen the select/cast so `voiceSettingsFromTts` can read the tuning keys (it
takes `unknown` and guards internally, so passing the raw `voice_tts` is fine).

### UI

`/channels/[id]/page.tsx` already reads `voice_tts`? — no; it currently selects
`id, name, brand_kit, brand_voice, defaults`. Add `voice_tts` to the select,
run `parseVoiceTts(channel.voice_tts)`, and render `<VoiceEditor
channelId={...} initial={voiceForm} />` below `<LogosEditor>` (preceded by an
`<hr>`).

`VoiceEditor` (client):

- Renders immediately from `initial` (no fetch on mount).
- **Voice / Model**: before a catalog load, each shows the current stored id as
  read-only text (with its raw id, since we have no name yet) and a disabled
  `<select>` placeholder; a **"Load voices & models"** button calls
  `loadVoiceCatalog()`. On success the two fields become `<select>`s populated
  from the lists, with the current id preserved (prepended "(current)" if
  absent). On failure a small error line shows the reason; the section stays
  usable.
- **Tuning**: three range inputs (`stability`, `similarity_boost`, `style`,
  step 0.05, 0–1) showing the numeric value, and a `use_speaker_boost`
  checkbox. Always editable.
- A single dirty-tracked **Save** → `saveChannelVoiceTts(channelId, form)`
  (try/catch/finally so the button never sticks; `{ ok:false }` keeps edits +
  shows the reason; `{ ok:true }` clears dirty + shows "Saved"). The catalog
  load is independent of dirty state (loading the list doesn't dirty the form;
  only changing a value does).

## Data flow

```
/channels/[id] (server) → read voice_tts → parseVoiceTts → VoiceForm
VoiceEditor (client) → [Load voices & models] → loadVoiceCatalog() → { voices, models }  (server-only key)
                     → edit → Save → saveChannelVoiceTts(id, form)
saveChannelVoiceTts → validateVoiceForm → set_channel_voice_tts RPC (RLS) → { ok }
later synthesis → synthesizeScenes reads voice_tts → voiceSettingsFromTts → voice.settings on the event
                → synthesize-voice.ts → ElevenLabs voice_settings
```

## Error handling

- `validateVoiceForm` → friendly `reason` for an empty voice/model or an
  out-of-range / non-numeric slider / non-boolean toggle; the editor shows it
  and keeps edits.
- `loadVoiceCatalog` catches network / non-2xx → `{ ok:false, reason }`; the
  section stays usable with the current stored values.
- `saveChannelVoiceTts` → `{ ok:false, reason }` on RPC error; `data == null` →
  `'Channel not found.'` (no phantom save).
- The page `notFound()`s a missing/non-owned channel before the editor (existing
  behaviour).

## Back-compatibility

- A channel with `voice_tts = '{}'` → `parseVoiceTts` yields the default
  voice/model + default tuning; saving pins them. Synthesis behaviour is
  unchanged until the operator saves a real selection (the existing
  `DEFAULT_VOICE_ID` / placeholder fallback still applies in
  `synthesizeScenes`).
- The synthesis wiring is additive: when `voice_tts` has no tuning keys,
  `voiceSettingsFromTts` returns `undefined` and the event omits `settings` —
  byte-identical to today.
- Old renders / in-flight jobs unaffected (they carry their own event payload).

## Testing

- **Unit (`src/lib/channels/voice.test.ts`):**
  - `parseVoiceTts` — empty/garbage → defaults (voice/model + tuning);
    `voice_id:'placeholder'` → falls back to the default voice id; stored
    partial tuning → backfills the missing keys; a full stored object →
    round-trips its values.
  - `validateVoiceForm` — accepts a valid form (asserts the stored object uses
    snake_case keys: `voice_id`, `similarity_boost`, `use_speaker_boost`);
    rejects empty `voice_id`/`model`, a slider at `-0.1` / `1.1` / `NaN` /
    non-number, and a non-boolean `use_speaker_boost`.
  - `voiceSettingsFromTts` — none present → `undefined`; a subset present →
    only those keys, correctly typed; ignores wrong-typed values.
  - Default-constant drift guard: the local `DEFAULT_VOICE_ID` /
    `ELEVENLABS_DEFAULT_MODEL` mirrors equal the canonical strings.
- **Migration:** `npm run db:apply` the RPC; confirm recorded + applied.
- **Manual / app-run e2e:** open `/channels/[id]` → Voice section shows the
  current voice/model (ids) + default tuning → click "Load voices & models" →
  pickers populate; the current id is selectable → change voice, model, and a
  couple of sliders, toggle speaker boost → Save → reload: all persist →
  trigger a synthesis on a video in that channel and confirm the tuning reaches
  the ElevenLabs request (the audio reflects it / the request body carries
  `voice_settings`). Confirm the slice-2/3/4 sections still save independently.
  A catalog-load failure (e.g. bad key) shows the reason and the section stays
  usable. **No render gate** — synthesis is an Inngest function, not the Lambda.

## Open questions

None. On-demand catalog load (current-id always kept), the 4 tuning params
(3 sliders + speaker-boost toggle) wired into synthesis, and the wholesale
`voice_tts` write are all settled.
