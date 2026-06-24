import 'server-only';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { serverEnv } from '../env.server';
import type { RawProbe } from '../ingest/probe';

// Invoke the dedicated ffmpeg re-mux Lambda (Phase 6, spec 10.1) via the Lambda SDK
// (SigV4) — NOT a public Function URL. The Lambda is a DUMB executor: it downloads
// each signed input URL to the named local path, runs ffmpeg with the argv we built
// (src/lib/music/ffmpeg.ts — the tested source of truth), and PUTs each output to its
// signed URL. Keeping the argv in the app means the filter graph stays unit-tested;
// the Lambda just runs it.
//
// We pass the same {args, inputs, outputs} payload the handler expects, wrapped as a
// synthetic event with the shared-secret header (defence in depth — the SDK already
// authenticates the caller via IAM). No public endpoint is exposed.

export interface RemuxInvocation {
  args: string[]; // ffmpeg argv referencing the local paths below
  inputs: Record<string, string>; // localPath -> signed GET url (downloaded before ffmpeg)
  outputs: Record<string, string>; // localPath -> signed PUT url (uploaded after ffmpeg)
  outputContentType?: string; // content-type the PUT urls were signed with
}

export interface RemuxResult {
  ok: boolean;
  durationMs?: number;
  error?: string;
}

let cached: LambdaClient | null = null;
function client(): LambdaClient {
  if (cached) return cached;
  cached = new LambdaClient({
    region: serverEnv.aws.region,
    credentials: { accessKeyId: serverEnv.aws.accessKeyId, secretAccessKey: serverEnv.aws.secretAccessKey },
  });
  return cached;
}

export async function invokeRemux(payload: RemuxInvocation): Promise<RemuxResult> {
  const event = {
    headers: { 'x-remux-secret': serverEnv.remux.secret },
    body: JSON.stringify({ outputContentType: 'video/mp4', ...payload }),
    isBase64Encoded: false,
  };
  const out = await client().send(
    new InvokeCommand({
      FunctionName: serverEnv.remux.functionName,
      Payload: Buffer.from(JSON.stringify(event)),
    }),
  );
  if (out.FunctionError) {
    const detail = out.Payload ? Buffer.from(out.Payload).toString().slice(0, 500) : out.FunctionError;
    throw new Error(`remux Lambda crashed: ${detail}`);
  }
  if (!out.Payload) throw new Error('remux Lambda returned no payload');
  const resp = JSON.parse(Buffer.from(out.Payload).toString()) as { statusCode: number; body: string };
  const result = JSON.parse(resp.body) as RemuxResult;
  if (resp.statusCode !== 200 || !result.ok) {
    throw new Error(`remux Lambda ${resp.statusCode}: ${result.error ?? 'unknown'}`);
  }
  return result;
}

// Invoke the same ffmpeg Lambda in PROBE mode (V2 Slice 2a): one input, no argv/outputs.
// Returns the raw ffprobe JSON (parse with parseProbe). One Lambda, two modes.
export async function invokeProbe(inputUrl: string): Promise<RawProbe> {
  const event = {
    headers: { 'x-remux-secret': serverEnv.remux.secret },
    body: JSON.stringify({ mode: 'probe', inputs: { '/tmp/probe-input': inputUrl } }),
    isBase64Encoded: false,
  };
  const out = await client().send(
    new InvokeCommand({
      FunctionName: serverEnv.remux.functionName,
      Payload: Buffer.from(JSON.stringify(event)),
    }),
  );
  if (out.FunctionError) {
    const detail = out.Payload ? Buffer.from(out.Payload).toString().slice(0, 500) : out.FunctionError;
    throw new Error(`probe Lambda crashed: ${detail}`);
  }
  if (!out.Payload) throw new Error('probe Lambda returned no payload');
  const resp = JSON.parse(Buffer.from(out.Payload).toString()) as { statusCode: number; body: string };
  const result = JSON.parse(resp.body) as { ok: boolean; probe?: RawProbe; error?: string };
  if (resp.statusCode !== 200 || !result.ok || !result.probe) {
    throw new Error(`probe Lambda ${resp.statusCode}: ${result.error ?? 'unknown'}`);
  }
  return result.probe;
}
