import 'server-only';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { serverEnv } from './env.server';

// Cloudflare R2 is S3-compatible. region 'auto' is the R2 convention.
let cached: S3Client | null = null;
function client(): S3Client {
  if (cached) return cached;
  cached = new S3Client({
    region: 'auto',
    endpoint: serverEnv.r2.endpoint,
    credentials: {
      accessKeyId: serverEnv.r2.accessKeyId,
      secretAccessKey: serverEnv.r2.secretAccessKey,
    },
  });
  return cached;
}

export async function putObject(
  key: string,
  body: Uint8Array | Buffer | string,
  contentType: string,
): Promise<string> {
  await client().send(
    new PutObjectCommand({
      Bucket: serverEnv.r2.bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
  return key;
}

/** Signed PUT URL for a direct client upload (Phase 5 channel resources). The
 *  uploader MUST send the same Content-Type it was signed with, or the signature
 *  fails. Short TTL — the URL is used immediately after it is handed out. */
export async function signedPutUrl(
  key: string,
  contentType: string,
  expiresInSeconds = 600,
): Promise<string> {
  return getSignedUrl(
    client(),
    new PutObjectCommand({ Bucket: serverEnv.r2.bucket, Key: key, ContentType: contentType }),
    { expiresIn: expiresInSeconds },
  );
}

/** Delete one R2 object. Used by regenerate's clear-first to remove a wiped scene's
 *  audio; callers treat failures as best-effort. */
export async function deleteObject(key: string): Promise<void> {
  await client().send(new DeleteObjectCommand({ Bucket: serverEnv.r2.bucket, Key: key }));
}

/** Signed GET URL for a private R2 object. Default 1h; pass a longer TTL for
 *  spec pointers that must outlive a queued render (spec 10.3). */
export async function signedGetUrl(
  key: string,
  expiresInSeconds = 3600,
): Promise<string> {
  return getSignedUrl(
    client(),
    new GetObjectCommand({ Bucket: serverEnv.r2.bucket, Key: key }),
    { expiresIn: expiresInSeconds },
  );
}

/** Fetch a remote URL and store its bytes in R2 under `key`. Used to persist
 *  generation/ingest results whose source URLs expire (e.g. Higgsfield ~1h).
 *  Returns the key. */
export async function streamUrlToR2(
  url: string,
  key: string,
  contentType?: string,
): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`streamUrlToR2 fetch ${res.status} for ${key}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  return putObject(key, bytes, contentType ?? res.headers.get('content-type') ?? 'application/octet-stream');
}
