# V2 Slice 7a — Production Deploy Spine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the app deployable to Vercel with Inngest in Cloud mode, with a complete env inventory, the minimal config hardening, and an operator deploy+validation runbook — validated end-to-end against the fake generation provider.

**Architecture:** The code is already structurally cloud-ready (the Inngest SDK reads its keys from env; the serve route registers all 9 functions). So 7a is one tiny config change (a route-level `maxDuration` + a Node `engines` pin) plus two docs (the env inventory and the deploy runbook). No app-logic change; the build must stay green (17/17 routes). Most of the actual deploy work is operator dashboard steps the runbook captures.

**Tech Stack:** Next.js (App Router) on Vercel, Inngest Cloud (via the official Vercel integration), Node 24 LTS. Docs in Markdown under `docs/deploy/`.

## Global Constraints

- **No app-logic change.** 7a touches only `package.json` (engines), `src/app/api/inngest/route.ts` (a `maxDuration` export), and two new docs under `docs/deploy/`. `npm run build` stays green (17/17 routes); `npm test` / `typecheck` / `lint` unchanged.
- **Cloud mode = absence of `INNGEST_DEV` + presence of the two Inngest keys.** No SDK/client code change. `INNGEST_DEV` must be UNSET (or `0`) in production.
- **D4 (polling→webhook) is DEFERRED to Slice 12.** Do not change `render.ts` polling.
- **Validation uses the FAKE generation provider** (`GENERATION_PROVIDER=fake` + `GEN_FAKE_STILL_URL`/`GEN_FAKE_CLIP_URL`). No real provider keys wired here (Slice 8).
- **Env inventory is derived from `src/lib/env.server.ts` + `src/lib/env.ts` + the Inngest SDK + `src/lib/generation/provider-factory.ts`** — not invented. `R2_ACCOUNT_ID` and `SUPABASE_DB_URL` are NOT Vercel runtime requirements.
- **Primitive authoring is broken on Vercel until 7b** — the runbook must say so explicitly.
- **The exact Vercel/Inngest dashboard click-paths must be confirmed against current docs when the runbook is written** (UI changes over time). Use context7 (`inngest`, `vercel`) at writing time; fix the sequence/requirements, fill the exact clicks.

---

### Task 1: Config hardening — route `maxDuration` + Node engines pin

**Files:**
- Modify: `src/app/api/inngest/route.ts` (add a `maxDuration` export)
- Modify: `package.json` (add/confirm `engines.node`)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing importable; a deploy-time config only.

**Why this and not `vercel.json`:** Vercel's default function duration is already 300s, and the App-Router route-segment `export const maxDuration` is the idiomatic, dependency-free way to make the Inngest serve function's budget explicit. This satisfies the spec's "config hardening" deliverable without a new config file. The longest Vercel-side Inngest step is the Anthropic compose call (tens of seconds), comfortably under 300s; render and music re-mux run off-Vercel on Lambda.

- [ ] **Step 1: Add `maxDuration` to the Inngest route**

Edit `src/app/api/inngest/route.ts`. It currently ends with the `serve(...)` export and has `export const runtime = 'nodejs';` near the top. Add a `maxDuration` export next to the `runtime` export:

```ts
// Node runtime: the render function uses @remotion/lambda + the AWS SDK, the script
// and composition steps use the Anthropic SDK, and voice synthesis writes audio
// bytes to R2.
export const runtime = 'nodejs';

// Give the Inngest serve function the full Vercel budget: the longest Vercel-side step
// is the Anthropic compose call (render + music re-mux run off-Vercel on Lambda). 300s
// is the current Vercel default; declaring it is explicit + future-proof against default
// changes. (Slice 7a — production deploy.)
export const maxDuration = 300;
```

- [ ] **Step 2: Pin the Node version in `package.json`**

Open `package.json`. If there is no `engines` field, add one (Node 24 LTS, Vercel's current default — pinning keeps the Vercel build matching local). If `engines.node` already exists, leave it unless it is below 20; do not downgrade. Add near the top level (sibling of `scripts`):

```json
  "engines": {
    "node": ">=20"
  },
```

(Use `>=20` as a floor — the app's deps require ≥20; Vercel selects its 24 LTS default within that range. Do not pin an exact version that could fall behind Vercel's available runtimes.)

- [ ] **Step 3: Verify the build is unaffected**

Run: `npm run build`
Expected: success, 17/17 routes. The `maxDuration` export is a recognized route-segment config; the `engines` field does not affect the local build.

Run: `npm run typecheck`
Expected: no errors.

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/inngest/route.ts package.json
git commit -m "feat(v2): pin Inngest route maxDuration + Node engines for Vercel"
```

---

### Task 2: Environment inventory doc

**Files:**
- Create: `docs/deploy/env-inventory.md`

**Interfaces:**
- Consumes: the authoritative env surface in `src/lib/env.server.ts`, `src/lib/env.ts`, and `src/lib/generation/provider-factory.ts`.
- Produces: the canonical list the runbook (Task 3) references.

**Content to write** — a doc with these exact categories and entries (verbatim from the spec §3, which was derived from the code). Render each category as a table with columns: Variable | Required? | Vercel scope | Source / notes.

- [ ] **Step 1: Write `docs/deploy/env-inventory.md`**

Create the file with this structure and content:

```markdown
# Reelscript — Vercel environment inventory (Slice 7a)

Every variable the deployed app reads, derived from `src/lib/env.server.ts`,
`src/lib/env.ts`, the Inngest SDK, and `src/lib/generation/provider-factory.ts`.
Set Category A/B/C/D on Vercel (Production + Preview). Do NOT set Category E on Vercel.

## A. Required at runtime (Production + Preview)

| Variable | Required | Source / notes |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | yes | Supabase dashboard → API. Client + server. |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | yes | Supabase → API Keys (publishable `sb_publishable_…`). Client. |
| `SUPABASE_SECRET_KEY` | yes | Supabase → API Keys (secret `sb_secret_…`). Server-only; bypasses RLS. |
| `R2_ACCESS_KEY_ID` | yes | Cloudflare R2 API token. |
| `R2_SECRET_ACCESS_KEY` | yes | Cloudflare R2 API token. |
| `R2_BUCKET` | yes | R2 bucket name. |
| `R2_ENDPOINT` | yes | R2 S3 endpoint URL. |
| `AWS_REGION` | yes | Matches the Remotion/remux Lambda region (e.g. eu-central-1). |
| `REMOTION_AWS_ACCESS_KEY_ID` | yes | The `remotion-user` AWS key (also used to invoke the remux Lambda). |
| `REMOTION_AWS_SECRET_ACCESS_KEY` | yes | As above. |
| `REMOTION_LAMBDA_FUNCTION_NAME` | yes | From `npm run deploy:remotion`. |
| `REMOTION_SERVE_URL` | yes | The deployed Remotion site (S3 — D3 deferred). |
| `ANTHROPIC_API_KEY` | yes | Script-gen + composition + vision. |
| `ELEVENLABS_API_KEY` | yes | Voice synthesis + music seeding. |
| `REMUX_LAMBDA_SECRET` | yes | Defence-in-depth header; MUST equal the music-remux Lambda's own `REMUX_LAMBDA_SECRET`. |

## B. Inngest (managed by the Vercel integration, documented here)

| Variable | Required | Source / notes |
| --- | --- | --- |
| `INNGEST_EVENT_KEY` | yes (prod) | Set by the Inngest Vercel integration. |
| `INNGEST_SIGNING_KEY` | yes (prod) | Set by the Inngest Vercel integration. |
| `INNGEST_DEV` | MUST be UNSET in prod | Set `1` only in local `.env.local`. The SDK runs cloud mode only when this is absent. |

## C. Optional (graceful degradation if absent)

| Variable | Required | Source / notes |
| --- | --- | --- |
| `PEXELS_API_KEY` | optional | A channel "has stock" only when set. |
| `PIXABAY_API_KEY` | optional | As above. |
| `OPENAI_API_KEY` | optional | Reserved (Phase 4). |
| `REMUX_LAMBDA_FUNCTION_NAME` | optional | Defaults to `reelscript-music-remux`. |
| `CREDENTIALS_ENCRYPTION_KEY` | required only when the per-account credentials vault is used | 64 hex chars (32 bytes). Set it now so the vault works in prod. |

## D. Generation (Slice-8 wiring; for 7a validation ONLY — temporary)

| Variable | Required | Source / notes |
| --- | --- | --- |
| `GENERATION_PROVIDER` | `fake` for 7a | Slice 8 flips to `higgsfield`. Default is `fake`. |
| `GEN_FAKE_STILL_URL` | for 7a validation | A `data:` URL fixture (keyframe). Remove after Slice 8. |
| `GEN_FAKE_CLIP_URL` | for 7a validation | A `data:` URL fixture (clip). Remove after Slice 8. |

> Provision the real Higgsfield/image-model credentials now; their exact env var
> names are finalized in Slice 8 and added here then.

## E. Dev/tooling only — DO NOT set on Vercel

| Variable | Where | Notes |
| --- | --- | --- |
| `SUPABASE_DB_URL` | local | Only the `verify:rls` script reads it. |
| `INNGEST_DEV` | local | `1` in local dev; absent in prod (see B). |

## F. On the Lambdas, not Vercel

`FFMPEG_PATH`, `FFPROBE_PATH`, `REMUX_LAMBDA_SECRET` live in the music-remux **Lambda's**
env. The Vercel `REMUX_LAMBDA_SECRET` (Category A) must equal the Lambda's value.

## Not a Vercel runtime requirement

`R2_ACCOUNT_ID` appears in `.env.example` but is NOT read by `src/lib/env.server.ts` at
runtime. Provision it only if a local script needs it; it is not required on Vercel.
```

- [ ] **Step 2: Cross-check the inventory against the code**

Re-read `src/lib/env.server.ts` and `src/lib/env.ts` and `src/lib/generation/provider-factory.ts`. Confirm every `required(...)`/`optional(...)`/`process.env.*` name in those files appears in the inventory's Category A/B/C/D (or is explicitly noted in E/F/Not-a-requirement). Fix any drift.

- [ ] **Step 3: Commit**

```bash
git add docs/deploy/env-inventory.md
git commit -m "docs(v2): Vercel environment inventory (Slice 7a)"
```

---

### Task 3: Deploy + validation runbook

**Files:**
- Create: `docs/deploy/runbook.md`

**Interfaces:**
- Consumes: `docs/deploy/env-inventory.md` (Task 2).
- Produces: the operator-executed deploy + validation checklist.

**Before writing:** pull current Inngest + Vercel deploy docs via context7 (`resolve-library-id` then `query-docs` for "inngest", "vercel") to confirm the integration install flow, the app-sync mechanism, and any Vercel project-setup specifics. Fix the exact dashboard click-paths against those docs; the sequence below is fixed, the clicks are filled in.

- [ ] **Step 1: Write `docs/deploy/runbook.md`**

Create the file with these sections (fill the exact dashboard clicks from current docs):

```markdown
# Reelscript — Vercel + Inngest Cloud deploy runbook (Slice 7a)

Most steps are dashboard actions only the operator can perform. Follow in order.
Env var values come from `docs/deploy/env-inventory.md`.

## 1. Vercel project
- Create a Vercel project; connect the GitHub repo `reelscript-v2`.
- Framework preset: Next.js. Confirm the Node version (≥20; Vercel uses its 24 LTS default).
- Leave build/output at defaults (`next build`).

## 2. Environment variables
- Enter every Category A/B/C/D variable from the env inventory in the **Production** scope
  (and Preview, if you want preview deploys to function).
- Do NOT set Category E. Confirm `INNGEST_DEV` is absent.
- For 7a validation only: set `GENERATION_PROVIDER=fake`, `GEN_FAKE_STILL_URL`,
  `GEN_FAKE_CLIP_URL` (Category D). These are removed when Slice 8 lands.

## 3. Inngest Cloud
- Create the Inngest account/app.
- Install the **Inngest Vercel integration** (sets `INNGEST_EVENT_KEY` /
  `INNGEST_SIGNING_KEY` and registers the app's `/api/inngest` URL for auto-sync).
- [exact integration install clicks — fill from current Inngest docs]

## 4. First deploy
- Trigger a production deploy (push to `main`, or Vercel "Deploy").
- Confirm the build succeeds.

## 5. Sync check
- In Inngest Cloud, confirm all **9 functions** appear: `reelscript-pipeline`,
  `renderVideo`, `renderSample`, `generateScript`, `synthesizeVoice`, `musicRemux`,
  `deployPrimitive`, `generateShots`, `ingestShots`.
- If they don't auto-sync, trigger a manual sync of the app URL `https://<domain>/api/inngest`
  in the Inngest dashboard. [exact manual-sync clicks — fill from current Inngest docs]

## 6. Smoke
- Load the deployed app, sign in, confirm the channels list loads (an RLS read works).

## Caveats
- **Do NOT author/save primitives in production until Slice 7b ships.** The `deployPrimitive`
  function writes the repo tree (`.primitive-cache/`, `remotion/primitives/db/`), which is
  read-only on Vercel — it will error. Author primitives locally and deploy the baked bundle
  until 7b moves bundling to a build Lambda.
- The Remotion site stays on S3 (D3 deferred); render works from Vercel via `REMOTION_SERVE_URL`.
- Remove the `GEN_FAKE_*` vars and flip `GENERATION_PROVIDER` when Slice 8 lands real providers.

## Production validation (the slice's acceptance gate — fake provider)
With `GENERATION_PROVIDER=fake` + fixtures set, run these on the DEPLOYED app:
- **F7 — Auto-produce / pipeline:** start an Auto-produce run on a voiced video with ≥1
  generative shot. Confirm: generation + ingest fan out and fan in; the G1 storyboard gate
  pauses; Approve resumes through render to a finished video. Then start another, and at the
  G1 pause, Cancel the job — confirm the cancellation cascades (the run stops; the editor
  doesn't dead-end).
- **F6 — G2 preview gate:** render a video with `preview_gate` on. Confirm it pauses after the
  graded base; Approve proceeds to music+finalize; a separate run's Reject terminates. Banner
  appears within ~3s.
- **F8 — budget block:** set a low monthly cap + enforcement on (`/costs`). Start Auto-produce;
  confirm it aborts with the budget error before any spend.

All three prove Inngest Cloud suspends/resumes/cancels in production (the behavior that drifted
on the local dev server). Record pass/fail for each.
```

- [ ] **Step 2: Fill the dashboard click-paths from current docs**

Using the context7 docs pulled before Step 1, replace the two `[exact … clicks — fill …]` placeholders with the current Inngest integration-install and manual-sync steps. Leave no bracketed placeholder in the committed file.

- [ ] **Step 3: Verify no placeholders remain**

Run: `grep -n "fill from current" docs/deploy/runbook.md` (or search the file).
Expected: no matches — every click-path is filled.

- [ ] **Step 4: Commit**

```bash
git add docs/deploy/runbook.md
git commit -m "docs(v2): Vercel + Inngest Cloud deploy + validation runbook (Slice 7a)"
```

---

## Final verification (after all tasks)

- [ ] `npm run build` — success, 17/17 routes.
- [ ] `npm run typecheck` — no errors.
- [ ] `npm run lint` — no errors.
- [ ] `npm test` — unchanged/green (no app-logic change).
- [ ] `docs/deploy/env-inventory.md` and `docs/deploy/runbook.md` exist, with no bracketed placeholders.
- [ ] `git diff --stat` touches only `src/app/api/inngest/route.ts`, `package.json`, and the two new docs.

## Operator execution (the real acceptance — not a code gate)

The runbook (`docs/deploy/runbook.md`) is executed by the operator against the Vercel + Inngest
dashboards: app live, 9 functions synced, and the F6/F7/F8 validation gates passing on the deployed
app against the fake provider. This is the slice's true done-signal and cannot be automated.
