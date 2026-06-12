import 'server-only';
import { serverEnv } from '../env.server';

// Invoke the dedicated ffmpeg re-mux Lambda (Phase 6, spec 10.1) over its Function
// URL. The Lambda is a DUMB executor: it downloads each signed input URL to the named
// local path, runs ffmpeg with the argv we built (src/lib/music/ffmpeg.ts — the
// tested source of truth), and PUTs each output path to its signed URL. Keeping the
// argv in the app means the filter graph stays unit-tested; the Lambda just runs it.
//
// Auth is a shared secret header (Function URL + secret), enough for V1's single
// operator; IAM-signed invocation is a Phase-9 hardening.

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

export async function invokeRemux(payload: RemuxInvocation): Promise<RemuxResult> {
  const res = await fetch(serverEnv.remux.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-remux-secret': serverEnv.remux.secret,
    },
    body: JSON.stringify({ outputContentType: 'video/mp4', ...payload }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`remux Lambda ${res.status}: ${body.slice(0, 500)}`);
  }
  return (await res.json()) as RemuxResult;
}
