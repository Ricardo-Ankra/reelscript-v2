# Phase 6 — Creative polish (captions, kinetic text, music + remux) — Design

**Status:** proposed 2026-06-12
**Build plan phase:** Phase 6 ("videos look produced")
**Milestone:** a video ships with **captions**, **kinetic emphasis**, and a **music
bed**, and **music changes re-mux in seconds without re-rendering**.

## 1. Goal & scope

Make the working, stock-rich video *look produced*. Three additions, each driven
by data the spine already has — the Phase-3 word timings — plus one genuinely new
piece of infrastructure: a dedicated **ffmpeg Lambda** that mixes music onto the
rendered video without re-rendering (spec 10.1).

Three operator answers shaped this scope:
1. **Milestone three only** — captions, kinetic text, music + remux. Aspect/FPS/
   target-length controls and thumbnail generation are **deferred to Phase 8**
   (aspect ratio + FPS are already honoured at render time; they just lack a UI).
2. **Seed music via the ElevenLabs Music API** — Pexels Audio is discontinued; we
   already hold `ELEVENLABS_API_KEY`, so a seed script generates instrumental beds.
3. **Minimal Music panel** — reroll/replace + master volume → re-mux. The remux
   step accepts the full param set (ducking depth, loop, crop, fade); only its UI
   is deferred to Phase 8.

### In scope
- **Captions (4.2.1, 8.5)** — a *system-generated* layer (independent of the AI):
  full narration aligned to `scenes.word_alignments`, one standard position/style
  from `brand_kit.caption_style`, **owning the lower-third band exclusively**.
  **Burnt into the MP4** when on; **always exported as SRT/VTT sidecars** to R2.
  Channel default: on for 9:16/1:1, off for 16:9.
- **Kinetic text (4.2.2, 8.4)** — a new `KineticText` **starter primitive** the
  composition AI places at emphasis moments, **frame-aligned to word timings**,
  reading the channel's kinetic config (usage off/sparing/liberal,
  font→Display default, position, accent). **Animation is a closed two-value enum**
  the AI selects from — `bounce` (← `<excited>`) and `pop` (← `<emphatic>`); nothing
  else ships in V1. AI-authored, unlike captions.
- **Background music (4.2.3, 10.1)** — opt-in per video. The compose AI picks an
  initial track by **mood-tag match** against the seeded library (fallback to a
  neutral track). The render emits **voiceover-only, no music**; a **dedicated
  ffmpeg Lambda** mixes + ducks the track into the final MP4. Music changes re-run
  **only the remux** (seconds). Music off ⇒ no mix step.
- **Seeded music library** — a seed script calls the ElevenLabs Music API once per
  mood, uploads each bed to R2, inserts a `music_tracks` row (mood tags + duration).
- **Minimal Music panel** in the video review UI — reroll/replace + master volume,
  Save → `music/remux` (no re-render).
- **Gate 2 collision check** — extend the existing mid-frame vision QA to flag
  kinetic-text / caption collisions (spec 11.2).

### Explicitly deferred (anticipated, not built)
- **Aspect ratio / FPS / target-length controls** (Phase 8 settings) — render
  honours `settings.aspect_ratio`/`fps` already; target-length is unbuilt.
- **Thumbnail generation** (`thumbnail_templates`, `thumbnail_copy`) — Phase 8.
- **Full Music panel** (ducking depth, loop, in/out crop, fade UI) — Phase 8; the
  remux accepts the params now.
- **Full caption/kinetic/music channel-settings UI** (Phase 8) — Phase 6 drives
  these via channel defaults + a seeded per-video toggle, like prior phases.
- **Audio / Group** starter primitives — add only if a gap appears.
- The **rate/concurrency governor** (Phase 9) and **model_routing** (Phase 8) —
  unchanged carry-forwards.

## 2. Decisions (proposed — flagged ones ⚑)

| Decision | Choice | Rationale |
|---|---|---|
| Captions ownership | **System-built layer, not an AI primitive.** A pure builder turns per-scene `word_alignments` → caption segments; `ReelComposition` renders a `CaptionTrack` directly. | Spec 8.5: captions are added "automatically … independent of the AI's creative output." Keeps them deterministic and out of the compose loop. |
| Caption segments | Pure `buildCaptions(scenes, fps, caption_style)` → `{ fromFrame, toFrame, text }[]`, chunked by `max_chars_per_line`; same segmentation feeds SRT/VTT. | One source for burnt-in + sidecars → they can't drift. Unit-testable (no network). |
| Sidecars | **SRT + VTT** generated from the segments, stored at `captions/{renderId}.srt`/`.vtt`; produced even when burn-in is off (spec 4.2.1 "always exported"). | Accessibility export is unconditional. |
| Spec shape | `CompositionSpec` gains `captions?: CaptionSegment[]` (top-level). **Music is NOT in the Remotion spec** (the render excludes it; remux owns it). KineticText needs no shape change — it's a normal `PrimitiveInstance`. | Captions are renderer-drawn; kinetic text is just instances; music is post-render. |
| KineticText primitive | New starter primitive (`remotion/primitives/KineticText.tsx` + schema in `starter.ts`); animation via `useCurrentFrame`/`spring`, brand-styled via `useTheme`. **`animation` is a closed two-value enum prop, not an open config field: `bounce` (← `<excited>`), `pop` (← `<emphatic>`)** — the only two that ship in V1. The AI emits instances with `startFrame`/`durationInFrames` derived from the word timings handed to it, choosing `animation` from the enum. | Spec 8.4 / starter set (Text, **KineticText**, Image, Video, Shape, Audio, Group). A closed enum keeps Gate-1 validation tight and the AI from inventing motions. |
| Emphasis-tag mapping ⚑ | Kinetic animation is driven by exactly two emotion tags: **`<excited>` → bounce**, **`<emphatic>` → pop**. **`<whisper>` and a future `rise` are V2 candidates, not built.** `<calm>`/`<curious>`/`<serious>`/`<whisper>` stay **tonal-for-voice-only** (they nudge synthesis, never kinetic motion); `<pause>` stays **timing-only**. | One closed vocabulary shared by the compose prompt and the `animation` enum, so voice tags and visual motion can't drift. |
| Word timings → compose | Extend `loadBrief` to select `word_alignments`; pass a compact per-scene word/timing list into the brief + compose prompt so the AI frame-aligns kinetic emphasis. **The compose prompt constrains `animation` to the closed enum (`bounce`\|`pop`)** and forbids any other value. | Timings already persisted; just not threaded. Constrained prompt + Gate-1 enum reject = no invented animations. |
| Collision prevention ⚑ | **Prevented by construction, not by Gate 2.** Captions own the lower-third band exclusively; `KineticText` placement is **forbidden from the caption band** and confined to its own zone (upper/mid); during an active kinetic span, any **overlapping caption words are suppressed**. Enforced in `buildCaptions` (band reservation + suppression windows) and `KineticText` placement (zone clamp). | A spent render that fails a probabilistic vision reject is wasted money; geometry that can't collide is free. Gate 2 stays a **backstop**, not the primary defense. |
| Text legibility bake ⚑ | Both `CaptionTrack` and `KineticText` apply a **system bake pass** (not an authored field): **stroke + drop-shadow + a zone-appropriate scrim**, colours pulled from the **baked theme/brand-kit snapshot** in the render. Kinetic's plate **sizes to the word's max-scale frame** so it never clips at the animation peak. Always-on baseline ships in Phase 6; an **adaptive bake-time luminance sample** (scrim opacity from the underlying frame) is a deferred enhancement. | Captions/kinetic over stock footage are unreadable without it. Baked, deterministic, theme-sourced — never depends on live config. |
| Music selection | Compose step picks `music_track_id` by matching the video's mood against `music_tracks.mood_tags` (fallback: neutral seeded track). Stored on the **render** row, not baked into the Remotion spec. **Reroll/replace is reselection from the seeded library only — never regeneration**: seed = one-off generation, reroll = pick an existing row. | Spec 4.2.3; render stays music-free so remux is cheap + re-runnable. The reselection boundary keeps generation (the only ledgered-spend risk) confined to seeding. |
| Render output split ⚑ | Render writes the **voiceover-only base** to `renders.base_output_r2_key`; the remux step writes the **final** to `renders.output_r2_key`. Music off ⇒ remux skipped, `output = base`. | Spec 10.1: "Voiceover stays baked in; only music is re-mixable." Enables re-mux-only on music change. |
| ffmpeg Lambda ⚑ | A **dedicated AWS Lambda from a container image bundling ffmpeg**, invoked from a new `music/remux` Inngest function. Ducking via ffmpeg `sidechaincompress` (music keyed to the voiceover); supports loop-to-length, in/out crop, fade, master volume. | Stack doc: "ffmpeg on a dedicated Lambda." Container image avoids a fragile layer; Inngest owns retries/idempotency. |
| Remux trigger | A `music/remux` event from (a) the render pipeline when music is on, and (b) the minimal Music panel's Save/reroll. Idempotent on `hash(base_key, music_track_id, canonical(music_params))` — **`music_params` is canonicalized before hashing** (stable key order + normalized numeric formatting) so semantically identical param sets hit the cache instead of re-muxing. | Re-mux is a first-class, repeatable step (spec 6.6); canonicalization stops needless re-mux on cosmetically-different params. |
| Seed music ⚑ | Seed script calls **ElevenLabs Music** (`POST /v1/music`, `force_instrumental: true`, `music_length_ms`) once per mood tag → R2 + `music_tracks`. | Operator's call; reuses the existing key. Confirm endpoint/cost at build. |
| Gate 2 | **Backstop only.** With collisions prevented structurally (above), the mid-frame vision check is extended to *catch residual* kinetic-text/caption overflow or collision and reject — but it is no longer the primary defense; no new step. | Spec 11.2 wording update; defense-in-depth behind the structural rule. |
| Migration | Small: add `base_output_r2_key`, `music_track_id`, `music_params jsonb` to `renders`. `music_tracks` + `music_remux` cost op already exist; captions live in the spec JSON (no column). | Minimal surface. |

## 3. Architecture & data flow

```
render-video (Phase 6 additions in *):
  compose:
    loadBrief now also loads scenes.word_alignments
    * brief carries per-scene word timings (for kinetic) + caption_style
    AI emits KineticText instances (frame-aligned; animation ∈ {bounce,pop})  [kinetic]
        placement clamped to the kinetic zone — caption band is off-limits
    * if music_on: pick music_track_id by mood match → store on render
  * buildCaptions(scenes, fps, caption_style) → spec.captions               [captions]
        reserves the lower-third band; suppresses caption words overlapping
        an active kinetic span  →  collisions prevented by construction
    Gate 1 (caption segments are system-built, not validated as props)
  storeSpec (durable) → resolveAssets (signed) → Gate 2 (BACKSTOP: residual
        overflow/collision only)
  Lambda render → BASE mp4 (voiceover + burnt captions + kinetic, NO music)
        CaptionTrack + KineticText each bake legibility (stroke+shadow+scrim,
        theme-sourced; kinetic plate sized to the word's max-scale frame)
    → renders.base_output_r2_key
  * write SRT/VTT sidecars → captions/{renderId}.{srt,vtt}
  * if music_on: emit music/remux ; else output_r2_key = base_key (finalize)

music-remux (new Inngest fn, dedicated ffmpeg Lambda):
  inputs: base mp4 + music track + music_params (volume, duck, loop, crop, fade)
  key = hash(base_key, music_track_id, canonical(music_params))   ← idempotent
  ffmpeg: loop/trim track (loop-point crossfade for short beds)
        → sidechaincompress(duck by voiceover) → amix → mp4
  → renders.output_r2_key ; cost_events('music_remux')

Music panel (minimal): reroll = reselect from seeded library + master volume → Save
  → re-emit music/remux against the EXISTING base (no re-render) → new final
```

## 4. Files (high level)
- **migration** `supabase/migrations/2026..._phase6_polish.sql` — `renders.base_output_r2_key`, `music_track_id`, `music_params`.
- **captions** `src/lib/captions/segments.ts` (pure builder + SRT/VTT, **lower-third
  band reservation + kinetic-span word suppression**, tested); `remotion/CaptionTrack.tsx`
  (**legibility bake: stroke + shadow + scrim, theme-sourced**); `spec.ts` gains
  `captions`; `ReelComposition` renders it.
- **kinetic** `remotion/primitives/KineticText.tsx` (**closed `animation` enum
  `bounce`\|`pop`; zone-clamped placement off the caption band; legibility bake +
  plate sized to the word's max-scale frame**) + `starter.ts` schema (**`animation`
  as a 2-value enum prop**) + registry; `compose.ts` prompt binding (channel kinetic
  config + per-scene word timings, **constrained to the enum**); `loadBrief` selects
  `word_alignments`.
- **music select** `src/lib/music/select.ts` (mood-match, pure; **reselection-only —
  no generation**); compose writes `music_track_id` to the render. **Mood-tag
  vocabulary enumerated once** in a shared module imported by both `select.ts` and
  `scripts/seed-music.ts`.
- **remux** `src/lib/inngest/functions/music-remux.ts`; `src/lib/music/ffmpeg.ts`
  (command builder + **`canonical(music_params)` for the idempotency key**,
  pure/tested); the AWS ffmpeg-Lambda deploy (container image) + an invoke helper;
  `render.ts` base/final split + sidecar write + remux emit.
- **seed** `scripts/seed-music.ts` — ElevenLabs Music → R2 → `music_tracks`.
- **UI** a minimal **Music panel** in `src/app/(app)/videos/[id]/...` + a
  `remuxMusic` server action; per-video `captions/kinetic/music` flags from defaults.
- **gate2** `src/lib/ai/vision.ts` — collision wording in the QA prompt.

## 5. Build order (each independently demonstrable; central risk first)
1. **Remux spine** — stand up the dedicated ffmpeg Lambda + the `music/remux`
   Inngest fn; prove a **hand-fed base MP4 + seed track → ducked final MP4 in
   seconds**. The riskiest new infra, de-risked first (Phase-1 pattern).
2. **Captions** — pure segment builder (lower-third band reservation + kinetic-span
   word suppression) + SRT/VTT; `CaptionTrack` in the renderer **with the legibility
   bake**; thread `word_alignments`; **Remotion site redeploy**. Prove a hand-written
   spec renders legible burnt-in captions + sidecars land in R2.
3. **KineticText** — primitive (closed `bounce`\|`pop` enum, zone-clamped off the
   caption band, legibility bake) + schema + compose-prompt binding (enum-constrained)
   + Gate-2 **backstop** collision check; redeploy (batch with step 2's redeploy).
   Prove the AI places frame-aligned emphasis words that never collide with captions.
4. **Music selection + pipeline wiring** — base/final split, mood-match pick, seed
   script (ElevenLabs Music), minimal Music panel + reroll → remux-only.
5. **End-to-end milestone** (Section 7).

## 6. Open items to confirm at build time
- **ElevenLabs Music API** exact request/response (`/v1/music`, output_format, mp3
  length cap) and **async-vs-sync**: if generation is async, the **seed script must
  handle a job-poll loop**. Seed generation is the *only* generation that happens —
  **reroll never regenerates** — so it stays a one-off, un-ledgered op (no
  `music_generation` cost op exists). Wiring reroll to generation would create
  un-ledgered spend; that boundary is fixed.
- **ffmpeg Lambda packaging** — container image vs layer; the `sidechaincompress`
  parameters that give natural ducking; memory/timeout sizing. **Loop-to-length for
  beds shorter than the video must use a loop-point crossfade** (not just in/out
  fade) — a hard loop seam clicks audibly.
- **Mood-tag vocabulary** — confirm the enumerated set lives in **one shared module**
  that both `scripts/seed-music.ts` (what it generates) and `music/select.ts` (what
  it matches) import, so seeded tags and match targets can't drift.
- **Caption styling** — the `caption_style` fields actually present on seeded
  channels (position, size, background, outline, max chars/line) and sensible
  defaults when absent.
- **Per-video toggles without settings UI** — where captions/kinetic/music flags
  come from in Phase 6 (channel `defaults` + the render trigger), pending Phase 8.

## 7. Milestone verification
With a channel whose music library is seeded and music toggled on: prompt → script
→ synthesize → **Generate Video** → the render produces an MP4 with **burnt-in
captions** aligned to the voiceover, **kinetic emphasis** words popping on beat, and
a **ducked music bed**; **SRT/VTT** sidecars exist in R2; `cost_events` shows a
`music_remux` line. Then, in the Music panel, **reroll the track and Save** → a new
final MP4 returns in **seconds** with no re-render (same `base_output_r2_key`, new
`output_r2_key`). On a video with music off, the same flow yields a captioned,
kinetic video with **no remux step** and voiceover-only audio.
