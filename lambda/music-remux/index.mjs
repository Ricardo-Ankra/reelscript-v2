// Dedicated ffmpeg re-mux Lambda (Phase 6, spec 10.1). A DUMB executor behind a
// Function URL: the Reelscript worker POSTs the ffmpeg argv plus signed R2 in/out
// URLs; this downloads the inputs, runs ffmpeg, and PUTs the outputs back. The argv
// (the ducking filter graph) is built and unit-tested in the app
// (src/lib/music/ffmpeg.ts) — this side never decides the mix, only runs it.
//
// Auth: a shared secret header (x-remux-secret) checked against REMUX_LAMBDA_SECRET.
// Enough for V1's single operator; IAM-signed invocation is a Phase-9 hardening.
//
// Runtime: a container image (see Dockerfile) that bundles a static ffmpeg at
// /usr/local/bin/ffmpeg. Node 20 (global fetch). Writes only to /tmp (Lambda's
// writable scratch); size the function's ephemeral storage for your longest video.

import { spawn } from 'node:child_process';
import { writeFile, readFile, rm } from 'node:fs/promises';

const FFMPEG = process.env.FFMPEG_PATH || '/usr/local/bin/ffmpeg';

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'inherit', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited ${code}: ${stderr.slice(-1500)}`));
    });
  });
}

async function download(url, path) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${path}: ${res.status}`);
  await writeFile(path, Buffer.from(await res.arrayBuffer()));
}

async function upload(url, path, contentType) {
  const body = await readFile(path);
  const res = await fetch(url, { method: 'PUT', headers: { 'content-type': contentType }, body });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`upload ${path}: ${res.status} ${t.slice(0, 300)}`);
  }
}

function reply(statusCode, obj) {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) };
}

export const handler = async (event) => {
  const started = Date.now();
  const headers = event?.headers ?? {};
  const secret = headers['x-remux-secret'] ?? headers['X-Remux-Secret'];
  if (!process.env.REMUX_LAMBDA_SECRET || secret !== process.env.REMUX_LAMBDA_SECRET) {
    return reply(401, { ok: false, error: 'unauthorized' });
  }

  let payload;
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    payload = JSON.parse(raw);
  } catch {
    return reply(400, { ok: false, error: 'invalid JSON body' });
  }

  const { args, inputs = {}, outputs = {}, outputContentType = 'video/mp4' } = payload;
  if (!Array.isArray(args) || !args.length) return reply(400, { ok: false, error: 'missing ffmpeg args' });

  const touched = [...Object.keys(inputs), ...Object.keys(outputs)];
  try {
    await Promise.all(Object.entries(inputs).map(([path, url]) => download(url, path)));
    await run(FFMPEG, args);
    await Promise.all(Object.entries(outputs).map(([path, url]) => upload(url, path, outputContentType)));
    return reply(200, { ok: true, durationMs: Date.now() - started });
  } catch (err) {
    return reply(500, { ok: false, error: String(err?.message ?? err), durationMs: Date.now() - started });
  } finally {
    // Best-effort scratch cleanup so a warm container doesn't accumulate /tmp files.
    await Promise.all(touched.map((p) => rm(p, { force: true }).catch(() => {})));
  }
};
