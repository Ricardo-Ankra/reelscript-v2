# Slice A — Formatted Composition/Render Errors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render composition/render errors (e.g. the Gate-2 smoke-frame QA failure) as a clean, human-readable card — phase badge, message, QA issues, and the smoke frame inline — instead of raw JSON, everywhere an error shows today (the editor and `/jobs`).

**Architecture:** A pure `parseRenderError(value)` normalizes both shapes the pipeline emits (a structured `{phase, issues[], message, frameUrl}` object or a plain string) into a typed `ParsedRenderError`. A presentational `RenderErrorCard` renders it. The editor stops receiving a `JSON.stringify`-ed string (`getRenderState` returns the raw structured error) and renders the card; `/jobs` renders each row's already-loaded `error` through the same card.

**Tech Stack:** Next.js App Router (client components + a server action), TypeScript, node:test.

## Global Constraints

- **Slice A is additive and independent** — no schema change, no coupling to the asset-model slices (B/C/D).
- **`ParsedRenderError`** = `{ phase: string | null; message: string; issues: string[]; frameUrl: string | null }`.
- **`parseRenderError(value: unknown)` never throws** — plain string → `{message: <string>}`; structured object → mapped fields (missing fields default: `phase`/`frameUrl` → null, `issues` → `[]`, `message` → fallback); `null`/garbage → a generic fallback message. The fallback message is exactly: `Something went wrong during composition or rendering.`
- **The card degrades:** no `frameUrl` → no image; no `issues` → no list; no `phase` → no badge.
- **Tests** run with `node --experimental-strip-types --import ./scripts/register-loader.mjs --test <file>`; test files import source with an explicit `.ts` extension; `import { test } from 'node:test'; import assert from 'node:assert/strict';`.
- **Server actions / client components are not unit-tested** (integration) — pure logic is in the tested helper; verification is `tsc` + `lint` + `build`.
- **Commit footer:** end every commit message with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **`<img>` with a remote signed URL** is intentional (not `next/image`, which needs domain config for signed S3 URLs) — precede the tag with `{/* eslint-disable-next-line @next/next/no-img-element */}` so the build gate stays clean.

## File Structure

**Create:**
- `src/lib/errors/render-error.ts` — pure `ParsedRenderError`, `parseRenderError`, `phaseLabel`.
- `src/lib/errors/render-error.test.ts` — unit tests.
- `src/components/RenderErrorCard.tsx` — the presentational card (shared by the editor + `/jobs`).

**Modify:**
- `src/app/(app)/videos/[id]/render-actions.ts` — `getRenderState` returns the raw structured `error` instead of `JSON.stringify`.
- `src/app/(app)/videos/[id]/Editor.tsx` — `renderError` state becomes `ParsedRenderError | null`; set-sites wrap with `parseRenderError`; render site uses `RenderErrorCard`.
- `src/app/(app)/jobs/JobsList.tsx` — `JobItem` renders its row's `error` through `RenderErrorCard`.

---

### Task 1: Pure error parser

**Files:**
- Create: `src/lib/errors/render-error.ts`
- Test: `src/lib/errors/render-error.test.ts`

**Interfaces:**
- Produces:
  - `interface ParsedRenderError { phase: string | null; message: string; issues: string[]; frameUrl: string | null }`
  - `parseRenderError(value: unknown): ParsedRenderError`
  - `phaseLabel(phase: string | null): string | null`

- [ ] **Step 1: Write the failing test**

Create `src/lib/errors/render-error.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRenderError, phaseLabel } from './render-error.ts';

const FALLBACK = 'Something went wrong during composition or rendering.';

test('parseRenderError: full structured object', () => {
  const r = parseRenderError({
    phase: 'gate2',
    issues: ['Vehicle shown is a white Jeep Wrangler, not a Rivian R2'],
    message: 'Smoke frame failed QA',
    frameUrl: 'https://example.com/out.png',
  });
  assert.deepEqual(r, {
    phase: 'gate2',
    message: 'Smoke frame failed QA',
    issues: ['Vehicle shown is a white Jeep Wrangler, not a Rivian R2'],
    frameUrl: 'https://example.com/out.png',
  });
});

test('parseRenderError: structured with missing phase/frameUrl', () => {
  const r = parseRenderError({ message: 'Boom', issues: ['a', 'b'] });
  assert.equal(r.phase, null);
  assert.equal(r.frameUrl, null);
  assert.equal(r.message, 'Boom');
  assert.deepEqual(r.issues, ['a', 'b']);
});

test('parseRenderError: issues filters non-strings and blanks', () => {
  const r = parseRenderError({ message: 'x', issues: ['ok', '', '   ', 5, null] });
  assert.deepEqual(r.issues, ['ok']);
});

test('parseRenderError: plain string is the message', () => {
  const r = parseRenderError('Render failed.');
  assert.deepEqual(r, { phase: null, message: 'Render failed.', issues: [], frameUrl: null });
});

test('parseRenderError: empty string falls back', () => {
  assert.equal(parseRenderError('   ').message, FALLBACK);
});

test('parseRenderError: null / number / object-without-message fall back', () => {
  assert.equal(parseRenderError(null).message, FALLBACK);
  assert.equal(parseRenderError(42).message, FALLBACK);
  assert.equal(parseRenderError({ phase: 'gate1' }).message, FALLBACK);
});

test('phaseLabel: known phases mapped, unknown passthrough, null → null', () => {
  assert.equal(phaseLabel('gate2'), 'Smoke-frame QA');
  assert.equal(phaseLabel('gate1'), 'Spec validation');
  assert.equal(phaseLabel('mystery'), 'mystery');
  assert.equal(phaseLabel(null), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/errors/render-error.test.ts`
Expected: FAIL — module `./render-error.ts` does not exist.

- [ ] **Step 3: Write the implementation**

Create `src/lib/errors/render-error.ts`:

```ts
// A normalized composition-/render-error shape for display. The pipeline writes
// either a structured object ({phase, issues[], message, frameUrl}) or a plain
// string into renders.error / jobs.error; this normalizes both for the UI.
export interface ParsedRenderError {
  phase: string | null;
  message: string;
  issues: string[];
  frameUrl: string | null;
}

const FALLBACK_MESSAGE = 'Something went wrong during composition or rendering.';

export function parseRenderError(value: unknown): ParsedRenderError {
  // Plain string error (e.g. "Render failed.", or a thrown Error's message).
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return { phase: null, message: trimmed || FALLBACK_MESSAGE, issues: [], frameUrl: null };
  }
  // Structured object error.
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    const phase = typeof o.phase === 'string' && o.phase.trim() ? o.phase.trim() : null;
    const message =
      typeof o.message === 'string' && o.message.trim() ? o.message.trim() : FALLBACK_MESSAGE;
    const issues = Array.isArray(o.issues)
      ? o.issues.filter((i): i is string => typeof i === 'string' && i.trim().length > 0)
      : [];
    const frameUrl =
      typeof o.frameUrl === 'string' && o.frameUrl.trim() ? o.frameUrl.trim() : null;
    return { phase, message, issues, frameUrl };
  }
  // null / undefined / number / anything else.
  return { phase: null, message: FALLBACK_MESSAGE, issues: [], frameUrl: null };
}

// Human label for a known pipeline phase (renders.status / error.phase), with a
// passthrough for unknown phases and null for absent.
export function phaseLabel(phase: string | null): string | null {
  if (!phase) return null;
  switch (phase) {
    case 'gate1':
      return 'Spec validation';
    case 'gate2':
      return 'Smoke-frame QA';
    case 'composing':
      return 'Composition';
    case 'resolving_assets':
      return 'Asset resolution';
    case 'rendering':
      return 'Rendering';
    default:
      return phase;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/errors/render-error.test.ts`
Expected: PASS (all 7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/errors/render-error.ts src/lib/errors/render-error.test.ts
git commit -m "feat(errors): parseRenderError + phaseLabel (normalize render errors)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `RenderErrorCard` component

**Files:**
- Create: `src/components/RenderErrorCard.tsx`

**Interfaces:**
- Consumes: `ParsedRenderError`, `phaseLabel` (`@/lib/errors/render-error`, Task 1).
- Produces: `RenderErrorCard({ error }: { error: ParsedRenderError })` (a React component).

No unit test (presentational). Verify `tsc` + `lint`.

- [ ] **Step 1: Write the component**

Create `src/components/RenderErrorCard.tsx`:

```tsx
import { type ParsedRenderError, phaseLabel } from '@/lib/errors/render-error';

// Presentational card for a normalized composition/render error: a phase badge,
// the message, any QA issues as a list, and the smoke frame inline when present.
// Degrades gracefully — each section renders only when its data is present.
export function RenderErrorCard({ error }: { error: ParsedRenderError }) {
  const label = phaseLabel(error.phase);
  return (
    <div className="space-y-2 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">
      <div className="flex flex-wrap items-center gap-2">
        {label && (
          <span className="shrink-0 rounded-full border border-red-500/40 px-2 py-0.5 text-xs font-medium">
            {label}
          </span>
        )}
        <span className="font-medium">{error.message}</span>
      </div>
      {error.issues.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5 text-xs">
          {error.issues.map((issue, i) => (
            <li key={i}>{issue}</li>
          ))}
        </ul>
      )}
      {error.frameUrl && (
        <a href={error.frameUrl} target="_blank" rel="noreferrer" className="block w-fit">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={error.frameUrl}
            alt="Frame that failed QA"
            className="max-h-48 w-auto rounded-md border border-red-500/30"
          />
        </a>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck + lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors (no `no-img-element` warning — the disable comment covers it).

- [ ] **Step 3: Commit**

```bash
git add src/components/RenderErrorCard.tsx
git commit -m "feat(errors): RenderErrorCard — phase badge, message, issues, smoke frame

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Editor renders the structured error

**Files:**
- Modify: `src/app/(app)/videos/[id]/render-actions.ts` (the `getRenderState` return)
- Modify: `src/app/(app)/videos/[id]/Editor.tsx`

**Interfaces:**
- Consumes: `parseRenderError`, `ParsedRenderError` (Task 1); `RenderErrorCard` (Task 2).
- Produces: the editor's render-error UI as a card; `getRenderState` returns `error: unknown` (raw structured value).

No unit test (server action + client). Verify `tsc` + `lint`.

- [ ] **Step 1: Stop stringifying the render error**

In `src/app/(app)/videos/[id]/render-actions.ts`, `getRenderState` currently ends:

```ts
export async function getRenderState(
  renderId: string,
): Promise<{ status: string; url: string | null; error: string | null }> {
```

…and returns (the last field):

```ts
    error: data.error ? JSON.stringify(data.error) : null,
```

Change the return type's `error` to `unknown` and pass the raw value:

```ts
export async function getRenderState(
  renderId: string,
): Promise<{ status: string; url: string | null; error: unknown }> {
```

```ts
    error: data.error ?? null,
```

(Leave the rest of the function — `status`, `url` — unchanged.)

- [ ] **Step 2: Add the imports to the Editor**

In `src/app/(app)/videos/[id]/Editor.tsx`, add near the other imports:

```ts
import { parseRenderError, type ParsedRenderError } from '@/lib/errors/render-error';
import { RenderErrorCard } from '@/components/RenderErrorCard';
```

- [ ] **Step 3: Change the `renderError` state type**

Find (currently line ~69):

```ts
  const [renderError, setRenderError] = useState<string | null>(null);
```

Replace with:

```ts
  const [renderError, setRenderError] = useState<ParsedRenderError | null>(null);
```

- [ ] **Step 4: Wrap the three string set-sites with `parseRenderError`**

There are three set-sites that assign a value (leave the `setRenderError(null)` reset, ~line 329, exactly as-is). Update them:

`setRenderError('Synthesize every scene before rendering.');` →
```ts
      setRenderError(parseRenderError('Synthesize every scene before rendering.'));
```

`if ('blocked' in retry) setRenderError('Render is still blocked.');` →
```ts
      if ('blocked' in retry) setRenderError(parseRenderError('Render is still blocked.'));
```

`if (s.status === 'failed') setRenderError(s.error ?? 'Render failed.');` →
```ts
        if (s.status === 'failed') setRenderError(parseRenderError(s.error ?? 'Render failed.'));
```

- [ ] **Step 5: Render the card**

Find (currently line ~473):

```tsx
          {renderError && <p className="text-xs text-red-600">{renderError}</p>}
```

Replace with:

```tsx
          {renderError && <RenderErrorCard error={renderError} />}
```

- [ ] **Step 6: Typecheck + lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors. (The state is now `ParsedRenderError | null`; every assignment goes through `parseRenderError`, so the types line up; the `<p>` that rendered a string is gone.)

- [ ] **Step 7: Commit**

```bash
git add "src/app/(app)/videos/[id]/render-actions.ts" "src/app/(app)/videos/[id]/Editor.tsx"
git commit -m "feat(videos): render errors as a formatted card in the editor

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: `/jobs` rows render their error as a card (full gate)

**Files:**
- Modify: `src/app/(app)/jobs/JobsList.tsx`

**Interfaces:**
- Consumes: `parseRenderError` (Task 1); `RenderErrorCard` (Task 2); `JobRow.error` (existing `unknown`, already loaded by `loadJobs`).
- Produces: a per-row formatted error on `/jobs`.

No unit test (client). This task runs the FULL gate.

- [ ] **Step 1: Add the imports**

In `src/app/(app)/jobs/JobsList.tsx`, add near the other imports:

```ts
import { parseRenderError } from '@/lib/errors/render-error';
import { RenderErrorCard } from '@/components/RenderErrorCard';
```

- [ ] **Step 2: Render the error inside `JobItem`**

`JobItem` currently returns a single flex row `<li>`. Restructure so an error card can sit beneath the row. Replace the `JobItem` return block:

```tsx
  return (
    <li className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-medium">{job.type}</span>
          {job.videoId && job.videoTitle && (
            <Link href={`/videos/${job.videoId}`} className="truncate underline opacity-70 hover:opacity-100">
              {job.videoTitle}
            </Link>
          )}
        </div>
        <div className="text-xs opacity-60">
          {jobStatusLabel(job.status)}
          {phase} · {relativeAge(job.createdAt)}
        </div>
      </div>
      {onCancel && isCancellable(job.status) && (
        <button
          type="button"
          disabled={busy}
          onClick={onCancel}
          className="shrink-0 rounded-md border border-red-500/40 px-2.5 py-1 text-xs font-medium text-red-600 enabled:hover:bg-red-500/10 disabled:opacity-40"
        >
          {busy ? 'Cancelling…' : 'Cancel'}
        </button>
      )}
      {onRetry && isRetryable(job.type, job.status) && (
        <button
          type="button"
          disabled={busy}
          onClick={onRetry}
          className="shrink-0 rounded-md border border-black/15 px-2.5 py-1 text-xs font-medium enabled:hover:bg-black/[0.04] disabled:opacity-40 dark:border-white/20 dark:enabled:hover:bg-white/[0.06]"
        >
          {busy ? 'Retrying…' : 'Retry'}
        </button>
      )}
    </li>
  );
```

with (the existing row becomes an inner `<div>`; the card renders below it when the job carries an error and is not a cancellation):

```tsx
  const showError = job.status !== 'cancelled' && job.error != null;
  return (
    <li className="space-y-2 px-4 py-3 text-sm">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-medium">{job.type}</span>
            {job.videoId && job.videoTitle && (
              <Link href={`/videos/${job.videoId}`} className="truncate underline opacity-70 hover:opacity-100">
                {job.videoTitle}
              </Link>
            )}
          </div>
          <div className="text-xs opacity-60">
            {jobStatusLabel(job.status)}
            {phase} · {relativeAge(job.createdAt)}
          </div>
        </div>
        {onCancel && isCancellable(job.status) && (
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="shrink-0 rounded-md border border-red-500/40 px-2.5 py-1 text-xs font-medium text-red-600 enabled:hover:bg-red-500/10 disabled:opacity-40"
          >
            {busy ? 'Cancelling…' : 'Cancel'}
          </button>
        )}
        {onRetry && isRetryable(job.type, job.status) && (
          <button
            type="button"
            disabled={busy}
            onClick={onRetry}
            className="shrink-0 rounded-md border border-black/15 px-2.5 py-1 text-xs font-medium enabled:hover:bg-black/[0.04] disabled:opacity-40 dark:border-white/20 dark:enabled:hover:bg-white/[0.06]"
          >
            {busy ? 'Retrying…' : 'Retry'}
          </button>
        )}
      </div>
      {showError && <RenderErrorCard error={parseRenderError(job.error)} />}
    </li>
  );
```

(The `<li>` flex layout moved to the inner `<div>`; the `<li>` is now a `space-y-2` stack of the row + the optional card. `phase`, `busy`, `onCancel`, `onRetry` references are unchanged.)

- [ ] **Step 3: Typecheck, lint, build**

Run: `npx tsc --noEmit && npm run lint && npm run build`
Expected: all succeed.

- [ ] **Step 4: Run the full unit suite**

Run: `npm test`
Expected: PASS (including `src/lib/errors/render-error.test.ts`).

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/jobs/JobsList.tsx"
git commit -m "feat(jobs): render each job's error as a formatted card

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage (slice A section of the design):**
- Pure formatter parsing `{phase, issues[], message, frameUrl}` + tolerant of string/garbage → Task 1. ✓
- React card: phase badge, message, issues list, smoke frame inline → Task 2. ✓
- Surfaced in the editor `renderError` path → Task 3 (incl. the `getRenderState` JSON.stringify removal, the real source of the raw JSON). ✓
- Surfaced in `/jobs` rows' error display → Task 4. ✓
- Unit-tested at the pure formatter; UI verified by tsc/lint/build → Tasks 1–4. ✓
- No schema change; independent of B/C/D → honored (no schema touched). ✓

**2. Placeholder scan:** No TBD/TODO/"handle errors"/"similar to". Every code step shows complete code; the fallback message, phase labels, and the exact before/after blocks are spelled out. ✓

**3. Type consistency:** `ParsedRenderError` (Task 1) is the prop type of `RenderErrorCard` (Task 2), the `renderError` state type and `parseRenderError` return (Task 3), and the `parseRenderError(job.error)` argument (Task 4). `getRenderState` returns `error: unknown` (Task 3 Step 1), and `s.error` flows into `parseRenderError(s.error ?? 'Render failed.')` (Task 3 Step 4) — `parseRenderError` accepts `unknown`, so it type-checks. `phaseLabel(phase: string | null)` (Task 1) is called with `error.phase` (`string | null`) in the card (Task 2). `JobRow.error` is `unknown` (existing) and `parseRenderError` accepts it (Task 4). ✓
