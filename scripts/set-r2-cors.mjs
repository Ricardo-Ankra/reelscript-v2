// Apply a CORS policy to the R2 bucket.
//
// WHY: the Remotion composition fetches the spec by signed URL from inside the
// render browser (calculateReelMetadata → fetch(specUrl), spec 10.3). That is a
// cross-origin browser fetch (Remotion site on S3 → spec on R2). R2 has no CORS
// by default, so the browser blocks it ("TypeError: Failed to fetch") and the
// Lambda render dies in calculateMetadata. CORS does not bypass auth — objects
// stay private and reachable only via signed URLs; this only lets the browser
// read a response it already holds a valid signed URL for.
//
// Run: npm run setup:r2-cors   (loads .env.local via node --env-file)
// Needs: R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_ENDPOINT
import { S3Client, PutBucketCorsCommand, GetBucketCorsCommand } from '@aws-sdk/client-s3';

const { R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_ENDPOINT } = process.env;
if (!R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET || !R2_ENDPOINT) {
  console.error('R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_ENDPOINT are required.');
  process.exit(2);
}

const s3 = new S3Client({
  region: 'auto',
  endpoint: R2_ENDPOINT,
  credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
});

// GET/HEAD only. AllowedOrigins '*' so it keeps working as the Remotion site
// origin changes (and when the site moves to R2 in Phase 7). Tighten to the
// specific serve origin later if desired.
const cors = {
  Bucket: R2_BUCKET,
  CORSConfiguration: {
    CORSRules: [
      {
        AllowedMethods: ['GET', 'HEAD'],
        AllowedOrigins: ['*'],
        AllowedHeaders: ['*'],
        ExposeHeaders: ['ETag', 'Content-Length'],
        MaxAgeSeconds: 3600,
      },
    ],
  },
};

async function main() {
  await s3.send(new PutBucketCorsCommand(cors));
  console.log(`Applied CORS to bucket "${R2_BUCKET}".`);
  const got = await s3.send(new GetBucketCorsCommand({ Bucket: R2_BUCKET }));
  console.log('Current rules:', JSON.stringify(got.CORSRules, null, 2));
}

main().catch((e) => {
  console.error('set-r2-cors failed:', e);
  process.exit(1);
});
