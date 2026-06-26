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
- Create the Inngest account/app at [app.inngest.com](https://app.inngest.com).
- Install the **Inngest Vercel integration** from the Vercel Marketplace. This automatically:
  1. Sets `INNGEST_SIGNING_KEY` in your Vercel project environment (for secure communication
     with the Inngest API).
  2. Sets `INNGEST_EVENT_KEY` in your Vercel project environment (for sending events).
  3. Registers a deploy hook so Inngest syncs your app automatically on every Vercel deployment.
- **Install steps:**
  1. In Vercel, open your project → **Integrations** tab (or visit the
     [Vercel Marketplace](https://vercel.com/integrations) and search "Inngest").
  2. Click **Add Integration** next to Inngest. Select a billing plan (the Pro plan starts at
     $75/month; a free tier is available for testing). The free tier is sufficient for the F6/F7/F8
     validation runs; upgrade to Pro before high-volume production use.
  3. Give the integration a name, then select the Vercel project to connect.
  4. Authorize the integration. Vercel will write `INNGEST_SIGNING_KEY` and `INNGEST_EVENT_KEY`
     into the project's environment variables automatically.
  5. Confirm both variables appear under **Settings → Environment Variables** in Vercel before
     proceeding to the first deploy.

## 4. First deploy
- Trigger a production deploy (push to `main`, or Vercel → **Deploy**).
- Confirm the build succeeds (17/17 routes expected).

## 5. Sync check
- In Inngest Cloud, confirm all **9 functions** appear (these are the function `id` slugs the
  dashboard shows, not the JS export names): `reelscript-pipeline`, `render-video`,
  `render-sample`, `generate-script`, `synthesize-voice`, `music-remux`, `deploy-primitive`,
  `generate-shots`, `ingest-shots`.
- If they don't appear after the deploy (auto-sync should fire via the integration), trigger a
  manual sync:
  1. In [Inngest Cloud](https://app.inngest.com), select the **Production** environment from the
     environment selector.
  2. Navigate to the **Apps** page (sidebar).
  3a. First deploy (no app yet): click **Sync New App**, paste the app URL
     `https://<your-vercel-domain>/api/inngest`, and click **Sync App**.
  3b. Re-syncing an existing app (only if the deploy-hook didn't fire): open the app and click
     **Resync** (top-right of the app page).
  4. Confirm all 9 functions are listed under the app. If functions still don't appear, you can
     also trigger discovery by sending a PUT request directly:
     ```bash
     curl -X PUT https://<your-vercel-domain>/api/inngest --fail-with-body
     ```

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
- **F8 — budget block:** set a low monthly cap + enforcement on (`/costs`). Start **Auto-produce**
  (not the manual Generate Video button — budget gating applies only to the pipeline path). Confirm
  it aborts with the budget error before any spend.

All three prove Inngest Cloud suspends/resumes/cancels in production (the behavior that drifted
on the local dev server). Record pass/fail for each.
