# Music re-mux Lambda (Phase 6, spec 10.1)

A dedicated ffmpeg Lambda that mixes the chosen music track onto the voiceover-only
base MP4 — the audio-only re-mux that lets a music change re-run in **seconds without
re-rendering**. It is a *dumb executor*: the Reelscript worker builds the ffmpeg argv
(the ducking filter graph, in `src/lib/music/ffmpeg.ts`, unit-tested) and invokes this
Lambda with signed R2 in/out URLs; the Lambda downloads, runs ffmpeg, and PUTs the result.

**Invoked via the Lambda SDK (SigV4) — NOT a public Function URL.** This AWS account
blocks public Lambda Function URLs (persistent 403), and SDK invocation is more secure
anyway (no public endpoint). `src/lib/music/remux-invoke.ts` calls `InvokeCommand` with
the `REMOTION_AWS_*` creds and a synthetic event carrying the shared-secret header.

## Contract

Invoke `reelscript-music-remux` with an event whose `body` is JSON:

```json
{
  "args": ["-y", "-i", "/tmp/in.mp4", "-stream_loop", "-1", "-i", "/tmp/bed.mp3", "-filter_complex", "…", "/tmp/out.mp4"],
  "inputs":  { "/tmp/in.mp4": "<signed GET url>", "/tmp/bed.mp3": "<signed GET url>" },
  "outputs": { "/tmp/out.mp4": "<signed PUT url>" },
  "outputContentType": "video/mp4"
}
```

and header `x-remux-secret: <REMUX_LAMBDA_SECRET>`. Returns `{ "ok": true, "durationMs": <n> }`
on success (HTTP-style `statusCode` in the handler response), else `{ "ok": false, "error": … }`.

## Deploy (needs Docker + AWS CLI)

> **Before you start:**
> - **Start Docker Desktop** (`docker info` must succeed).
> - **AWS CLI** with a profile that can create ECR repos + Lambda functions + IAM roles.
>   The `REMOTION_AWS_*` keys are least-privilege — either attach `AdministratorAccess`
>   to that user *temporarily* for the deploy (then detach + add a narrow
>   `lambda:InvokeFunction` inline policy), or use a separate admin profile.
> - Region must match the Remotion Lambda (`AWS_REGION`, e.g. `eu-central-1`).

```bash
# From repo root.
export AWS_REGION=eu-central-1
export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text --profile reelscript-admin)
export REPO=reelscript-music-remux
export REG=$ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com

# 1) ECR repo + login
aws ecr create-repository --repository-name "$REPO" --region "$AWS_REGION" --profile reelscript-admin 2>/dev/null || true
aws ecr get-login-password --region "$AWS_REGION" --profile reelscript-admin \
  | docker login --username AWS --password-stdin "$REG"

# 2) Build (provenance OFF — Lambda rejects buildx's attestation manifest) + push
docker buildx build --platform linux/amd64 --provenance=false -t "$REPO:latest" --load lambda/music-remux
docker tag "$REPO:latest" "$REG/$REPO:latest"
docker push "$REG/$REPO:latest"
```

Then the AWS-side (IAM role → function → env wiring) is automated — it creates the role,
the function (2 GB RAM, 4 GB /tmp, 300 s), generates/reuses the secret, and writes
`REMUX_LAMBDA_FUNCTION_NAME` + `REMUX_LAMBDA_SECRET` into `.env.local`. **No Function URL
is created**; any leftover public URL from an earlier attempt is removed.

```bash
node --env-file=.env.local scripts/deploy-music-lambda.mjs   # uses --profile reelscript-admin
```

**Then restart the Next dev server** so it picks up the new env (it reads `.env.local`
at startup): stop `npm run dev` and start it again. The Inngest dev server can keep running.

To update after a code change: re-run step 2, then re-run the deploy script (it
`update-function-code`s when the function already exists).

## Verify

Drive it headlessly (no browser):

```bash
npm run drive:render -- <videoId>            # music_on video → select → base → re-mux → final .mp4
npm run drive:remux  -- <renderId> --reroll  # reroll the track, time the re-mux (expect seconds)
npm run inspect:render -- <renderId>         # captions/kinetic/sidecars + the music_remux cost line
```
