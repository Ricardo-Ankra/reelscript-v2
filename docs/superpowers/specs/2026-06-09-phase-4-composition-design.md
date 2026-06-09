# Phase 4 — Composition, and the slice closes — Design

**Status:** COMPLETE & VERIFIED 2026-06-09 — the thin slice is closed. Built,
statically verified (typecheck + lint + 46 unit tests + production build), and the
live milestone passed end-to-end: a committed, voiced 5-scene script ran the full
pipeline (compose → Gate 1 → durable storeSpec → resolveAssets → Lambda → finalize)
through `composing → resolving_assets → rendering → complete`, producing a 1.75 MB
MP4 with both audio (`mp4a`/`soun`) and video (`vide`) tracks — AI-composed, no human
touched a spec. `cost_events` recorded composition ($0.18, Sonnet+thinking) and render
($0.004, Lambda); `video.current_render_id` was promoted.
**Build plan phase:** Phase 4 ("connect the AI front end to the render spine — the
first fully automatic video")
**Milestone:** a prompt produces a rendered MP4 **with voiceover**, entirely through
the system. Everything after this is enrichment on a working spine.

## 1. Goal & scope

Close the thin vertical slice. A committed, voiced script becomes a composition spec
authored by AI (Sonnet, extended thinking) from scenes + a baked brand theme + the
starter primitives + the Phase-3 voice timings; Gate 1 validates the spec (bounded
AI retry); per-scene voiceover is signed; the spec is stored in R2; the Phase-1
Lambda spine renders it to an MP4 that plays the voiceover. No human touches a spec.

### In scope (core only)
- **Generate Video** action (spec 6.5): completeness gate (block `not_synthesized`;
  `stale` needs explicit override), snapshot the live scenes into a
  `script_revision`, create the `renders` + `jobs` rows, emit `render/start`.
- **Composition pipeline** as one Inngest function, each step a durable checkpoint
  (spec 13.1): `compose → gate1 → resolveAssets → storeSpec → [Lambda spine] →
  finalize`.
- **Composition AI**: `claude-sonnet-4-6` + extended thinking (spec 8.7), a single
  call (no asset-tool loop — stock is deferred). Emits per-scene instances of
  **Text / Shape / FullBleed**, given the active prop schemas, the baked theme,
  each scene's narration + shot intents, and the **system-computed scene durations**.
- **Composition spec v2**: add an **asset manifest** + **per-scene voiceover binding**
  (by R2 key), and the renderer plays voiceover via Remotion `<Audio>`. Scene
  `durationInFrames` is derived from the synthesized `duration_seconds` (spec 8.3).
- **Gate 1** (spec 11.1): structural (Zod spec schema) + semantic (primitive exists;
  props validate against the active+deprecated schema via the contract's
  `buildPropValidator`/`validateInstance`; token refs resolve in the theme; audio
  refs resolve in the manifest; instance timing fits within its scene). Failures
  return to the AI with feedback; **retry budget 2**.
- **Starter primitive prop schemas** for Text/Shape/FullBleed, authored as
  `PropSchema` in a server-shared registry (Gate 1 + the prompt both read them).
- **Theme baking** from `channel.brand_kit` into the contract's `Theme` (spec 8.2),
  embedded in the spec — the renderer never reads live channel config.
- **Live status** (queued → composing → resolving_assets → validating → rendering →
  encoding → complete) via the `jobs` row, and the finished MP4 played in the editor.

### Explicitly deferred (anticipated, not built)
- **Stock + agentic asset selection / vision** (Pexels/Pixabay, spec 8.8) — Phase 5.
  Phase 4 composes from Text/Shape/FullBleed only (the 8.9 procedural path), which
  proves the whole spine without a stock provider.
- **Gate 2** (smoke frame + vision, spec 11.2) — Phase 5.
- **Captions, kinetic text, music + ffmpeg re-mux, attribution overlay** — Phase 6
  (no stock ⇒ no attributions yet).
- The other starter primitives (ImageWithPan, VideoClip, KineticText, LowerThird) —
  added as the pipeline needs them (Phase 5/6).
- **`model_routing`** — Sonnet pinned in code (as Opus/ElevenLabs are now); Phase 8/9.

## 2. Decisions (proposed — flagged ones marked ⚑)

| Decision | Choice | Rationale |
|---|---|---|
| Scene timing | **System-derived**: `durationInFrames = ceil(duration_seconds × fps)` per scene; the AI arranges instances *within* that window | Voiceover defines scene length, so the video can't drift from the audio. The AI owns visual arrangement, not duration guessing. |
| Audio in the spec ⚑ | Two artifacts. The **durable spec references voiceover by R2 key** (the permanent record at `renders.composition_spec_r2_key`); `resolveAssets` signs the keys into an **ephemeral render-time copy** that Lambda fetches | Lambda's environment is empty, so every asset must be a fetchable signed URL (10.3) — but renders are preserved indefinitely (7.2) and signed URLs expire, so the **permanent artifact must be key-based, never the expiring URLs**. See "Spec durability" below. |
| Spec durability ⚑ | **Durable = key-based** spec (the record). **Render-time = ephemeral** signed copy, regenerable by re-signing the durable spec. A later re-render of a preserved version re-signs from the durable spec, never reuses dead URLs | Resolves 7.2 (preserved forever) vs 10.3 (signed, expiring): the record outlives any signature; signing is a render-time, repeatable transform. |
| Gate 1 feedback ⚑ | On failure, feed back **structured per-error detail** (scene index, instance index, primitive, prop, rule) — not "validation failed" | Specific feedback is what makes retry 2 actually fix the spec; vague feedback makes the budget theater. The validators already return precise messages; surface them verbatim per offending instance. |
| Compose-failure resumability ⚑ | When the budget-2 retry is exhausted: mark the render **failed with the validation errors preserved in the payload**, and **leave the snapshot revision and synthesized audio untouched** | A composition that won't validate must never cost the user their voiceover (spec 15.2: completed work is never discarded). This is the compose-step resumability guarantee. |
| Retry cost honesty ⚑ | Each Gate-1 retry is a **full extended-thinking call** (initial + 2 retries = up to 3× thinking tokens on the most expensive AI step). Conscious and acceptable; every attempt is logged to the cost ledger | Thinking can't be partial; making the cost explicit ties it to the ledger row below. |
| Cost ledger ⚑ | Write `cost_events`: one **`composition`** row covering the Sonnet call **incl. all retries** (sum input/output+thinking tokens), and one **`render`** row for the Lambda render seconds | These are the two largest cost lines in the system (spec 13.7); the per-video lifetime total can't be missing its biggest items. The ledger + `cost_operation` enum already have both. |
| Stale-override honesty ⚑ | `overrideStale` = render with the **existing (mismatched) audio**, user-accepted. The snapshot revision records **narration as-is**, so the mismatch is honest (revision shows new text, audio is old) — never silently "fixed" | The user explicitly accepts the mismatch; the immutable record must reflect reality, not paper over it. |
| Phase-1 sample harness ⚑ | **Keep** `startSampleRender` behind a separate, clearly **debug-only event** (`render/sample`) — do not retire | It is the only **no-AI** path to exercise the Lambda spine in isolation — exactly what triage needs when Phase 5/6 breaks. |
| Idempotency basis ⚑ | `hash(script_revision_id)`; **reuse only non-terminal (in-flight) renders** | The composition is non-deterministic, so the spec isn't known at kickoff; the immutable revision captures the committed input. In-flight-only reuse coalesces double-clicks while still allowing an explicit **re-render → new preserved version** (spec 7.2). Deviates from the literal "hash of spec + revision" (10.5) because the spec can't be hashed before it's composed. |
| Pipeline shape | **One unified `render-video` function** doing compose→gate1→resolveAssets→storeSpec→[spine]→finalize; `render/start` carries `{jobId, renderId, videoId}` | Matches spec 13.1 / the api-surface event shape. Supersedes Phase 1's `{renderId, specKey}` (the spec no longer pre-exists). |
| Composition output method ⚑ | **Prompt-for-JSON + parse + Gate-1 retry** (NOT structured outputs) | Confirmed via the `claude-api` skill: thinking + structured outputs *are* compatible, but a strict `json_schema` can't model the per-primitive `props` object (`additionalProperties:false` forbids arbitrary keys). Gate 1 is the real validator; its budget-2 retry is the safety net. |
| AI output scope | **The AI emits only per-scene `instances`** (`{scenes:[{sceneId, instances[]}]}`); the system assembles the full spec (baked theme, audio-derived durations, voiceover bindings, manifest, metadata) around them | Theme/durations/voiceover are system-baked (spec 8.2/8.3), not AI-authored — the AI can't break them. Its job is purely visual arrangement (spec 8.1). Gate 1 validates the assembled spec. |
| Composition model | **`claude-sonnet-4-6` + `thinking: {type:'adaptive'}`**, pinned (no `budget_tokens` — deprecated on Sonnet 4.6, same as Phase 2's Opus) | Build plan + spec 8.7 route composition to Sonnet w/ extended thinking; adaptive thinking is the modern form. Thinking stays in thinking blocks; only the text JSON is parsed. **Stream + `finalMessage()`** for HTTP-timeout safety (no token-by-token needed). |
| Gate 1 engine | Reuse the contract's `buildPropValidator`/`validateInstance` + a spec-level Zod schema + semantic checks against the baked theme & manifest | The validators already exist in `src/lib/primitives/contract.ts`; Gate 1 is their first real caller. |
| Starter primitive schemas | Author `PropSchema` + `PrimitiveMeta` for Text/Shape/FullBleed in `src/lib/primitives/starter/` (pure; shared by Gate 1 and the prompt). The Remotion components stay the rendering source | The components currently export no schema; Gate 1 and the AI both need one. Schemas mirror each component's real props. |
| Theme baking ⚑ | `bakeTheme(brand_kit)` → full `Theme`, with sensible **defaults for tokens the minimal seed omits** | The seed `brand_kit` has only `colors.primary` + `typography.font`; the `Theme` needs background/foreground/secondary/accent/bodyText, three fonts, motion. Derive/default the rest. |
| Completeness gate | Block if any scene `not_synthesized`; `stale` requires `overrideStale` | Reuses the Phase-3 `audio_status` lifecycle (RenderApi.startRender). |
| Live render status | Subscribe to the **`jobs` row** (already in Realtime) for phase; play the MP4 from a signed URL on complete | Avoids adding `renders` to the publication; `jobs.phase` already carries the lifecycle. |

## 3. Architecture & data flow

```
Editor "Generate Video"
   │  startVideoRender(videoId, overrideStale?)   [Tier 2 server action]
   ▼
completeness gate (no not_synthesized; stale⇒override)
   → snapshot scenes+shots → script_revisions row
   → idempotencyKey = hash(revisionId); reuse in-flight render if present
   → create renders row (status=queued) + jobs row (type=render)
   → inngest.send('render/start', { jobId, renderId, videoId })
   ▼  returns { renderId, jobId }  (or { blocked, sceneIds })
Editor subscribes to the jobs row (phase) + plays MP4 on complete

Inngest render-video function          [Tier 3, service-role admin client]
   step compose+gate1:  load scenes(+narration,duration,shots,audio_key)+brand
                        → bakeTheme → prompt (active schemas + durations)
                        → Sonnet(thinking) → KEY-BASED spec → validateSpec(...)
                        fail → re-prompt with STRUCTURED per-error feedback (budget 2)
                        each attempt → cost_events(composition); exhausted → THROW
                        (audio + revision untouched; errors preserved on the render)
   step storeSpec:      write the DURABLE key-based spec → renders.composition_spec_r2_key
   step resolveAssets:  sign each scene's voiceover key → EPHEMERAL signed spec copy
                        (lifetime > max render) → renderSpecKey
   [Lambda spine — Phase 1, unchanged]: mark-rendering → invoke-lambda(renderSpecKey)
                        → poll → store-mp4-in-r2
   step finalize:       cost_events(render, lambda seconds); renders.status=complete,
                        output_r2_key, render_date; videos.current_render_id; jobs complete
   onFailure: renders.status=failed (validation/errors preserved), jobs failed.
              Revision + synthesized audio are NEVER touched (spec 15.2).
              [Phase 9 = full failure taxonomy]

ReelComposition (Remotion): per scene, <Audio src={signedVoiceUrl}/> +
   primitive instances; scene durationInFrames from synthesized duration.
```

## 4. Files

**Spec & renderer**
- `src/lib/composition/spec.ts` — bump to `version: 2`; add `assets` manifest +
  `CompositionScene.voiceover` (asset ref); keep theme + instances.
- `remotion/ReelComposition.tsx` — play `<Audio>` per scene; scene duration from spec.

**Primitives**
- `src/lib/primitives/starter/{text,shape,fullbleed}.ts` + an index registry
  `{ name → { propSchema, meta } }` (pure, server-importable).

**Composition (pure, unit-tested)**
- `src/lib/composition/theme.ts` — `bakeTheme(brandKit) → Theme`.
- `src/lib/composition/compose.ts` — system/user prompt builders + `parseSpec`.
- `src/lib/composition/gate1.ts` — `validateSpec(spec, registry, theme) → ok|errors`.
- matching `*.test.ts` for theme, gate1, compose parse, idempotency.

**AI / Inngest / actions**
- `src/lib/ai/anthropic.ts` — add `COMPOSITION_MODEL`.
- `src/lib/inngest/functions/render.ts` — refactor into the full pipeline (durable
  storeSpec + ephemeral resolveAssets; cost_events for composition incl. retries +
  render seconds); update `client.ts` event type to `{ jobId, renderId, videoId }`.
- Keep the Phase-1 sample path behind a **debug-only `render/sample` event** (rename
  its trigger from `render/start`); `startSampleRender` stays for no-AI spine triage.
- `src/app/(app)/videos/[id]/render-actions.ts` — `startVideoRender` (completeness
  gate, honest stale-override, revision snapshot, idempotency), `getRenderState`
  (signed playback URL).

**UI**
- `Editor.tsx` — "Generate Video" button (disabled until all synthesized / with a
  stale-override confirm), live status from the jobs row, and the finished player.

**Migration:** none expected — `render_status`, `script_revisions`, `renders`,
`jobs` all already exist; `scenes` audio fields land from Phase 3.

## 5. Build order (each step independently demonstrable)

1. **Spec v2 + renderer audio** — extend the spec type + `ReelComposition` `<Audio>`;
   prove by hand-writing a voiced spec over the already-synthesized "dogs" audio and
   rendering it on Lambda. (Extends the Phase-1 proof with sound — a real checkpoint.)
2. **Starter prop schemas + Gate 1** (pure, unit-tested: valid spec passes; unknown
   primitive / bad prop / unresolved token / out-of-range timing fail).
3. **Theme baking** (pure, tested; minimal-seed defaults).
4. **Composition step** — prompt builders + Sonnet(thinking) call + parse (confirm
   model/thinking/structured-output via the `claude-api` skill here).
5. **Render pipeline** — wire compose→gate1(retry 2)→resolveAssets→storeSpec→spine→
   finalize; reshape the `render/start` event.
6. **Generate Video action** — completeness gate, revision snapshot, idempotency,
   row creation, emit.
7. **UI** — Generate Video button + live status + play the MP4.
8. **End-to-end milestone** (Section 7).

## 6. Open items to confirm at build time
- **Composition model specifics** — confirm `claude-sonnet-4-6`, extended-thinking
  budget, and structured-output-vs-prompt (and thinking compatibility) via the
  `claude-api` skill before wiring the compose step.
- **Theme derivation** — the defaults for tokens the minimal seed `brand_kit` omits
  (background/secondary/accent/bodyText, body/mono fonts, motion).

(Resolved during review and now decisions above: spec durability = key-based record +
ephemeral signed copy; Gate-1 feedback is structured per-error; compose-failure leaves
audio+revision intact; cost ledger covers composition incl. retries + render seconds;
stale-override is honest; the Phase-1 sample harness stays as the debug-only
`render/sample` event.)

## 6a. Build learnings (step 1 — verified 2026-06-09)
Spec v2 + `<Audio>` proven on Lambda: a hand-written 2-scene voiced spec over the
Phase-3 audio rendered to an MP4 carrying both `mp4a`/`soun` (audio) and `vide`
(video) tracks. Two constraints surfaced that **step 5 must honour**:
- **Lambda concurrency ceiling.** A 33s render fanned out into more concurrent
  chunk-Lambdas than the AWS account allows → fatal "Rate Exceeded". The render call
  must **cap chunk concurrency** (e.g. set `framesPerLambda` so chunk count stays
  small) — a lightweight stand-in for the Phase-9 governor. A short render with 2
  chunks succeeded cleanly.
- **`render-video` needs an `onFailure`.** The Phase-1 function has none, so a failed
  run left the `renders` row stuck at `rendering`. The refactored pipeline must mark
  the render failed (errors preserved) on terminal failure — which the compose-failure
  resumability decision already requires.

## 6b. Build learning (compose latency — fixed 2026-06-09)
A browser render looked "stuck in composing" for ~5–6 min. Root cause: adaptive
thinking tokens count against `max_tokens`, and at `max_tokens: 16000` Sonnet could
spend the **entire budget thinking and emit NO text** (empty output → forced Gate-1
retry → another ~2–3 min call). It was never failing validation — it was starved of
output budget. Fix: `max_tokens: 32000` (we already stream; Sonnet caps at 64K) gives
thinking + the JSON room, and `output_config: { effort: 'medium' }` reins in
over-thinking on what is a layout task. Result: **first attempt 103s, `stop_reason=
end_turn`, valid first try** (was ~375s across two attempts). Also added a
`stop_reason === 'max_tokens'` guard so budget exhaustion surfaces as itself rather
than masquerading as a malformed-output retry.

## 7. Milestone verification
From the dashboard: prompt → script streams in (Phase 2) → **Synthesize all** → green
(Phase 3) → **Generate Video** → status advances queued→composing→resolving→
validating→rendering→encoding→complete → the **MP4 plays with voiceover**, each scene
timed to its narration, brand colours/fonts applied, composed from Text/Shape/FullBleed.
The prompt-to-video path is now fully automatic — the slice is closed.
