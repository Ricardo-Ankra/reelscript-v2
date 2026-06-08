# Phase 1 — Cloud setup guide (AWS, R2, Inngest)

Everything you fill in lands in **`.env.local`** (gitignored). Region is
`eu-central-1` everywhere to match Supabase. Do **AWS** and **R2** now; **Inngest**
needs nothing for Phase 1 (local dev server only).

When you're done, tell Claude and it will run `npm run deploy:remotion`, fill in
the two generated values, and drive the first render.

---

## A. AWS — Remotion Lambda

Remotion renders on AWS Lambda. You need (1) an IAM **user** with permission to
deploy/invoke, and (2) an IAM **role** the Lambda function runs as. You never use
the AWS root account for this.

### A1. Create the IAM policies' JSON (no AWS login needed)
In this project folder, run each and copy the JSON it prints:

```
npx remotion lambda policies user
npx remotion lambda policies role
```

Keep both outputs handy — "user policy" and "role policy".

### A2. Create the IAM user
1. AWS Console → **IAM** → **Users** → **Create user**.
2. Name: `remotion-user`. Do **not** enable console access (programmatic only).
   Click through to **Create user**.

### A3. Attach the user policy
1. Open `remotion-user` → **Permissions** tab → **Add permissions** →
   **Create inline policy**.
2. Switch to the **JSON** editor, paste the **user policy** from A1, **Next**.
3. Name it `remotion-user-policy` → **Create policy**.

### A4. Create the Lambda execution role (must be named exactly `remotion-lambda-role`)
1. IAM → **Roles** → **Create role**.
2. Trusted entity type: **AWS service**; Use case: **Lambda** → **Next**.
3. Skip adding managed permissions → **Next**.
4. Role name: **`remotion-lambda-role`** (exactly — the user policy's PassRole is
   scoped to this name) → **Create role**.
5. Open the new role → **Add permissions** → **Create inline policy** → **JSON**
   → paste the **role policy** from A1 → **Next** → name it
   `remotion-lambda-role-policy` → **Create policy**.

### A5. Create an access key for the user
1. IAM → Users → `remotion-user` → **Security credentials** → **Create access key**.
2. Use case: **Application running outside AWS** → **Create access key**.
3. Copy the **Access key ID** and **Secret access key** (shown once).

### A6. Put the credentials in `.env.local`
```
AWS_REGION=eu-central-1                 # already set
REMOTION_AWS_ACCESS_KEY_ID=<access key id>
REMOTION_AWS_SECRET_ACCESS_KEY=<secret access key>
```
> Remotion-specific names (`REMOTION_AWS_*`) are used on purpose so they don't
> clash with any other AWS profile on your machine.

That's all for AWS. Claude will deploy the function + site and (if needed)
Remotion will auto-request a small Lambda concurrency-quota bump on first use.

---

## B. Cloudflare R2 — storage for the spec + rendered MP4

The bucket stays **private**; the app serves files via short-lived signed URLs.
(The Remotion *site bundle* lives on S3 in Phase 1, not R2 — see the deferred
S3→R2 task for Phase 7. R2 here only holds the spec JSON and the output MP4.)

### B1. Enable R2 and create a bucket
1. Cloudflare dashboard → **R2**. If first time, enable R2 (may ask for a payment
   method even on the free tier).
2. **Create bucket** → name `reelscript` → location **Automatic** → **Create**.
   Leave public access **off**.

### B2. Create an S3 API token
1. R2 → **Manage R2 API Tokens** (or **API** → **Create API token**).
2. Permissions: **Object Read & Write**. Optionally scope it to the `reelscript`
   bucket. → **Create API token**.
3. Copy the **Access Key ID** and **Secret Access Key** (shown once).

### B3. Find your endpoint / account id
On the R2 overview (or the token page) you'll see the S3 API endpoint:
`https://<ACCOUNT_ID>.r2.cloudflarestorage.com`. Copy it.

### B4. Put the values in `.env.local`
```
R2_ACCESS_KEY_ID=<access key id>
R2_SECRET_ACCESS_KEY=<secret access key>
R2_BUCKET=reelscript
R2_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
```

### B5. Add a CORS policy to the bucket (required for rendering)
The Remotion composition fetches the spec by signed URL **from inside the render
browser** (`calculateReelMetadata`). That's a cross-origin browser fetch, and R2
blocks it by default — the Lambda render dies with `TypeError: Failed to fetch`
in `calculateMetadata`. CORS does not weaken privacy: the bucket stays private
and a browser can only read a response it already holds a valid signed URL for.

The Object-scoped API token from B2 **can't** set bucket CORS (you'll get a 403),
so add it in the dashboard:
1. R2 → `reelscript` bucket → **Settings** → **CORS Policy** → **Add CORS policy**.
2. Paste and save:
```json
[
  {
    "AllowedOrigins": ["*"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag", "Content-Length"],
    "MaxAgeSeconds": 3600
  }
]
```
> `scripts/set-r2-cors.mjs` (`npm run setup:r2-cors`) applies the same policy via
> the S3 API, but only with an **admin-scoped** R2 token. With the Object-only
> token it returns 403 — use the dashboard.

---

## C. Inngest — orchestration

### Phase 1: nothing to provision
Locally, Inngest runs entirely via its dev server; **no account or keys needed**.
Claude will run it during the render test:

```
npx inngest-cli@latest dev -u http://localhost:3001/api/inngest
```

(The app runs on port **3001** because 3000 is taken by another project. The
Inngest dev dashboard opens at http://localhost:8288.) Leave
`INNGEST_EVENT_KEY` / `INNGEST_SIGNING_KEY` blank for now, but **do** set
`INNGEST_DEV=1` in `.env.local`:

```
INNGEST_DEV=1
```
> Without it the SDK starts in "cloud mode" and rejects every request from the
> dev server with a 500 ("no signing key found"). The flag is local-only; on
> Vercel we set the real signing key instead.

### Later (production, when we deploy to Vercel)
1. Create an account at **inngest.com** → create an app.
2. **Manage** → **Event Keys** → copy an Event Key → `INNGEST_EVENT_KEY`.
3. **Manage** → **Signing Key** → copy → `INNGEST_SIGNING_KEY`.
4. Add both to the Vercel project env. This is also when we swap render-completion
   polling for the `/api/webhooks/lambda-render` wait-for-event pattern.

---

## Checklist before telling Claude to proceed
- [ ] `.env.local` has `REMOTION_AWS_ACCESS_KEY_ID` + `REMOTION_AWS_SECRET_ACCESS_KEY`
- [ ] IAM role named exactly `remotion-lambda-role` exists with the role policy
- [ ] `.env.local` has `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_ENDPOINT`
- [ ] R2 bucket has the B5 CORS policy applied
- [ ] `AWS_REGION=eu-central-1` (already set)
- [ ] `INNGEST_DEV=1` is set in `.env.local`
- [ ] Leave `REMOTION_LAMBDA_FUNCTION_NAME`, `REMOTION_SERVE_URL`, and the Inngest event/signing keys blank
