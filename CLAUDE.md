# Reelscript V2

AI-orchestrated video studio: a short prompt becomes a brand-consistent,
publish-ready video, composed by AI and rendered programmatically. V1 is
personal use by a single operator running multiple channels, built to be
multi-tenant-capable without a rewrite.

Governing principle: **the AI emits recipes, not output.** The script is text,
the scene plan is JSON, the composition is a JSON spec; rendering is a
deterministic transformation into an MP4. The only place AI-authored code exists
is the primitive authoring studio, where it is validated once at authoring time,
never on every render.

## Design source of truth

Read these before starting any task. They are the authoritative design; when in
doubt, follow them rather than inferring.

- `docs/spec/` — the full design & feature specification (rev 8). Start here for
  the what and why.
- `docs/build-plan/` — the phased build order. We build in this sequence, one
  phase at a time.
- `docs/schema/` — the database schema (Supabase / PostgreSQL), with RLS.
- `docs/contracts/` — the primitive contract (`primitive-contract.ts`) and a
  worked example primitive (`KeyStatRing.tsx`).
- `docs/api/` — the API surface, organized into three tiers.

These `.ts` files under `docs/` are **reference specifications**, not wired-in
code. When a phase needs them, copy them into the real source tree (e.g.
`src/lib/primitives/contract.ts`) — at that point the source copy becomes
authoritative and the `docs/` copy remains the design record.

## Stack

- **Frontend / hosting:** Next.js (App Router) + React + Tailwind on Vercel.
  Holds no secrets, runs no long jobs.
- **Database / auth / realtime:** Supabase (PostgreSQL). RLS enabled from day
  one, keyed to `auth.uid()`. Supabase Auth (email/password + Google) and
  Supabase Realtime.
- **File storage:** Cloudflare R2 (MP4s, uploads, audio, fonts, the bundled
  Remotion site). Zero egress; S3-compatible.
- **Orchestration:** Inngest (voice synthesis, the render pipeline). Step code
  runs on Vercel for light work, on Lambda for heavy/untrusted work.
- **Rendering:** Remotion Lambda on AWS. ffmpeg on a dedicated Lambda for the
  music re-mux.
- **AI:** Anthropic / OpenAI, routed per task. **Audio:** ElevenLabs.
  **Stock:** Pexels / Pixabay.

## Architecture boundaries (do not violate)

- Fast work on Vercel, slow work on Inngest. The frontend never holds a secret
  and never runs a long job.
- Plain data CRUD goes directly through the Supabase client under RLS (Tier 1).
  Custom server endpoints exist only for secrets, trusted logic, or job kickoff
  (Tier 2). Long jobs are Inngest functions (Tier 3). See `docs/api/`.
- Renders are self-contained: the composition spec embeds a baked theme snapshot;
  the renderer never reads live channel config.

## Working agreement

- **Build strictly in the build-plan phase order. Do not jump ahead.**
- **Current phase: Phase 8 — Full surfaces.** (Phase 0 —
  Foundations: complete & verified 2026-06-04. Phase 1 — Render spine: complete &
  verified 2026-06-08. Phase 2 — Script and scenes: complete & verified 2026-06-08.
  Phase 3 — Voice synthesis: complete & verified 2026-06-09. Phase 4 — Composition,
  the slice closes: complete & verified 2026-06-09. Phase 5 — Asset richness:
  complete & verified 2026-06-10. Phase 6 — Captions, kinetic text, music + remux:
  complete & verified 2026-06-15. **Phase 7 — The primitive authoring studio:
  complete & verified 2026-06-15** — the library is extensible from the UI: describe a
  primitive → Opus drafts it with the primitive skill → the four authoring gates
  (lint static / compile / smoke / brand stress kit) validate it once → save re-bundles
  the Remotion site → the composition AI places it. Bounded auto-fix loop, prop-schema
  lifecycle + evolution guard, archive/restore/delete with usage gating. Backend proven
  end-to-end headlessly (`npm run drive:primitive`); the three-pane studio UI ships.
  Design docs under `docs/superpowers/specs/2026-06-0*`.)
  - **Frontend navigation & creation-flow overhaul (2026-06-21):** **Home (`/`) is now
    the channels surface** (channel cards + inline create; `/dashboard` and `/channels`
    redirect to `/`; "Channels" nav link dropped; `PromptBox` deleted). The **channel
    page is tabbed — Videos (default) | Settings** — the Videos tab lists the channel's
    videos with a **derived status** (`src/lib/videos/status.ts` `deriveVideoStatus`) and
    is the **sole "New video" entry point**. A channel-scoped **New Video setup screen**
    (`/videos/new?channel=<id>`) collects the prompt + **all options before generation**
    (aspect/fps/length/captions/density/music), prefilled from the channel's full stored
    defaults and overridable per video. `startScriptGeneration(prompt, channelId,
    settings?)` now seeds from `parseChannelCreateOptions(channel.defaults)` ⊕
    `mergeCreateSettings` (`src/lib/videos/create-settings.ts`) — **fixing the prior bug
    where captions/music were hardcoded and `caption_emphasis_density` was omitted**. No
    schema change (captions/density/music already lived in `channels.defaults` via the
    Brand editor; no duplicate controls added). Design:
    `docs/superpowers/specs/2026-06-21-frontend-navigation-overhaul-design.md`.
  - **Jobs monitor + real Inngest cancellation (2026-06-21):** a **`/jobs` page**
    (server + account-wide Supabase Realtime on `jobs`, Active/Recent groups) and a
    **navbar "Jobs" badge** (live active count) show all background work; a **Cancel**
    action **truly cancels the Inngest run** via `cancelOn` keyed by `jobId` (a
    `jobs/cancel` event on all four job functions — `generateScript`/`renderVideo`/
    `synthesizeVoice`/`deployPrimitive`, using the non-deprecated `if` form), then marks
    the job row `cancelled` (and a render job's `renders` row `failed`+`{cancelled}` so a
    fresh render starts clean). New `cancelled` value on the `job_status` enum
    (migration); pure tested `src/lib/jobs/monitor.ts` (`isCancellable`/`jobStatusLabel`/
    `partitionJobs`); `cancelJob`/`loadJobs`/`countActiveJobs` in
    `src/app/(app)/jobs/actions.ts` (RLS, account-dual-keyed, send-then-mark, no-mark on
    send failure). Handles both the genuinely-running case (cancelOn stops it) and the
    queued-never-started case (row still marked so a new run can start). **Retry is
    deferred** to a follow-up. Design:
    `docs/superpowers/specs/2026-06-21-jobs-monitor-cancellation-design.md`. Also this
    session: dev port pinned to **3000** (`next dev -p 3000`) + `npm run inngest` /
    `npm run inspect:video <id>` helpers (a stuck "Generating" job traced to Inngest
    dev-server port drift), and the video editor now **loads the latest render on open**
    so a previously-rendered video is watchable without re-rendering.
  - **Video recovery — retry generation + delete video (2026-06-22):** closes the
    create→cancel dead-end. **Retry** re-runs a `failed`/`cancelled` script generation
    in place — `retryGeneration(videoId)` reads the video's stored prompt +
    `settings.target_length` and delegates to the existing
    `regenerateVideo(videoId, {prompt, targetLengthSeconds})` (`replace:true` wipes
    partial scenes; the in-flight guard is reused, not duplicated; empty prompt → friendly
    error, never fabricated). **Delete** (the first delete-video capability anywhere) —
    `deleteVideo(videoId)` (`src/app/(app)/videos/[id]/delete-actions.ts`): account-scoped,
    refuses while a job is `queued`/`running` ("Cancel the running job before deleting."),
    best-effort R2 cleanup of scene audio (`audio/<sceneId>.mp3`) + render
    `output_r2_key`/`base_output_r2_key`/`composition_spec_r2_key` (**NOT `music_remux_key`**
    — a cache hash, not an R2 key; each delete try/catch'd, never fatal), then a dual-keyed
    row delete; the FK cascade removes scenes/shots/renders/jobs/script_revisions and
    `cost_events.video_id` → NULL (ledger preserved). Pure `isRetryable(type, status)` =
    `script_generation && (failed||cancelled)` drives the affordances. **Placement:** editor
    recovery banner (Retry) + header Delete (→ `/channels/<channelId>`, new `channelId`
    prop), `cancelled` StatusPill label (amber); `/jobs` Retry on retryable
    `script_generation` rows; channel Videos list per-row Delete (`DeleteVideoButton`, row
    restructured so the button isn't nested in the `<Link>`). **No schema change** (the
    `cancelled` enum + cascade already existed). 6 tasks subagent-driven, final Opus review
    READY TO MERGE; 329 tests + tsc + lint + build(17/17) green. Design:
    `docs/superpowers/specs/2026-06-21-video-recovery-retry-delete-design.md`.
  - **Asset model overhaul — program (design 2026-06-22):** a 4-slice program to fix
    asset reliability + workflow, triggered by a Gate-2 failure (stock returned a white
    Jeep for a "Rivian R2" shot; vision QA caught it but the flow dead-ended). **Insight:
    reliability is a routing problem** — stock *and* text-to-video both hallucinate
    specific named entities; route by a per-shot `specificity` class instead. The spine:
    an editable **VisualBrief** on shots (subject/action/setting/framing/mood/specificity/
    entity_name/recommended_source, authored at script time), a **provider-registry
    resolver** with a specificity-ordered fallback ladder (upload→stock→generate→primitive),
    a `generated` `shot_source` value, and an **editor-side readiness gate** (fail-forward —
    block Generate Video on unresolved `entity` shots, with Gate-2 vision QA as the
    backstop). Slices **A→B→C→D**: A formatted errors (done, below); B scene asset tray +
    operator upload; C visual brief authoring + resolver router + readiness gate; D
    generation providers (Heygen/Higgsfield/text-to-image) registered behind the resolver
    later, no pipeline change. Design:
    `docs/superpowers/specs/2026-06-22-asset-model-overhaul-design.md`.
    - **Slice A — formatted composition/render errors (2026-06-22):** render/composition
      errors now render as a card (phase badge + message + QA issues + smoke frame inline)
      instead of raw JSON, in the editor and on `/jobs`. Pure `parseRenderError(unknown)` +
      `phaseLabel` (`src/lib/errors/render-error.ts`, never-throws, normalizes the structured
      `{phase,issues[],message,frameUrl}` object OR a plain string); shared
      `RenderErrorCard` (`src/components/`). **Root-cause fix:** `getRenderState` stopped
      `JSON.stringify`-ing the error (returns `error: unknown`); editor `renderError` state
      is now `ParsedRenderError`; `/jobs` renders each row's already-loaded `error` (guarded
      `status !== 'cancelled' && error != null`). A discovered 3rd `getRenderState` caller
      (`MusicPanel`) got a minimal `typeof string` guard. 4 tasks subagent-driven, final
      Opus review READY TO MERGE; 336 tests + tsc + lint + build(17/17) green. No schema
      change. (Follow-up: a *cancelled* render in the editor shows the generic fallback —
      cancel writes `{cancelled:true}` with no `message`; nicer "Cancelled" copy is a future
      nicety, not a regression.)
    - **Slice B — scene asset tray + operator upload (2026-06-22):** the operator can now
      upload an image/video **straight from any shot in the editor** and it pins to that
      shot — so a shot stock can't satisfy (the Rivian R2 case) is fixed by attaching
      footage. New `SceneAssetUploader` (`videos/[id]/`) reuses the existing channel-resource
      flow verbatim (`createResource` → signed PUT → `confirmResource`) and binds via the
      existing `setShotResource`; the editor holds a **live resource list** so an upload
      appears in every shot's picker immediately (`onUploadAndAttach` = dedup-add then
      `onSetShotResource`). The uploader renders on **every** shot row regardless of how many
      resources exist (solves the no-resources→no-picker chicken-and-egg; the old read-only
      `{shot.source}` badge was replaced by it). A per-scene **"Attached:" tray** (pure
      `sceneAttachedResources` in `src/lib/resources/scene-tray.ts`) shows what's pinned. 4
      tasks subagent-driven, final Opus review READY TO MERGE; 340 tests + tsc + lint +
      build(17/17) green. **No schema change, no new server action** (reuses
      `channel_resources` + `shots.resource_id`). The resolver-*preference* for attached
      assets + the readiness gate that *enforce* this are Slice C.
    - **Slice C1 — visual briefs + editor + readiness gate (2026-06-22):** every shot now
      carries a structured, AI-authored, **operator-editable** `VisualBrief` (subject /
      action / setting / framing / mood / `specificity` (`generic|entity|abstract|
      spokesperson`) / `entity_name` / `recommended_source`), authored at **script time**.
      Migration `20260622120000_shot_visual_brief.sql` adds `shots.visual_brief jsonb` + a
      `generated` `shot_source` value (unused until Slice D) + rewrites
      `upsert_scene_with_shots` to persist the brief. Pure `parseVisualBrief`
      (`src/lib/videos/visual-brief.ts`) + `shotReadiness` (`src/lib/videos/shot-readiness.ts`).
      Script-gen emits the brief (camelCase AI output → snake_case stored shape converted in
      the single `sceneToRpcArgs` site). A collapsible **`ShotBriefEditor`** per shot
      (saved via `setShotVisualBrief`). The **readiness gate** blocks **Generate Video** when
      any shot is `specificity==='entity'` with no attached asset (fail-forward), with a
      per-shot "Accept anyway" override; Slice B's upload clears it, and Gate-2 vision QA
      stays the backstop. **The resolver/compose/render path is UNCHANGED** — the brief is
      additive; legacy shots (no brief) are never gated and render as before. 7 tasks
      subagent-driven, final Opus review READY TO MERGE; 354 tests + tsc + lint + build(17/17)
      green. The resolver *routing* on the brief (provider registry + fallback ladder) is
      **Slice C2** (next). **Operator nit:** a stray `version='verify'` row landed in
      `supabase_migrations.schema_migrations` during migration verification — harmless;
      `delete from supabase_migrations.schema_migrations where version='verify'` if any
      Supabase tooling complains.
  - **Caption emphasis revision (2026-06-16):** **kinetic text is now folded into the
    caption track — there is no longer a separate kinetic track.** The caption track
    builds word-by-word (DOAC-style) off the same `scenes.word_alignments` timing, and
    emphasis is a **three-axis annotation on the caption word** — `role` (→ typography,
    brand table), `tone` (→ color, brand table + new `positive`/`negative` theme tokens),
    `effect` (→ a gate-validated animation registry, AI-selected by word meaning).
    **`KineticText` is retired by deprecation** (prop schema set to `deprecated`, not
    removed, so in-flight specs don't hard-fail). **Superseded:** the old two-track
    caption/kinetic split, the `bounce`/`pop` closed enum, and `kinetic_text_usage` as a
    channel-level toggle. **Renamed:** `kinetic_text_usage` → `caption_emphasis_density`
    (`off`/`sparing`/`liberal`). Full design:
    `docs/superpowers/specs/2026-06-16-caption-emphasis-revision-design.md`.
  - **Phase 7 deferrals carried forward:** the **dynamic bundle** writes into the repo
    tree (`.primitive-cache/`, `remotion/primitives/db/`) — fine in dev, but **production
    bundling needs a writable workspace** (a build Lambda or a /tmp self-contained
    bundle); flagged in `bundle.ts`. Re-bundle **overwrites the single site** (`reelscript`)
    — **in-flight render pinning is deferred** (renders are quick + single-operator).
    The **compile gate = esbuild bundle-success** (not a full `tsc` type-check). The
    **code editor is a textarea** (no Monaco). Primitive drafting defaulted to **Opus**
    (now operator-routable — **`model_routing` shipped 2026-06-18**). The **studio UI's browser interaction pass** (watching
    auto-fix retry live) is the operator's manual review; the backend it drives is proven.
  - **Phase 6 deferrals carried forward:** ~~aspect-ratio / FPS / target-length
    controls~~ **shipped** — per-video on `VideoSettingsPanel`, and channel-level
    defaults (`channels.defaults` aspect/fps/target_length, inherited by new videos
    at creation) via the Phase-8 video-defaults slice (2026-06-18). **Thumbnail
    generation** is still Phase 8. Music selection is a **deterministic mood-match in code** (not an AI
    choice), and the **Music panel** now exposes all six mix params (volume, ducking
    depth, loop, in/out crop, fade) — **full panel shipped 2026-06-21**; Save
    dual-writes `renders.music_params` (immediate remux) + `videos.settings.music_params`
    (re-render inherits). Seed beds are **generated via the ElevenLabs Music
    API** (Pexels Audio discontinued); **reroll is reselection-only**, never
    regeneration. The remux Lambda is **invoked via the SDK (SigV4)**, not a public
    Function URL (the AWS account blocks public URLs); `remotion-user` carries a narrow
    `lambda:InvokeFunction` inline policy for it. Per-video caption/kinetic/music
    toggles come from **`video.settings` + channel defaults** (no settings UI until
    Phase 8). ~~**Kinetic duration is uncapped** — a long emphasis word suppresses
    captions for its span~~ — **superseded by the 2026-06-16 caption emphasis revision**
    (single caption track, no kinetic span / suppression machinery).
  - **Phase 3 deferrals carried forward:** ~~ElevenLabs key is an **env var**
    (`ELEVENLABS_API_KEY`), not `api_credentials` (Phase 8)~~ — **API credentials vault
    shipped 2026-06-21**: per-account encrypted keys for **anthropic/elevenlabs/pexels/
    pixabay** entered/validated on `/settings`, consumed by the pipeline with **env-var
    fallback** (an account with no stored key is byte-identical to today). App-layer
    **AES-256-GCM** (pure `src/lib/credentials/crypto.ts`), `store.ts` resolver/validators,
    `anthropic(apiKey?)` per-account across all 8 call sites. **Decrypted keys never enter
    Inngest step state** (resolved via plain awaits, never returned from a `step.run`).
    openai/google excluded (no consumer). **Operator gate:** set `CREDENTIALS_ENCRYPTION_KEY`
    (64 hex chars) in the deploy env before using stored keys — a `required()` getter that
    degrades safely if unset (save shows a friendly error; resolve falls back to env).
    Known V1 wart: a key marked `invalid` must be re-saved to re-test. ~~synthesis is
    fallback-only~~ — **emotion tags shipped 2026-06-21** (slice 1): the AI emits
    the 7-tag vocab sparingly and synthesis honors it via a **built-in model-aware
    profile** (`voice/profile.ts`; v2: strip + pause→SSML + scene-level
    `voice_settings` nudge; v3: inline audio tags). **The editable per-model
    `voice_profiles` table/UI shipped 2026-06-21 (slice 2)** — the built-in profile
    is now the *default mapping* of a general `applyStoredProfile` engine
    (`applyVoiceProfile` delegates to it, slice-1 behavior frozen by an equivalence
    test); synthesis loads the account's stored `tag_mappings` for the chosen model
    (account-scoped `upsert_voice_profile`/`delete_voice_profile` RPCs, `/settings`
    editor) and falls back to the default when no row exists. The slice-1 v3
    caption-leak limitation is resolved — `tokenizeSpokenWords` drops fully-bracketed
    `[audio-tag]` tokens. (`is_fallback` left unused; resolution is exact-model-row →
    code default.) The voice
    concurrency cap is a plain chunk of 5 (shared governor — Phase 9); seed uses a
    hardcoded default voice.
  - **Phase 5 deferrals carried forward:** the **channel-resource feature is now fully
    unlocked (both slices shipped 2026-06-21)**. Slice 1 — the **library UI**:
    create/upload (signed PUT + vision auto-tag)/edit/delete image+video resources on the
    channel page (pure `src/lib/resources/library.ts` + `resource-actions.ts` direct-RLS
    writes over `channel_resources`, reusing the Phase-5 `createResourceUpload`/
    `confirmResourceUpload`). Slice 2 — **placement + compose binding**: a per-shot
    resource picker in the video editor (`setShotResource` → `shots.source='resource'`),
    `SceneBrief.pinnedResources` surfaced to the **shared compose prompt** as a strong-pin
    directive that **both agentic and procedural** honor (`buildCompositionUserPrompt`);
    `loadBrief` populates the per-scene pins and `resolveResourceAssets` already merges the
    bytes (the prompt's `resource-<id>` == the manifest entry id, so Gate 1 passes).
    `confirmResourceUpload` still doesn't write a `resource_tagging` cost_event (deferred).
    The stock **search-result + file-bytes caches** are live; the full
    rate/concurrency **governor is Phase 9** (search uses a plain per-call count).
    Gate-2 has **no auto-fix loop** (Phase 7) — it surfaces the failing frame only.
  - **Phase 4 deferrals carried forward:** Captions / kinetic text / music + remux
    are Phase 6 (the attribution overlay shipped in Phase 5).
    ~~`model_routing` is Phase 8 (Sonnet pinned in code)~~ — **model routing shipped
    2026-06-18**: composition defaults to Sonnet but is operator-routable per task. The
    **cost ledger UI shipped 2026-06-21**: recorded `cost_events` are surfaced as a
    per-video lifetime total + per-render/per-operation breakdown on the video page and
    an account-level `/costs` rollup (pure `src/lib/costs/aggregate.ts` over RLS-scoped
    reads; the security-definer `video_costs`/`render_costs` views are bypassed). Figures
    are labeled **"Estimated"** — the **cost accounting itself is still Sonnet-pinned**
    (a non-Sonnet `video_composition` route bills at Sonnet rates) and a few ops
    (thumbnails) aren't metered yet; correcting the accounting is a separate item. The **render idempotency
    key is `hash(script_revision_id)`** (composition is non-deterministic), reused
    only for in-flight renders. The composition spec exists as a **durable
    key-based record** + an **ephemeral signed render-time copy** (sign at
    render-start, re-signable on re-render). **Lambda chunk concurrency is capped**
    via `framesPerLambda` (a stand-in for the Phase-9 governor — uncapped fan-out
    hits the AWS account "Rate Exceeded" limit). The **Phase-1 sample render** is
    kept behind the debug-only `render/sample` event.
  - **Phase 1 deferrals carried forward:** (1) the Remotion site is hosted on
    **S3**, not R2 — migrate the site bundle to R2 in Phase 7 (see
    `docs/.../deferred-remotion-site-r2`). (2) Lambda completion is handled by
    **polling** `getRenderProgress` (isolated in `waitForLambdaCompletion()`),
    not the wait-for-event webhook — swap to the spec-10.6 pattern when we
    deploy to Vercel.
- Before writing code for a phase, propose a short plan and the milestone, and
  flag any ambiguity in the docs. Build only to the current phase's milestone.
- Day-one, even in the thin slice (cheap now, ruinous to retrofit): RLS,
  `account_id` on every table, render idempotency keys, theme baking.
- Ask before introducing a dependency, library, or pattern not implied by the
  docs.
- Keep changes scoped. Prefer small, reviewable steps over large sweeps.

## How we progress

When a phase's milestone is met, update the **Current phase** line above, then
start the next phase with: "Plan Phase N first, then build to the milestone."
