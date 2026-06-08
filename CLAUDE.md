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
- **Current phase: Phase 2 — Script and scenes.** (Phase 0 — Foundations:
  complete and verified, 2026-06-04. Phase 1 — The render spine: complete and
  verified, 2026-06-08, hand-written spec rendered to MP4 on Lambda and played
  in the browser.)
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
