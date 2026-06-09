# Phase 3 — Voice Synthesis — Design

**Status:** COMPLETE & VERIFIED 2026-06-09 — built, statically verified (typecheck
+ lint + 24 unit tests + production build), and the live milestone passed end-to-end
against real ElevenLabs + R2: a 5-scene generated script synthesized to green, audio
confirmed a valid MP3 in R2, real durations overwrote the Phase-2 estimates,
`word_alignments` captured, a narration edit flipped to stale, re-synthesis returned
to synthesized, one `cost_events` row per scene, and the 5-at-a-time cap shown on a
7-scene video (two waves: 5 then 2).
**Build plan phase:** Phase 3 ("scenes get voiceover")
**Milestone:** synthesize voiceover for the scenes and play each scene's audio;
editing a scene flips it to stale.

## 1. Goal & scope

A deliberate, user-triggered phase (spec 6.4): turn committed scene narration into
per-scene voiceover via ElevenLabs, store the audio in R2, capture the
character-level timings, and run the `audio_status` lifecycle
(`not_synthesized → synthesized → stale`) live in the editor. Voice costs real
characters, so synthesis is an explicit action with a cost estimate, never a side
effect of typing.

### In scope (core only)
- An ElevenLabs client (REST, via `fetch`) that synthesizes one scene's narration
  to audio **with character timestamps**.
- A `voice/synthesize` Inngest job: per-scene synthesis, each scene a durable
  checkpoint (spec 15.2), concurrency capped at 5 (spec 6.4 / 15.3, simple form).
- Writing `scenes.audio_r2_key`, `word_alignments`, `duration_seconds`, and
  `audio_status` per scene; flips stream live over Realtime.
- The **staleness trigger**: editing `scenes.narration` flips a `synthesized`
  scene to `stale` (BEFORE UPDATE trigger — the api-surface's promised DB rule).
- The **fallback voice profile** as a pure function (strip the fixed emotion tags →
  plain text; `<pause>` → an SSML break) + the fixed emotion vocabulary as the
  defined contract.
- Editor UI: per-scene audio-status indicator, Synthesize / Re-synthesize / Listen,
  a "Synthesize all" action, and an inline cost estimate before synthesizing.
- A `cost_events` line per synthesis (the ledger exists; this is cheap and correct).

### Explicitly deferred (anticipated, not built)
- The **voice-profiles UI** and **per-model `voice_profiles` rows / tag mappings**
  (Phase 8) — the built-in fallback covers the slice, so no DB profile row is
  required this phase. The `voice_profiles` table stays empty until Phase 8.
- **Emitting emotion tags from script generation** (decided: fallback-only). The
  vocabulary + strip logic are defined now as the contract so a real per-model
  profile drops in later; script-gen keeps emitting plain narration.
- The **full rate/concurrency governor** as a shared component (Phase 9). Phase 3
  uses a plain cap of 5 inside the synthesis function.
- The **full failure taxonomy** (quota-pause/resume, Retry-After, partial) — Phase
  9. Phase 3 relies on Inngest step retries + an `onFailure` that marks the job
  failed, matching the Phase 1/2 "surface failures" lesson.
- The **api_credentials** table + encryption (Phase 8). The ElevenLabs key is an
  env var this phase, matching the existing `ANTHROPIC_API_KEY` pattern.

## 2. Decisions (locked)

| Decision | Choice | Rationale |
|---|---|---|
| ElevenLabs key | **Env var `ELEVENLABS_API_KEY`** via `env.server.ts` | Matches `ANTHROPIC_API_KEY`; defers the credentials table + encryption to Phase 8 (settings UI). |
| Emotion tags | **Fallback-only** | Milestone needs audio that plays + staleness, not expressiveness. Vocabulary + strip logic defined as contract; script-gen stays plain. |
| Seed voice | **Default public ElevenLabs voice_id** hardcoded into the seed `voice_tts` | Synthesis works immediately without the user choosing a voice; trivially swapped in Phase 8. |
| ElevenLabs transport | **`fetch` against the REST `with-timestamps` endpoint**, no SDK dependency | One simple call returning audio + alignment; avoids a new dep (consistent with R2/Anthropic being the only provider SDKs, and ElevenLabs' endpoint being trivial). |
| Per-scene checkpoint | **One `step.run('synth-<sceneId>')` per scene** | Inngest caches completed step results, so a retry re-synthesizes only the unfinished scenes — spec 15.2 resumability for free. |
| Concurrency cap | **Process scene steps in chunks of ≤5 via `Promise.all`** | The spec-6.4 cap of 5, simplest correct form; the shared governor is Phase 9. |
| Staleness | **BEFORE UPDATE trigger on `scenes`**, condition exactly `OLD.narration IS DISTINCT FROM NEW.narration AND OLD.audio_status = 'synthesized'` → set `NEW.audio_status = 'stale'` | The api-surface specifies this as a DB trigger so the client just writes text; also correctly invalidates audio when a scene is regenerated (RPC updates narration). `IS DISTINCT FROM` (not `<>`) so a null↔text change is still caught. The whole staleness model rests on this condition, so it is stated precisely. **The re-synthesis write sets `audio_status='synthesized'` without changing narration, so `OLD.narration IS DISTINCT FROM NEW.narration` is false → the trigger does not fire** (and even if narration were equal, `OLD.audio_status` is `stale`/`not_synthesized`, not `synthesized`). |
| Edit-during-synthesis | **Capture narration at step start; on write, if current narration differs → mark `stale` not `synthesized`** | Audio for old text must not claim to match new text (spec 6.4 staleness correctness). |
| `duration_seconds` authority | **Synthesis is authoritative for `duration_seconds` once audio exists** — the real audio duration (last alignment end time) overwrites Phase 2's model estimate | Deliberate handoff: composition / kinetic-text timing (Phase 4+) reads the true spoken duration, not a guess. Before synthesis the column holds the model's estimate; after, the measured value. |
| Estimate vs. ledger | **`estimateSynthesis` counts pre-fallback narration length; `cost_events` records the actual post-fallback characters sent to ElevenLabs** | The fallback profile strips tags, so the billed character count is ≤ the narration length. The two are deliberately not expected to match exactly — the estimate is an upper-bound preview, the ledger is the truth. |
| "Synthesize all" empty case | **If no scenes are `stale`/`not_synthesized`, the action is a no-op (disabled in the UI)** — no job row is created | Avoids an empty job that immediately completes with nothing to do. |
| Signed audio URL lifetime | **`getSceneAudioUrl` signs for a few minutes (300s)**, comfortably longer than any scene's audio | A listen-through or a replay never expires mid-play (scenes are seconds long; 300s is ample headroom). |
| Audio status source of truth | **`scenes.audio_status` column, streamed via existing Realtime** | `scenes` is already in the `supabase_realtime` publication with replica identity full (Phase 2) — audio fields arrive with no new publication change. |
| Playback URL | **Server action `getSceneAudioUrl` → signed R2 GET** | Audio is private in R2; the client gets a short-lived signed URL on demand (same pattern as render playback). |
| Cost ledger | **Write a `cost_events` row per scene** (`operation='voice_synthesis'`, units=characters) | Table exists; per-video lifetime cost is a spec feature and this is the cheap moment to start populating it. |

## 3. Architecture & data flow

```
Editor "Synthesize all" / per-card "Synthesize"
   │  estimateSynthesis(videoId, sceneIds?)        [Tier 2, inline] → {characters, usd}
   │  synthesizeScenes(videoId, sceneIds?)         [Tier 2 server action]
   ▼
resolve account + channel voice (voice_tts) → default sceneIds = stale+not_synthesized
   → create jobs row (type=voice_synthesis, queued)
   → inngest.send('voice/synthesize', { jobId, videoId, accountId, sceneIds, voice })
   ▼  returns { jobId }
Editor reflects per-scene status over Realtime (scenes.audio_status)

Inngest synthesize-voice function          [Tier 3, service-role admin client]
   step: mark job running
   for each chunk of ≤5 sceneIds:  Promise.all(
     step.run('synth-<sceneId>'):
       read scene narration (capture text)
       text = applyFallbackProfile(narration)        // strip tags, <pause>→break
       { audio, alignment } = elevenlabs.synthesize(text, voiceId, modelId)
       putObject('audio/<sceneId>-<hash>.mp3', audio)
       duration = last alignment end time
       status = (current narration === captured) ? 'synthesized' : 'stale'
       update scene { audio_r2_key, word_alignments, duration_seconds, audio_status }
       insert cost_event(voice_synthesis, elevenlabs, characters, usd)
   )
   step: mark job complete
   onFailure: mark job failed (message)

Listen ▶  getSceneAudioUrl(sceneId)  [Tier 2] → signed R2 URL → <audio>
Edit narration → BEFORE UPDATE trigger flips synthesized→stale → Realtime → amber dot
```

## 4. Files

**Migration** `supabase/migrations/<ts>_phase3_voice.sql`
- `scenes_audio_staleness` BEFORE UPDATE trigger + function (synthesized→stale on
  narration change). `scenes` already streams audio fields via Phase 2 Realtime.

**Env** `src/lib/env.server.ts` (+ `.env.example`)
- `elevenlabs.apiKey` getter (`ELEVENLABS_API_KEY`).

**Voice lib**
- `src/lib/voice/emotion.ts` — `EMOTION_TAGS` (fixed vocabulary) + `applyFallbackProfile`.
- `src/lib/voice/elevenlabs.ts` — `synthesize({ text, voiceId, modelId })` →
  `{ audio: Buffer, alignment, durationSeconds }` (REST `with-timestamps`, `fetch`).
- `src/lib/voice/estimate.ts` — `countCharacters`, `estimateUsd` (pure).
- `src/lib/voice/*.test.ts` — node `--test`: fallback strips each tag, pause→break,
  vocabulary completeness, character counting, alignment→duration parse.

**Inngest** `src/lib/inngest/functions/synthesize-voice.ts` (+ register in
`src/app/api/inngest/route.ts`; add `VoiceSynthesizeData` to `client.ts`).

**Server actions** `src/app/(app)/videos/[id]/voice-actions.ts`
- `estimateSynthesis`, `synthesizeScenes`, `getSceneAudioUrl`.

**UI**
- `videos/[id]/page.tsx` — also select `audio_status`, `audio_r2_key`.
- `Editor.tsx` — thread `audio_status`/`audio_r2_key` into scene state + Realtime;
  "Synthesize all" with estimate; per-scene synth-in-progress.
- `SceneCard.tsx` — fill the reserved status dot (gray/amber/green) + action slot
  (Synthesize / Re-synthesize / Listen).

**Seed** `videos/actions.ts` — replace the placeholder `voice_tts.voice_id` with the
chosen default public voice id.

## 5. Build order (each step independently runnable/verifiable)

1. **Migration: staleness trigger** — apply via `npm run db:apply`; verify editing a
   `synthesized` scene flips it to `stale` (and a `not_synthesized` scene does not).
2. **Env + voice lib (pure)** — `emotion.ts`, `estimate.ts`, unit tests green
   (`npm test`). No network.
3. **ElevenLabs client** — `elevenlabs.ts`; a thin manual smoke (one short string →
   audio bytes + alignment) once `ELEVENLABS_API_KEY` is set.
4. **Inngest synthesize-voice + client event type + route registration.**
5. **Server actions** (`estimateSynthesis`, `synthesizeScenes`, `getSceneAudioUrl`)
   + seed voice id.
6. **UI** — SceneCard status dot + actions; Editor "Synthesize all" + estimate +
   Realtime audio status; page select.
7. **End-to-end milestone check** (Section 7).

## 6. Open items to confirm at build time
- **ElevenLabs endpoint shape**: confirm the current `text-to-speech/{voice_id}/
  with-timestamps` response (`audio_base64` + `alignment.character_*_times_seconds`)
  against live docs before wiring (use context7 / ElevenLabs docs). Default model
  `eleven_multilingual_v2` supports `<break>` for the pause mapping.
- **Voice settings**: seed `voice_tts` has no real stability/similarity; use
  ElevenLabs defaults until the Phase 8 voice UI.
- **Quota/429 handling**: Phase 3 surfaces failures via `onFailure` only; the
  Retry-After / quota-pause-and-resume treatment is deferred to Phase 9.

## 7. Milestone verification
Type a prompt → script streams (Phase 2) → click **Synthesize all** → scenes flip
`not_synthesized → synthesized` live, dots go green → press **Listen**, each scene's
audio plays from R2 → edit a scene's narration → it flips to **stale** (amber) →
**Re-synthesize** that one scene → back to green. Confirm a `cost_events` row per
scene and the 5-at-a-time cap on a many-scene video.
