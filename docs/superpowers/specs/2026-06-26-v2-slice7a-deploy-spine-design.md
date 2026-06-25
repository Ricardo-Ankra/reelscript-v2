# Reelscript V2 — Slice 7a: Production deploy spine (Vercel + Inngest Cloud) — Design

> **V2 deferred-backlog roadmap, Slice 7 (production deploy readiness), sub-slice 7a.**
> See `2026-06-25-v2-deferred-roadmap-design.md`. 7a makes the app deployable to **Vercel**
> with **Inngest in Cloud mode**, validated end-to-end **against the fake generation provider**
> (no real spend) so the platform is proven before Slice 8 turns on real money. 7b (production
> primitive bundling) and Slice 8 (real generation) follow.

## 0. Context & locked decisions

- **Fresh start** — no Vercel project and no Inngest Cloud app exist yet. The runbook covers
  everything from account creation onward.
- **The code is already structurally cloud-ready.** The Inngest client is `new Inngest({ id:
  'reelscript' })` (`src/lib/inngest/client.ts:77`) — the SDK reads `INNGEST_EVENT_KEY` /
  `INNGEST_SIGNING_KEY` / `INNGEST_DEV` from env, no code change needed for cloud mode. The serve
  route (`src/app/api/inngest/route.ts`) already registers all 9 functions with
  `runtime = 'nodejs'`. So 7a is **configuration + a runbook + validation**, with one small config
  file as the only code.
- **D4 (polling → webhook) is DEFERRED to Slice 12** (operator-confirmed recommendation). The
  Lambda-completion polling (`render.ts`: `step.run('poll-N')` + `step.sleep('3s')`) is
  **durable-safe on Vercel** — `step.sleep` suspends the function and Inngest re-invokes after the
  wait, so nothing breaks; it just costs more function invocations per render. The webhook is an
  efficiency optimization, not a deploy blocker, and belongs with production-scale work.
- **Validation uses the FAKE generation provider** (`GENERATION_PROVIDER=fake` +
  `GEN_FAKE_STILL_URL` / `GEN_FAKE_CLIP_URL` data-URL fixtures) so the full pipeline — including the
  generative path — runs on the deployed app with **zero external spend**. Real providers land in
  Slice 8.
- **Inngest↔Vercel via the official integration** (auto-manages the Event/Signing keys + auto-syncs
  the app on each deploy). Manual Cloud setup is the documented fallback.

## 1. Goal & non-goals

**Goal.** A repeatable Vercel deployment of the app running Inngest in Cloud (production) mode, where
the full fake-provider pipeline completes on the deployed app and the gate/cancel behaviors that have
been flaky on the local dev server are verified working in production.

**Non-goals (deferred).** No webhook swap for Lambda completion (D4 → Slice 12). No production
primitive bundling — primitive authoring stays broken on Vercel until **7b** (D1/D2). No real
generation providers (Slice 8). No S3→R2 Remotion-site migration (D3 → Slice 12; render works from
Vercel via the S3 serve URL). No custom domain / SSO / multi-region tuning. No CI pipeline beyond
Vercel's built-in git deploys.

## 2. Current state (anchors)

- `src/lib/inngest/client.ts:77` — `new Inngest({ id: 'reelscript' })`; SDK-managed keys via env.
- `src/app/api/inngest/route.ts` — `serve({ client, functions: [...9...] })`, `runtime = 'nodejs'`.
- `src/lib/env.server.ts` — the lazy `required()`/`optional()` server-env accessor (the authoritative
  runtime env surface; §3 is derived from it).
- `src/lib/env.ts` — client env (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`).
- `src/lib/generation/provider-factory.ts:13-18` — `GENERATION_PROVIDER` (default `fake`),
  `GEN_FAKE_STILL_URL`, `GEN_FAKE_CLIP_URL`.
- `.env.example` — the existing documented surface (some entries are tooling/provision-only; §3
  reconciles which are actually read at runtime).
- The longest Vercel-side Inngest step is the Anthropic **compose** call (tens of seconds, well under
  Vercel's 300s default function duration); **render** and **music re-mux** run off-Vercel on Lambda.

## 3. Deliverable 1 — Complete env/secrets inventory (doc)

A new doc `docs/deploy/env-inventory.md` listing every variable, its Vercel scope, source, and
whether it is required. Derived from `env.server.ts` + `env.ts` + the Inngest SDK + the generation
factory. **Categories:**

**A. Required at runtime on Vercel (production + preview):**
- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (client + server), `SUPABASE_SECRET_KEY`
- `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_ENDPOINT`
- `AWS_REGION`, `REMOTION_AWS_ACCESS_KEY_ID`, `REMOTION_AWS_SECRET_ACCESS_KEY`
- `REMOTION_LAMBDA_FUNCTION_NAME`, `REMOTION_SERVE_URL`
- `ANTHROPIC_API_KEY`, `ELEVENLABS_API_KEY`
- `REMUX_LAMBDA_SECRET` (must match the value baked into the music-remux Lambda's own env)

**B. Inngest (managed by the integration, but documented):**
- `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY` — set by the Vercel integration.
- `INNGEST_DEV` — **must be UNSET (or `0`) in production**; the SDK runs cloud mode only when it is
  absent. (Set `1` only in local dev.)

**C. Optional (graceful-degradation if absent):**
- `PEXELS_API_KEY`, `PIXABAY_API_KEY` (a channel "has stock" only when set), `OPENAI_API_KEY`.
- `REMUX_LAMBDA_FUNCTION_NAME` (defaults to `reelscript-music-remux`).
- `CREDENTIALS_ENCRYPTION_KEY` — required **only when** the per-account credentials vault is used; an
  account on env-var keys never needs it. **Set it now** (D6) so the vault works in prod; 64 hex
  chars.

**D. Generation (Slice-8 wiring; for 7a validation only):**
- `GENERATION_PROVIDER=fake`, `GEN_FAKE_STILL_URL`, `GEN_FAKE_CLIP_URL` — **temporary**, set for the
  7a validation pass, removed/overridden when Slice 8 sets `GENERATION_PROVIDER=higgsfield` + real
  keys. The Higgsfield/image key names are finalized in Slice 8 — provision the credentials now,
  wire the names then.

**E. Dev/tooling only — DO NOT set on Vercel:**
- `SUPABASE_DB_URL` (only the `verify:rls` script reads it), `INNGEST_DEV` (local), and the
  deploy/maintenance scripts' creds.

**F. On the Lambdas, not Vercel:**
- `FFMPEG_PATH`, `FFPROBE_PATH`, `REMUX_LAMBDA_SECRET` live in the music-remux **Lambda's** env; the
  Vercel `REMUX_LAMBDA_SECRET` must equal the Lambda's.

The doc also flags `R2_ACCOUNT_ID` (in `.env.example`, **not** read by `env.server.ts` at runtime —
provision if any tooling needs it, but it is not a Vercel runtime requirement).

## 4. Deliverable 2 — Config hardening (the only code)

A `vercel.json` at the repo root:
- Pin the Inngest serve function to a generous `maxDuration` (e.g. 300s) so the compose step never
  trips a default cap, and confirm the Node runtime (the route already sets `runtime = 'nodejs'`).
- Node version pin via `package.json` `engines.node` (Node 24 LTS) if not already pinned, so Vercel's
  build matches local.

No SDK/client code changes: cloud mode is purely the absence of `INNGEST_DEV` + the presence of the
two Inngest keys. The build already passes `npm run build` (17/17 routes); 7a must not regress it.

> If, at plan time, `vercel.json` cannot express the per-route `maxDuration` for the App-Router
> handler, fall back to the App-Router `export const maxDuration = 300` in `route.ts` — decided then,
> not a scope change.

## 5. Deliverable 3 — Deploy runbook (operator-executed)

A new doc `docs/deploy/runbook.md` — an ordered, copy-pasteable checklist. **Most steps are dashboard
actions only the operator can perform; the spec is explicit about that.** Outline:

1. **Vercel project:** create it, connect the GitHub repo (`reelscript-v2`), framework = Next.js,
   confirm the Node version, set the build/output to defaults.
2. **Env vars:** enter every Category-A/B/C/D var from the inventory in the Production (and Preview)
   scope.
3. **Inngest Cloud:** create the account/app; install the **Inngest Vercel integration** (it sets
   `INNGEST_EVENT_KEY` / `INNGEST_SIGNING_KEY` and registers the app URL); confirm `INNGEST_DEV` is
   **not** set in prod.
4. **First deploy:** trigger a production deploy; confirm the build succeeds.
5. **Sync check:** in Inngest Cloud, confirm all **9 functions** appear (the app synced via
   `/api/inngest`). If the integration didn't auto-sync, do the manual sync (documented fallback).
6. **Smoke:** load the deployed app, sign in, confirm a trivial RLS read works (channels list).

## 6. Deliverable 4 — Production validation (operator gates, fake provider)

With `GENERATION_PROVIDER=fake` + the fake fixtures set on Vercel, run — **on the deployed app** —
the gate/cancel behaviors that have only ever been exercised on the local dev server:

- **F7** — an Auto-produce run (`pipeline/start`): confirm `Promise.all([step.invoke(generateShots),
  step.invoke(ingestShots)])` fans out and fans in, the G1 storyboard gate pauses, approve resumes
  through render to completion; then a `jobs/cancel` on a paused run **cascades** to the children.
- **F6** — the G2 preview gate: a render with `preview_gate` on pauses after the graded base, and
  Approve/Reject via `pipeline/gate.resolved` resumes/terminates within ~3s.
- **F8** — set a low monthly cap + enforcement on: an Auto-produce run aborts with the
  `{phase:'budget'}` error before the fan-out.

These prove **Inngest Cloud** actually suspends/resumes/cancels in production — the exact class of
behavior that drifted on the local dev server. They are operator-run (the codebase has no automated
test for Inngest runtime, by design); the spec lists them as the slice's acceptance gate.

## 7. Caveats baked into the runbook

- **Primitive authoring is broken on Vercel until 7b.** The `deployPrimitive` function writes the
  repo tree (`.primitive-cache/`, `remotion/primitives/db/`) — read-only on Vercel. It is registered
  but unused by 7a's validation. The runbook says: **do not author/save primitives in production
  until 7b ships** (it errors on the read-only FS). Authoring locally + deploying the baked bundle
  still works.
- **Remotion site stays on S3** (D3 deferred). Render works from Vercel via `REMOTION_SERVE_URL`.
- **Fake fixtures are temporary.** Remove `GEN_FAKE_*` and flip `GENERATION_PROVIDER` when Slice 8
  lands real providers.

## 8. Testing

- **Automated:** `npm run build` stays green (17/17 routes) with `vercel.json` + any `engines` pin;
  `npm test` / `npm run typecheck` / `npm run lint` unaffected (no app-code change). No new unit
  tests — the deliverables are config + docs.
- **Manual (operator, the real acceptance):** the §5 runbook completes (app live, 9 functions
  synced) and the §6 gates (F6/F7/F8) pass on the deployed app against the fake provider.

## 9. File structure (drives the plan)

| File | Responsibility |
| --- | --- |
| `vercel.json` (create) | Inngest serve function `maxDuration` + runtime; Vercel build config |
| `package.json` (modify, if needed) | `engines.node` pin |
| `docs/deploy/env-inventory.md` (create) | the complete categorized env/secrets inventory (§3) |
| `docs/deploy/runbook.md` (create) | the ordered operator deploy runbook (§5) + caveats (§7) + validation (§6) |

## 10. Execution note

7a is a **lightweight-code, heavyweight-runbook** slice: the buildable surface is one config file
(+ maybe an `engines` line) and two docs; the substantive work is operator dashboard steps that
cannot be automated. **Inline execution (executing-plans) likely fits better than the full TDD
subagent flow** — confirmed at plan handoff. The plan still lists discrete, checkable steps.

## 11. Open items (resolved-by-default; flagged for the plan)

- **`maxDuration` mechanism:** `vercel.json` vs the App-Router `export const maxDuration` — pick at
  plan time whichever the framework honors for the `/api/inngest` route; both are in-scope, neither
  changes the slice.
- **Inngest sync mechanism:** integration auto-sync is primary; manual app-URL sync is the
  documented fallback in the runbook.
- **Exact Vercel/Inngest dashboard click-paths** will be confirmed against current Vercel + Inngest
  docs when the runbook is written (the flow may have minor UI changes); the spec fixes the
  *sequence* and *requirements*, the runbook fills the exact clicks.
