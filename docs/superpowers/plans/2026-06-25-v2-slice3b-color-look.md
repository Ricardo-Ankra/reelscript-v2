# Reelscript V2 — Slice 3b: Color (master look) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a subtle, deterministic, per-channel-selectable master color **look** applied to every render as an ffmpeg `-vf` post-pass between the base render and the music re-mux.

**Architecture:** A "look" is a named set of grade params compiled to an ffmpeg `-vf` filter chain (`eq`/`colorbalance`) by a new pure module. `color_look` joins the existing `VideoSettings` contract (so it inherits the channel-default ⊕ per-video-override machinery with no new plumbing). The render function inserts a best-effort `grade-base` step that re-encodes the voiceover base MP4 through the filter on the dedicated ffmpeg Lambda (reusing `invokeRemux`), updating `base_output_r2_key` in place; on any failure it degrades to the ungraded base. The music branch and everything downstream are untouched.

**Tech Stack:** TypeScript, Next.js (App Router) server actions + client components, Supabase (jsonb settings, no migration), Inngest (`render.ts` step), the existing ffmpeg-executor Lambda via `invokeRemux`, `node:test` unit tests.

## Global Constraints

- **No migration.** `color_look` lives in the existing `channels.defaults` + `videos.settings` jsonb, exactly like the other settings keys.
- **Look vocabulary (single source of truth — `src/lib/color/looks.ts`):** `ColorLook = 'none' | 'neutral' | 'warm' | 'cool' | 'punch'`; default everywhere is `'neutral'`.
- **`none` (and any unknown id) ⇒ no grade ⇒ byte-identical to today.** `buildGradeFilter` returns `null`; the render step is skipped.
- **Subtle + broadcast-safe presets.** Use only `eq`/`colorbalance` (no `curves`, no `lut3d` this slice) so filter strings are space-free and robust across ffmpeg builds.
- **Grade is best-effort.** The `grade-base` step is wrapped in try/catch and degrades to the ungraded base on any error — the video stays watchable. Color is non-essential.
- **Pure modules stay pure.** `src/lib/color/looks.ts` and `src/lib/videos/settings.ts` import no react/server-only/network. `looks.ts` → imported by `settings.ts` (pure→pure) and by `brand.ts` (pure→pure).
- **Audio is preserved bit-exact** in the grade pass (`-c:a copy`) — the base is voiceover-only.
- **Test command:** `npm test` runs `node --experimental-strip-types --import ./scripts/register-loader.mjs --test "src/**/*.test.ts"`. Test files use `import { test } from 'node:test'`, `import assert from 'node:assert/strict'`, and import the module under test with the `.ts` extension (e.g. `from './looks.ts'`).
- **Gates that must stay green:** `npm test`, `npm run typecheck` (`tsc --noEmit`), `npm run lint` (`eslint`), `npm run build` (`next build`).

---

## File structure

| File | Task | Responsibility |
| --- | --- | --- |
| `src/lib/color/looks.ts` (create) + `looks.test.ts` (create) | 1 | `ColorLook`/`COLOR_LOOKS`/`LOOK_LABELS`/`DEFAULT_COLOR_LOOK`, `buildGradeFilter`, `buildGradeArgs` |
| `src/lib/videos/settings.ts` (modify) + `settings.test.ts` (create) | 2 | add `color_look` to the settings contract + sanitize/parse |
| `src/lib/inngest/functions/render.ts` (modify) | 3 | `resolve-color-look` + `grade-base` post-pass step (degrade-on-fail); no-music finalize uses the effective base key |
| `src/lib/channels/brand.ts` (modify) + `brand.test.ts` (create or extend) | 4 | `colorLook` in `BrandForm` + `parseChannelBrand` + `validateBrandForm` defaults |
| `src/app/(app)/channels/[id]/BrandEditor.tsx` (modify) | 4 | channel-default Look `<select>` |
| `src/app/(app)/videos/[id]/VideoSettingsPanel.tsx` (modify) | 5 | per-video Look `<select>` (autosave through the existing action) |

`brand-actions.ts` and `settings-actions.ts` are **unchanged** — both already pass the form/patch through the validators we extend.

---

## Task 1: Color look presets — `src/lib/color/looks.ts`

**Files:**
- Create: `src/lib/color/looks.ts`
- Test: `src/lib/color/looks.test.ts`

**Interfaces:**
- Consumes: nothing (leaf pure module).
- Produces:
  - `export type ColorLook = 'none' | 'neutral' | 'warm' | 'cool' | 'punch'`
  - `export const COLOR_LOOKS: readonly ColorLook[]`
  - `export const DEFAULT_COLOR_LOOK: ColorLook` (= `'neutral'`)
  - `export const LOOK_LABELS: Record<ColorLook, string>`
  - `export function buildGradeFilter(look: ColorLook): string | null`
  - `export interface GradeInput { inPath: string; outPath: string; filter: string }`
  - `export function buildGradeArgs(input: GradeInput): string[]`

- [ ] **Step 1: Write the failing test**

Create `src/lib/color/looks.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COLOR_LOOKS,
  DEFAULT_COLOR_LOOK,
  LOOK_LABELS,
  buildGradeFilter,
  buildGradeArgs,
  type ColorLook,
} from './looks.ts';

test('COLOR_LOOKS lists every look and DEFAULT is neutral', () => {
  assert.deepEqual([...COLOR_LOOKS], ['none', 'neutral', 'warm', 'cool', 'punch']);
  assert.equal(DEFAULT_COLOR_LOOK, 'neutral');
  for (const l of COLOR_LOOKS) assert.equal(typeof LOOK_LABELS[l], 'string');
});

test('buildGradeFilter returns null for none and unknown ids', () => {
  assert.equal(buildGradeFilter('none'), null);
  assert.equal(buildGradeFilter('bogus' as ColorLook), null);
});

test('buildGradeFilter returns a non-empty -vf chain per named look', () => {
  const neutral = buildGradeFilter('neutral');
  assert.ok(neutral && neutral.includes('eq='));

  const warm = buildGradeFilter('warm');
  assert.ok(warm && warm.includes('colorbalance=') && warm.includes('rm=0.04'));

  const cool = buildGradeFilter('cool');
  assert.ok(cool && cool.includes('colorbalance=') && cool.includes('bs=0.04'));

  const punch = buildGradeFilter('punch');
  assert.ok(punch && punch.includes('eq=') && punch.includes('contrast=1.12'));
});

test('look filter chains contain no spaces (argv-safe)', () => {
  for (const l of ['neutral', 'warm', 'cool', 'punch'] as ColorLook[]) {
    const f = buildGradeFilter(l);
    assert.ok(f && !f.includes(' '), `${l} filter must be space-free`);
  }
});

test('buildGradeArgs re-encodes video with the filter and copies audio', () => {
  const args = buildGradeArgs({ inPath: 'in.mp4', outPath: 'out.mp4', filter: 'eq=contrast=1.06' });
  const joined = args.join(' ');
  assert.ok(joined.includes('-vf eq=contrast=1.06'));
  assert.ok(joined.includes('-c:a copy'));
  assert.ok(joined.includes('-c:v libx264'));
  assert.ok(joined.includes('-movflags +faststart'));
  assert.equal(args[args.length - 1], 'out.mp4');
  assert.equal(args[0], '-y');
  const i = args.indexOf('-i');
  assert.equal(args[i + 1], 'in.mp4');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --test-name-pattern="buildGradeFilter|buildGradeArgs|COLOR_LOOKS|argv-safe"`
Expected: FAIL (`Cannot find module './looks.ts'`).

- [ ] **Step 3: Write the implementation**

Create `src/lib/color/looks.ts`:

```ts
// Master color "look" presets (V2 Slice 3b). PURE — no react/server/network. A look
// is a named, subtle, broadcast-safe ffmpeg -vf chain (eq/colorbalance only, no curves
// or lut3d this slice → filter strings are space-free and robust across ffmpeg builds).
// The render step applies it as a post-pass on the dedicated ffmpeg Lambda. This module
// is the single source of the look vocabulary, shared by settings.ts and the channel
// brand validator.
//
// Subtle by design: a master look is a stylistic top-coat, not a consistency-fixer;
// aggressive grades on heterogeneous AI/stock footage amplify mismatch. lut3d/.cube is
// a clean future upgrade (same render step, different argv + a .cube input).

export type ColorLook = 'none' | 'neutral' | 'warm' | 'cool' | 'punch';

export const COLOR_LOOKS: readonly ColorLook[] = ['none', 'neutral', 'warm', 'cool', 'punch'];

export const DEFAULT_COLOR_LOOK: ColorLook = 'neutral';

export const LOOK_LABELS: Record<ColorLook, string> = {
  none: 'None (no grade)',
  neutral: 'Neutral (clean)',
  warm: 'Warm cinematic',
  cool: 'Cool teal',
  punch: 'Punch (high contrast)',
};

// Subtle, broadcast-safe filter chains. eq: contrast/saturation/gamma multipliers around
// 1.0. colorbalance: rm/rh = red mids/highlights, bm/bh = blue mids/highlights,
// bs/rs = blue/red shadows, range roughly -0.1..0.1. Space-free so the whole chain is a
// single argv token.
const FILTERS: Record<Exclude<ColorLook, 'none'>, string> = {
  neutral: 'eq=contrast=1.06:saturation=1.08:gamma=0.98',
  warm: 'eq=contrast=1.05:saturation=1.06,colorbalance=rm=0.04:rh=0.03:bm=-0.03:bh=-0.04',
  cool: 'eq=contrast=1.05:saturation=1.04,colorbalance=bs=0.04:bh=0.03:rs=-0.02:rh=-0.03',
  punch: 'eq=contrast=1.12:saturation=1.14:gamma=0.97',
};

// The ffmpeg -vf chain for a look, or null for 'none' / an unknown id (caller skips the
// grade entirely → byte-identical base).
export function buildGradeFilter(look: ColorLook): string | null {
  if (look === 'none') return null;
  return FILTERS[look as Exclude<ColorLook, 'none'>] ?? null;
}

export interface GradeInput {
  inPath: string;
  outPath: string;
  filter: string;
}

// Pure argv for the grade pass: re-encode video with the filter, COPY audio (the base is
// voiceover-only — keep it bit-exact), faststart. Mirrors buildRemuxArgs.
export function buildGradeArgs(input: GradeInput): string[] {
  return [
    '-y',
    '-i',
    input.inPath,
    '-vf',
    input.filter,
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-preset',
    'veryfast',
    '-crf',
    '20',
    '-c:a',
    'copy',
    '-movflags',
    '+faststart',
    input.outPath,
  ];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- --test-name-pattern="buildGradeFilter|buildGradeArgs|COLOR_LOOKS|argv-safe"`
Expected: PASS (all assertions green).

- [ ] **Step 5: Commit**

```bash
git add src/lib/color/looks.ts src/lib/color/looks.test.ts
git commit -m "feat(v2): color look presets (buildGradeFilter/buildGradeArgs) — Slice 3b Task 1"
```

---

## Task 2: Add `color_look` to the settings contract — `src/lib/videos/settings.ts`

**Files:**
- Modify: `src/lib/videos/settings.ts`
- Test: `src/lib/videos/settings.test.ts` (create — there is no existing settings test file)

**Interfaces:**
- Consumes: `ColorLook`, `COLOR_LOOKS`, `DEFAULT_COLOR_LOOK` from `src/lib/color/looks.ts` (Task 1).
- Produces: `VideoSettings.color_look: ColorLook`, `VideoSettingsPatch.color_look?: ColorLook`, `SETTINGS_DEFAULTS.color_look = 'neutral'`. `sanitizeSettingsPatch`/`parseVideoSettings` keep their existing signatures; `color_look` now flows through both. `create-settings.ts` inherits it with no change (it reuses `parseVideoSettings`/`sanitizeSettingsPatch`).

- [ ] **Step 1: Write the failing test**

Create `src/lib/videos/settings.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeSettingsPatch, parseVideoSettings, SETTINGS_DEFAULTS } from './settings.ts';

test('color_look default is neutral', () => {
  assert.equal(SETTINGS_DEFAULTS.color_look, 'neutral');
  assert.equal(parseVideoSettings({}).color_look, 'neutral');
});

test('sanitizeSettingsPatch keeps a valid color_look', () => {
  assert.equal(sanitizeSettingsPatch({ color_look: 'warm' }).color_look, 'warm');
  assert.equal(sanitizeSettingsPatch({ color_look: 'none' }).color_look, 'none');
});

test('sanitizeSettingsPatch drops an invalid color_look', () => {
  assert.equal('color_look' in sanitizeSettingsPatch({ color_look: 'bogus' }), false);
  assert.equal('color_look' in sanitizeSettingsPatch({ color_look: 5 }), false);
});

test('parseVideoSettings round-trips a stored color_look', () => {
  assert.equal(parseVideoSettings({ color_look: 'punch' }).color_look, 'punch');
  // invalid stored value falls back to the default
  assert.equal(parseVideoSettings({ color_look: 'nope' }).color_look, 'neutral');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --test-name-pattern="color_look"`
Expected: FAIL (`color_look` is not on `SETTINGS_DEFAULTS`; `parseVideoSettings({}).color_look` is `undefined`).

- [ ] **Step 3: Edit `src/lib/videos/settings.ts`**

Add the import at the top of the file (after the comment header, before the existing type aliases). **Use a relative path** — `settings.ts` is unit-tested under `node:test`, whose loader resolves relative extensionless imports but NOT the `@/` tsconfig alias (mirrors `brand.ts` importing `../composition/theme`):

```ts
import { type ColorLook, COLOR_LOOKS, DEFAULT_COLOR_LOOK } from '../color/looks';
```

Add `color_look` to `VideoSettingsPatch` (after `fps?: Fps;`):

```ts
  fps?: Fps;
  color_look?: ColorLook;
```

Add `color_look` to `VideoSettings` (after `fps: Fps;`):

```ts
  fps: Fps;
  color_look: ColorLook;
```

Add the default to `SETTINGS_DEFAULTS` (after `fps: 30,`):

```ts
  fps: 30,
  color_look: DEFAULT_COLOR_LOOK,
```

In `sanitizeSettingsPatch`, add the new check immediately before `return out;`:

```ts
  if (FPSES.includes(p.fps as Fps)) out.fps = p.fps as Fps;
  if (COLOR_LOOKS.includes(p.color_look as ColorLook)) out.color_look = p.color_look as ColorLook;
  return out;
```

`parseVideoSettings` needs no change — it already spreads `clean` from `sanitizeSettingsPatch` over `SETTINGS_DEFAULTS`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- --test-name-pattern="color_look"`
Expected: PASS.

- [ ] **Step 5: Run typecheck to confirm the contract change compiles**

Run: `npm run typecheck`
Expected: no errors. (`create-settings.ts` consumes these via `parseVideoSettings`/`sanitizeSettingsPatch` and needs no change.)

- [ ] **Step 6: Commit**

```bash
git add src/lib/videos/settings.ts src/lib/videos/settings.test.ts
git commit -m "feat(v2): color_look on the settings contract — Slice 3b Task 2"
```

---

## Task 3: Render integration — `grade-base` post-pass step in `render.ts`

**Files:**
- Modify: `src/lib/inngest/functions/render.ts` (imports near top ~line 10; insert steps between `finalize-base` ~line 317 and the music branch ~line 329; change the no-music `finalize` ~line 345)

**Interfaces:**
- Consumes: `buildGradeFilter`, `buildGradeArgs` from `@/lib/color/looks` (Task 1); `parseVideoSettings` from `@/lib/videos/settings` (Task 2); `invokeRemux` from `@/lib/music/remux-invoke`; `signedGetUrl`, `signedPutUrl`, `deleteObject`, `putObject` from `@/lib/r2`.
- Produces: no exported API change. After the grade step, `renders.base_output_r2_key` points at the graded MP4 (or the ungraded base on degrade); the no-music finalize writes `output_r2_key = effectiveBaseKey`.

**Context for the implementer:** This is an Inngest function. Reads inside a `step.run(...)` are durable (memoized across replays). `admin`, `videoId`, `renderId`, `jobId`, `step` are all in scope in the main function body. `invokeRemux` is **not yet imported** in this file (the music path emits a `music/remux` event instead) — add the import. `invokeRemux` already throws on a non-200/`!ok` Lambda response, so the inner `if (!result.ok) throw` is a defensive belt-and-braces that the surrounding try/catch handles either way. No unit test for this task — the ffmpeg Lambda I/O is not unit-tested (matches the music-remux precedent); correctness is covered by the gates plus the operator `drive:render` path. Verify with typecheck/build.

- [ ] **Step 1: Add imports**

At the top of `src/lib/inngest/functions/render.ts`, change the r2 import (currently `import { putObject, signedGetUrl } from '@/lib/r2';`) to:

```ts
import { putObject, signedGetUrl, signedPutUrl, deleteObject } from '@/lib/r2';
```

Add two new import lines alongside the other `@/lib/...` imports:

```ts
import { buildGradeFilter, buildGradeArgs } from '@/lib/color/looks';
import { parseVideoSettings } from '@/lib/videos/settings';
import { invokeRemux } from '@/lib/music/remux-invoke';
```

(If `parseVideoSettings` is already imported in this file for another reason, do not double-import — reuse the existing import.)

- [ ] **Step 2: Insert the resolve-look + grade-base steps**

Immediately **after** the `finalize-base` `step.run(...)` block (the one that ends with `await admin.from('renders').update({ base_output_r2_key: baseKey }).eq('id', renderId);` then `});` ~line 317) and **before** the `// --- caption sidecars` comment (~line 319), insert:

```ts
    // --- master color look (V2 Slice 3b) -------------------------------------
    // Resolve the look from the video's settings (the channel default was merged
    // into video.settings at creation). Best-effort: a transient grade failure
    // degrades to the ungraded base — color is non-essential, the video stays
    // watchable. 'none'/unknown ⇒ filter is null ⇒ step skipped ⇒ byte-identical.
    const colorLook = await step.run('resolve-color-look', async () => {
      const { data: v } = await admin.from('videos').select('settings').eq('id', videoId).single();
      return parseVideoSettings(v?.settings).color_look;
    });
    let effectiveBaseKey = baseKey;
    const gradeFilter = buildGradeFilter(colorLook);
    if (gradeFilter) {
      effectiveBaseKey = await step.run('grade-base', async () => {
        try {
          const gradedKey = `renders/${renderId}.graded.mp4`;
          const [inUrl, outUrl] = await Promise.all([
            signedGetUrl(baseKey, 60 * 60),
            signedPutUrl(gradedKey, 'video/mp4', 60 * 60),
          ]);
          const args = buildGradeArgs({ inPath: '/tmp/grade-in.mp4', outPath: '/tmp/grade-out.mp4', filter: gradeFilter });
          const result = await invokeRemux({
            args,
            inputs: { '/tmp/grade-in.mp4': inUrl },
            outputs: { '/tmp/grade-out.mp4': outUrl },
          });
          if (!result.ok) throw new Error(result.error ?? 'grade failed');
          await admin.from('renders').update({ base_output_r2_key: gradedKey }).eq('id', renderId);
          await deleteObject(baseKey).catch(() => {}); // best-effort cleanup of the ungraded base
          return gradedKey;
        } catch (e) {
          // Degrade: keep the ungraded base as the result; the video is still watchable.
          console.error(`grade-base degraded for render ${renderId}:`, e);
          return baseKey;
        }
      });
    }
```

- [ ] **Step 3: Use `effectiveBaseKey` in the no-music finalize**

In the `finalize` `step.run(...)` block (~line 342), change the no-music output key from `baseKey` to `effectiveBaseKey`:

```ts
    await step.run('finalize', async () => {
      await admin
        .from('renders')
        .update({ status: 'complete', output_r2_key: effectiveBaseKey, render_date: new Date().toISOString() })
        .eq('id', renderId);
      await admin.from('videos').update({ current_render_id: renderId }).eq('id', videoId);
      await admin.from('jobs').update({ status: 'complete', phase: 'done' }).eq('id', jobId);
    });
```

(The music branch is **unchanged**: the `music/remux` function reads `base_output_r2_key` from the DB — now the graded key — and mixes onto it.)

- [ ] **Step 4: Typecheck and build**

Run: `npm run typecheck`
Expected: no errors.

Run: `npm run build`
Expected: build succeeds (17/17 routes, matching the established baseline).

- [ ] **Step 5: Run the full unit suite (no regressions)**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/lib/inngest/functions/render.ts
git commit -m "feat(v2): grade-base color post-pass step (degrade-on-fail) — Slice 3b Task 3"
```

---

## Task 4: Channel-default Look — `brand.ts` + `BrandEditor.tsx`

**Files:**
- Modify: `src/lib/channels/brand.ts`
- Test: `src/lib/channels/brand.test.ts` (create if absent; otherwise add tests to the existing file)
- Modify: `src/app/(app)/channels/[id]/BrandEditor.tsx`

**Interfaces:**
- Consumes: `ColorLook`, `COLOR_LOOKS`, `DEFAULT_COLOR_LOOK`, `LOOK_LABELS` from `@/lib/color/looks` (Task 1, via relative `../color/looks` inside `brand.ts`).
- Produces: `BrandForm.colorLook: ColorLook`; `BrandSaveValue.defaults.color_look: ColorLook`. `parseChannelBrand` reads `defaults.color_look` (validated, default `neutral`); `validateBrandForm` validates `f.colorLook` and writes `color_look` into `defaults`. `brand-actions.ts` is unchanged (it passes `valid.value.defaults` straight to the `update_channel_brand` RPC, which merges it into `channels.defaults`).

**Context for the implementer:** Check whether `src/lib/channels/brand.test.ts` exists. If it does, append the new tests; if not, create it with the node:test scaffold below. The channel editor uses a single dirty-tracked Save (not per-field autosave); the new control just calls the existing `update('colorLook', value)` helper.

- [ ] **Step 1: Write the failing test**

Create or extend `src/lib/channels/brand.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseChannelBrand, validateBrandForm } from './brand.ts';

const VALID_COLORS = {
  background: '#000000',
  foreground: '#ffffff',
  primary: '#ff0000',
  secondary: '#00ff00',
  accent: '#0000ff',
  bodyText: '#cccccc',
  positive: '#00cc66',
  negative: '#cc0033',
};

function baseForm(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Chan',
    colors: VALID_COLORS,
    font: 'Poppins',
    motion: 'standard',
    tone: '',
    captionsOn: true,
    musicOn: false,
    density: 'sparing',
    colorLook: 'warm',
    ...overrides,
  };
}

test('parseChannelBrand defaults colorLook to neutral when absent', () => {
  const form = parseChannelBrand({ name: 'C', brand_kit: {}, brand_voice: {}, defaults: {} });
  assert.equal(form.colorLook, 'neutral');
});

test('parseChannelBrand reads a stored colorLook and falls back for an invalid one', () => {
  assert.equal(
    parseChannelBrand({ name: 'C', brand_kit: {}, brand_voice: {}, defaults: { color_look: 'cool' } }).colorLook,
    'cool',
  );
  assert.equal(
    parseChannelBrand({ name: 'C', brand_kit: {}, brand_voice: {}, defaults: { color_look: 'bogus' } }).colorLook,
    'neutral',
  );
});

test('validateBrandForm writes color_look into defaults', () => {
  const res = validateBrandForm(baseForm({ colorLook: 'punch' }));
  assert.ok(res.ok);
  if (res.ok) assert.equal(res.value.defaults.color_look, 'punch');
});

test('validateBrandForm rejects an invalid colorLook', () => {
  const res = validateBrandForm(baseForm({ colorLook: 'bogus' }));
  assert.equal(res.ok, false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --test-name-pattern="colorLook|color_look"`
Expected: FAIL (`form.colorLook` is `undefined`; `defaults.color_look` missing).

- [ ] **Step 3: Edit `src/lib/channels/brand.ts`**

Add the import (after the existing imports near the top):

```ts
import { type ColorLook, COLOR_LOOKS, DEFAULT_COLOR_LOOK } from '../color/looks';
```

Add `colorLook` to `BrandForm` (after `musicOn: boolean;`):

```ts
  musicOn: boolean;
  colorLook: ColorLook;
```

Add `color_look` to `BrandSaveValue.defaults` (after `music_on: boolean;`):

```ts
    music_on: boolean;
    color_look: ColorLook;
```

In `parseChannelBrand`, after the `musicOn` line, add:

```ts
  const musicOn = typeof d.music_on === 'boolean' ? d.music_on : DEFAULT_MUSIC_ON;
  const colorLook = COLOR_LOOKS.includes(d.color_look as ColorLook)
    ? (d.color_look as ColorLook)
    : DEFAULT_COLOR_LOOK;
```

And add `colorLook` to the returned object:

```ts
  return { name: row.name, colors, font, motion: baked.motion, tone, captionsOn, density, musicOn, colorLook };
```

In `validateBrandForm`, add a guard after the captionsOn/musicOn check:

```ts
  if (typeof f.captionsOn !== 'boolean' || typeof f.musicOn !== 'boolean') {
    return { ok: false, reason: 'Invalid default toggle.' };
  }
  if (!COLOR_LOOKS.includes(f.colorLook as ColorLook)) {
    return { ok: false, reason: 'Invalid colour look.' };
  }
```

And add `color_look` to the returned `defaults`:

```ts
      defaults: {
        captions_on: f.captionsOn,
        caption_emphasis_density: f.density as CaptionEmphasisDensity,
        music_on: f.musicOn,
        color_look: f.colorLook as ColorLook,
      },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- --test-name-pattern="colorLook|color_look"`
Expected: PASS.

- [ ] **Step 5: Add the Look select to `BrandEditor.tsx`**

Add the import (extend the existing `@/lib/color/looks`-free imports). After the existing `import type { BrandForm, ... }` block, add:

```ts
import { COLOR_LOOKS, LOOK_LABELS } from '@/lib/color/looks';
```

Inside the "Video defaults" `<fieldset>` (after the Emphasis `<label>` that closes ~line 196, still inside the `<div className="flex flex-wrap items-center gap-6 text-sm">`), add a Look control:

```tsx
          <label className="flex items-center gap-2">
            Look
            <select
              value={form.colorLook}
              onChange={(e) => update('colorLook', e.target.value as BrandForm['colorLook'])}
              disabled={busy}
              className={inputCls}
            >
              {COLOR_LOOKS.map((l) => (
                <option key={l} value={l}>
                  {LOOK_LABELS[l]}
                </option>
              ))}
            </select>
          </label>
```

`update('colorLook', ...)` already exists generically (`update<K extends keyof BrandForm>`), so no new handler is needed. The form's `colorLook` is seeded from `initial` (which comes from `parseChannelBrand`, defaulting to `neutral`).

- [ ] **Step 6: Typecheck, lint, build**

Run: `npm run typecheck`
Expected: no errors (the `BrandForm` change makes `form.colorLook` typed).

Run: `npm run lint`
Expected: no errors.

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 7: Commit**

```bash
git add src/lib/channels/brand.ts src/lib/channels/brand.test.ts src/app/(app)/channels/[id]/BrandEditor.tsx
git commit -m "feat(v2): channel-default colour look (brand form + editor) — Slice 3b Task 4"
```

---

## Task 5: Per-video Look override — `VideoSettingsPanel.tsx`

**Files:**
- Modify: `src/app/(app)/videos/[id]/VideoSettingsPanel.tsx`

**Interfaces:**
- Consumes: `COLOR_LOOKS`, `LOOK_LABELS` from `@/lib/color/looks` (Task 1); `VideoSettings`/`VideoSettingsPatch` (already imported — `color_look` is now on both from Task 2); the existing `save(patch)` autosave → `updateVideoSettings` → `sanitizeSettingsPatch` (color-look-aware from Task 2).
- Produces: no new exports. The panel renders a Look `<select>` that autosaves `{ color_look }` like the other controls. `settings-actions.ts` is **unchanged**.

**Context for the implementer:** This is a `'use client'` component. The existing `save(patch: VideoSettingsPatch)` helper is optimistic + reconciles to the written settings. The new control mirrors the "Aspect ratio" select exactly, but saves `color_look`.

- [ ] **Step 1: Add the import**

After the existing `@/lib/videos/settings` import block, add:

```ts
import { COLOR_LOOKS, LOOK_LABELS } from '@/lib/color/looks';
```

- [ ] **Step 2: Add the Look select**

After the "Frame rate" `<label>` (closes ~line 142) and before the "Length" `<div>` (~line 144), add:

```tsx
      <label className={rowClass}>
        <span className="opacity-80">Look</span>
        <select
          className={ctrlClass}
          value={settings.color_look}
          disabled={busy}
          onChange={(e) => save({ color_look: e.target.value as VideoSettings['color_look'] })}
        >
          {COLOR_LOOKS.map((l) => (
            <option key={l} value={l}>
              {LOOK_LABELS[l]}
            </option>
          ))}
        </select>
      </label>
```

`settings.color_look` is always defined: `settings` is `parseVideoSettings(initialSettings)`, which backfills `neutral`.

- [ ] **Step 3: Typecheck, lint, build**

Run: `npm run typecheck`
Expected: no errors.

Run: `npm run lint`
Expected: no errors.

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 4: Run the full unit suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/app/(app)/videos/[id]/VideoSettingsPanel.tsx
git commit -m "feat(v2): per-video colour look override (settings panel) — Slice 3b Task 5"
```

---

## Done criteria

- `buildGradeFilter`/`buildGradeArgs` + `settings.color_look` + `brand.ts` colour-look are unit-tested and green.
- `render.ts` applies the grade as a best-effort post-pass; `none`/unknown is byte-identical to today; failures degrade to the ungraded base; the no-music finalize uses the graded key.
- The channel BrandEditor and the per-video settings panel each expose a Look dropdown; channel default ⊕ per-video override flow through the existing `create-settings.ts` machinery with no change there.
- `npm test`, `npm run typecheck`, `npm run lint`, `npm run build` all green. No migration.
- **Operator follow-up (not a code task):** run `drive:render` on a video with a non-`none` look and eyeball the graded result (the ffmpeg-Lambda I/O is not unit-tested, matching the remux precedent).
