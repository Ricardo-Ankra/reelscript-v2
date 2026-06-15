// Finish deploying the music re-mux Lambda (Phase 6) once its image is in ECR.
// Ensures the IAM execution role, creates/updates the function from the image, adds a
// Function URL, and writes REMUX_LAMBDA_URL/SECRET into .env.local. Idempotent.
//
// Prereqs: image pushed to <acct>.dkr.ecr.<region>/reelscript-music-remux:latest, and
// an AWS CLI profile (default 'reelscript-admin') with admin-ish permissions.
//
// Run: node --env-file=.env.local scripts/deploy-music-lambda.mjs
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';

const AWS = process.env.AWS_BIN || 'C:/Users/ricar/AppData/Local/Programs/Python/Python313/Scripts/aws';
const PROFILE = process.env.DEPLOY_PROFILE || 'reelscript-admin';
const REGION = process.env.AWS_REGION || 'eu-central-1';
const REPO = 'reelscript-music-remux';
const ROLE = 'reelscript-remux-role';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function aws(args, { capture = true, allowFail = false } = {}) {
  try {
    return execFileSync('python', [AWS, ...args, '--profile', PROFILE], {
      encoding: 'utf8',
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'ignore',
    });
  } catch (e) {
    const msg = String(e.stderr || e.message);
    if (allowFail) return msg;
    throw new Error(`${args.slice(0, 2).join(' ')}: ${msg.slice(0, 400)}`);
  }
}

function setEnvVar(file, key, value) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  let found = false;
  const out = lines.map((l) => {
    if (l.startsWith(`${key}=`)) {
      found = true;
      return `${key}=${value}`;
    }
    return l;
  });
  if (!found) out.push(`${key}=${value}`);
  fs.writeFileSync(file, out.join('\n'));
}

async function main() {
  const account = aws(['sts', 'get-caller-identity', '--query', 'Account', '--output', 'text', '--region', REGION]).trim();
  const imageUri = `${account}.dkr.ecr.${REGION}.amazonaws.com/${REPO}:latest`;
  const roleArn = `arn:aws:iam::${account}:role/${ROLE}`;
  console.log(`account ${account}, region ${REGION}\nimage ${imageUri}`);

  // 1) IAM execution role (basic logging only — R2 is reached via signed URLs).
  const trust = JSON.stringify({
    Version: '2012-10-17',
    Statement: [{ Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' }],
  });
  aws(['iam', 'create-role', '--role-name', ROLE, '--assume-role-policy-document', trust], { allowFail: true });
  aws(['iam', 'attach-role-policy', '--role-name', ROLE, '--policy-arn', 'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'], { allowFail: true });
  console.log(`role ${ROLE} ensured`);

  // 2) Reuse an existing secret if .env.local already has one, else generate.
  const existing = (fs.readFileSync('.env.local', 'utf8').match(/^REMUX_LAMBDA_SECRET=(.+)$/m) || [])[1]?.trim();
  const secret = existing && existing.length >= 16 ? existing : randomBytes(24).toString('hex');

  // 3) Create the function (retry while the new role propagates), else update it.
  const exists = !/ResourceNotFoundException|NotFound/.test(
    aws(['lambda', 'get-function', '--function-name', REPO, '--region', REGION], { allowFail: true }),
  );
  if (!exists) {
    let created = false;
    for (let i = 0; i < 8 && !created; i++) {
      const out = aws(
        ['lambda', 'create-function', '--function-name', REPO, '--package-type', 'Image', '--code', `ImageUri=${imageUri}`,
          '--role', roleArn, '--timeout', '300', '--memory-size', '2048', '--ephemeral-storage', 'Size=4096',
          '--architectures', 'x86_64', '--environment', `Variables={REMUX_LAMBDA_SECRET=${secret}}`, '--region', REGION],
        { allowFail: true },
      );
      if (/FunctionArn|"State"/.test(out)) created = true;
      else if (/cannot be assumed|InvalidParameterValueException/.test(out)) { console.log('  role not ready, retrying…'); await sleep(6000); }
      else throw new Error(`create-function: ${out.slice(0, 400)}`);
    }
    if (!created) throw new Error('create-function failed after retries (role propagation).');
    console.log('function created');
  } else {
    aws(['lambda', 'update-function-code', '--function-name', REPO, '--image-uri', imageUri, '--region', REGION]);
    aws(['lambda', 'wait', 'function-updated', '--function-name', REPO, '--region', REGION], { allowFail: true });
    aws(['lambda', 'update-function-configuration', '--function-name', REPO, '--timeout', '300', '--memory-size', '2048',
      '--ephemeral-storage', 'Size=4096', '--environment', `Variables={REMUX_LAMBDA_SECRET=${secret}}`, '--region', REGION]);
    console.log('function updated');
  }
  aws(['lambda', 'wait', 'function-active', '--function-name', REPO, '--region', REGION], { allowFail: true });

  // 4) The app invokes this Lambda via the SDK (SigV4) — NOT a public Function URL —
  // so no URL/permission is created. Remove any leftover public URL from an earlier
  // deploy (defence in depth: no public endpoint).
  aws(['lambda', 'remove-permission', '--function-name', REPO, '--statement-id', 'FnUrlPublic', '--region', REGION], { allowFail: true });
  aws(['lambda', 'delete-function-url-config', '--function-name', REPO, '--region', REGION], { allowFail: true });

  // 5) Wire .env.local.
  setEnvVar('.env.local', 'REMUX_LAMBDA_FUNCTION_NAME', REPO);
  setEnvVar('.env.local', 'REMUX_LAMBDA_SECRET', secret);
  console.log(`\n✅ Deployed. Function "${REPO}" is live; invoked via the Lambda SDK (no public URL).\n  REMUX_LAMBDA_FUNCTION_NAME + REMUX_LAMBDA_SECRET written to .env.local (secret not printed).`);
}

main().catch((e) => {
  console.error('deploy-music-lambda failed:', e.message);
  process.exit(1);
});
