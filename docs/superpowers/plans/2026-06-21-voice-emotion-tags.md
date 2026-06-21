# Voice Emotion Tags Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Activate the dormant 7-tag emotion vocabulary end-to-end with a built-in, model-aware profile: the AI emits tags sparingly and synthesis honors them (v2: strip + pause→SSML + scene-level voice_settings nudge; v3: inline audio tags).

**Architecture:** A new pure module (`profile.ts`) interprets emotion tags into ElevenLabs input model-awarely; the synthesis worker uses it instead of `applyFallbackProfile`; the script-gen prompt emits tags; the caption/emphasis path strips them so the spoken-text invariant holds. No schema change; `voice_profiles` table/editor untouched (deferred to slice 2).

**Tech Stack:** TypeScript pure module + `node:test`; Inngest synthesis worker; Anthropic script-gen prompt (string); ElevenLabs `voice_settings`.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-06-21-voice-emotion-tags-design.md`.
- **Vocabulary (fixed):** `EMOTION_TAGS` in `src/lib/voice/emotion.ts` = `<excited> <pause> <whisper> <emphatic> <calm> <curious> <serious>`. `applyFallbackProfile` (strip all + `<pause>`→`<break time="0.4s"/>` + tidy ws) is RETAINED and reused.
- **Pure-core rule:** `src/lib/voice/profile.ts` imports only `./emotion` + the `VoiceSettings` type from `./alignment` (no react/server/network).
- **v2 nudge math:** for non-audio models, `settings = base ⊕ AVERAGE of the distinct present emotion tags' deltas` (exclude `<pause>`), added to `stability`/`style`, clamped [0,1]. No emotion tags → `settings = base` (undefined stays undefined → `voice_settings` omitted).
- **Model capability:** `modelSupportsAudioTags(modelId)` = `/v3/i.test(modelId)`. Default `eleven_multilingual_v2` → false.
- **Spoken-text invariant:** anything consuming "what's spoken" downstream uses tag-stripped narration.
- **Back-compat:** no-tags + undefined base → byte-identical to today (no `voice_settings`).
- **No-regression:** `npx tsc --noEmit` + `npm run lint` clean; `npm test` green.
- **Tests:** single file via `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/voice/profile.test.ts`; test imports use `.ts` extensions.
- **Commit footer:** `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## File Structure

- `src/lib/voice/profile.ts` (create) — pure profile core.
- `src/lib/voice/profile.test.ts` (create) — unit tests.
- `src/lib/inngest/functions/synthesize-voice.ts` (modify) — use `applyVoiceProfile`.
- `src/lib/inngest/functions/render.ts` (modify) — strip tags for the emphasis `sceneScript`.
- `src/lib/ai/script-generation.ts` (modify) — prompt emits the tags.
- `src/lib/ai/script-generation.test.ts` (modify, if it asserts the prompt).

---

### Task 1: Pure profile core `profile.ts` + tests

**Files:**
- Create: `src/lib/voice/profile.ts`
- Test: `src/lib/voice/profile.test.ts`

**Interfaces:**
- Consumes: `EMOTION_TAGS`, `type EmotionTag`, `applyFallbackProfile` from `./emotion`; `type VoiceSettings` from `./alignment` (`{ stability?: number; similarity_boost?: number; style?: number; use_speaker_boost?: boolean }`).
- Produces: `modelSupportsAudioTags(modelId: string): boolean`; `EMOTION_NUDGES: Record<EmotionTag, Partial<VoiceSettings>>`; `AUDIO_TAGS: Record<EmotionTag, string>`; `stripEmotionTags(narration: string): string`; `applyVoiceProfile(narration: string, modelId: string, base: VoiceSettings | undefined): { text: string; settings: VoiceSettings | undefined }`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/voice/profile.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  modelSupportsAudioTags,
  applyVoiceProfile,
  stripEmotionTags,
  EMOTION_NUDGES,
} from './profile.ts';

test('modelSupportsAudioTags: v2 false, v3 true', () => {
  assert.equal(modelSupportsAudioTags('eleven_multilingual_v2'), false);
  assert.equal(modelSupportsAudioTags('eleven_v3'), true);
  assert.equal(modelSupportsAudioTags('eleven_multilingual_v3'), true);
});

test('stripEmotionTags: removes all tags incl. pause, no SSML', () => {
  const out = stripEmotionTags('Hello <excited> world <pause> now <whisper>.');
  assert.equal(out, 'Hello world now .');
  assert.ok(!out.includes('<break'));
  assert.ok(!out.includes('<excited>'));
});

test('applyVoiceProfile v2: strips tags, pause→break, nudges settings', () => {
  const r = applyVoiceProfile('A <excited> b <pause> c', 'eleven_multilingual_v2', {
    stability: 0.5,
    similarity_boost: 0.75,
    style: 0,
    use_speaker_boost: true,
  });
  assert.ok(r.text.includes('<break time="0.4s"/>'));
  assert.ok(!r.text.includes('<excited>'));
  // single tag <excited>: style 0 + 0.2 = 0.2, stability 0.5 - 0.1 = 0.4
  assert.equal(r.settings?.style, 0.2);
  assert.equal(r.settings?.stability, 0.4);
  assert.equal(r.settings?.similarity_boost, 0.75);
  assert.equal(r.settings?.use_speaker_boost, true);
});

test('applyVoiceProfile v2: multiple emotion tags AVERAGE (not sum)', () => {
  // <excited> style +0.2, <calm> style -0.15 → avg = +0.025; base style 0 → 0.025
  // <excited> stability -0.1, <calm> stability +0.1 → avg 0 → base 0.5
  const r = applyVoiceProfile('<excited> x <calm> y', 'eleven_multilingual_v2', {
    stability: 0.5,
    similarity_boost: 0.75,
    style: 0,
    use_speaker_boost: true,
  });
  assert.equal(r.settings?.style, 0.025);
  assert.equal(r.settings?.stability, 0.5);
});

test('applyVoiceProfile v2: clamps to [0,1]', () => {
  // base style 0.95 + <excited> +0.2 = 1.15 → clamp 1
  const r = applyVoiceProfile('<excited> x', 'eleven_multilingual_v2', {
    stability: 0.5,
    similarity_boost: 0.75,
    style: 0.95,
    use_speaker_boost: true,
  });
  assert.equal(r.settings?.style, 1);
});

test('applyVoiceProfile v2: no tags + undefined base → settings undefined (back-compat)', () => {
  const r = applyVoiceProfile('plain narration', 'eleven_multilingual_v2', undefined);
  assert.equal(r.settings, undefined);
  assert.equal(r.text, 'plain narration');
});

test('applyVoiceProfile v2: no emotion tags + a base → base unchanged', () => {
  const base = { stability: 0.3, similarity_boost: 0.6, style: 0.1, use_speaker_boost: false };
  const r = applyVoiceProfile('plain <pause> text', 'eleven_multilingual_v2', base);
  assert.deepEqual(r.settings, base);
  assert.ok(r.text.includes('<break time="0.4s"/>'));
});

test('applyVoiceProfile v2: emotion tag + undefined base → seeds defaults then nudges', () => {
  // base undefined → seed {stability:0.5, similarity_boost:0.75, style:0, use_speaker_boost:true}
  const r = applyVoiceProfile('<excited> x', 'eleven_multilingual_v2', undefined);
  assert.equal(r.settings?.style, 0.2);
  assert.equal(r.settings?.stability, 0.4);
});

test('applyVoiceProfile v3: inserts audio tags, settings = base unchanged', () => {
  const base = { stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: true };
  const r = applyVoiceProfile('A <excited> b <pause> c', 'eleven_v3', base);
  assert.ok(r.text.includes('[excited]'));
  assert.ok(r.text.includes('<break time="0.4s"/>'));
  assert.ok(!r.text.includes('<excited>'));
  assert.deepEqual(r.settings, base);
});

test('EMOTION_NUDGES: pause has no nudge', () => {
  assert.deepEqual(EMOTION_NUDGES['<pause>'], {});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/voice/profile.test.ts`
Expected: FAIL — cannot find module `./profile.ts`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/voice/profile.ts`:

```ts
// Built-in, model-aware emotion profile (Phase 8 slice 1). Pure: interprets the
// fixed EMOTION_TAGS vocabulary into ElevenLabs input. v3-class models get inline
// audio tags (per-span delivery); v2 strips tags to plain text (keeping <pause>
// as an SSML break) and derives one scene-level voice_settings nudge from the
// emotion tags present. The editable per-model voice_profiles override is slice 2.
import { EMOTION_TAGS, applyFallbackProfile, type EmotionTag } from './emotion';
import type { VoiceSettings } from './alignment';

const PAUSE_BREAK = '<break time="0.4s"/>';

// ElevenLabs defaults (mirrors DEFAULT_VOICE_FORM_TUNING in channels/voice.ts) —
// the numeric base for a nudge when the channel has no tuning set.
const DEFAULT_VOICE_SETTINGS: Required<VoiceSettings> = {
  stability: 0.5,
  similarity_boost: 0.75,
  style: 0,
  use_speaker_boost: true,
};

// v3-class models support inline audio tags ([excited], [whispers], ...); v2 does
// not. Heuristic on the model id; the default eleven_multilingual_v2 → false.
export function modelSupportsAudioTags(modelId: string): boolean {
  return /v3/i.test(modelId);
}

// Per-tag voice_settings deltas for the non-audio (v2) path; <pause> has none
// (handled as an SSML break, not a setting). Deltas are gentle and applied over
// the channel's base, averaged across the tags in a scene, then clamped.
export const EMOTION_NUDGES: Record<EmotionTag, Partial<VoiceSettings>> = {
  '<excited>': { style: 0.2, stability: -0.1 },
  '<pause>': {},
  '<whisper>': { stability: 0.15, style: -0.15 },
  '<emphatic>': { style: 0.15 },
  '<calm>': { style: -0.15, stability: 0.1 },
  '<curious>': { style: 0.1 },
  '<serious>': { style: -0.1, stability: 0.1 },
};

// v3 inline audio-tag forms; <pause> stays an SSML break in both paths.
export const AUDIO_TAGS: Record<EmotionTag, string> = {
  '<excited>': '[excited]',
  '<pause>': PAUSE_BREAK,
  '<whisper>': '[whispers]',
  '<emphatic>': '[emphatic]',
  '<calm>': '[calm]',
  '<curious>': '[curious]',
  '<serious>': '[serious]',
};

function tidy(s: string): string {
  return s.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim();
}

// Strip ALL tags (incl. <pause>) to clean prose, no SSML — the spoken-text form
// used as the emphasis pass's sceneScript.
export function stripEmotionTags(narration: string): string {
  let out = narration;
  for (const tag of EMOTION_TAGS) out = out.split(tag).join('');
  return tidy(out);
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

// The built-in profile: returns the exact text to synthesize + the per-scene
// voice_settings (undefined ⇒ omit voice_settings, exactly as today).
export function applyVoiceProfile(
  narration: string,
  modelId: string,
  base: VoiceSettings | undefined,
): { text: string; settings: VoiceSettings | undefined } {
  if (modelSupportsAudioTags(modelId)) {
    let out = narration;
    for (const tag of EMOTION_TAGS) out = out.split(tag).join(AUDIO_TAGS[tag]);
    return { text: tidy(out), settings: base };
  }

  // v2: strip + pause→break (reuse the fallback), then nudge scene-wide.
  const text = applyFallbackProfile(narration);
  const present = EMOTION_TAGS.filter((t) => t !== '<pause>' && narration.includes(t));
  if (present.length === 0) return { text, settings: base };

  const seed: Required<VoiceSettings> = { ...DEFAULT_VOICE_SETTINGS, ...(base ?? {}) };
  let dStability = 0;
  let dStyle = 0;
  for (const t of present) {
    const n = EMOTION_NUDGES[t];
    dStability += n.stability ?? 0;
    dStyle += n.style ?? 0;
  }
  dStability /= present.length;
  dStyle /= present.length;

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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/voice/profile.test.ts`
Expected: PASS (all tests). Note: `0.5 + (-0.1)` etc. are exact in IEEE for these tenths/0.025 cases used in the tests; if any assertion shows a float-precision tail, round in the test with `Math.round(x*1000)/1000` — but the chosen cases (0.2, 0.4, 0.025, 1) are exact.

- [ ] **Step 5: Commit**

```bash
git add src/lib/voice/profile.ts src/lib/voice/profile.test.ts
git commit -m "feat: built-in model-aware voice emotion profile (pure)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Wire the profile into synthesis + the caption/emphasis path

**Files:**
- Modify: `src/lib/inngest/functions/synthesize-voice.ts`
- Modify: `src/lib/inngest/functions/render.ts`

**Interfaces:**
- Consumes: `applyVoiceProfile`, `stripEmotionTags` from `@/lib/voice/profile` (Task 1).

**Context:** In `synthesize-voice.ts` the per-scene step currently does `const text = applyFallbackProfile(captured)` then `synthesize({ text, voiceId, modelId, voiceSettings: voice.settings })`. The `voice` object on the event already carries `voiceId`, `modelId`, `settings`. In `render.ts` the caption loop calls `annotateSceneEmphasis({ alignment, sceneScript: ci.narration, density, model })`.

- [ ] **Step 1: `synthesize-voice.ts` — use `applyVoiceProfile`**

Change the import from `applyFallbackProfile` to `applyVoiceProfile`:

```ts
import { applyVoiceProfile } from '@/lib/voice/profile';
```

(Remove the `applyFallbackProfile` import from `@/lib/voice/emotion` if it is no longer used in this file.)

Replace the text-prep + synthesize call inside the `synth-${sceneId}` step:

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

> `voice.modelId` may be optional on the event type. `modelSupportsAudioTags`/`applyVoiceProfile` take a `string`; if `voice.modelId` is `string | undefined`, pass `voice.modelId ?? ''` (empty string → not v3 → v2 path, the safe default). Use that coalesce if tsc flags it.

- [ ] **Step 2: `render.ts` — strip tags for the emphasis sceneScript**

Add the import:

```ts
import { stripEmotionTags } from '@/lib/voice/profile';
```

In the caption loop, change the `annotateSceneEmphasis` call's `sceneScript`:

```ts
              : await annotateSceneEmphasis({
                  alignment: ci.alignment,
                  sceneScript: stripEmotionTags(ci.narration),
                  density: brief.captionEmphasisDensity,
                  model: models.caption_emphasis,
                });
```

- [ ] **Step 3: Type-check, suite, lint**

Run: `npx tsc --noEmit`
Expected: clean. (If `voice.modelId` is `string | undefined`, apply the `?? ''` coalesce from Step 1.)

Run: `npm test`
Expected: PASS (no existing test asserts the synthesis text-prep; profile.test covers the logic).

Run: `npm run lint`
Expected: clean (no unused `applyFallbackProfile` import left in `synthesize-voice.ts`).

- [ ] **Step 4: Commit**

```bash
git add src/lib/inngest/functions/synthesize-voice.ts src/lib/inngest/functions/render.ts
git commit -m "feat: synthesis applies the emotion profile; emphasis uses spoken text

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Script-generation prompt emits emotion tags

**Files:**
- Modify: `src/lib/ai/script-generation.ts`
- Modify (if needed): `src/lib/ai/script-generation.test.ts`

**Interfaces:**
- No new exports. `buildSystemPrompt()` returns a richer string; `generatedSceneSchema.narration` stays `z.string().min(1)` (tags are valid narration text — no schema change).

**Context:** `buildSystemPrompt()` (in `script-generation.ts`) returns a `[...].join('\n')`. The `narration` field is described as `'  "narration": the spoken voiceover for the scene (one or two sentences)'`. Add an emotion-tags block after the field list (before or after the stock/procedural Guidance line).

- [ ] **Step 1: Add the emotion-tags block to the system prompt**

In `buildSystemPrompt()`, insert these lines into the array after the
`'"procedural" for text/animation/diagrams. Keep 1-3 shots per scene.'` line:

```ts
    '',
    'DELIVERY TAGS (optional, use SPARINGLY — at most one or two per scene, only',
    'where they genuinely improve delivery; most scenes need none):',
    '- Place an inline tag from this fixed set directly in the narration text:',
    '  <excited> <pause> <whisper> <emphatic> <calm> <curious> <serious>',
    '- They are non-spoken delivery directives, not words. <pause> inserts a short',
    '  beat; the others colour the surrounding delivery.',
    '- Use ONLY these exact tags (any other tag is ignored). Do not stack them.',
    '- Example: "This changes everything. <pause> <excited> Let us dig in."',
```

- [ ] **Step 2: Reconcile the prompt test**

Run: `npm test`
Expected: PASS, OR a failure ONLY in `src/lib/ai/script-generation.test.ts` if it asserts the exact prompt string. If it fails:
- Read the failing assertion. If it is an exact-equality or "contains the old text" check that the new lines break, update it minimally to accommodate the added block (e.g. keep asserting the stable anchors it already checks, or add an assertion that the prompt includes `'<excited>'`). Do NOT weaken a meaningful assertion beyond what the new content requires.

After any test edit, re-run: `npm test` → Expected: PASS.

- [ ] **Step 3: Type-check + lint**

Run: `npx tsc --noEmit`
Expected: clean.

Run: `npm run lint`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/lib/ai/script-generation.ts src/lib/ai/script-generation.test.ts
git commit -m "feat: script generation emits emotion delivery tags sparingly

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Manual / app-run e2e (operator, after Task 3)

Not an automated task:

1. Generate a script → narration now carries sparse delivery tags (e.g. `<pause>`, an occasional `<excited>`).
2. Synthesize on the default v2 channel → the audio reflects the per-scene nudge (a `<calm>` scene steadier, an `<excited>` one more animated) + `<pause>` beats.
3. Open the captions → clean text, no tag markup (the emphasis pass + captions use the spoken/stripped text).
4. Re-synthesize an old plain-narration scene → unchanged.
5. (Optional) Set a v3 model on the channel Voice editor → re-generate + synthesize → tags become inline audio tags.

---

## Self-Review

**1. Spec coverage:**
- Built-in model-aware profile (v2 nudge + pause, v3 audio tags) → Task 1. ✅
- Synthesis applies it → Task 2 Step 1. ✅
- Spoken-text invariant (emphasis uses stripped narration) → Task 2 Step 2. ✅
- AI emits tags sparingly → Task 3. ✅
- Back-compat (no tags + undefined base → settings undefined) → Task 1 test + impl. ✅
- `applyFallbackProfile`/`emotion.ts` retained + reused → Task 1 (v2 path). ✅
- No schema change / `voice_profiles` untouched → confirmed (no task touches them). ✅

**2. Placeholder scan:** none — the only conditional instructions (the `?? ''` coalesce in Task 2; the test reconciliation in Task 3) are concrete, bounded contingencies with exact handling, not vague stubs. All code steps carry complete code.

**3. Type consistency:** `applyVoiceProfile(narration, modelId, base) → { text; settings: VoiceSettings | undefined }` consistent between Task 1 (definition) and Task 2 (use); `stripEmotionTags(string) → string` consistent (Task 1 def, Task 2 use); `EMOTION_NUDGES`/`AUDIO_TAGS` keyed by `EmotionTag` (all 7) — matches `EMOTION_TAGS`. The `settings` from `applyVoiceProfile` flows into `synthesize`'s `voiceSettings?: VoiceSettings` (compatible, `undefined` omits).
