# Reelscript V2 — Deferred-Backlog Roadmap (Slices 7–13) — Design

> **Program-level decomposition, not a single buildable spec.** The V2 Higgsfield
> program shipped its core through Slice 6 (Slices 0,1,2,3,4,6; Slice 5 dropped). This
> document sequences **all remaining deferred work** into dependency-ordered slices 7–13.
> Each slice gets its **own** spec → plan → subagent build, exactly as Slices 0–6 did —
> this roadmap defines the order and the contents, not the implementation.

## 0. Context & the two decisions that set the order

The generative pipeline is **built end-to-end and merged**, but it is **not yet real**: generation
runs against a **fake provider** (`fake-provider.ts`) with **placeholder motion UUIDs**
(`placeholder-*`) and a **placeholder cost rate** (`GEN_RATE_USD = 0.5`). So the backlog sorts into
three buckets — **make it real**, **make it better**, **make it correct** — plus niceties.

Two operator decisions set the sequence:

1. **Vercel deployment is imminent and a priority.** → A production-readiness slice leads (Slice 7),
   ahead of making generation real. Rationale: validate the whole deploy environment (Vercel +
   Inngest Cloud + Lambda + R2 + bundling) **cheaply against the fake provider first**, so real API
   spend only ever happens on a proven platform.
2. **Real Higgsfield + image-model credentials are available now.** → Real generation is unblocked
   and is the critical path immediately after the deploy is stable (Slice 8). Cost-accounting
   correctness (E1) is **brought forward** to ride with it, so the first real spend is billed right.

**Ordering principle:** make-it-real (deploy → real generation) → make-it-better (continuity,
assembly depth, automation) → make-it-correct (production correctness & scale) → niceties.
Considered and rejected: *risk-first* (harden everything before turning on spend — delays all value
for hardening a single-operator setup doesn't need yet) and *value-density interleave* (fragments
the riskiest work).

## 1. The complete deferred inventory (source of truth for the slices)

Item IDs are referenced by the slices in §2. Status: **OPEN** unless noted. Two items are closed:
**G4 thumbnails** — *cancelled* by operator (designs them externally; do not rebuild). **F1, F5** —
operator gates *already run green*.

**A) Generation realness**
- **A1** Real Higgsfield text-to-video adapter (replaces fake; behind `getGenerationProvider()`).
- **A2** Real image-still (text-to-image) adapter (keyframe generation).
- **A3** Real motion-preset UUIDs replacing `placeholder-*` in `motion-presets.ts` (`MOTION_ID`).
- **A4** Real generation cost metering — `generateShots` records a real `cost_event`; retires the
  `GEN_RATE_USD = 0.5` placeholder the Slice 6b budget guardrail depends on.
- **A5** Runtime model-fallback chain (preferred model unavailable → fallback) in `router.ts`.

**B) Assembly / render depth**
- **B1** First/last-frame chaining — last frame of clip N seeds keyframe of clip N+1
  (`keyframe_last_key` is written nowhere today).
- **B2** Per-shot match-grade / per-segment color (Slice 3b ships master-look only).
- **B3** Operator-uploaded LUTs (.cube) + ffmpeg `lut3d` (3b uses `eq`/`colorbalance` only).
- **B4** Sub-range-confined primitive composition (mixed clip+primitive scenes — primitives
  currently span the whole scene and clips occlude them).
- **B5** Real generative-clip duration probing (3a uses planned `duration_seconds`, not the actual
  clip length).
- **B6** Stock-sourced conform (2b conforms uploaded/resource footage only).

**C) Pipeline completeness & automation**
- **C1** Auto-revise loop on gate reject (today: terminate, recoverable by edit + re-trigger).
- **C2** Auto-voice synthesis inside the pipeline (entry is post-voice today).
- **C3** Full prompt→video (collapse the manual script-gen + voice steps).
- **C4** Inngest job retry for failed/queued runs (manual video retry exists; step-level retry not).
- **C5** Per-entity seed-locking + recurring-entity extraction (the `entities` table is built but
  unused; today a single per-video seed).
- **C6** Per-entity reference-image carry (first keyframe of an entity references later occurrences).
- **C7** StyleRef→generation wiring (2b stores `style_ref_key` from live-action; not fed to a
  generative sibling yet).
- **C8** Resource-tagging cost event in `confirmResourceUpload` (not written today).

**D) Infrastructure & production hardening**
- **D1** Production bundling workspace — the primitive bundler writes the repo tree
  (`.primitive-cache/`, `remotion/primitives/db/`); read-only on Vercel → must move to a writable
  workspace (build Lambda or `/tmp` self-contained bundle). **Hard Vercel blocker given production
  primitive authoring is intended.**
- **D2** In-flight render pinning — re-bundle overwrites the single `reelscript` site; pin each
  render to the bundle version it started with.
- **D3** Remotion site migration S3 → R2.
- **D4** Lambda completion: polling `getRenderProgress` → `waitForEvent` webhook (Phase-1 item
  explicitly tagged "when we deploy to Vercel").
- **D5** Concurrency governor (Phase 9) — shared rate/concurrency cap (voice chunk-of-5, stock
  per-call, generation) → centralized.
- **D6** `CREDENTIALS_ENCRYPTION_KEY` (+ all secrets) set in the Vercel deploy env.

**E) Cost-accounting accuracy**
- **E1** Bill the actually-routed composition model (today Sonnet-pinned `SONNET_USD_PER_1M_*` in
  `render.ts`; a non-Sonnet route bills wrong).
- **E2** Per-model price table (rates hardcoded; table-driven, optionally per-account).

**F) Operator-runtime verification gates** (manual, untested-by-design; run as the prerequisite
slice ships — these are checkpoints, **not build slices**)
- **F2** `drive:generation` (fake → real after Slice 8). **F3** `drive:ingest` (real Lambda).
  **F4** `drive:render` assembled mixed-media eyeball. **F6** Slice 4 G2 suspend/resume matrix.
  **F7** `drive:pipeline` step.invoke + cancel cascade. **F8** `drive:pipeline` budget block.
  (F1 Slice-2a probe redeploy, F5 Slice-3b color — already green.)

**G) Niceties / reconciliation**
- **G1** Monaco editor (primitive studio uses a `<textarea>`). **G2** Full `tsc` compile gate (today
  esbuild-bundle-success only). **G3** Voice-seed model routing (hardcoded default voice).
- **G5** Asset-overhaul "Slice D" (a `generate` path in `render.ts`) — **likely SUPERSEDED** by the
  V2 architecture (generation is its own `generateShots` function keyed on `shot_kind`, not a
  resolution ladder in `render.ts`). **Action: confirm & close as superseded, don't build.**

## 2. The slice sequence

Each slice below is a **placeholder for its own future brainstorm → spec → plan → build**. The
"Contains" lists are scope, not implementation; the "Milestone" is the done-signal; "Gates" are the
operator verifications folded in.

### Slice 7 — Production deploy readiness (Vercel + Inngest Cloud) — **sub-decomposed 7a→7b**
**Why first:** Vercel is imminent; prove the platform on the fake before real spend.

- **7a — Deploy spine.** Inngest **Cloud** (signing/event keys, the production serve route, off the
  drift-prone local dev server); full **env/secrets inventory on Vercel** (R2, AWS Lambda, Supabase,
  Anthropic/ElevenLabs/Pexels/Pixabay, Inngest keys, `CREDENTIALS_ENCRYPTION_KEY`, and the new
  Higgsfield/image keys); **polling → `waitForEvent` webhook** for Lambda completion (D4). *Items:
  D4, D6 + the implied Inngest-Cloud/Vercel-env work. Validated end-to-end with the **fake**
  generation provider — no real spend.*
- **7b — Production primitive bundling.** Move the esbuild bundle + `deploySite` **off the repo
  filesystem** into a **build Lambda** (invoked by the `deployPrimitive` Inngest function via SDK
  SigV4, mirroring the render/remux Lambdas — "fast work on Vercel, slow work on Lambda"), so
  operators can **author primitives live in production** (the Phase-7 studio's intended behavior).
  The esbuild compile gate + smoke/brand-stress render gates ride in/alongside it. Revisit **render
  pinning (D2)** here — production now re-bundles on demand, so pinning matters more. *Items: D1, D2.*

**Milestone:** the app runs on Vercel with Inngest in production; a full fake-provider pipeline
completes there; an operator authors a new primitive from the deployed frontend and it bundles +
becomes placeable — no repo-tree writes. **Gates: F6, F7, F8 re-run against the real deploy.**

### Slice 8 — Real generation — **critical path; sub-decomposes at its own brainstorm**
Swap the fake for real adapters behind `getGenerationProvider()`: real **image-still** (keyframe) +
**Higgsfield video** (submit/poll) adapters, real **motion-preset UUIDs**, runtime **model-fallback**
chain, and **real cost metering** wired into `generateShots`. **Brought forward: E1** (bill the
actually-routed model) so the first real spend — generation *and* composition — is accounted
correctly; this also makes the Slice 6b budget guardrail honest (real rate, not `0.5`). *Items: A1,
A2, A3, A4, A5, E1.*

**Milestone:** `drive:generation` produces a real keyframe + clip in R2; `drive:pipeline` yields a
real assembled, graded video; budget guardrail blocks on true projected cost. **Gates: F2 (now
real), F3, F4.**

### Slice 9 — Generation continuity
Per-entity **seed-locking + recurring-entity extraction** (lights up the `entities` table) +
**reference-image carry**; **first/last-frame chaining** (writes `keyframe_last_key`);
**styleRef→generation wiring** (live-action informs a generative sibling). *Items: C5, C6, B1, C7.*
**Milestone:** a recurring character/location stays visually consistent across its shots; adjacent
generative clips flow frame-to-frame.

### Slice 10 — Assembly depth
Real **clip-duration probing** (planned≠actual now matters with real clips); **sub-range-confined
primitive composition** for mixed scenes; **stock-sourced conform**; **per-shot match-grade**;
**operator-uploaded LUTs** (.cube / `lut3d`). *Items: B5, B4, B6, B2, B3.* **Milestone:** mixed
clip+primitive scenes layer correctly; grading can vary per shot.

### Slice 11 — Pipeline automation
**Auto-voice** + **full prompt→video** (collapse the manual script-gen/voice steps into the
pipeline); **auto-revise loop** on gate reject; **Inngest job retry**. *Items: C2, C3, C1, C4.*
**Milestone:** a single prompt → finished video with the optional human gates and far fewer manual
steps.

### Slice 12 — Production correctness & scale
**Per-model price table** (E2, completes E1); **S3→R2 site migration** (D3); **concurrency governor**
(D5); **in-flight render pinning** (D2, if not already pulled into 7b); **resource-tagging cost
event** (C8). *Items: E2, D3, D5, D2, C8.* **Milestone:** accurate per-model billing; consolidated
storage; bounded concurrency under production load.

### Slice 13 — Niceties
**Monaco editor** (G1); **full `tsc` compile gate** (G2); **voice-seed model routing** (G3).
*Low priority; pick up opportunistically.*

### Reconciliation (not a slice)
**Close G5** (asset-overhaul Slice D) as **superseded** by the V2 generation architecture after a
quick confirmation — do not build a `render.ts` generate path.

## 3. Dependency notes

- **7 → 8:** deploy stable (fake-validated) before real spend.
- **8 → 9, 10:** continuity and assembly depth are only meaningfully verifiable against **real**
  generated frames/clips (e.g. B5 duration probing, B1 frame chaining, C5/C6 entity consistency).
- **8 brings E1 forward; 12 completes it (E2).**
- **7b unblocks production primitive authoring;** D2 (pinning) is pulled into 7b because production
  re-bundles on demand. If 7b defers D2, Slice 12 picks it up.
- **F-gates** are checkpoints attached to their slice, not standalone work.

## 4. Out of scope / explicitly not doing

- **G4 thumbnails** — cancelled by operator; do not rebuild.
- **G5** — close as superseded, do not build.
- No new features beyond this inventory; the roadmap drains the deferred backlog, it does not expand
  it.

## 5. How this roadmap is executed

This document is the **map**. Execution proceeds **one slice at a time**, each through the full
program discipline: its own brainstorm (spec) → writing-plans (plan) → subagent-driven build (fresh
implementer + task review per task, final whole-branch review) → finishing-the-branch → merge →
push → update CLAUDE.md + memory. The **next action** after this roadmap is approved is to **begin
Slice 7a's own brainstorm** — not to plan the whole roadmap at once.
