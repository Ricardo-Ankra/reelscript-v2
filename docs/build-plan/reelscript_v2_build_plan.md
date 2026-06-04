# Reelscript V2 — Build Sequencing Plan

This is the order to build Reelscript V2 so that the riskiest infrastructure is proven first and each phase ends in something you can run and see. It assumes the design spec (rev 8) and the three scaffolding artifacts already produced: the database schema, the primitive contract, and the API surface.

## Principles

**Walking skeleton first.** Build one thin vertical slice — prompt to a rendered video on screen — before building breadth. A narrow path that works end-to-end de-risks the whole architecture; a wide set of half-features that don't connect does not.

**De-risk the unknowns early.** The least proven, most failure-prone piece is the render pipeline: a composition spec becoming an MP4 on Remotion Lambda, with fonts, assets, and R2 all lining up. That gets built and proven in Phase 1, before any AI is involved, using a hand-written spec.

**Cheap-now-expensive-later things are day one, even in the skeleton.** A few decisions are painful to retrofit, so they go in from the first commit regardless of how thin the slice is: RLS and `account_id` on every table, render idempotency keys, and theme baking (each render self-contained). The spec's own reasoning applies — these cost almost nothing up front and a fortune later.

**Defer breadth and sophistication.** Full settings screens, the primitive authoring studio, agentic asset selection, and the full resilience layer all wait until the spine works. They are layered on in a deliberate order, each on top of something already proven.

**Every phase is demonstrable.** Each ends in a concrete milestone you can show, not an abstract "component done."

## The critical path to a first video

The thin slice that proves the product is: **a channel exists → a prompt becomes a script → the script becomes voiceover → composition turns it into a spec → Lambda renders it → the MP4 plays in the app.** Phases 0–4 build exactly that and nothing more. Everything after Phase 4 is enrichment.

---

## Phase 0 — Foundations

**Goal:** the empty app stands up, authenticated, with the database and its isolation in place.

**Build:** the repo and Next.js app on Vercel; the Supabase project with the schema applied; Supabase Auth (email/password + Google) with one account that can sign in; the R2 bucket; the Inngest connection; the AWS account for Remotion Lambda. Wire `account_id` and RLS from the first migration.

**Stub / defer:** every feature screen. This phase is plumbing.

**Milestone:** you can sign in, the app shell loads, and a quick check confirms RLS — a second account cannot read the first's rows.

**Risk addressed:** auth/RLS integration (the gap that drove the Supabase decision) is settled before anything is built on top of it.

---

## Phase 1 — The render spine

**Goal:** prove the render pipeline with the simplest possible input and no AI.

**Build:** a Remotion project containing three starter primitives (Text, Shape, FullBleed) following the primitive contract; bundle and deploy the Remotion site to R2. Write a composition spec by hand (JSON, with a baked theme snapshot). Stand up the Inngest render function: a `render/start` event invokes Remotion Lambda with the spec by R2 pointer, waits on the Lambda-completion webhook, writes the MP4 to R2, and updates the render row. Play the result from a signed URL in the app.

**Stub / defer:** all AI, voice, stock, the other primitives, music, captions.

**Milestone — the most important in the plan:** a hand-written spec renders a brand-styled MP4 on Lambda and plays in the browser. The riskiest infrastructure now works end-to-end.

**Risk addressed:** Lambda rendering, font registration before first frame, the empty-render-environment asset model, the by-pointer spec, the wait-for-event pattern, and idempotency keys — all proven on a trivial input rather than discovered late under a full composition.

---

## Phase 2 — Script and scenes

**Goal:** a prompt becomes an editable script.

**Build:** seed one channel with minimum brand (name, primary colour, font, voice) — seeded, not a settings UI yet. Prompt input → script generation (Opus) writing scenes and shots to the database and streaming into the editor over Realtime. A basic scene editor with debounced autosave; scenes are the source of truth, the script panel a stitched view.

**Stub / defer:** the full channel settings UI (the seed is enough); voice, composition, render still disconnected.

**Milestone:** type a prompt, watch the script stream in, edit a scene, see it persist.

---

## Phase 3 — Voice synthesis

**Goal:** scenes get voiceover.

**Build:** the ElevenLabs integration and the deliberate Phase-4-of-the-workflow synthesis trigger; per-scene synthesis writing audio to R2; the `audio_status` lifecycle with the staleness flip on edit; at minimum the fallback voice profile and the fixed emotion-tag vocabulary mapping. Per-scene status flips live over Realtime.

**Stub / defer:** the full voice-profiles UI and per-model profiles (the fallback covers the slice); the concurrency governor can be a simple cap for now.

**Milestone:** synthesize voiceover for the scenes and play each scene's audio; editing a scene flips it to stale.

---

## Phase 4 — Composition, and the slice closes

**Goal:** connect the AI front end to the render spine — the first fully automatic video.

**Build:** the composition AI (Sonnet, thinking-enabled) turning scenes + brand + the starter primitives into a composition spec, consuming the Phase 3 voice timings. Gate 1 (spec validation via the prop-schema validator from the contract) with its bounded AI retry. Feed the spec into the Phase 1 render spine.

**Stub / defer:** stock assets (compose from Text/Shape/FullBleed only for now — proves the path without needing Pexels); Gate 2; captions; kinetic text; music.

**Milestone — the thin end-to-end slice is complete:** a prompt produces a rendered MP4 with voiceover, entirely through the system. Everything from here is enrichment on a working spine.

---

## Phase 5 — Asset richness

**Goal:** videos use real, well-chosen media.

**Build:** Pexels/Pixabay integration; agentic asset selection with vision (scoped to stock-needing shots without a strong resource match); channel resource upload (signed R2 URL) and the fast synchronous tag; Gate 2 (smoke frame + vision QA); graceful degradation when stock keys are absent; the search-result and file-bytes caches.

**Milestone:** videos pull real footage and images the AI chose by looking at candidates, and a channel with no stock keys still produces a complete graphic/typographic video.

---

## Phase 6 — Creative polish

**Goal:** videos look produced.

**Build:** captions (burnt-in + sidecars); kinetic text frame-aligned to voice timings; opt-in background music with the seeded library and the ffmpeg-Lambda re-mux path; aspect-ratio / FPS / target-length controls; thumbnail generation. Expand the starter primitive set as gaps appear.

**Milestone:** a video ships with captions, kinetic emphasis, and a music bed, and music changes re-mux in seconds without re-rendering.

---

## Phase 7 — The primitive authoring studio

**Goal:** the library becomes extensible from the frontend.

**Build:** the three-pane studio (AI draft chat with the primitive skill, code editor, preview + gates); the four authoring gates with lint static and compile/smoke/brand on isolated Lambda; the brand stress kit; the bounded auto-fix loop; the prop-schema lifecycle (active/deprecated/removed) with the evolution guard; site re-bundle on save; the primitive lifecycle (archive/delete with usage gating).

**Why here:** the studio is only meaningful once composition and rendering work and you can see which primitives you actually reach for. Built earlier, it would be a studio with no pipeline to validate its output against.

**Milestone:** author a new primitive by describing it, watch it pass the gates, and have the composition AI use it in the next video.

---

## Phase 8 — Full surfaces

**Goal:** the app is self-serve; no seeding or hardcoding remains.

**Build:** the complete channel settings (visual identity, brand voice, resources, show structures, thumbnail templates); account settings (credentials, model routing, the voice-profiles UI with live ElevenLabs model fetch, primitive library management); projects organization; versioning and history UI; the cost ledger surfaced as per-render and per-video lifetime totals.

**Milestone:** a video can be created and shipped end-to-end through the UI alone, against a channel and account the user configured themselves.

---

## Phase 9 — Resilience and operations

**Goal:** production-ready — fails gracefully, observable, onboards a stranger.

**Build:** the full failure taxonomy behaviours; hardened per-phase resumability checkpoints; the per-provider rate/concurrency governor; observability (structured logging, error tracking with job context, the recent-failures surface); the social-draft export and downloads; the first-run guided setup with starter-primitive and music seeds; the monthly cost-alert.

**Note:** lightweight forms of some of this were threaded in earlier (idempotency keys from Phase 1, a simple ElevenLabs cap from Phase 3, basic error surfacing throughout). Phase 9 is where they become the full, deliberate treatment from spec section 15 — not their first appearance.

**Milestone:** a provider outage degrades cleanly instead of losing work; a fresh sign-up reaches a first rendered video through guided setup.

---

## What this ordering buys you

The first four phases prove every hard assumption — auth/RLS, the Lambda render pipeline, AI script generation, voice timing, and composition — on the thinnest possible path, so any architectural surprise surfaces in week N, not month N+3. Enrichment (assets, polish), extensibility (the studio), breadth (settings), and hardening (resilience) then each land on a foundation that already works, in an order where nothing is built before the thing it depends on exists. The day-one decisions (RLS, idempotency, theme baking) are the few exceptions deliberately pulled forward because they are cheap now and ruinous to retrofit.
