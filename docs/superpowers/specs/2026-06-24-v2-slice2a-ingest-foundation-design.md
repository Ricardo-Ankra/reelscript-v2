# Reelscript V2 — Slice 2a: Ingest foundation — Design

> **Reelscript V2 program, Slice 2 (live-action ingest), sub-slice 2a.**
> Slice 2 conforms live-action footage (probe → conform/trim/reframe → keyframe) so the
> assembly spine (Slice 3) can sequence consistent clips. It is sub-decomposed into
> **2a (foundation: Lambda probe mode + pure cores, this doc)** and **2b (the ingest
> pipeline)**. 2a delivers everything 2b orchestrates — a probe mode on the ffmpeg Lambda,
> a probe client + parser, and the pure ffmpeg-argv builders — all unit-tested, ending
> with an operator redeploy + probe smoke. **Nothing is wired into the pipeline yet.**

## 0. Context & locked decisions

- **Program runtime/data decisions** are locked in the V2 program (existing Next.js +
  Supabase + RLS + Inngest + Remotion Lambda + R2). See
  `2026-06-24-v2-slice0-shot-model-contract-design.md` §0.
- **Slice 2 decisions (this sub-slice's parents):**
  1. **Probe is included** (the most future-proof option). Self-adapting filters handle
     reframe geometry, but reliable conform needs facts only `ffprobe` gives: source
     duration (trim decisions), real dimensions (avoid upscaling tiny footage),
     **rotation metadata** (phone uploads carry a rotation flag that renders sideways if
     unhandled), and audio-track presence. This generalizes the "dumb executor" Lambda to
     **ffmpeg + ffprobe**, which Slice 3 will also use.
  2. **Sub-decompose 2a → 2b.** 2a = Lambda probe mode + Dockerfile `ffprobe` + an
     `invokeProbe` client + the pure argv builders & probe parser (unit-tested); ends with
     an operator redeploy + probe smoke. 2b = the `ingestShots` Inngest function + the
     `shots.footage_key` migration + styleRef-frame storage + a drive script.
  3. **styleRef = extract + store only** (defer wiring). 2b extracts a keyframe from each
     conformed clip and stores its R2 key; feeding it into a generative sibling's
     `styleRefUrl` defers (no generative↔live-action link in the model yet — mirrors the
     1b entity-locking deferral).
  4. **Uploaded/resource footage only.** Ingest conforms footage whose bytes are already
     in R2 (`source='resource'`); the working stock search/agentic loop is untouched;
     stock-sourced conform integrates later (Slice 3 resolve restructure).
- Sandbox build: no concern for DB migration / data loss.

## 1. Goal & non-goals

**Goal.** Ship the ingest building blocks 2b consumes: a `mode: 'probe'` branch on the
ffmpeg Lambda (returns `ffprobe` JSON) with `ffprobe` in the container; an `invokeProbe`
client; a pure `parseProbe` normalizer; and the pure ffmpeg-argv builders
`buildConformArgs` (reframe + rotation-correct + normalize + trim) and `buildKeyframeArgs`
(styleRef still). All app-side logic is unit-tested; the Lambda probe path is verified by
an operator smoke after redeploy.

**Non-goals (deferred).** No `ingestShots` Inngest function, no durable pipeline, no
`shots.footage_key` migration, no styleRef-frame storage, no drive script (2b). No
styleRef *wiring* into generation, no stock-sourced conform, no in-point/trim-window
(later). No change to `render.ts`/compose/assembly — the conformed footage is consumed at
assembly (Slice 3). Nothing renders or resolves differently this slice.

## 2. Current state (anchors)

- `lambda/music-remux/index.mjs` — the **generic argv executor** Lambda: auth via
  `x-remux-secret`; payload `{ args, inputs (localPath→signed GET), outputs
  (localPath→signed PUT), outputContentType }`; downloads inputs, runs `ffmpeg args`,
  PUTs outputs, returns `{ ok, durationMs }` (no data-return path). `run(cmd,args)` uses
  `stdio: ['ignore','inherit','pipe']` — **stdout is inherited, not captured** (probe
  must capture it).
- `lambda/music-remux/Dockerfile` — `public.ecr.aws/lambda/nodejs:20` + the johnvansickle
  static ffmpeg tarball (which **also contains `ffprobe`**); only `ffmpeg` is copied today.
- `src/lib/music/remux-invoke.ts` — `invokeRemux(payload)`: SDK (SigV4) `InvokeCommand`
  to `serverEnv.remux.functionName` with the synthetic event + secret. `client()` is a
  cached `LambdaClient`. This module is the ffmpeg-Lambda client.
- `src/lib/music/ffmpeg.ts` — `buildRemuxArgs(input): string[]`, the pure, unit-tested
  argv pattern this slice mirrors (`src/lib/music/ffmpeg.test.ts`).
- `src/lib/inngest/functions/render.ts` — `DIMS[ratio] → {width,height}` (the
  aspect→dimensions map 2b will reuse for the conform target); `settings.aspect_ratio`,
  `settings.fps`.
- `scripts/deploy-music-lambda.mjs` — the Docker build/push/update redeploy (operator,
  needs Docker + AWS CLI). `scripts/drive-remux.ts` — the operator-run-against-real-Lambda
  precedent for the probe smoke.
- Tests run with `node --experimental-strip-types --import ./scripts/register-loader.mjs
  --test <file>`; sibling imports use explicit `.ts` extensions.

## 3. Lambda probe mode — `lambda/music-remux/index.mjs`

Additive branch; the ffmpeg path is byte-unchanged.

- A stdout-capturing runner (the current `run()` inherits stdout; add `runCapture(cmd,
  args)` that buffers stdout and resolves with it, rejecting non-zero like `run`).
- Detect probe by `payload.mode === 'probe'`. When probe:
  - Require exactly one `inputs` entry (the file to probe). Download it (reuse `download`).
  - Run `ffprobe -v error -print_format json -show_streams -show_format <path>` via
    `runCapture` (`FFPROBE = process.env.FFPROBE_PATH || '/usr/local/bin/ffprobe'`).
  - `reply(200, { ok: true, probe: JSON.parse(stdout) })`. No `outputs` upload, no argv
    required for this mode.
  - Errors → `reply(500, { ok: false, error })` like the ffmpeg path; `/tmp` cleanup in
    `finally` unchanged.
- The default (non-probe) path: unchanged — `args` required, run `ffmpeg`, upload outputs,
  return `{ ok, durationMs }`.
- `Dockerfile`: add `cp /tmp/ffmpeg/ffprobe /usr/local/bin/ffprobe && chmod +x
  /usr/local/bin/ffprobe` alongside the existing `ffmpeg` copy.
- Comments/README updated from "re-mux" to "ffmpeg/ffprobe executor" framing (the function
  is now genuinely generic).

## 4. Probe client — `src/lib/music/remux-invoke.ts`

Add, beside `invokeRemux` (same `client()` + secret):

```ts
export interface RawProbe { streams?: unknown[]; format?: Record<string, unknown> }

export async function invokeProbe(inputUrl: string): Promise<RawProbe> {
  // Invoke the same Lambda in probe mode: one input, no outputs, no argv.
  const event = {
    headers: { 'x-remux-secret': serverEnv.remux.secret },
    body: JSON.stringify({ mode: 'probe', inputs: { '/tmp/probe-input': inputUrl } }),
    isBase64Encoded: false,
  };
  // …InvokeCommand to serverEnv.remux.functionName; parse {statusCode, body};
  // body → { ok, probe }; throw on non-200/!ok; return probe as RawProbe.
}
```

(The local path name is arbitrary — the Lambda only needs *a* path to download to.)

## 5. Probe parser — `src/lib/ingest/probe.ts` (+ test)

Pure, never-throws (mirrors `parseVisualBrief`/`parseCameraSpec`):

```ts
export interface ProbeResult {
  width: number;        // first video stream width (0 if none)
  height: number;       // first video stream height (0 if none)
  durationSec: number;  // format.duration (fallback first stream duration), 0 if absent
  fps: number;          // first video stream avg_frame_rate "num/den" → number (0 if none)
  hasAudio: boolean;    // any stream codec_type === 'audio'
  rotation: number;     // degrees, normalized to {0,90,180,270}; 0 if none
}
export function parseProbe(raw: RawProbe): ProbeResult
```

- `width`/`height`/`fps` from the first `codec_type==='video'` stream; `fps` parses
  `avg_frame_rate` (or `r_frame_rate`) `"num/den"` → rounded number (`0/0` → 0).
- `durationSec` from `format.duration` (string→number), else the video stream's
  `duration`, else 0.
- `hasAudio` = any stream `codec_type==='audio'`.
- `rotation` resolved from the video stream's `side_data_list[].rotation` (newer ffprobe,
  may be negative → normalize mod 360) **or** `tags.rotate`; absent → 0.
- Any missing/malformed field falls back to its default; the function never throws.

## 6. Pure ffmpeg-argv builders — `src/lib/ingest/ffmpeg.ts` (+ test)

Pure, unit-tested; the Lambda just runs the argv (mirrors `src/lib/music/ffmpeg.ts`).

### 6.1 `buildConformArgs`
```ts
export interface ConformInput {
  inPath: string;
  outPath: string;
  target: { width: number; height: number; fps: number };
  probe: ProbeResult;
  durationSec?: number; // trim output to this many seconds from the start (in-point 0)
}
export function buildConformArgs(input: ConformInput): string[]
```
Produces argv that:
- **Reframe to cover** the target via filters that use ffmpeg's *runtime* input
  dimensions, never app-side source-dim arithmetic: `scale=W:H:force_original_aspect_ratio=increase,
  crop=W:H` then `fps=FPS` (one `-vf` chain). Cover (not pad) fills the frame; the assembly
  can letterbox later if it ever wants.
- **Rotation:** rely on ffmpeg's **default autorotate** — do **not** pass `-noautorotate`.
  Autorotate uprights container-flagged rotation *before* the `-vf` chain, so `scale`/`crop`
  operate on the upright frame and the output is correctly oriented. `probe.rotation` is
  **not** re-applied as a manual transpose here (that would double-rotate); it is captured
  by `parseProbe` as metadata/validation and for future assembly use.
- **Normalize codec:** `-c:v libx264 -pix_fmt yuv420p -preset veryfast -crf 20`; audio
  `-c:a aac -b:a 128k` when `probe.hasAudio`, else `-an`.
- **Trim:** `-t durationSec` when provided (output bounded; in-point 0).
- `-movflags +faststart`, `-y`, `outPath`.

`probe` is consumed in 2a only for `hasAudio` (the `-an` vs `-c:a aac` branch); the full
`ProbeResult` is passed for forward use. The builder never divides by or interpolates
source dimensions — all geometry is target-driven + ffmpeg runtime expressions — so a
degenerate `0×0` probe cannot produce bad argv.

Tested: scale+crop+fps present for the target; `-an` when `!hasAudio` and `-c:a aac` when
`hasAudio`; `-t` present only when `durationSec` given; `-noautorotate` is never emitted;
argv contains no source-dimension arithmetic (target dims only).

### 6.2 `buildKeyframeArgs`
```ts
export interface KeyframeInput { inPath: string; outPath: string; atSec: number }
export function buildKeyframeArgs(input: KeyframeInput): string[]
```
`['-y','-ss', f(atSec), '-i', inPath, '-frames:v','1', outPath]` (single PNG still at
`atSec`). Tested: `-ss` + `-frames:v 1` present; `atSec` formatted stably.

## 7. Operator gate (end of 2a)

1. **Redeploy** the Lambda: `node scripts/deploy-music-lambda.mjs` (Docker build/push +
   function update) so the probe branch + `ffprobe` are live. (Operator step — needs
   Docker + AWS CLI; documented in `lambda/music-remux/README.md`.)
2. **Probe smoke:** `scripts/smoke-probe.ts` (+ `npm run smoke:probe -- <r2-key>`): signs
   a GET for the R2 key, calls `invokeProbe`, prints `parseProbe(raw)`. Confirms the
   redeployed Lambda probes and the parser shapes the result. Mirrors `drive:remux`
   (operator-run against the real Lambda).

## 8. Testing

- **Unit (node:test):** `parseProbe` (dims/duration/fps/audio/rotation incl. `tags.rotate`
  and `side_data_list` variants + missing-field defaults); `buildConformArgs` (reframe +
  fps + trim + audio branch + no `-noautorotate` + target-dims-only/zero-probe safety);
  `buildKeyframeArgs`.
- **Lambda probe mode + `invokeProbe`:** proven by the operator `smoke:probe` after
  redeploy (real Lambda; following the `drive:remux` precedent — Lambda I/O is not
  unit-tested).
- **Gates:** `npm test`, `npm run typecheck`, `npm run lint`, `npm run build` all green.
- **No migration** (the `shots.footage_key` column is a 2b concern).

## 9. Backward compatibility

Additive: new modules `src/lib/ingest/probe.ts` + `src/lib/ingest/ffmpeg.ts`, one new
export in `remux-invoke.ts`, an additive probe branch on the Lambda (the ffmpeg path
byte-unchanged), a Dockerfile line, a smoke script. Nothing in `src/` imports the new
modules yet (2b wires them). The music remux path is untouched (same `invokeRemux`, same
`buildRemuxArgs`, same default Lambda mode). No behavior change to compose/render/
script-gen/readiness.

## 10. File structure (drives the plan)

| File | Responsibility |
| --- | --- |
| `lambda/music-remux/index.mjs` (modify) | add the `mode:'probe'` branch + `runCapture` |
| `lambda/music-remux/Dockerfile` (modify) | also install `ffprobe` |
| `lambda/music-remux/README.md` (modify) | document the probe mode + ffmpeg/ffprobe framing |
| `src/lib/music/remux-invoke.ts` (modify) | add `invokeProbe` + `RawProbe` |
| `src/lib/ingest/probe.ts` (+ test) (create) | `parseProbe(raw) → ProbeResult` |
| `src/lib/ingest/ffmpeg.ts` (+ test) (create) | `buildConformArgs`, `buildKeyframeArgs` |
| `scripts/smoke-probe.ts` (create) + `package.json` (modify) | operator probe smoke |

## 11. Open items (resolved-by-default; flagged for the plan)

- Rotation is handled by ffmpeg's default autorotate (the conform output is upright);
  `parseProbe.rotation` is captured as metadata/validation, not re-applied in 2a's conform
  argv (avoids double-rotation). A source needing manual de-rotation beyond autorotate is a
  later refinement if it ever surfaces.
- Conform uses **cover** (scale-to-fill + crop), not pad — matches a full-frame social
  video. Letterboxing, if ever wanted, is an assembly-time choice (Slice 3).
- The probe smoke + redeploy are operator steps; CI/subagents verify only the pure cores +
  gates (the Lambda I/O needs AWS, like `drive:remux`).
- `invokeProbe` targets the same function as `invokeRemux` (`serverEnv.remux.functionName`)
  — one Lambda, two modes. No new infra.
