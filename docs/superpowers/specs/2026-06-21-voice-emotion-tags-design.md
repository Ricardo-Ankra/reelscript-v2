# Voice emotion tags — design (slice 1: end-to-end, built-in profile)

**Date:** 2026-06-21
**Phase:** 8 (Full surfaces) — voice expressivity
**Status:** design approved, ready for implementation plan

## Context

The codebase has a fixed 7-tag emotion vocabulary
(`src/lib/voice/emotion.ts`: `<excited> <pause> <whisper> <emphatic> <calm>
<curious> <serious>`) and a `applyFallbackProfile(narration)` that strips every
tag to plain text, converting `<pause>` to an SSML `<break>`. But **the AI emits
plain narration today** (no tags) and synthesis always uses the fallback — so the
vocabulary is dormant. A deployed `voice_profiles` table (account-scoped,
per-ElevenLabs-model `tag_mappings`) is designed to make tag interpretation
editable per model, but nothing reads or writes it yet.

This slice activates emotion tags **end-to-end with a built-in, model-aware
profile** (no editor). The editable `voice_profiles` UI/table use is a separate
later slice (slice 2), which will override the built-in defaults.

**Key model constraint:** the default model `eleven_multilingual_v2` has **no
audio-tag support** — delivery comes only from punctuation, SSML `<break>`, and
`voice_settings` (stability/style). Audio tags (`[excited]`, `[whispers]`) are an
**eleven_v3-class** feature. And ElevenLabs `voice_settings` apply to the **whole
synthesis request** (a scene), not per-span. So on v2, emotion is expressed at
**scene granularity** via a `voice_settings` nudge; true per-span emotion needs v3.

## Goal

Have the AI mark narration with sparse inline emotion/delivery tags and have
synthesis honor them per the chosen model — a real expressivity gain on the
model actually in use (v2: scene-level nudge + pause; v3: inline audio tags).

## Scope

**In scope:**

- The script-generation prompt emits the 7 tags inline, **sparingly**, as
  non-spoken delivery directives.
- A built-in, model-aware profile applied at synthesis:
  - **v3-class model** (`modelSupportsAudioTags`): replace each emotion tag with
    its inline audio-tag form (`<excited>`→`[excited]`, …; `<pause>`→SSML break),
    `voice_settings` unchanged (the model handles delivery per-span).
  - **non-audio model** (v2, default): strip the emotion tags (keep `<pause>`→
    break) and derive one scene-level `voice_settings` adjustment from the emotion
    tags present — a delta over the channel's base settings, clamped 0–1.
- The caption/emphasis path uses tag-stripped narration as the emphasis pass's
  `sceneScript` (the "spoken text" invariant).

**Out of scope:**

- The `voice_profiles` editor + table use (slice 2 — overrides the built-in).
- Per-channel emotion on/off or density control (slice 2).
- Per-span `voice_settings` on v2 (impossible — settings are per-request).
- v3 audio-tag fidelity tuning; regenerating beds; any schema change.

## Architecture

No schema change, no editor, `voice_profiles` untouched. One new pure module +
edits to the synthesis worker, the script prompt, and the caption/emphasis path.

### Pure core: `src/lib/voice/profile.ts` (unit-tested)

Imports `EMOTION_TAGS`, `type EmotionTag`, `applyFallbackProfile` from
`./emotion`; `type VoiceSettings` from `./alignment`. Pure (no
react/server/network).

```ts
// ElevenLabs defaults, mirrored so a nudge has a numeric base when the channel
// has no tuning (snake_case to match VoiceSettings). Comment: mirrors
// DEFAULT_VOICE_FORM_TUNING in channels/voice.ts.
const DEFAULT_VOICE_SETTINGS: Required<VoiceSettings> =
  { stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: true };

// v3-class models support inline audio tags; v2 does not. Heuristic on the id.
export function modelSupportsAudioTags(modelId: string): boolean; // /v3/i.test(modelId)

// Per-tag voice_settings deltas for the non-audio (v2) path. <pause> has none
// (handled as SSML). Values chosen for a gentle, honest per-scene shift.
export const EMOTION_NUDGES: Record<EmotionTag, Partial<VoiceSettings>>;
//  <excited>:  { style: +0.2, stability: -0.1 }
//  <whisper>:  { stability: +0.15, style: -0.15 }
//  <emphatic>: { style: +0.15 }
//  <calm>:     { style: -0.15, stability: +0.1 }
//  <curious>:  { style: +0.1 }
//  <serious>:  { style: -0.1, stability: +0.1 }
//  <pause>:    {}

// v3 inline forms. <pause> stays an SSML break in both paths.
export const AUDIO_TAGS: Record<EmotionTag, string>;
//  <excited>→'[excited]', <whisper>→'[whispers]', <emphatic>→'[emphatic]',
//  <calm>→'[calm]', <curious>→'[curious]', <serious>→'[serious]',
//  <pause>→'<break time="0.4s"/>'

// Strip ALL tags (incl. <pause>) to clean prose, no SSML — for the spoken-text
// invariant (the emphasis pass's sceneScript).
export function stripEmotionTags(narration: string): string;

// The built-in profile. Returns the exact text to synthesize + the per-scene
// voice_settings (undefined ⇒ omit voice_settings, exactly as today).
export function applyVoiceProfile(
  narration: string,
  modelId: string,
  base: VoiceSettings | undefined,
): { text: string; settings: VoiceSettings | undefined };
```

`applyVoiceProfile` logic:

- **v3 (`modelSupportsAudioTags`):** replace each `EMOTION_TAG` with `AUDIO_TAGS[tag]`,
  then tidy whitespace (same cleanup as `applyFallbackProfile`); `settings = base`.
- **v2:** `text = applyFallbackProfile(narration)` (strip + pause→break + tidy).
  Let `emo = the distinct emotion tags present except <pause>`. If `emo` is empty,
  `settings = base` (undefined stays undefined → omitted). Else seed
  `base ?? DEFAULT_VOICE_SETTINGS`, add the **average** of the present tags' deltas
  to `stability`/`style` (others untouched), clamp each to [0,1], and return that.
  Averaging (not summing) keeps multi-tag scenes from over-nudging.

### `src/lib/inngest/functions/synthesize-voice.ts`

Replace the per-scene text prep:

```ts
const captured = before.narration as string;
const { text, settings } = applyVoiceProfile(captured, voice.modelId, voice.settings);
if (!text.trim()) return { skipped: true as const };

const { audio, alignment, durationSeconds } = await synthesize({
  text,
  voiceId: voice.voiceId,
  modelId: voice.modelId,
  voiceSettings: settings,
});
```

`voice.modelId`/`voice.settings` are already on the event payload (set by
`synthesizeScenes`). Settings now vary per scene (nudged) instead of one fixed
object.

### `src/lib/ai/script-generation.ts`

`buildSystemPrompt()` gains an emotion-tags block (after the `narration` field
description), listing the vocabulary and instructing **sparing** inline use as
non-spoken directives. Narration stays `z.string().min(1)` (tags are valid text);
no schema change. (Update `script-generation.test.ts` if it asserts on the prompt
string.)

### `src/lib/inngest/functions/render.ts` (caption loop)

The `annotateSceneEmphasis({ ... sceneScript: ci.narration ... })` call wraps the
narration: `sceneScript: stripEmotionTags(ci.narration)`, so the Haiku emphasis
pass sees clean prose. (Captions render from the spoken `alignment`, which is
already tag-free since synthesis stripped/handled tags; only the emphasis context
needs stripping.)

## Data flow

```
script-gen → narration with sparse inline <tags> → scenes.narration
synthesis (per scene) → applyVoiceProfile(narration, modelId, baseSettings)
   v2: applyFallbackProfile text + voice_settings = base ⊕ avg(nudges)
   v3: text with [audio tags]   + voice_settings = base
   → ElevenLabs → audio + alignment (for the spoken text)
captions/emphasis → stripEmotionTags(narration) as sceneScript
render → captions from spoken alignment (unchanged)
```

## Error handling / safety

- Unknown / malformed tags: `applyFallbackProfile` strips anything not in
  `EMOTION_TAGS`, so garbage can never reach ElevenLabs.
- Nudged settings are clamped to [0,1].
- A channel with no base tuning + a scene with no emotion → `settings` undefined →
  `voice_settings` omitted (byte-identical to today). A scene WITH emotion seeds
  from `DEFAULT_VOICE_SETTINGS` so the nudge has a base (intended new behavior).
- Synthesis stays best-effort/retryable as today; nothing here can throw on
  malformed input (pure string ops + clamped numbers).

## Back-compatibility

- Existing plain-narration scenes synthesize identically: no tags →
  `applyVoiceProfile` text = `applyFallbackProfile`, settings = base (unchanged).
  Re-synthesizing an old scene is unchanged.
- `applyFallbackProfile` + `emotion.ts` are retained (the v2 text path reuses
  `applyFallbackProfile`); its existing tests stay valid.
- The v3 path is best-effort (v3 is opt-in via the channel model picker; default
  stays v2).
- No render-output change beyond the synthesized audio; captions still build from
  the spoken alignment.

## Testing

- **Unit (`src/lib/voice/profile.test.ts`):**
  - `modelSupportsAudioTags` — `eleven_multilingual_v2` → false; an id containing
    `v3` → true.
  - `applyVoiceProfile` v2 — narration with `<excited>` + `<pause>` →
    text has the SSML break + no tag text; `settings.style` ≈ base+nudge (assert
    the exact averaged value for a known case) and clamped; multiple emotion tags
    average (not sum).
  - `applyVoiceProfile` v2 — no tags + `base = undefined` → `settings` undefined
    (back-compat); no tags + a base → settings = base unchanged.
  - `applyVoiceProfile` v3 — `<excited>`→`[excited]`, `<pause>`→break, `settings`
    = base (unchanged).
  - `stripEmotionTags` — removes all 7 tags incl. `<pause>` (no SSML), tidies ws.
- **Existing:** `emotion.test.ts` stays green; update `script-generation.test.ts`
  only if it asserts the prompt text.
- **Regression:** `npm test` green; `npx tsc --noEmit` + `npm run lint` clean.
- **Manual / app-run e2e:** generate a script → narration now carries sparse tags
  → synthesize on the default v2 channel → the audio reflects the per-scene nudge
  (e.g. a `<calm>` scene is steadier) + `<pause>` beats; captions show clean text
  (no tag markup) → an old plain-narration scene re-synthesizes unchanged → (if a
  v3 model is selected on the channel) tags become inline audio tags.

## Open questions

None. Built-in model-aware profile (v2 nudge + pause, v3 audio tags), AI emits
sparingly, spoken-text invariant via `stripEmotionTags`, and `voice_profiles`
editor deferred to slice 2 are all settled.
