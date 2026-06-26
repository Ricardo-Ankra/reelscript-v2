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

## C. Optional (the deploy succeeds without these; exact behavior varies per var — see notes)

| Variable | Required | Source / notes |
| --- | --- | --- |
| `PEXELS_API_KEY` | optional | A channel "has stock" only when set. |
| `PIXABAY_API_KEY` | optional | As above. |
| `OPENAI_API_KEY` | optional | Reserved (Phase 4); not read anywhere in `src/` yet — setting it has no effect today. |
| `REMUX_LAMBDA_FUNCTION_NAME` | optional | Defaults to `reelscript-music-remux`. |
| `CREDENTIALS_ENCRYPTION_KEY` | only for the credentials vault | 64 hex chars (32 bytes). Read via a `required()` getter (`env.server.ts`), so it THROWS if the per-account credentials vault is exercised without it — but the app otherwise runs on env-var provider keys (the vault save shows a friendly error and resolution falls back to env when absent). Set it now so the vault works in prod. |

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
