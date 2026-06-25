# Reelscript V2 — Slice 4: Human gates (G2 preview) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in human **preview gate** that pauses a render after the graded base MP4 and waits for the operator to Approve (→ music + finalize) or Reject (→ terminate, recoverable) in-app, plus a reusable `runGate` primitive (Slice 6 reuses it for the storyboard gate).

**Architecture:** A pure gate vocabulary module (`gates/gate.ts`) + an Inngest `runGate` helper that pauses the job (`status='paused'` + a phase string) and `step.waitForEvent`s for a `pipeline/gate.resolved` event correlated on `jobId`. `preview_gate` joins the `VideoSettings` contract (rides the channel-default ⊕ override machinery; no migration). `renderVideo` inserts the gate between the graded base and the music/finalize branch. The editor's existing render poll surfaces the pause + the base preview; an `approve`/`reject` server action sends the resume event. Gate state lives entirely on the existing `jobs` row (no schema change).

**Tech Stack:** TypeScript, Next.js (App Router) server actions + client components, Supabase (jsonb settings + Realtime), Inngest `^4.5.0` (`step.waitForEvent` — first usage), Remotion Lambda render, R2, `node:test` unit tests.

## Global Constraints

- **No migration.** Gate state = the existing `jobs.status='paused'` enum value (written by nothing today) + `phase` strings. `preview_gate` lives in `videos.settings`/`channels.defaults` jsonb.
- **Gate vocabulary is the single source of truth (`src/lib/gates/gate.ts`):** `GateKind='storyboard'|'preview'`; `GateDecision='approve'|'reject'`; `GATE_EVENT='pipeline/gate.resolved'`; `GATE_TIMEOUT='7d'`; `GATE_PHASE={storyboard:'awaiting_storyboard_review', preview:'awaiting_preview_review'}`.
- **Naming:** the human gate uses `runGate`, step ids `enter-gate-<kind>` / `human-gate-<kind>` / `reject-preview` / `resume-after-preview`, event `pipeline/gate.resolved`. Do NOT touch or reuse the existing AUTOMATED steps named `gate1`/`gate2`/`mark-gate2-failed`/`runGate2` (compose-validation + smoke-frame QA).
- **Opt-in, default off.** `preview_gate` defaults `false`. A render with it off is byte-identical to today (no pause, no extra step).
- **Safe-default decision:** a timeout or malformed resume event resolves to `reject` (an unreviewed render never silently ships).
- **Reject terminates the render** with `error={phase:'preview_gate', message:'Preview rejected by operator'}` (the structured shape Slice A's `RenderErrorCard` renders); recoverable by edit + re-render. No auto-revise loop.
- **Preview is the graded base** (`renders.base_output_r2_key`), pre-music.
- **Pure modules stay pure** (no react/server-only/network): `gates/gate.ts`, `videos/settings.ts`, `channels/brand.ts`, `jobs/monitor.ts`. Modules unit-tested under `node:test` MUST import siblings via RELATIVE paths (the loader does not apply the `@/` alias). Build-only files (server actions, client components, `render.ts`) use the `@/` alias.
- **Test command:** `npm test` = `node --experimental-strip-types --import ./scripts/register-loader.mjs --test "src/**/*.test.ts"`. Tests use `import { test } from 'node:test'`, `import assert from 'node:assert/strict'`, and import the module under test with the `.ts` extension. **Run the FULL `npm test` (not a scoped `--test-name-pattern`) whenever you change a shared contract** (`settings.ts`/`brand.ts`) — full-shape `deepEqual` assertions in other files can drift (a real Slice-3b regression).
- **Gates that must stay green:** `npm test`, `npm run typecheck`, `npm run lint`, `npm run build` (17/17 routes).

---

## File structure

| File | Task | Responsibility |
| --- | --- | --- |
| `src/lib/gates/gate.ts` (create) + `gate.test.ts` (create) | 1 | gate vocab + `parseGateDecision`/`gateResolution` |
| `src/lib/videos/settings.ts` (modify) + `settings.test.ts` (modify) + `create-settings.test.ts` (modify) | 2 | `preview_gate` on the settings contract |
| `src/lib/inngest/functions/render.ts` (modify) | 3 | `runGate` helper + `resolve-preview-gate` + the preview-gate branch |
| `src/app/(app)/videos/[id]/gate-actions.ts` (create) + `render-actions.ts` (modify) | 4 | `resolveGate` action + `getRenderState` surfaces the gate + base preview |
| `src/app/(app)/videos/[id]/Editor.tsx` (modify) | 5 | preview-review banner (base video + Approve/Reject) |
| `src/app/(app)/videos/[id]/VideoSettingsPanel.tsx` (modify) + `channels/[id]/BrandEditor.tsx` (modify) + `lib/channels/brand.ts` (modify) + `brand.test.ts` (modify) | 6 | per-video toggle + channel default |
| `src/lib/jobs/monitor.ts` (modify) + `monitor.test.ts` (modify) + `src/app/(app)/jobs/JobsList.tsx` (modify) | 7 | `isAwaitingPreview`/`gatePhaseLabel` + paused-gate label & Review link |

---

## Task 1: Gate primitive — `src/lib/gates/gate.ts`

**Files:**
- Create: `src/lib/gates/gate.ts`
- Test: `src/lib/gates/gate.test.ts`

**Interfaces:**
- Consumes: nothing (leaf pure module).
- Produces: `GateKind`, `GateDecision`, `GATE_EVENT`, `GATE_TIMEOUT`, `GATE_PHASE`, `parseGateDecision(raw): GateDecision|null`, `gateResolution(event): GateDecision`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/gates/gate.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GATE_EVENT,
  GATE_TIMEOUT,
  GATE_PHASE,
  parseGateDecision,
  gateResolution,
} from './gate.ts';

test('gate constants', () => {
  assert.equal(GATE_EVENT, 'pipeline/gate.resolved');
  assert.equal(GATE_TIMEOUT, '7d');
  assert.equal(GATE_PHASE.storyboard, 'awaiting_storyboard_review');
  assert.equal(GATE_PHASE.preview, 'awaiting_preview_review');
});

test('parseGateDecision accepts the two decisions, rejects anything else', () => {
  assert.equal(parseGateDecision('approve'), 'approve');
  assert.equal(parseGateDecision('reject'), 'reject');
  assert.equal(parseGateDecision('bogus'), null);
  assert.equal(parseGateDecision(undefined), null);
  assert.equal(parseGateDecision(1), null);
});

test('gateResolution: null (timeout) and malformed → reject; valid passes through', () => {
  assert.equal(gateResolution(null), 'reject');
  assert.equal(gateResolution({ data: { decision: 'approve' } }), 'approve');
  assert.equal(gateResolution({ data: { decision: 'reject' } }), 'reject');
  assert.equal(gateResolution({ data: { decision: 'bogus' } }), 'reject');
  assert.equal(gateResolution({ data: {} }), 'reject');
  assert.equal(gateResolution({}), 'reject');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --test-name-pattern="gate"`
Expected: FAIL (`Cannot find module './gate.ts'`).

- [ ] **Step 3: Write the implementation**

Create `src/lib/gates/gate.ts`:

```ts
// Human-gate vocabulary (V2 Slice 4). PURE — no react/server/network. The single source
// of the gate kinds, the resume-event name, the durable phase labels, and the decision
// parsing. The Inngest `runGate` helper (render.ts) and the resolveGate action consume
// these. Distinct from the AUTOMATED gate1/gate2 (compose-validation + smoke-frame QA) in
// render.ts — those are machine checks, these are human-in-the-loop.

export type GateKind = 'storyboard' | 'preview';
export type GateDecision = 'approve' | 'reject';

// The event the in-app Approve/Reject UI sends; the suspended function waits for it.
export const GATE_EVENT = 'pipeline/gate.resolved';
// Inngest duration string. On expiry the wait resolves to null → reject (never ship
// an unreviewed render).
export const GATE_TIMEOUT = '7d';

// The jobs.phase string written while a run is paused at each gate.
export const GATE_PHASE: Record<GateKind, string> = {
  storyboard: 'awaiting_storyboard_review',
  preview: 'awaiting_preview_review',
};

// Never-throws. Validates an incoming event's decision field.
export function parseGateDecision(raw: unknown): GateDecision | null {
  return raw === 'approve' || raw === 'reject' ? raw : null;
}

// Maps a waitForEvent result to a decision. null (timeout / no match) → 'reject';
// a malformed decision → 'reject' (safe default).
export function gateResolution(event: { data?: { decision?: unknown } } | null): GateDecision {
  if (!event) return 'reject';
  return parseGateDecision(event.data?.decision) ?? 'reject';
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- --test-name-pattern="gate"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/gates/gate.ts src/lib/gates/gate.test.ts
git commit -m "feat(v2): human-gate primitive (parseGateDecision/gateResolution) — Slice 4 Task 1"
```

---

## Task 2: `preview_gate` on the settings contract — `src/lib/videos/settings.ts`

**Files:**
- Modify: `src/lib/videos/settings.ts`
- Modify: `src/lib/videos/settings.test.ts`
- Modify: `src/lib/videos/create-settings.test.ts`

**Interfaces:**
- Consumes: nothing new (a plain boolean key).
- Produces: `VideoSettings.preview_gate: boolean`, `VideoSettingsPatch.preview_gate?: boolean`, `SETTINGS_DEFAULTS.preview_gate = false`. `sanitizeSettingsPatch`/`parseVideoSettings` keep their signatures; `create-settings.ts` inherits the key with no change.

**Context:** Mirror the existing `music_on` boolean exactly. Then fix the two full-shape `deepEqual` assertions in `create-settings.test.ts` that will otherwise break (they assert the entire `VideoSettings` shape, which now includes `preview_gate`).

- [ ] **Step 1: Write the failing test**

Append to `src/lib/videos/settings.test.ts`:

```ts
test('preview_gate default is false', () => {
  assert.equal(SETTINGS_DEFAULTS.preview_gate, false);
  assert.equal(parseVideoSettings({}).preview_gate, false);
});

test('sanitizeSettingsPatch keeps a boolean preview_gate, drops non-boolean', () => {
  assert.equal(sanitizeSettingsPatch({ preview_gate: true }).preview_gate, true);
  assert.equal('preview_gate' in sanitizeSettingsPatch({ preview_gate: 'yes' }), false);
});

test('parseVideoSettings round-trips preview_gate', () => {
  assert.equal(parseVideoSettings({ preview_gate: true }).preview_gate, true);
});
```

(If `SETTINGS_DEFAULTS`/`sanitizeSettingsPatch`/`parseVideoSettings` are not already imported at the top of `settings.test.ts`, add them to the existing import from `./settings.ts`.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --test-name-pattern="preview_gate"`
Expected: FAIL (`preview_gate` not on `SETTINGS_DEFAULTS`).

- [ ] **Step 3: Edit `src/lib/videos/settings.ts`**

Add to `VideoSettingsPatch` (after `color_look?: ColorLook;`):

```ts
  color_look?: ColorLook;
  preview_gate?: boolean;
```

Add to `VideoSettings` (after `color_look: ColorLook;`):

```ts
  color_look: ColorLook;
  preview_gate: boolean;
```

Add to `SETTINGS_DEFAULTS` (after `color_look: DEFAULT_COLOR_LOOK,`):

```ts
  color_look: DEFAULT_COLOR_LOOK,
  preview_gate: false,
```

In `sanitizeSettingsPatch`, add next to the other boolean checks (after the `music_on` line):

```ts
  if (typeof p.music_on === 'boolean') out.music_on = p.music_on;
  if (typeof p.preview_gate === 'boolean') out.preview_gate = p.preview_gate;
```

`parseVideoSettings` needs no change (it spreads `sanitizeSettingsPatch` over `SETTINGS_DEFAULTS`).

- [ ] **Step 4: Fix the two full-shape assertions in `create-settings.test.ts`**

In `src/lib/videos/create-settings.test.ts`, the test `'parseChannelCreateOptions: reads the channel-stored full option set'` has an `assert.deepEqual(out, {...})` — add `preview_gate: false,` to that expected object (the input doesn't set it → default false). The test `'mergeCreateSettings: valid override wins per key'` has an `assert.deepEqual(out, {...})` — add `preview_gate: false,` to that expected object too (the override doesn't set it → base default preserved).

- [ ] **Step 5: Run the targeted tests, then the FULL suite**

Run: `npm test -- --test-name-pattern="preview_gate|parseChannelCreateOptions|mergeCreateSettings"`
Expected: PASS.

Run: `npm test`
Expected: `# fail 0` (confirm no other full-shape assertion drifted).

- [ ] **Step 6: Typecheck + commit**

Run: `npm run typecheck`
Expected: no errors.

```bash
git add src/lib/videos/settings.ts src/lib/videos/settings.test.ts src/lib/videos/create-settings.test.ts
git commit -m "feat(v2): preview_gate on the settings contract — Slice 4 Task 2"
```

---

## Task 3: Render integration — `runGate` + preview-gate branch in `render.ts`

**Files:**
- Modify: `src/lib/inngest/functions/render.ts`

**Interfaces:**
- Consumes: `GateKind`, `GateDecision`, `GATE_EVENT`, `GATE_TIMEOUT`, `GATE_PHASE`, `gateResolution` from `@/lib/gates/gate` (Task 1); `parseVideoSettings` from `@/lib/videos/settings` (already imported by Slice 3b); `createAdminClient`, `step`, `admin`, `jobId`, `renderId`, `videoId` (in scope).
- Produces: no exported API change. When `preview_gate` is on, the run pauses the job and waits before the music/finalize branch.

**Context:** This is an Inngest function. `parseVideoSettings` is already imported (Slice 3b's `resolve-color-look`). `runGate`'s `step` param is typed `any` and carries an eslint-disable, matching the existing `runLambdaSpine(step: any, …)` helper in this file. The `step.waitForEvent` `if` compares the awaited event (`async`) to the function's trigger event (`event` = `render/start`, whose `data.jobId` is this render's job). No unit test for this task (Inngest/DB I/O, matching the pipeline precedent); the pure core (`gateResolution`) is tested in Task 1. Verify via typecheck + full suite + build.

- [ ] **Step 1: Add the import**

Near the other `@/lib/...` imports at the top of `src/lib/inngest/functions/render.ts`:

```ts
import { GATE_EVENT, GATE_TIMEOUT, GATE_PHASE, gateResolution, type GateKind, type GateDecision } from '@/lib/gates/gate';
```

- [ ] **Step 2: Add the `runGate` helper**

In the helpers section near the bottom of the file (alongside `runLambdaSpine`), add:

```ts
// Human gate (V2 Slice 4): pause the job durably, then suspend the run waiting for the
// in-app Approve/Reject event (correlated on jobId — the same key cancelOn uses, so a
// jobs/cancel still cancels a run suspended here). A timeout/malformed event → reject.
// `step` is `any` to match runLambdaSpine (Inngest's step types are awkward to thread).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runGate(step: any, admin: ReturnType<typeof createAdminClient>, opts: { jobId: string; kind: GateKind }): Promise<GateDecision> {
  await step.run(`enter-gate-${opts.kind}`, async () => {
    await admin.from('jobs').update({ status: 'paused', phase: GATE_PHASE[opts.kind] }).eq('id', opts.jobId);
  });
  const ev = await step.waitForEvent(`human-gate-${opts.kind}`, {
    event: GATE_EVENT,
    timeout: GATE_TIMEOUT,
    if: 'async.data.jobId == event.data.jobId',
  });
  return gateResolution(ev as { data?: { decision?: unknown } } | null);
}
```

- [ ] **Step 3: Insert the preview-gate branch before the music/finalize branch**

In `renderVideo`, immediately before the `// --- music: re-mux onto the base …` comment / the `if (composed.musicTrackId) {` block (this is after `finalize-base`, the Slice-3b grade step, and the caption-sidecars block), insert:

```ts
    // --- G2 preview gate (V2 Slice 4) — opt-in human approval of the graded base ------
    // Off by default ⇒ this whole block is skipped ⇒ byte-identical to today. On ⇒ the
    // job pauses (status='paused', phase='awaiting_preview_review') until the operator
    // approves (continue to music/finalize) or rejects (terminate, recoverable).
    const previewGate = await step.run('resolve-preview-gate', async () => {
      const { data: v } = await admin.from('videos').select('settings').eq('id', videoId).single();
      return parseVideoSettings(v?.settings).preview_gate;
    });
    if (previewGate) {
      const decision = await runGate(step, admin, { jobId, kind: 'preview' });
      if (decision === 'reject') {
        await step.run('reject-preview', async () => {
          const error = { phase: 'preview_gate', message: 'Preview rejected by operator' };
          await admin.from('renders').update({ status: 'failed', error }).eq('id', renderId);
          await admin.from('jobs').update({ status: 'failed', phase: 'failed', error }).eq('id', jobId);
        });
        return { renderId, failed: 'preview_gate' as const };
      }
      await step.run('resume-after-preview', async () => {
        // Clear the paused state (rendering already finished); the music/finalize branch
        // sets the next phase. A non-terminal 'encoding' holding label, no new enum value.
        await admin.from('jobs').update({ status: 'running', phase: 'encoding' }).eq('id', jobId);
      });
    }
```

- [ ] **Step 4: Typecheck, build, full suite**

Run: `npm run typecheck`
Expected: no errors.

Run: `npm test`
Expected: `# fail 0`.

Run: `npm run build`
Expected: 17/17 routes.

- [ ] **Step 5: Commit**

```bash
git add src/lib/inngest/functions/render.ts
git commit -m "feat(v2): G2 preview gate in renderVideo (runGate + waitForEvent) — Slice 4 Task 3"
```

---

## Task 4: `resolveGate` action + `getRenderState` surfaces the gate

**Files:**
- Create: `src/app/(app)/videos/[id]/gate-actions.ts`
- Modify: `src/app/(app)/videos/[id]/render-actions.ts`

**Interfaces:**
- Consumes: `GATE_EVENT`, `GATE_PHASE`, `GateDecision` from `@/lib/gates/gate`; `signedGetUrl` from `@/lib/r2`; `createClient` from `@/lib/supabase/server`; `inngest`.
- Produces: `resolveGate(jobId: string, decision: GateDecision): Promise<{ok:true}|{ok:false;reason:string}>`. `getRenderState` return type GAINS `awaitingPreview: boolean`, `previewUrl: string | null`, `jobId: string | null` (additive — existing callers that destructure `{status,url,error}` are unaffected).

**Context:** `resolveGate` mirrors `cancelJob` (`src/app/(app)/jobs/actions.ts`): account-scoped ownership check, then `inngest.send`. It does NOT write the row — the suspended function performs the status transition on resume. `getRenderState` is polled by the editor every 3s while a render is active; it learns the gate state from the render's job row and signs `base_output_r2_key` for the preview.

- [ ] **Step 1: Create `src/app/(app)/videos/[id]/gate-actions.ts`**

```ts
'use server';

import { createClient } from '@/lib/supabase/server';
import { inngest } from '@/lib/inngest/client';
import { GATE_EVENT, type GateDecision } from '@/lib/gates/gate';

// Resolve a human gate: send the resume event (the suspended render function wakes and
// transitions the job/render). Account-scoped; only a paused job can be resolved. Mirrors
// cancelJob (send-then-let-the-function-transition; no optimistic row write here because
// the function is actively waiting and owns the transition).
export async function resolveGate(
  jobId: string,
  decision: GateDecision,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const supabase = await createClient();
  const { data: account } = await supabase.from('accounts').select('id').maybeSingle();
  if (!account) return { ok: false, reason: 'No account found.' };
  const accountId = account.id as string;

  const { data: job } = await supabase
    .from('jobs')
    .select('id, status')
    .eq('id', jobId)
    .eq('account_id', accountId)
    .maybeSingle();
  if (!job) return { ok: false, reason: 'Job not found.' };
  if (job.status !== 'paused') return { ok: false, reason: 'Job is not awaiting review.' };

  try {
    await inngest.send({ name: GATE_EVENT, data: { jobId, accountId, decision } });
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : 'Could not submit decision.' };
  }
  return { ok: true };
}
```

- [ ] **Step 2: Extend `getRenderState` in `src/app/(app)/videos/[id]/render-actions.ts`**

Add the import (top of file, after the existing imports):

```ts
import { GATE_PHASE } from '@/lib/gates/gate';
```

Replace the `getRenderState` function (currently lines ~131–151) with:

```ts
// Polled/subscribed by the editor; returns a signed playback URL once complete, plus the
// preview-gate state (the render's job paused at the preview gate) + a signed URL of the
// graded base for in-editor preview. Additive fields — existing callers ignore them.
export async function getRenderState(
  renderId: string,
): Promise<{
  status: string;
  url: string | null;
  error: unknown;
  awaitingPreview: boolean;
  previewUrl: string | null;
  jobId: string | null;
}> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('renders')
    .select('status, output_r2_key, base_output_r2_key, error')
    .eq('id', renderId)
    .single();
  if (error || !data) throw new Error(error?.message ?? 'render not found');

  let url: string | null = null;
  if (data.status === 'complete' && data.output_r2_key) {
    url = await signedGetUrl(data.output_r2_key as string, 60 * 60);
  }

  // Gate state lives on the job (status='paused' + phase). Surface it + the graded base.
  const { data: job } = await supabase
    .from('jobs')
    .select('id, status, phase')
    .eq('render_id', renderId)
    .maybeSingle();
  const awaitingPreview = job?.status === 'paused' && job?.phase === GATE_PHASE.preview;
  let previewUrl: string | null = null;
  if (awaitingPreview && data.base_output_r2_key) {
    previewUrl = await signedGetUrl(data.base_output_r2_key as string, 60 * 60);
  }

  return {
    status: data.status as string,
    url,
    error: data.error ?? null,
    awaitingPreview: Boolean(awaitingPreview),
    previewUrl,
    jobId: (job?.id as string | null) ?? null,
  };
}
```

- [ ] **Step 3: Typecheck + build**

Run: `npm run typecheck`
Expected: no errors (the three `getRenderState` callers destructure a subset, so additive fields are safe).

Run: `npm run build`
Expected: 17/17 routes.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/videos/[id]/gate-actions.ts" "src/app/(app)/videos/[id]/render-actions.ts"
git commit -m "feat(v2): resolveGate action + getRenderState surfaces the preview gate — Slice 4 Task 4"
```

---

## Task 5: Editor preview-review banner — `Editor.tsx`

**Files:**
- Modify: `src/app/(app)/videos/[id]/Editor.tsx`

**Interfaces:**
- Consumes: `resolveGate` from `./gate-actions`; the extended `getRenderState` (Task 4) returning `awaitingPreview`/`previewUrl`/`jobId`.
- Produces: no exports. Renders an Approve/Reject banner over the graded base while the render is paused at the preview gate.

**Context:** The editor already polls `getRenderState(renderId)` every 3s (the `useEffect` at ~line 403). Add three state slots, set them in the poll tick, and render a banner inside the existing render-status card (the `ordered.length > 0` block at ~line 539) between `{renderError && …}` and `{renderUrl && …}`.

- [ ] **Step 1: Add the import**

With the other `./`-action imports near the top (e.g. after `import { startVideoRender, getRenderState } from './render-actions';`):

```ts
import { resolveGate } from './gate-actions';
```

- [ ] **Step 2: Add state slots**

After the existing render state (after `const [renderElapsed, setRenderElapsed] = useState(0);` ~line 74), add:

```ts
  const [awaitingPreview, setAwaitingPreview] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewJobId, setPreviewJobId] = useState<string | null>(null);
  const [gateBusy, setGateBusy] = useState(false);
```

- [ ] **Step 3: Set the gate state in the poll tick**

In the render poll `useEffect` (~line 407), inside `tick`, after `if (s.url) setRenderUrl(s.url);`, add:

```ts
        setAwaitingPreview(s.awaitingPreview);
        setPreviewUrl(s.previewUrl);
        setPreviewJobId(s.jobId);
```

- [ ] **Step 4: Add the resolve handler**

Near the other `useCallback`s (e.g. after `handleGenerate`), add:

```ts
  const onResolveGate = useCallback(async (decision: 'approve' | 'reject') => {
    if (!previewJobId) return;
    setGateBusy(true);
    try {
      const res = await resolveGate(previewJobId, decision);
      // On success the render poll/Realtime reconciles: approve → render continues;
      // reject → render becomes failed (the RenderErrorCard shows). Clear optimistically.
      if (res.ok) setAwaitingPreview(false);
    } finally {
      setGateBusy(false);
    }
  }, [previewJobId]);
```

- [ ] **Step 5: Render the banner**

In the render-status card (the `ordered.length > 0` block ~line 539), immediately after `{renderError && <RenderErrorCard error={renderError} />}` and before `{renderUrl && (`, add:

```tsx
          {awaitingPreview && previewUrl && (
            <div className="space-y-2 rounded-md border border-blue-500/40 bg-blue-500/10 p-2 text-xs">
              <p className="font-medium">Preview ready — approve to finish, or reject to discard this render.</p>
              <video
                key={previewUrl}
                src={previewUrl}
                controls
                className="w-full rounded-md border border-black/10 dark:border-white/10"
              />
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  disabled={gateBusy}
                  onClick={() => onResolveGate('reject')}
                  className="rounded-md border border-red-500/40 px-2.5 py-1 font-medium text-red-600 enabled:hover:bg-red-500/10 disabled:opacity-40"
                >
                  {gateBusy ? 'Working…' : 'Reject'}
                </button>
                <button
                  type="button"
                  disabled={gateBusy}
                  onClick={() => onResolveGate('approve')}
                  className="rounded-md border border-black/15 px-2.5 py-1 font-medium enabled:hover:bg-black/[0.04] disabled:opacity-40 dark:border-white/20 dark:enabled:hover:bg-white/[0.06]"
                >
                  {gateBusy ? 'Working…' : 'Approve'}
                </button>
              </div>
            </div>
          )}
```

- [ ] **Step 6: Typecheck, lint, build**

Run: `npm run typecheck` → no errors.
Run: `npm run lint` → no errors.
Run: `npm run build` → 17/17 routes.

- [ ] **Step 7: Commit**

```bash
git add "src/app/(app)/videos/[id]/Editor.tsx"
git commit -m "feat(v2): editor preview-review banner (Approve/Reject) — Slice 4 Task 5"
```

---

## Task 6: `preview_gate` UI — per-video toggle + channel default

**Files:**
- Modify: `src/app/(app)/videos/[id]/VideoSettingsPanel.tsx`
- Modify: `src/lib/channels/brand.ts`
- Modify: `src/lib/channels/brand.test.ts`
- Modify: `src/app/(app)/channels/[id]/BrandEditor.tsx`

**Interfaces:**
- Consumes: `VideoSettings`/`VideoSettingsPatch` (now with `preview_gate`, Task 2); the existing `save(patch)` autosave + `updateVideoSettings` (already `sanitizeSettingsPatch`-backed — no action change).
- Produces: `BrandForm.previewGate: boolean`; `BrandSaveValue.defaults.preview_gate: boolean`. `parseChannelBrand`/`validateBrandForm` carry it (default false). `brand-actions.ts` is unchanged.

**Context:** The per-video toggle mirrors the existing "Music" checkbox in `VideoSettingsPanel`. The channel default mirrors the existing `captionsOn`/`musicOn` boolean in `brand.ts` + `BrandEditor`. Adding `preview_gate` to `brand.ts`'s `defaults` will break the `validateBrandForm` full-shape `deepEqual` in `brand.test.ts` (and its `VALID_FORM`/`baseForm` fixture) — update those.

- [ ] **Step 1: Add the per-video toggle to `VideoSettingsPanel.tsx`**

After the existing "Music" `<label>` block (the checkbox bound to `settings.music_on`), add:

```tsx
      <label className={rowClass}>
        <span className="opacity-80">Preview gate</span>
        <input
          type="checkbox"
          checked={settings.preview_gate}
          disabled={busy}
          onChange={(e) => save({ preview_gate: e.target.checked })}
        />
      </label>
```

(`settings.preview_gate` is always defined — `settings` is `parseVideoSettings(...)`, which backfills `false`.)

- [ ] **Step 2: Add the failing channel-default test**

In `src/lib/channels/brand.test.ts`, add:

```ts
test('parseChannelBrand defaults previewGate to false; reads a stored value', () => {
  assert.equal(parseChannelBrand({ name: 'C', brand_kit: {}, brand_voice: {}, defaults: {} }).previewGate, false);
  assert.equal(
    parseChannelBrand({ name: 'C', brand_kit: {}, brand_voice: {}, defaults: { preview_gate: true } }).previewGate,
    true,
  );
});

test('validateBrandForm writes preview_gate into defaults', () => {
  const res = validateBrandForm(baseForm({ previewGate: true }));
  assert.ok(res.ok);
  if (res.ok) assert.equal(res.value.defaults.preview_gate, true);
});
```

Then update the existing fixture(s): the `baseForm`/`VALID_FORM` helper used by `validateBrandForm` tests must include `previewGate: false` (so it stays a valid form), and any existing `assert.deepEqual` on `res.value.defaults` must add `preview_gate: false`.

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- --test-name-pattern="previewGate|preview_gate"`
Expected: FAIL (`previewGate` not on the form; `defaults.preview_gate` missing).

- [ ] **Step 4: Edit `src/lib/channels/brand.ts`**

Add `previewGate: boolean` to `BrandForm` (after `musicOn: boolean;`):

```ts
  musicOn: boolean;
  previewGate: boolean;
```

Add `preview_gate: boolean` to `BrandSaveValue.defaults` (after `music_on: boolean;`):

```ts
    music_on: boolean;
    preview_gate: boolean;
```

In `parseChannelBrand`, after the `musicOn` line, add:

```ts
  const musicOn = typeof d.music_on === 'boolean' ? d.music_on : DEFAULT_MUSIC_ON;
  const previewGate = typeof d.preview_gate === 'boolean' ? d.preview_gate : false;
```

And add `previewGate` to the returned object:

```ts
  return { name: row.name, colors, font, motion: baked.motion, tone, captionsOn, density, musicOn, colorLook, previewGate };
```

In `validateBrandForm`, after the existing `captionsOn`/`musicOn` boolean guard, extend it to also require `previewGate` to be boolean (or add a separate guard):

```ts
  if (typeof f.captionsOn !== 'boolean' || typeof f.musicOn !== 'boolean' || typeof f.previewGate !== 'boolean') {
    return { ok: false, reason: 'Invalid default toggle.' };
  }
```

And add `preview_gate` to the returned `defaults`:

```ts
      defaults: {
        captions_on: f.captionsOn,
        caption_emphasis_density: f.density as CaptionEmphasisDensity,
        music_on: f.musicOn,
        color_look: f.colorLook as ColorLook,
        preview_gate: f.previewGate as boolean,
      },
```

- [ ] **Step 5: Add the channel-default checkbox to `BrandEditor.tsx`**

In the "Video defaults" fieldset, after the existing "Music on" `<label>`, add:

```tsx
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={form.previewGate}
              onChange={(e) => update('previewGate', e.target.checked)}
              disabled={busy}
            />
            Preview gate
          </label>
```

(`update('previewGate', …)` already exists generically via `update<K extends keyof BrandForm>`.)

- [ ] **Step 6: Run targeted + FULL suite, typecheck, lint, build**

Run: `npm test -- --test-name-pattern="previewGate|preview_gate"` → PASS.
Run: `npm test` → `# fail 0`.
Run: `npm run typecheck` → no errors.
Run: `npm run lint` → no errors.
Run: `npm run build` → 17/17 routes.

- [ ] **Step 7: Commit**

```bash
git add "src/app/(app)/videos/[id]/VideoSettingsPanel.tsx" src/lib/channels/brand.ts src/lib/channels/brand.test.ts "src/app/(app)/channels/[id]/BrandEditor.tsx"
git commit -m "feat(v2): preview_gate UI (per-video toggle + channel default) — Slice 4 Task 6"
```

---

## Task 7: `/jobs` paused-gate label + Review link

**Files:**
- Modify: `src/lib/jobs/monitor.ts`
- Modify: `src/lib/jobs/monitor.test.ts`
- Modify: `src/app/(app)/jobs/JobsList.tsx`

**Interfaces:**
- Consumes: `GATE_PHASE` from `../gates/gate` (relative — `monitor.ts` is node:test-run); `JobRow` (existing).
- Produces: `isAwaitingPreview(job: {status:string; phase:string|null}): boolean`; `gatePhaseLabel(phase: string | null): string`.

**Context:** `JobItem` in `JobsList.tsx` already renders `{phase}` raw and links the video title to `/videos/<id>`. Add a friendly phase label for the gate phase and an explicit "Review" link for an awaiting-preview job. `monitor.ts` must import `GATE_PHASE` via the relative path (it is unit-tested under node:test).

- [ ] **Step 1: Write the failing test**

Append to `src/lib/jobs/monitor.test.ts` (create it if it does not exist, with the `node:test` scaffold):

```ts
import { isAwaitingPreview, gatePhaseLabel } from './monitor.ts';

test('isAwaitingPreview: true only for paused + preview phase', () => {
  assert.equal(isAwaitingPreview({ status: 'paused', phase: 'awaiting_preview_review' }), true);
  assert.equal(isAwaitingPreview({ status: 'running', phase: 'awaiting_preview_review' }), false);
  assert.equal(isAwaitingPreview({ status: 'paused', phase: 'rendering' }), false);
  assert.equal(isAwaitingPreview({ status: 'paused', phase: null }), false);
});

test('gatePhaseLabel: friendly for the preview gate, passthrough otherwise', () => {
  assert.equal(gatePhaseLabel('awaiting_preview_review'), 'Awaiting preview review');
  assert.equal(gatePhaseLabel('rendering'), 'rendering');
  assert.equal(gatePhaseLabel(null), '');
});
```

(If `monitor.test.ts` already imports `test`/`assert`, reuse them; otherwise add the `node:test`/`assert/strict` imports at the top.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --test-name-pattern="isAwaitingPreview|gatePhaseLabel"`
Expected: FAIL (functions not exported).

- [ ] **Step 3: Edit `src/lib/jobs/monitor.ts`**

Add the import at the top:

```ts
import { GATE_PHASE } from '../gates/gate';
```

Add the two functions (e.g. after `jobStatusLabel`):

```ts
// A render job suspended at the preview gate (state lives on the job — Slice 4).
export function isAwaitingPreview(job: { status: string; phase: string | null }): boolean {
  return job.status === 'paused' && job.phase === GATE_PHASE.preview;
}

// Friendly label for a gate phase; falls through to the raw phase (or '' for null).
const GATE_PHASE_LABELS: Record<string, string> = {
  [GATE_PHASE.preview]: 'Awaiting preview review',
  [GATE_PHASE.storyboard]: 'Awaiting storyboard review',
};
export function gatePhaseLabel(phase: string | null): string {
  if (!phase) return '';
  return GATE_PHASE_LABELS[phase] ?? phase;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- --test-name-pattern="isAwaitingPreview|gatePhaseLabel"`
Expected: PASS.

- [ ] **Step 5: Wire the label + Review link in `JobsList.tsx`**

Add `isAwaitingPreview, gatePhaseLabel` to the existing `@/lib/jobs/monitor` import. In `JobItem`, replace the raw phase line:

```tsx
  const phase = job.phase ? ` · ${job.phase}` : '';
```

with:

```tsx
  const phase = job.phase ? ` · ${gatePhaseLabel(job.phase)}` : '';
```

And inside the `<div className="flex items-center justify-between gap-3">`, after the Cancel/Retry buttons (still inside that flex row), add a Review link for an awaiting-preview job:

```tsx
        {isAwaitingPreview(job) && job.videoId && (
          <Link
            href={`/videos/${job.videoId}`}
            className="shrink-0 rounded-md border border-black/15 px-2.5 py-1 text-xs font-medium enabled:hover:bg-black/[0.04] dark:border-white/20 dark:hover:bg-white/[0.06]"
          >
            Review
          </Link>
        )}
```

(`Link` is already imported in `JobsList.tsx`.)

- [ ] **Step 6: FULL suite, typecheck, lint, build**

Run: `npm test` → `# fail 0`.
Run: `npm run typecheck` → no errors.
Run: `npm run lint` → no errors.
Run: `npm run build` → 17/17 routes.

- [ ] **Step 7: Commit**

```bash
git add src/lib/jobs/monitor.ts src/lib/jobs/monitor.test.ts "src/app/(app)/jobs/JobsList.tsx"
git commit -m "feat(v2): /jobs preview-gate label + Review link — Slice 4 Task 7"
```

---

## Done criteria

- The gate primitive (`gate.ts`), `preview_gate` settings, `isAwaitingPreview`/`gatePhaseLabel`, and the channel-default validation are unit-tested and green.
- `renderVideo` pauses at the preview gate when `preview_gate` is on (job `paused` + `awaiting_preview_review`), and is byte-identical to today when off. Reject terminates with a structured error; approve continues to music/finalize. A `jobs/cancel` still cancels a paused run.
- The editor shows a base-preview banner with Approve/Reject while paused; `/jobs` shows a friendly "Awaiting preview review" label + a Review link.
- `npm test`, `npm run typecheck`, `npm run lint`, `npm run build` all green. No migration.
- **Operator follow-up (not a code task):** `drive:render` (or the editor) on a video with `preview_gate` on → confirm the job pauses, Approve → completes, Reject → fails with the preview-gate error, and Cancel on a paused job still terminates it. The `waitForEvent`/render-wiring/UI are not unit-tested (Inngest/AWS), matching the remux/gate2 precedent.
