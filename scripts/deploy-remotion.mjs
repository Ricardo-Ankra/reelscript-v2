// Deploy the Remotion render infrastructure to AWS.
//   1. Deploy/ensure the Remotion Lambda function.
//   2. Ensure the Remotion S3 bucket (site host for Phase 1 — see the deferred
//      task to move the site to R2 in Phase 7).
//   3. Bundle + deploy the site (remotion/index.ts) to S3.
// Prints the function name and serve URL to put into .env.local / .env.hosted.
//
// Run: npm run deploy:remotion   (loads .env.local via node --env-file)
// Needs: AWS_REGION, REMOTION_AWS_ACCESS_KEY_ID, REMOTION_AWS_SECRET_ACCESS_KEY
// (the AWS SDK / @remotion/lambda read the REMOTION_AWS_* credentials from env).
import path from 'node:path';
import { deployFunction, deploySite, getOrCreateBucket } from '@remotion/lambda';

const region = process.env.AWS_REGION;
if (!region) {
  console.error('AWS_REGION is required.');
  process.exit(2);
}
if (!process.env.REMOTION_AWS_ACCESS_KEY_ID || !process.env.REMOTION_AWS_SECRET_ACCESS_KEY) {
  console.error('REMOTION_AWS_ACCESS_KEY_ID and REMOTION_AWS_SECRET_ACCESS_KEY are required.');
  process.exit(2);
}

const entryPoint = path.resolve('remotion/index.ts');

async function main() {
  console.log(`Region: ${region}`);

  console.log('Deploying Lambda function...');
  const { functionName } = await deployFunction({
    region,
    timeoutInSeconds: 240,
    memorySizeInMb: 2048,
    diskSizeInMb: 2048,
    createCloudWatchLogGroup: true,
  });
  console.log(`  functionName: ${functionName}`);

  console.log('Ensuring bucket...');
  const { bucketName } = await getOrCreateBucket({ region });
  console.log(`  bucketName: ${bucketName}`);

  console.log('Bundling + deploying site...');
  const { serveUrl } = await deploySite({
    entryPoint,
    bucketName,
    region,
    siteName: 'reelscript',
  });
  console.log(`  serveUrl: ${serveUrl}`);

  console.log('\nAdd these to .env.local (and .env.hosted for the deploy):');
  console.log(`REMOTION_LAMBDA_FUNCTION_NAME=${functionName}`);
  console.log(`REMOTION_SERVE_URL=${serveUrl}`);
}

main().catch((e) => {
  console.error('deploy-remotion failed:', e);
  process.exit(1);
});
