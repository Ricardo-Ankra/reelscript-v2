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
  - **Reelscript V2 program — Higgsfield generative-video pipeline (started 2026-06-24):**
    a major overhaul driven by the operator's "Reelscript Higgsfield Build Spec v3.0",
    mapping the spec's principles onto the **existing TS stack** (NOT the spec's literal
    Python/agent-skills or Neon/Drizzle). **Locked program decisions:** runtime = existing
    Next.js + Supabase + **RLS** + Inngest + Remotion Lambda + R2 (refactor in place, don't
    replace); data = **keep Supabase+RLS**, map v3's "job"→existing account/channel-scoped
    **`video`**, keep the **`scenes`** table as the narrative grouping (= v3 `sceneId`),
    extend `shots` in place; shot model = **extend additively** (the existing readiness gate
    already encodes v3's authenticity test: `specificity==='entity'` must be a real asset).
    **Decomposed into sequential slices** (each its own spec→plan→build): **Slice 0**
    shot-model contract (done, below) → **1** Higgsfield generation spine (riskiest;
    keyframe-gen + native client + router + motion presets + durable Inngest poll +
    seed/continuity — this is the long-deferred asset-overhaul Slice D) → **2** live-action
    ingest (extend the existing ffmpeg/remux Lambda — a generic argv executor — with
    probe/conform/trim/reframe/keyframe+styleRef) → **3** assembly spine (`FinalTimeline`
    Remotion comp sequencing clips/footage/gfx + master LUT + match-grade + overlays +
    captions; VO-first audio — the deepest render-spine change, **needs a spike**) → **4**
    gates G1 (storyboard) + G2 (preview) in-app via Inngest `waitForEvent` → **5** provenance
    ledger + disclosure (`Disclosure` overlay + platform flag) → **6** master
    `reelscript.pipeline` orchestration. v3 source spec retained by the operator; design
    `docs/superpowers/specs/2026-06-24-v2-slice0-shot-model-contract-design.md`.
    - **Slice 0 — shot-model contract & beat classification (2026-06-24):** additive,
      **no rendering/resolution/readiness behavior change** — lays the contract later slices
      consume. New enum `shot_kind` (`generative|motion_graphic|live_action`) + columns
      `shots.{kind,camera_spec,lighting_spec,provenance,hero,needs_speech,broadcast_4k}`
      (migration `20260624120000_v2_shot_kind.sql`, backfills `kind` from `source`:
      procedural→motion_graphic, generated→generative, else live_action; `upsert_scene_with_shots`
      rewritten to persist them — a faithful superset, `visual_brief` byte-unchanged). Pure
      `src/lib/videos/cinematography.ts` (`CameraSpec`/`LightingSpec`/`Provenance` types +
      never-throw parsers, mirrors `visual-brief.ts`) + `classify-beat.ts` (`classifyBeat(
      specificity, recommendedSource)`: `entity`→`live_action` overrides all, else
      `primitive`→motion_graphic / `generate`→generative / `stock`|`upload`→live_action — an
      **auditable pure function of the brief, not an LLM choice**). Script-gen
      (`script-generation.ts`) now authors camelCase `camera`/`lighting` for generative-bound
      shots + `sceneToRpcArgs` derives `kind` + converts cinematography snake_case + attaches
      a provenance stub (`synthetic = kind==='generative'`). **`shot_kind` is distinct from
      `shot_source`** (kind = producing subsystem; source = acquisition path within a kind).
      Deferred to Slice 1 (intentional): `seed`/`entities`/continuity, generation-output
      columns (keyframe/styleRef/render keys, routed_model), and the AI emitting
      `source='generated'` (source↔kind coherence). 4 tasks subagent-driven, final Opus
      review READY TO MERGE; **374 tests + tsc + lint + build(17/17) green.** Plan:
      `docs/superpowers/plans/2026-06-24-v2-slice0-shot-model-contract.md`.
    - **Slice 1 — Higgsfield generation spine. Sub-decomposed 1a→1b; built behind a
      provider seam + fake** (no live external creds needed — real Higgsfield/image-model
      adapters drop in behind the seam when creds exist).
      - **Slice 1a — generation cores & provider seam (2026-06-24):** additive, behind-a-seam,
        **nothing wired into the pipeline yet** (1b does that). `src/lib/generation/provider.ts`
        — the seam (`ImageProvider.generateStill` fast/await; `VideoProvider.submitClip`+`checkClip`
        async submit/poll; `ClipStatus`=`pending|completed{mediaUrl}|failed{error}`; results are
        fetchable URLs that expire ~1h → stream to R2 now). `fake-provider.ts` — `createFakeProvider`
        (stateful in-memory double: per-requestId poll counts, pending×N→completed, `failNext()`) so
        1b proves the durable poll headlessly. Pure cores: `motion-presets.ts` (`MOTION_ID` —
        PLACEHOLDER `placeholder-<move>` ids, replace w/ live Higgsfield UUIDs before go-live;
        `resolveMotion`), `prompt.ts` (`buildClipPrompt` v3 §6), `router.ts` (`route(shot)→Engine`
        `'remotion'|'ingest'|`higgsfield.${string}``; hero-move→dop-preview, else
        needs_speech→veo-3.1>broadcast_4k→kling-3.0>hero→seedance-2.0>dop-preview). `r2.ts`
        +`streamUrlToR2`. Migration `20260624130000_v2_generation_contract.sql`:
        `shots.{keyframe_first_key,keyframe_last_key,clip_key,routed_model}` + `entities` table
        (account/video FK cascade, `unique(video_id,name)`, `seed`, RLS `acct_isolation`) — the
        locked-seed-per-entity continuity store (1a defines, 1b populates). Seam coherence verified
        end-to-end for 1b. 3 tasks subagent-driven, final Opus READY TO MERGE; **384 tests + tsc +
        lint + build green.** Deferred to 1b: keyframeGenerator/higgsfieldShot Inngest fns + durable
        poll, seed-assignment + reference-image carry, the drive script; real adapters land when
        creds exist; first/last-frame chaining defers past Slice 2 (needs ffmpeg). Spec/plan:
        `docs/superpowers/{specs,plans}/2026-06-24-v2-slice1a-generation-cores*`.
      - **Slice 1b — generation pipeline (2026-06-24). SHIPPED, merged to main, 391 tests +
        build(17/17) green, final Opus READY TO MERGE.** Wires 1a's seam into Inngest;
        **additive, fires only on an explicit `generation/run` event nothing sends yet**
        (Slice 6 wires it into the master pipeline). `src/lib/inngest/functions/generate-shots.ts`
        — `generateShots` (event `generation/run` `{videoId,accountId,jobId?}`, 2-arg `triggers:[…]`
        + `cancelOn` by jobId like the other job fns): loads the video's `kind='generative'` shots
        (via scene ids — shots have no `video_id`) **with `.is('clip_key',null)` so re-runs are
        idempotent**, then per shot runs `runGenerationSpine` **mirroring `render.ts`'s
        `runLambdaSpine`**: durable steps `keyframe-`/`submit-`/`poll-…-${attempt}`/`wait-…`/
        `finalize-${shot.id}` (all **namespaced by shot UUID** → no Inngest checkpoint collision).
        Flow: `buildStillPrompt`→`provider.generateStill`→`streamUrlToR2`→`shots.keyframe_first_key`;
        then `signedGetUrl(keyframe)`+`resolveMotion`+`buildClipPrompt`+`route`→`submitClip`→durable
        poll `checkClip` (failed→throw / completed→break / sleep 3s, MAX_POLLS 150, then timeout)→
        `streamUrlToR2`→`shots.clip_key`+`routed_model`+ the full **7-field `Provenance`**
        (`synthetic:true, source:`higgsfield:${model}`, model, seed, source_uri/created_at/operator:null`).
        Pure cores (Tasks 1–2): `generation/seed.ts` `videoSeed(videoId)` (FNV-1a **per-video** seed,
        all generative shots share it), `prompt.ts` += `buildStillPrompt` (= `buildClipPrompt` minus
        the camera-move clause — a still has no motion), `provider-factory.ts` `getGenerationProvider()`
        (**the sole provider source**, env-gated `GENERATION_PROVIDER` default `fake`; `higgsfield`/unknown
        throw; threads `GEN_FAKE_STILL_URL`/`GEN_FAKE_CLIP_URL` into the fake). 1a minor folded:
        `HERO_MOVES`→`readonly CameraMove[]`. `scripts/drive-generation.ts` (+ `npm run drive:generation
        -- <videoId>`) — **operator** headless proof against the fake with **`data:`-URL fixtures in
        `.env.local`** (the fn runs in the dev-server process, not the script's → fixtures must live in
        the dev-server env; documented in-file); never fabricates shots. **Continuity = per-video seed
        ONLY** — the `entities` table stays **unused** in 1b; per-entity seed-locking + reference-image
        carry + recurring-entity extraction defer to a later slice. `keyframe_last_key` never written
        (first/last chaining past Slice 2). Deferred: real Higgsfield/image adapters (behind the
        factory when creds exist), generation cost metering, assembly consumption of the clip (Slice 3).
        Spec/plan: `docs/superpowers/{specs,plans}/2026-06-24-v2-slice1b-generation-pipeline*`.
    - **Slice 2 — live-action ingest. Sub-decomposed 2a→2b** (the deployed-Lambda change is
      the de-riskable foundation). Conforms uploaded/resource live-action footage (probe →
      conform/trim/reframe → keyframe) so the assembly spine (Slice 3) sequences consistent
      clips. **Locked:** probe IS included (most future-proof — real source facts: duration,
      dims, rotation, audio); styleRef = extract+store only (defer wiring, no generative↔live
      link yet); uploaded/resource footage only (stock search/agentic loop untouched).
      - **Slice 2a — ingest foundation (2026-06-24). SHIPPED, merged to main, 403 tests +
        build(17/17) green, final Opus READY TO MERGE.** Additive; **nothing wired into the
        pipeline yet** (2b does that). The `lambda/music-remux` ffmpeg executor gains a
        `mode:'probe'` branch (downloads one input, runs `ffprobe -v error -print_format json
        -show_streams -show_format`, returns `{ok,probe}`) + `ffprobe` in the Dockerfile —
        **the default ffmpeg re-mux path is byte-unchanged** (probe returns before the `args`
        guard; `runCapture` captures stdout vs `run`'s inherit). `invokeProbe(inputUrl)` in
        `src/lib/music/remux-invoke.ts` (same Lambda, same secret/client — **one Lambda, two
        modes**). Pure cores: `src/lib/ingest/probe.ts` `parseProbe` (never-throws ffprobe-JSON
        → `ProbeResult{width,height,durationSec,fps,hasAudio,rotation}`, `Array.isArray`-guarded;
        defines `RawProbe`/`ProbeResult` so the server client imports `RawProbe` as a **type** —
        pure←server dep direction) + `src/lib/ingest/ffmpeg.ts` `buildConformArgs` (cover
        `scale=…:force_original_aspect_ratio=increase,crop=W:H,fps`, **target-dims-only — no
        source-dim arithmetic**, **no `-noautorotate`** (rotation = ffmpeg default autorotate;
        `probe.rotation` is metadata, NOT re-applied → no double-rotate), h264/yuv420p + aac|`-an`,
        `-t` only when `durationSec>0`, `+faststart`) + `buildKeyframeArgs` (`-ss` before `-i`,
        `-frames:v 1` PNG). `scripts/smoke-probe.ts` (+ `npm run smoke:probe -- <r2-key>`) —
        **operator** verification. **Operator gate before 2b:** redeploy the Lambda
        (`node scripts/deploy-music-lambda.mjs`, needs Docker+AWS CLI) then `npm run smoke:probe`.
        Deferred to 2b: `ingestShots` Inngest fn, `shots.footage_key` migration, styleRef-frame
        storage, drive script. Spec/plan:
        `docs/superpowers/{specs,plans}/2026-06-24-v2-slice2a-ingest-foundation*`.
      - **Slice 2b — ingest pipeline (2026-06-24). SHIPPED on branch, 408 tests +
        build(17/17) green.** Wires 2a's cores into Inngest; **additive, fires only on an
        explicit `ingest/run` event nothing sends yet** (Slice 6 wires it). The **2a operator
        gate is now DONE** — the probe Lambda was redeployed (build→ECR push→`deploy-music-lambda.mjs`)
        and `smoke:probe` is green (a real render MP4 → `{1080×1920,5.08s,30fps,audio,rot0}`);
        the redeploy needed temporary **AdministratorAccess on `remotion-user`** (the only AWS
        profile = that least-priv render user; no permissions boundary) then detach. Migration
        `20260624140000_v2_ingest_contract.sql` adds `shots.{footage_key,style_ref_key}` (nullable
        text, pipeline outputs — no RPC change). `src/lib/inngest/functions/ingest-shots.ts` —
        `ingestShots` **mirrors `generateShots`** (2-arg `createFunction` + `triggers:[{event:'ingest/run'}]`
        + `cancelOn` by jobId, `retries:2`): loads `kind='live_action' AND source='resource' AND
        resource_id NOT NULL AND footage_key IS NULL` shots **via scene ids** (shots have no
        `video_id`; `.is('footage_key',null)` → **idempotent re-runs**), then per shot a durable
        spine **namespaced by shot UUID**: `resolve-` (`channel_resources.{r2_key,kind}`,
        account-scoped, throws on missing) → **video branch** `probe-` (signedGetUrl→`invokeProbe`→
        `parseProbe`) → `conform-` (signed GET in + signed PUT out, `buildConformArgs(target,probe,
        durationSec=shot.duration_seconds)`, `invokeRemux` → write `footage_key`) → `keyframe-`
        (`buildKeyframeArgs` at `styleRefAt(duration)` on the conformed clip → write `style_ref_key`)
        | **image branch** (operator chose "also reframe images") single `conform-image-`
        (`buildImageConformArgs` reframe → write **both** `footage_key` + `style_ref_key` = the
        conformed still IS its own styleRef). **Per-step DB writes** (not a final finalize) so a
        mid-shot failure resumes without re-conforming. New pure cores (Task 2, TDD):
        `buildImageConformArgs` (cover scale+crop, `-frames:v 1`, no video-only flags, target-dims-only)
        + `styleRefAt(dur)=min(0.5,dur/2)` else 0 (representative frame, avoids fade-in, no probe).
        Registered in `src/app/api/inngest/route.ts`. `scripts/drive-ingest.ts` (+ `npm run
        drive:ingest -- <videoId>`) — **operator** proof against the REAL Lambda (no fake seam like
        generation; needs a video with ≥1 resource-pinned live-action shot; never fabricates shots).
        **styleRef = store only** (no generation wiring — mirrors 1b's unused-`entities` deferral).
        `ingestShots` itself has NO unit test (like `generateShots` — gate+drive verified; pure cores
        ARE tested). Deferred: styleRef→generation wiring, stock-sourced conform, assembly consumption
        (Slice 3). 5 tasks subagent-driven. Spec/plan:
        `docs/superpowers/{specs,plans}/2026-06-24-v2-slice2b-ingest-pipeline*`.
    - **Slice 3 — assembly spine (`FinalTimeline`). Spiked + sub-decomposed 3a→3b.**
      A spike confirmed the two pillars: **(1) assembly** — Remotion `<OffthreadVideo src
      trimBefore trimAfter playbackRate/>` in `<Sequence>` sequences/trims **external MP4s**
      frame-accurately (4.0.472), Lambda-rendered, coexisting with the primitive/scene model;
      **(2) color** — Remotion's bundled ffmpeg is minimal (no lavfi), so master-LUT/match-grade
      run as an **ffmpeg post-pass on the dedicated Lambda** (johnvansickle static — `lut3d`/`eq`/
      `colorbalance`), reusing Slice 2's executor + the music-re-mux post-pass pattern. So 3 =
      **3a assembly skeleton** (sequence clips/footage as segments) → **3b color** (LUT + match-grade
      post-pass). Overlays/captions ride composition-wide unchanged.
      - **Slice 3a — assembly skeleton (2026-06-24). SHIPPED on branch, 417 tests + build(17/17)
        green.** Additive; **consumes** the keys 1b/2b write — no migration, no AI for clip/footage
        shots, legacy videos byte-identical. **Locked:** scene-driven (shots partition the scene's
        VO frames proportionally to `duration_seconds`, tiling exactly); generative/live-action shots
        **bypass compose** (placed deterministically); **VO-fit = trim-long / freeze-hold-short**;
        **A-lite** mixed scenes (a `clip_key`/`footage_key` shot is dropped from compose hints +
        `needsStock` and rendered full-frame over its sub-range, occluding primitives there).
        `CompositionScene.segments?: ShotSegment[]` (`spec.ts`) = `{shotId,from,durationInFrames,
        assetId,fit,sourceDurationInFrames}`. Pure `src/lib/composition/assembly.ts` (TDD):
        `partitionSceneFrames` (floor-shares, remainder-to-last, equal-split on zero weights),
        `fitForSegment` (native≥allotted→trim), `segmentAssetId`→`seg-<shotId>`, `buildSegmentAssets`
        (keys→`kind:'video'` manifest entries). `assembleSpec` carries `segments` onto the scene
        (conditional spread, legacy byte-identical — the single agentic+procedural assembly point).
        `loadBrief` reads `kind/clip_key/footage_key/duration_seconds`, partitions ALL shots, emits
        segments + assets, excludes assembly shots from hints/`needsStock` (`sourceDurationInFrames =
        max(round(duration_seconds*fps),1)`). `ReelComposition` renders segments as full-frame muted
        `OffthreadVideo` above primitives (`SEGMENT_LAYER=10000`; `fit:'trim'`→`trimAfter`,
        `fit:'freeze'`→play then `<Freeze frame={max(0,sourceDur-1)}>`; null-url guard); captions/
        attribution overlays untouched. **Deferred:** color/LUT/match-grade (3b), sub-range-confined
        primitive composition (clips occlude), generative-clip duration probing (uses planned
        `duration_seconds`), first/last-frame chaining. Verified by gates + the existing `drive:render`
        operator path (Remotion render not unit-tested). 6 tasks subagent-driven. Spec/plan:
        `docs/superpowers/{specs,plans}/2026-06-24-v2-slice3a-assembly-skeleton*`.
      - **Slice 3b — color (master look) (2026-06-25). SHIPPED, merged to main (merge `498f9d8`),
        430 tests + tsc/lint/build(17/17) green, final Opus review READY TO MERGE.** Additive,
        **no migration**; adds a subtle, per-channel-selectable master color grade applied to every
        render as a **best-effort ffmpeg `-vf` post-pass** between the voiceover base MP4 and the
        music re-mux — reusing the same `invokeRemux` ffmpeg-Lambda + base/final pattern as the
        music remux. **Locked:** master-look only (per-shot match-grade deferred); mechanism =
        **code-defined ffmpeg filter presets** (`eq`/`colorbalance`, **space-free/argv-safe**, NO
        `curves`/`lut3d` this slice — `lut3d`/.cube is a clean future upgrade, same step + a 2nd
        input); subtle by design; per-channel default `neutral` (zero-config), overridable per video;
        **degrade-on-failure** (grade pass fails → render uses the ungraded base, logged). New pure
        `src/lib/color/looks.ts` (TDD): `ColorLook = none|neutral|warm|cool|punch`, `COLOR_LOOKS`,
        `DEFAULT_COLOR_LOOK`, `LOOK_LABELS`, `buildGradeFilter(look)→string|null` (null for
        `none`/unknown → caller skips → byte-identical), `buildGradeArgs({inPath,outPath,filter})`
        (libx264/yuv420p, **`-c:a copy`** — base is VO-only, `+faststart`). `color_look` joins the
        `VideoSettings` contract (`settings.ts`, **relative import of looks** for node:test) so it
        **inherits the channel-default ⊕ per-video-override machinery via `create-settings.ts` with
        no change there** (DRY). `render.ts` inserts a durable `resolve-color-look` step
        (`videos.settings`→`parseVideoSettings`) + a best-effort `grade-base` step (try/catch returns
        the ungraded `baseKey`, never rethrows; on success writes `renders/<id>.graded.mp4` +
        updates `base_output_r2_key` to the graded key **before** best-effort `deleteObject(baseKey)`,
        threads `effectiveBaseKey` to the no-music `finalize`; music branch UNCHANGED — re-mux reads
        the now-graded `base_output_r2_key`). UI: a **Look `<select>`** on the channel `BrandEditor`
        (→ `channels.defaults.color_look` via `brand.ts` validate/parse, **relative looks import**)
        + the per-video `VideoSettingsPanel` (autosaves `{color_look}` through the existing action).
        Final Opus verified all 4 {grade succeeds/degrades}×{music on/off} combos leave
        `output_r2_key` on a real object (no deleted-object window). **Behavioral note:** default
        `neutral` is a REAL subtle grade, so existing videos re-rendered after 3b get it (intended
        brand-consistency default; only explicit `none` is byte-identical). **Caught regression
        (fixed, commit `7152e9f`):** adding `color_look` broke 2 `create-settings.test` full-shape
        deepEqual assertions → added `color_look:'neutral'` to the expected literals (LESSON: run
        FULL `npm test`, not a `--test-name-pattern` subset, when changing a shared contract).
        **Deferred:** per-shot match-grade, operator-uploaded LUTs, `lut3d`/.cube looks, per-segment
        grading. **Operator follow-up:** `drive:render` eyeball of a non-`none` look (ffmpeg-Lambda
        I/O is the only untested surface, by design, like remux); note a transient settings-read
        failure biases toward grade-with-`neutral` rather than skip. 5 tasks subagent-driven.
        Spec/plan: `docs/superpowers/{specs,plans}/2026-06-25-v2-slice3b-color-look*`.
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
    - **Slice C2 — brief-driven composition (2026-06-22):** the composition AI now receives
      each shot's structured `VisualBrief` instead of the terse `description`. Pure
      `formatShotHint(brief, description)` (`src/lib/composition/compose.ts`) renders an
      enriched hint (subject/action/setting + framing/mood qualifiers) plus, for
      `specificity==='entity'`, an explicit directive — "SPECIFIC ENTITY (…): use the
      pinned/uploaded asset if present; do not substitute generic stock." `loadBrief`
      (`render.ts`) builds each scene's `shotHints` via
      `formatShotHint(parseVisualBrief(sh.visual_brief), sh.description)`. **The
      provider-registry from the design was DROPPED as YAGNI** — resolution is already three
      separated paths in `render.ts` (pins → `resolveResourceAssets`; stock → the agentic
      vision loop; procedural → primitives), the agentic loop is the router, and Slice B+C1
      already deliver "prefer the attached asset." So C2 = brief-driven, entity-aware
      composition (better stock queries, no stock substitution for named entities), a 2-task
      low-risk change; the compose-prompt structure, agentic/procedural loops, Gates, pins,
      `needsStock`, and the render path are all unchanged — only the hint *content* is
      richer. Back-compat: a null/empty brief → the description verbatim (unbriefed videos
      compose byte-identically). No schema change. Final Opus review READY TO MERGE; 359
      tests + tsc + lint + build(17/17) green. **The asset-model overhaul program is now
      A+B+C1+C2 shipped; only Slice D (generation providers — Heygen/Higgsfield/text-to-image,
      a new generate path in `render.ts` alongside the existing three) remains, deferred.**
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
    generation was built then scrapped (2026-06-24) — cancelled, not planned; the
    operator designs thumbnails externally.** Music selection is a **deterministic mood-match in code** (not an AI
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
    (a non-Sonnet `video_composition` route bills at Sonnet rates); correcting the
    accounting is a separate item. The **render idempotency
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
