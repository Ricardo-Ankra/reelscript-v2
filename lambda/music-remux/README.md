# Music re-mux Lambda (Phase 6, spec 10.1)

A dedicated ffmpeg Lambda that mixes the chosen music track onto the voiceover-only
base MP4 — the audio-only re-mux that lets a music change re-run in **seconds without
re-rendering**. It is a *dumb executor*: the Reelscript worker builds the ffmpeg argv
(the ducking filter graph, in `src/lib/music/ffmpeg.ts`, unit-tested) and POSTs it
with signed R2 in/out URLs; this Lambda downloads, runs ffmpeg, and PUTs the result.

## Contract

`POST <Function URL>` with header `x-remux-secret: <REMUX_LAMBDA_SECRET>` and body:

```json
{
  "args": ["-y", "-i", "/tmp/in.mp4", "-stream_loop", "-1", "-i", "/tmp/bed.mp3", "-filter_complex", "…", "/tmp/out.mp4"],
  "inputs":  { "/tmp/in.mp4": "<signed GET url>", "/tmp/bed.mp3": "<signed GET url>" },
  "outputs": { "/tmp/out.mp4": "<signed PUT url>" },
  "outputContentType": "video/mp4"
}
```

Returns `{ "ok": true, "durationMs": <n> }` on success, `{ "ok": false, "error": … }` otherwise.

## Deploy (human checkpoint — needs Docker + AWS CLI)

Build for **linux/amd64**, push to ECR, create the function from the image, and add a
Function URL. Region must match your Remotion Lambda (`AWS_REGION`).

> **Before you start (env-specific notes):**
> - **Start Docker Desktop** — the daemon must be running (`docker info` should succeed).
> - **Install AWS CLI v2** if you don't have it: https://aws.amazon.com/cli/
> - **Use a PRIVILEGED AWS identity, NOT the `REMOTION_AWS_*` keys.** Those keys are
>   least-privilege (Remotion-scoped) and cannot create ECR repos, Lambda functions, or
>   IAM roles. Configure the CLI with an admin profile for this account
>   (`aws configure --profile admin`, then add `--profile admin` to each command below).
> - Account `151929428673`, region `eu-central-1` (your current setup).

```bash
# From repo root. Set these first:
export AWS_REGION=eu-central-1
export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export REPO=reelscript-music-remux
export SECRET="$(openssl rand -hex 24)"   # save this — it goes in .env.local too

# 1) ECR repo + login
aws ecr create-repository --repository-name "$REPO" --region "$AWS_REGION" 2>/dev/null || true
aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "$ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com"

# 2) Build + push (amd64)
docker buildx build --platform linux/amd64 -t "$REPO" lambda/music-remux --load
docker tag "$REPO:latest" "$ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$REPO:latest"
docker push "$ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$REPO:latest"

# 3) Execution role — needs ONLY AWSLambdaBasicExecutionRole (R2 is reached via signed
#    URLs, so the function needs no AWS data permissions). Create one if you have none:
cat > /tmp/trust.json <<'JSON'
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}
JSON
aws iam create-role --role-name reelscript-remux-role \
  --assume-role-policy-document file:///tmp/trust.json 2>/dev/null || true
aws iam attach-role-policy --role-name reelscript-remux-role \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
export ROLE_ARN=arn:aws:iam::$ACCOUNT_ID:role/reelscript-remux-role
# (IAM role propagation takes a few seconds; if create-function 400s on the role, wait + retry.)

# 4) Create the function (2 GB RAM, 4 GB /tmp, 300s) and set the secret
aws lambda create-function --function-name "$REPO" \
  --package-type Image \
  --code ImageUri="$ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$REPO:latest" \
  --role "$ROLE_ARN" --timeout 300 --memory-size 2048 \
  --ephemeral-storage Size=4096 \
  --environment "Variables={REMUX_LAMBDA_SECRET=$SECRET}" \
  --region "$AWS_REGION"

# 5) Public Function URL (auth handled by our secret header)
aws lambda create-function-url-config --function-name "$REPO" \
  --auth-type NONE --region "$AWS_REGION"
aws lambda add-permission --function-name "$REPO" \
  --statement-id FnUrlPublic --action lambda:InvokeFunctionUrl \
  --principal '*' --function-url-auth-type NONE --region "$AWS_REGION"

# 6) Print the URL — paste into .env.local with the secret:
aws lambda get-function-url-config --function-name "$REPO" \
  --region "$AWS_REGION" --query FunctionUrl --output text
```

Then in `.env.local` (and `.env.hosted`):

```
REMUX_LAMBDA_URL=https://….lambda-url.eu-central-1.on.aws/
REMUX_LAMBDA_SECRET=<the $SECRET from above>
```

**Then restart the Next dev server** so it picks up the new env (it reads `.env.local`
at startup): stop the running `npm run dev` and start it again. The Inngest dev server
can keep running. Tell me once it's back up and I'll drive the music verification.

To update after a code change: re-run steps 2 then
`aws lambda update-function-code --function-name "$REPO" --image-uri …:latest --region "$AWS_REGION"`.

## Smoke test

```bash
curl -sS -X POST "$REMUX_LAMBDA_URL" -H "x-remux-secret: $REMUX_LAMBDA_SECRET" \
  -H 'content-type: application/json' \
  -d '{"args":["-y","-f","lavfi","-i","sine=frequency=440:duration=1","/tmp/out.mp4"],"inputs":{},"outputs":{"/tmp/out.mp4":"<a signed PUT url>"}}'
```
