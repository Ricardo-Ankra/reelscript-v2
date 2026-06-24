# Reelscript V2 — Slice 2a: Ingest foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `probe` mode to the ffmpeg Lambda (returns `ffprobe` JSON) plus the pure app-side ingest cores — a probe parser and ffmpeg-argv builders — so Slice 2b can orchestrate live-action conform/keyframe ingest.

**Architecture:** The existing `lambda/music-remux` Lambda is a generic argv executor; we add a `mode:'probe'` branch that runs `ffprobe` and returns its JSON, install `ffprobe` in the container, and add an `invokeProbe` client. The conform/keyframe operations are pure ffmpeg-argv builders (mirroring `src/lib/music/ffmpeg.ts`) that 2b will feed to the existing `invokeRemux`. All app logic is unit-tested; the Lambda probe path is verified by an operator redeploy + smoke.

**Tech Stack:** TypeScript, Node `node:test`, AWS Lambda (container image, ffmpeg/ffprobe static build), Cloudflare R2, the AWS Lambda SDK (`InvokeCommand`).

## Global Constraints

- **Sandbox build** — no migration / data-loss concern. **No migration this slice** (the `shots.footage_key` column is a 2b concern).
- **Additive only.** Nothing in `src/` imports the new ingest modules yet (2b wires them). The music remux path is untouched — same `invokeRemux`, same `buildRemuxArgs`, **the Lambda's default (non-probe) ffmpeg path is byte-unchanged**.
- **One Lambda, two modes.** `invokeProbe` targets the *same* function as `invokeRemux` (`serverEnv.remux.functionName`); no new infra, no new env.
- **Pure modules stay pure.** `src/lib/ingest/probe.ts` and `src/lib/ingest/ffmpeg.ts` have no runtime imports from server-only modules (type-only is fine). `RawProbe`/`ProbeResult` are defined in `probe.ts`; the server-only `remux-invoke.ts` imports `type { RawProbe }` from it (dependency points pure ← server, never the reverse).
- **Conform = cover, not pad** (`scale=…:force_original_aspect_ratio=increase, crop=W:H`). Reframe geometry uses ffmpeg runtime expressions only — **never app-side source-dimension arithmetic** (a degenerate `0×0` probe must not produce bad argv).
- **Rotation = ffmpeg default autorotate.** Do **not** emit `-noautorotate`; do **not** re-apply `probe.rotation` as a manual transpose (that double-rotates). `probe.rotation` is captured as metadata only.
- **The Lambda + `invokeProbe` are NOT unit-tested** (they need AWS) — verified by the operator `smoke:probe` after redeploy, following the `drive:remux` precedent. Plan-mandated; do not add a unit test that invokes AWS.
- **Test commands:** unit tests run with `node --experimental-strip-types --import ./scripts/register-loader.mjs --test <file>`; test files import siblings with explicit `.ts` extensions; header `import { test } from 'node:test'; import assert from 'node:assert/strict';`. App gates: `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`. Lambda gate: `node --check lambda/music-remux/index.mjs`.
- **Commit footer** (every commit): a blank line then `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

### Task 1: Pure ingest cores — probe parser + ffmpeg-argv builders

**Files:**
- Create: `src/lib/ingest/probe.ts`
- Create: `src/lib/ingest/probe.test.ts`
- Create: `src/lib/ingest/ffmpeg.ts`
- Create: `src/lib/ingest/ffmpeg.test.ts`

**Interfaces:**
- Produces: `RawProbe`, `ProbeResult`, `parseProbe(raw: RawProbe): ProbeResult` (probe.ts); `ConformInput`, `buildConformArgs(input: ConformInput): string[]`, `KeyframeInput`, `buildKeyframeArgs(input: KeyframeInput): string[]` (ffmpeg.ts).
- Consumes: `ffmpeg.ts` imports `type { ProbeResult }` from `./probe`.

- [ ] **Step 1: Write the failing test for `parseProbe`**

`src/lib/ingest/probe.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProbe } from './probe.ts';

test('parseProbe reads dims, fps, duration, audio from a full probe', () => {
  const r = parseProbe({
    streams: [
      { codec_type: 'video', width: 1920, height: 1080, avg_frame_rate: '30000/1001', duration: '12.5' },
      { codec_type: 'audio' },
    ],
    format: { duration: '12.34' },
  });
  assert.equal(r.width, 1920);
  assert.equal(r.height, 1080);
  assert.equal(r.fps, 30); // 30000/1001 ≈ 29.97 → rounds to 30
  assert.equal(r.durationSec, 12.34); // format.duration preferred
  assert.equal(r.hasAudio, true);
});

test('parseProbe falls back to stream duration when format.duration absent', () => {
  const r = parseProbe({ streams: [{ codec_type: 'video', width: 100, height: 100, duration: '5' }] });
  assert.equal(r.durationSec, 5);
  assert.equal(r.hasAudio, false);
});

test('parseProbe rotation from tags.rotate', () => {
  const r = parseProbe({ streams: [{ codec_type: 'video', width: 10, height: 10, tags: { rotate: '90' } }] });
  assert.equal(r.rotation, 90);
});

test('parseProbe rotation from side_data_list (negative → normalized)', () => {
  const r = parseProbe({
    streams: [{ codec_type: 'video', width: 10, height: 10, side_data_list: [{ rotation: -90 }] }],
  });
  assert.equal(r.rotation, 270);
});

test('parseProbe on empty/garbage never throws and returns zeros', () => {
  const r = parseProbe({});
  assert.deepEqual(r, { width: 0, height: 0, durationSec: 0, fps: 0, hasAudio: false, rotation: 0 });
});

test('parseProbe fps 0/0 → 0', () => {
  const r = parseProbe({ streams: [{ codec_type: 'video', width: 1, height: 1, avg_frame_rate: '0/0' }] });
  assert.equal(r.fps, 0);
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/ingest/probe.test.ts`
Expected: FAIL — `Cannot find module './probe.ts'`.

- [ ] **Step 3: Implement `src/lib/ingest/probe.ts`**

```ts
// Pure ffprobe-JSON normalizer (V2 Slice 2a). Never throws — every field defaults so a
// missing/garbage probe yields zeros rather than crashing the ingest pipeline (2b).
// RawProbe is the loose shape ffprobe emits; ProbeResult is the typed digest 2b uses.

export interface RawProbe {
  streams?: Array<Record<string, unknown>>;
  format?: Record<string, unknown>;
}

export interface ProbeResult {
  width: number; // first video stream width (0 if none)
  height: number; // first video stream height (0 if none)
  durationSec: number; // format.duration, else first stream duration, else 0
  fps: number; // avg_frame_rate "num/den" rounded (0 if none/0-den)
  hasAudio: boolean; // any stream codec_type === 'audio'
  rotation: number; // normalized to {0,90,180,270}; metadata only (not re-applied)
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
}

function parseFps(v: unknown): number {
  if (typeof v !== 'string' || !v.includes('/')) return 0;
  const [n, d] = v.split('/');
  const den = Number(d);
  const numr = Number(n);
  if (!Number.isFinite(den) || den === 0 || !Number.isFinite(numr)) return 0;
  return Math.round(numr / den);
}

function normalizeRotation(deg: number): number {
  const r = ((Math.round(deg) % 360) + 360) % 360;
  return r === 90 || r === 180 || r === 270 ? r : 0;
}

function videoStream(raw: RawProbe): Record<string, unknown> | null {
  return (raw.streams ?? []).find((x) => x && x.codec_type === 'video') ?? null;
}

function rotationOf(vs: Record<string, unknown> | null): number {
  if (!vs) return 0;
  const sdl = vs.side_data_list;
  if (Array.isArray(sdl)) {
    for (const sd of sdl) {
      if (sd && typeof sd === 'object' && 'rotation' in sd) {
        return normalizeRotation(num((sd as Record<string, unknown>).rotation));
      }
    }
  }
  const tags = vs.tags;
  if (tags && typeof tags === 'object' && 'rotate' in tags) {
    return normalizeRotation(num((tags as Record<string, unknown>).rotate));
  }
  return 0;
}

export function parseProbe(raw: RawProbe): ProbeResult {
  const vs = videoStream(raw);
  const fmtDur = raw.format ? num(raw.format.duration) : 0;
  return {
    width: vs ? num(vs.width) : 0,
    height: vs ? num(vs.height) : 0,
    durationSec: fmtDur > 0 ? fmtDur : vs ? num(vs.duration) : 0,
    fps: vs ? parseFps(vs.avg_frame_rate ?? vs.r_frame_rate) : 0,
    hasAudio: (raw.streams ?? []).some((x) => x && x.codec_type === 'audio'),
    rotation: rotationOf(vs),
  };
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/ingest/probe.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Write the failing test for the argv builders**

`src/lib/ingest/ffmpeg.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildConformArgs, buildKeyframeArgs } from './ffmpeg.ts';
import type { ProbeResult } from './probe.ts';

const probe = (over: Partial<ProbeResult> = {}): ProbeResult => ({
  width: 1920, height: 1080, durationSec: 10, fps: 30, hasAudio: true, rotation: 0, ...over,
});
const target = { width: 1080, height: 1920, fps: 30 };

test('buildConformArgs reframes to cover the target with fps, faststart, h264', () => {
  const a = buildConformArgs({ inPath: '/tmp/in.mp4', outPath: '/tmp/out.mp4', target, probe: probe() });
  const vf = a[a.indexOf('-vf') + 1];
  assert.match(vf, /scale=1080:1920:force_original_aspect_ratio=increase/);
  assert.match(vf, /crop=1080:1920/);
  assert.match(vf, /fps=30/);
  assert.ok(a.includes('libx264'));
  assert.ok(a.includes('+faststart'));
  assert.ok(!a.includes('-noautorotate')); // rely on default autorotate
  assert.equal(a[a.length - 1], '/tmp/out.mp4');
});

test('buildConformArgs uses aac when audio present, -an when not', () => {
  const withAudio = buildConformArgs({ inPath: 'i', outPath: 'o', target, probe: probe({ hasAudio: true }) });
  assert.ok(withAudio.includes('-c:a') && withAudio.includes('aac'));
  assert.ok(!withAudio.includes('-an'));
  const noAudio = buildConformArgs({ inPath: 'i', outPath: 'o', target, probe: probe({ hasAudio: false }) });
  assert.ok(noAudio.includes('-an'));
  assert.ok(!noAudio.includes('aac'));
});

test('buildConformArgs adds -t only when durationSec given (and > 0)', () => {
  const trimmed = buildConformArgs({ inPath: 'i', outPath: 'o', target, probe: probe(), durationSec: 4.5 });
  assert.equal(trimmed[trimmed.indexOf('-t') + 1], '4.5');
  const untrimmed = buildConformArgs({ inPath: 'i', outPath: 'o', target, probe: probe() });
  assert.ok(!untrimmed.includes('-t'));
});

test('buildConformArgs never emits source-dimension arithmetic (target dims only)', () => {
  const a = buildConformArgs({ inPath: 'i', outPath: 'o', target, probe: probe({ width: 0, height: 0 }) });
  const vf = a[a.indexOf('-vf') + 1];
  // geometry references the target (1080x1920) only — never the probe's 0x0
  assert.match(vf, /1080:1920/);
  assert.doesNotMatch(vf, /\b0:0\b/);
});

test('buildKeyframeArgs grabs a single still at the timestamp', () => {
  const a = buildKeyframeArgs({ inPath: '/tmp/in.mp4', outPath: '/tmp/k.png', atSec: 1.25 });
  assert.equal(a[a.indexOf('-ss') + 1], '1.25');
  assert.ok(a.includes('-frames:v') && a[a.indexOf('-frames:v') + 1] === '1');
  assert.equal(a[a.length - 1], '/tmp/k.png');
});
```

- [ ] **Step 6: Run it, verify it fails**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/ingest/ffmpeg.test.ts`
Expected: FAIL — `Cannot find module './ffmpeg.ts'`.

- [ ] **Step 7: Implement `src/lib/ingest/ffmpeg.ts`**

```ts
import type { ProbeResult } from './probe';

// Pure ffmpeg-argv builders for live-action ingest (V2 Slice 2a). The Lambda just runs
// the argv (mirrors src/lib/music/ffmpeg.ts), so the conform/keyframe recipes stay
// reviewable and unit-tested. Geometry is target-driven + ffmpeg runtime expressions —
// never app-side source-dim arithmetic. Rotation rides on ffmpeg's default autorotate.

export interface ConformInput {
  inPath: string;
  outPath: string;
  target: { width: number; height: number; fps: number };
  probe: ProbeResult;
  durationSec?: number; // trim output to N seconds from the start (in-point 0)
}

export interface KeyframeInput {
  inPath: string;
  outPath: string;
  atSec: number;
}

// Stable, ffmpeg-friendly float string (no exponent / trailing noise).
function f(n: number): string {
  return (Math.round(n * 1000) / 1000).toString();
}

export function buildConformArgs(input: ConformInput): string[] {
  const { inPath, outPath, target, probe, durationSec } = input;
  const vf = [
    `scale=${target.width}:${target.height}:force_original_aspect_ratio=increase`,
    `crop=${target.width}:${target.height}`,
    `fps=${target.fps}`,
  ].join(',');

  const args: string[] = ['-y', '-i', inPath, '-vf', vf];
  args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '20');
  if (probe.hasAudio) args.push('-c:a', 'aac', '-b:a', '128k');
  else args.push('-an');
  if (typeof durationSec === 'number' && durationSec > 0) args.push('-t', f(durationSec));
  args.push('-movflags', '+faststart', outPath);
  return args;
}

export function buildKeyframeArgs(input: KeyframeInput): string[] {
  // -ss before -i = fast input seek; one frame out to a PNG still.
  return ['-y', '-ss', f(input.atSec), '-i', input.inPath, '-frames:v', '1', input.outPath];
}
```

- [ ] **Step 8: Run it, verify it passes**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/ingest/ffmpeg.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 9: Commit**

```bash
git add src/lib/ingest/probe.ts src/lib/ingest/probe.test.ts src/lib/ingest/ffmpeg.ts src/lib/ingest/ffmpeg.test.ts
git commit -m "$(printf 'feat(v2): ingest cores — probe parser + ffmpeg conform/keyframe argv\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 2: Lambda probe mode + `ffprobe` in the container

**Files:**
- Modify: `lambda/music-remux/index.mjs`
- Modify: `lambda/music-remux/Dockerfile`
- Modify: `lambda/music-remux/README.md`

**Interfaces:**
- Produces (runtime contract): the Lambda accepts `{ mode: 'probe', inputs: { <path>: <signed GET url> } }` and returns `{ ok: true, probe: <ffprobe JSON> }`; the default (no `mode`, `args` present) ffmpeg path is unchanged.
- **No unit test** (AWS runtime) — gate is `node --check` + the operator smoke after redeploy.

- [ ] **Step 1: Add a stdout-capturing runner + `FFPROBE` const in `lambda/music-remux/index.mjs`**

Below the existing `const FFMPEG = process.env.FFMPEG_PATH || '/usr/local/bin/ffmpeg';` add:
```js
const FFPROBE = process.env.FFPROBE_PATH || '/usr/local/bin/ffprobe';
```
Below the existing `run(cmd, args)` function add a capturing variant (the existing `run` inherits stdout; probe must read it):
```js
function runCapture(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${cmd} exited ${code}: ${stderr.slice(-1500)}`));
    });
  });
}
```

- [ ] **Step 2: Add the probe branch in the `handler`**

The handler currently destructures the payload and then checks `args`. Change the destructure to also pull `mode`, and insert the probe branch BEFORE the `args` check. Replace:
```js
  const { args, inputs = {}, outputs = {}, outputContentType = 'video/mp4' } = payload;
  if (!Array.isArray(args) || !args.length) return reply(400, { ok: false, error: 'missing ffmpeg args' });
```
with:
```js
  const { mode, args, inputs = {}, outputs = {}, outputContentType = 'video/mp4' } = payload;

  // Probe mode: download the single input, run ffprobe, return its JSON. No argv, no
  // outputs. (V2 Slice 2a — generalizes this executor to ffmpeg + ffprobe.)
  if (mode === 'probe') {
    const entries = Object.entries(inputs);
    if (entries.length !== 1) return reply(400, { ok: false, error: 'probe needs exactly one input' });
    const [path, url] = entries[0];
    try {
      await download(url, path);
      const stdout = await runCapture(FFPROBE, [
        '-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', path,
      ]);
      return reply(200, { ok: true, probe: JSON.parse(stdout) });
    } catch (err) {
      return reply(500, { ok: false, error: String(err?.message ?? err) });
    } finally {
      await rm(path, { force: true }).catch(() => {});
    }
  }

  if (!Array.isArray(args) || !args.length) return reply(400, { ok: false, error: 'missing ffmpeg args' });
```
(Everything after — the `touched`/download/run/upload try/finally for the ffmpeg path — is unchanged.)

- [ ] **Step 3: Install `ffprobe` in the Dockerfile**

In `lambda/music-remux/Dockerfile`, the static-ffmpeg `RUN` block copies only `ffmpeg`. Add the `ffprobe` copy in the same block. Change:
```dockerfile
    cp /tmp/ffmpeg/ffmpeg /usr/local/bin/ffmpeg && chmod +x /usr/local/bin/ffmpeg && \
```
to:
```dockerfile
    cp /tmp/ffmpeg/ffmpeg /usr/local/bin/ffmpeg && chmod +x /usr/local/bin/ffmpeg && \
    cp /tmp/ffmpeg/ffprobe /usr/local/bin/ffprobe && chmod +x /usr/local/bin/ffprobe && \
```
(The johnvansickle tarball already contains `ffprobe` alongside `ffmpeg`.)

- [ ] **Step 4: Document the probe mode in the README**

In `lambda/music-remux/README.md`, under the existing "## Contract" section, add a probe subsection (place it right after the existing JSON contract block):
```markdown
### Probe mode (V2 Slice 2a)

Invoke with `{ "mode": "probe", "inputs": { "/tmp/probe-input": "<signed GET url>" } }`
(no `args`, no `outputs`). The Lambda downloads the input, runs
`ffprobe -v error -print_format json -show_streams -show_format`, and returns
`{ "ok": true, "probe": <ffprobe JSON> }`. The container now ships both `ffmpeg` and
`ffprobe`; the default (argv) ffmpeg re-mux path is unchanged.
```
Also update the top-of-file description so it reads as an "ffmpeg/ffprobe executor" rather than ffmpeg-only (a one-line edit to the opening paragraph).

- [ ] **Step 5: Syntax-check the Lambda**

Run: `node --check lambda/music-remux/index.mjs`
Expected: no output, exit 0 (valid syntax).

- [ ] **Step 6: Commit**

```bash
git add lambda/music-remux/index.mjs lambda/music-remux/Dockerfile lambda/music-remux/README.md
git commit -m "$(printf 'feat(v2): ffmpeg Lambda probe mode + ffprobe in container\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 3: `invokeProbe` client + operator probe smoke

**Files:**
- Modify: `src/lib/music/remux-invoke.ts`
- Create: `scripts/smoke-probe.ts`
- Modify: `package.json` (add the `smoke:probe` entry)

**Interfaces:**
- Consumes: `RawProbe` (type) from `../ingest/probe`; `serverEnv.remux.{functionName,secret}`; the cached `client()` + `InvokeCommand` already in `remux-invoke.ts`; `signedGetUrl` from `../r2` and `parseProbe` from `../ingest/probe` (smoke script).
- Produces: `invokeProbe(inputUrl: string): Promise<RawProbe>`; an `npm run smoke:probe -- <r2-key>` entry.
- **No unit test** (AWS) — typecheck/lint/build are the gate; the smoke is operator-run after redeploy.

- [ ] **Step 1: Add `invokeProbe` to `src/lib/music/remux-invoke.ts`**

Add the type import at the top (with the other imports):
```ts
import type { RawProbe } from '../ingest/probe';
```
Add the function below `invokeRemux` (reuses the same `client()` + secret; probe mode → one input, no outputs, no argv):
```ts
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
```

- [ ] **Step 2: Create `scripts/smoke-probe.ts`**

```ts
// Operator probe smoke (V2 Slice 2a). After redeploying the ffmpeg/ffprobe Lambda, verify
// the probe mode end-to-end: sign a GET for an R2 key, invokeProbe, print the parsed
// ProbeResult. Mirrors drive:remux (operator-run against the real Lambda).
//
// Run: npm run smoke:probe -- <r2-key>
import { signedGetUrl } from '../src/lib/r2';
import { invokeProbe } from '../src/lib/music/remux-invoke';
import { parseProbe } from '../src/lib/ingest/probe';

async function main(): Promise<void> {
  const key = process.argv[2];
  if (!key) throw new Error('Usage: npm run smoke:probe -- <r2-key>');
  const url = await signedGetUrl(key, 600);
  const raw = await invokeProbe(url);
  console.log('raw ffprobe (truncated):', JSON.stringify(raw).slice(0, 400));
  console.log('parsed ProbeResult:', parseProbe(raw));
  console.log('✓ probe ok');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 3: Add the npm script to `package.json`**

In the `scripts` block, next to the other `smoke:`/`drive:` entries, add:
```json
"smoke:probe": "node --env-file=.env.local --experimental-strip-types --import ./scripts/register-smoke-loader.mjs scripts/smoke-probe.ts",
```

- [ ] **Step 4: Gates**

Run: `npm run typecheck`
Expected: no errors.
Run: `npm run lint`
Expected: no errors.
Run: `npm run build`
Expected: success (17/17 routes).
Run: `npm test`
Expected: PASS (existing suite + Task 1's new tests; no new unit tests here).

> Do NOT run `npm run smoke:probe` — it needs the redeployed Lambda + R2 creds. It is an operator verification step (see the post-merge section), like `drive:remux`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/music/remux-invoke.ts scripts/smoke-probe.ts package.json
git commit -m "$(printf 'feat(v2): invokeProbe client + smoke:probe operator verification\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

## Operator verification (post-merge, not a subagent task)

The Lambda code change (Task 2) only takes effect after a redeploy:

1. **Redeploy** (needs Docker + AWS CLI, per `lambda/music-remux/README.md`): `node scripts/deploy-music-lambda.mjs` — rebuilds the container (now with `ffprobe`) and updates the function.
2. **Smoke:** `npm run smoke:probe -- <r2-key>` against any existing video/footage R2 key — prints the parsed `ProbeResult`. Confirms the redeployed Lambda probes and the parser shapes the result.

Until the redeploy, `invokeProbe` will hit the old function (no probe branch) and error — expected; this is the operator gate before Slice 2b builds the ingest pipeline on it.

---

## Self-Review

**1. Spec coverage:**
- §3 Lambda probe mode (`runCapture` + `mode:'probe'` branch + Dockerfile `ffprobe` + README) → Task 2. §4 `invokeProbe` → Task 3. §5 `parseProbe`/`ProbeResult`/`RawProbe` → Task 1 (probe.ts). §6 `buildConformArgs`/`buildKeyframeArgs` → Task 1 (ffmpeg.ts). §7 operator gate (redeploy + `smoke:probe`) → Operator-verification section + Task 3's script. §8 testing → unit tests in Task 1, gates in Task 3, Lambda `node --check` in Task 2. §9 back-compat (additive, ffmpeg path unchanged, music untouched) → Global Constraints. §10 file table → every row mapped to a task. §11 open items (rotation=autorotate, cover-not-pad, operator-only Lambda verify, one-Lambda-two-modes) → Global Constraints + code comments. All covered.
- **Improvement over spec §4:** `RawProbe` is defined in the pure `probe.ts`, and `remux-invoke.ts` imports it as a type — so the pure module has no server-only dependency (spec §4 sketched `RawProbe` in `remux-invoke.ts`; this is the cleaner dependency direction and is called out in Global Constraints).

**2. Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to Task N". Every code step shows complete code. The README opening-paragraph edit is a concrete one-line instruction. No vague steps.

**3. Type consistency:**
- `parseProbe(raw: RawProbe): ProbeResult` (Task 1) — consumed by `buildConformArgs`'s `probe: ProbeResult` (Task 1) and the smoke script (Task 3). ✓
- `RawProbe` defined in `probe.ts` (Task 1), imported as a type by `invokeProbe` (Task 3) returning `Promise<RawProbe>`, and by the smoke script via `parseProbe`. ✓
- `ConformInput`/`KeyframeInput` field names (`inPath`/`outPath`/`target`/`probe`/`durationSec`; `atSec`) match between the builders and their tests. ✓
- The Lambda probe contract (`{ mode:'probe', inputs:{path:url} }` → `{ ok, probe }`) written in Task 2 matches exactly what `invokeProbe` sends and parses in Task 3. ✓
- `serverEnv.remux.functionName`/`.secret`, `client()`, `InvokeCommand`, `signedGetUrl` — all pre-existing, used consistently. ✓
- `f(n)` float formatter exists in `ffmpeg.ts` (Task 1) and is used by both builders. ✓

No inconsistencies found.
