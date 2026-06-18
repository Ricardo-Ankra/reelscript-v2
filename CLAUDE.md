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
    **code editor is a textarea** (no Monaco). Primitive drafting is pinned to **Opus**
    (`model_routing` is Phase 8). The **studio UI's browser interaction pass** (watching
    auto-fix retry live) is the operator's manual review; the backend it drives is proven.
  - **Phase 6 deferrals carried forward:** ~~aspect-ratio / FPS / target-length
    controls~~ **shipped** — per-video on `VideoSettingsPanel`, and channel-level
    defaults (`channels.defaults` aspect/fps/target_length, inherited by new videos
    at creation) via the Phase-8 video-defaults slice (2026-06-18). **Thumbnail
    generation** is still Phase 8. Music selection is a **deterministic mood-match in code** (not an AI
    choice), and the **Music panel is minimal** (reroll + master volume) — the full
    panel (ducking depth, loop, in/out crop, fade) is Phase 8, though the re-mux
    already accepts those params. Seed beds are **generated via the ElevenLabs Music
    API** (Pexels Audio discontinued); **reroll is reselection-only**, never
    regeneration. The remux Lambda is **invoked via the SDK (SigV4)**, not a public
    Function URL (the AWS account blocks public URLs); `remotion-user` carries a narrow
    `lambda:InvokeFunction` inline policy for it. Per-video caption/kinetic/music
    toggles come from **`video.settings` + channel defaults** (no settings UI until
    Phase 8). ~~**Kinetic duration is uncapped** — a long emphasis word suppresses
    captions for its span~~ — **superseded by the 2026-06-16 caption emphasis revision**
    (single caption track, no kinetic span / suppression machinery).
  - **Phase 3 deferrals carried forward:** ElevenLabs key is an **env var**
    (`ELEVENLABS_API_KEY`), not `api_credentials` (Phase 8); synthesis is
    **fallback-only** (no per-model `voice_profiles` rows/UI — Phase 8); the voice
    concurrency cap is a plain chunk of 5 (shared governor — Phase 9); seed uses a
    hardcoded default voice.
  - **Phase 5 deferrals carried forward:** the **channel-resource UI** is Phase 8 —
    the server capability (signed upload, fast vision auto-tag, `resolveResourceAssets`)
    ships, but with no UI to create resources or set a shot `source='resource'`, and
    the compose prompt doesn't yet surface resource ids, **resource placement is
    dormant** (the AI can't place pinned resources until the Phase-8 UI + prompt
    binding land). `confirmResourceUpload` doesn't yet write a `resource_tagging`
    cost_event. The stock **search-result + file-bytes caches** are live; the full
    rate/concurrency **governor is Phase 9** (search uses a plain per-call count).
    Gate-2 has **no auto-fix loop** (Phase 7) — it surfaces the failing frame only.
  - **Phase 4 deferrals carried forward:** Captions / kinetic text / music + remux
    are Phase 6 (the attribution overlay shipped in Phase 5).
    `model_routing` is Phase 8 (Sonnet pinned in code). The **render idempotency
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
