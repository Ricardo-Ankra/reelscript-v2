# Channel Brand Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the `/channels/[id]` shell into a working brand editor — rename + 8 colors + curated font + motion + brand-voice tone + channel defaults — each baking into renders.

**Architecture:** A pure core (`fonts.ts`, `brand.ts`) is unit-tested; the renderer loads all allowlisted fonts so a brand font actually renders; a `saveChannelBrand` server action calls one atomic `update_channel_brand` RPC that shallow-merges `brand_kit` (preserving later slices' keys) and writes `name`/`brand_voice`/`defaults` wholesale; a client `BrandEditor` form with a single Save button fills the detail page.

**Tech Stack:** Next.js 16 App Router (server + client components), Supabase under RLS, `@remotion/google-fonts`, TypeScript, `node:test` via the project loader.

Design source: `docs/superpowers/specs/2026-06-18-channel-brand-editor-design.md`.

## Global Constraints

- **`FONT_ALLOWLIST`** (`src/lib/channels/fonts.ts`) is the single source of truth: `['Poppins','Montserrat','Inter','Roboto','Playfair Display','Bebas Neue']`. These exact strings are stored in `brand_kit.typography.font`, offered in the dropdown, accepted by validation, and used as CSS `fontFamily`.
- **`fontSubpath(family)`** maps a family to its `@remotion/google-fonts` subpath by removing spaces (`'Playfair Display'` → `'PlayfairDisplay'`). Exported and used by both the renderer wiring and the drift test.
- **Drift guard:** `remotion/brand-fonts.ts` duplicates the family list as static `loadFont` imports (it can't import `fonts.ts` — that's a pure node:test lib; this pulls Remotion). `fonts.test.ts` reads `brand-fonts.ts` as text and asserts every `@remotion/google-fonts/${fontSubpath(family)}` import is present — divergence fails the suite.
- **`update_channel_brand` RPC** is SECURITY INVOKER (caller RLS applies), shallow-merges `brand_kit` (`brand_kit || patch` — preserves `caption_emphasis`/`caption_style`/`logos`), writes `name`/`brand_voice`/`defaults` wholesale, and `RETURNING id` (NULL on zero rows).
- **No phantom save:** `saveChannelBrand` returns `{ ok: false, reason: 'Channel not found.' }` when the RPC returns null (zero rows), never `{ ok: true }`.
- **All 8 colors required:** `validateBrandForm` rejects a `colors` object missing any of the 8 `ColorKey`s (colors is replaced wholesale on the merge; a partial would silently reset to `DEFAULT_THEME`). Each color must be valid hex (`#RGB` or `#RRGGBB`).
- **Pure boundary:** `fonts.ts` and `brand.ts` import nothing react/server/network. `brand.ts` may import `DEFAULT_THEME`/`bakeTheme` from `../composition/theme` (confirmed pure: only a type-only `Theme` import, erased at runtime). Test imports use explicit `.ts` extensions.
- **Channel defaults are explicit** once saved (no tri-state inherit). Default values: `captions_on: true`, `caption_emphasis_density: 'sparing'`, `music_on: false` (match render fallbacks).
- **Brand-voice tone** is omitted from `brand_voice` when blank (`{}`), not stored as `''`.
- RLS via `@/lib/supabase/server`'s `createClient()`. Server actions begin with `'use server'`. Tests run via `npm test`.
- **Renderer change → pre-merge render gate:** after the code lands, `npm run deploy:remotion` and render a video on a non-Poppins channel to confirm the font + colors render and Lambda init time is unaffected. This is the operator's manual gate at finish time (cannot be automated here).

---

### Task 1: Font allowlist + renderer wiring + drift test

**Files:**
- Create: `src/lib/channels/fonts.ts`
- Create: `remotion/brand-fonts.ts`
- Modify: `remotion/ReelComposition.tsx` (swap the single-font import for `./brand-fonts`)
- Test: `src/lib/channels/fonts.test.ts`

**Interfaces:**
- Consumes: `@remotion/google-fonts/<Font>` subpaths.
- Produces: `FONT_ALLOWLIST` (readonly tuple), `BrandFont` type, `isBrandFont(v): v is BrandFont`, `fontSubpath(family: string): string`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/channels/fonts.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FONT_ALLOWLIST, fontSubpath, isBrandFont } from './fonts.ts';

test('FONT_ALLOWLIST: non-empty and includes Poppins (renderer prior default)', () => {
  assert.ok(FONT_ALLOWLIST.length > 0);
  assert.ok((FONT_ALLOWLIST as readonly string[]).includes('Poppins'));
});

test('fontSubpath: strips spaces to the google-fonts PascalCase subpath', () => {
  assert.equal(fontSubpath('Poppins'), 'Poppins');
  assert.equal(fontSubpath('Playfair Display'), 'PlayfairDisplay');
  assert.equal(fontSubpath('Bebas Neue'), 'BebasNeue');
});

test('isBrandFont: accepts allowlisted, rejects others', () => {
  assert.equal(isBrandFont('Poppins'), true);
  assert.equal(isBrandFont('Comic Sans'), false);
  assert.equal(isBrandFont(42), false);
});

test('drift guard: every allowlisted font has a loadFont import in remotion/brand-fonts.ts', () => {
  const src = readFileSync(new URL('../../../remotion/brand-fonts.ts', import.meta.url), 'utf8');
  // Sanity: prove we read the REAL file — a misresolved-but-readable path (or an
  // empty file) must not let this pass vacuously before the loop runs.
  assert.ok(src.length > 0, 'brand-fonts.ts is empty or unreadable — check the path');
  assert.ok(src.includes('loadFont'), 'brand-fonts.ts has no loadFont imports — wrong file?');
  for (const family of FONT_ALLOWLIST) {
    const subpath = `@remotion/google-fonts/${fontSubpath(family)}`;
    assert.ok(
      src.includes(subpath),
      `missing loadFont import for ${family} (${subpath}) in remotion/brand-fonts.ts`,
    );
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/channels/fonts.test.ts`
Expected: FAIL — cannot find module `./fonts.ts`.

- [ ] **Step 3: Create `fonts.ts`**

Create `src/lib/channels/fonts.ts`:

```ts
// Curated brand fonts — the SINGLE source of truth for which fonts the editor
// offers, validation accepts, brand_kit stores, and the renderer must load. The
// renderer can't import this list (it pulls @remotion/google-fonts, which the
// node:test loader can't load), so remotion/brand-fonts.ts duplicates the family
// names — fonts.test.ts asserts the two stay in sync.
export const FONT_ALLOWLIST = [
  'Poppins',
  'Montserrat',
  'Inter',
  'Roboto',
  'Playfair Display',
  'Bebas Neue',
] as const;

export type BrandFont = (typeof FONT_ALLOWLIST)[number];

export function isBrandFont(value: unknown): value is BrandFont {
  return typeof value === 'string' && (FONT_ALLOWLIST as readonly string[]).includes(value);
}

// Family name → @remotion/google-fonts subpath (space-less PascalCase).
// 'Playfair Display' → 'PlayfairDisplay'.
export function fontSubpath(family: string): string {
  return family.replace(/\s+/g, '');
}
```

- [ ] **Step 4: Create `remotion/brand-fonts.ts`**

Create `remotion/brand-fonts.ts`:

```ts
// Loads every brand-allowlisted font before the first frame so a spec's
// theme.fonts value resolves in the CSS. MUST stay in sync with FONT_ALLOWLIST
// in src/lib/channels/fonts.ts — fonts.test.ts asserts every allowlisted family
// has its loadFont import here. (This file can't import that list: it pulls
// @remotion/google-fonts, which the node:test loader can't load.)
import { loadFont as loadPoppins } from '@remotion/google-fonts/Poppins';
import { loadFont as loadMontserrat } from '@remotion/google-fonts/Montserrat';
import { loadFont as loadInter } from '@remotion/google-fonts/Inter';
import { loadFont as loadRoboto } from '@remotion/google-fonts/Roboto';
import { loadFont as loadPlayfairDisplay } from '@remotion/google-fonts/PlayfairDisplay';
import { loadFont as loadBebasNeue } from '@remotion/google-fonts/BebasNeue';

loadPoppins();
loadMontserrat();
loadInter();
loadRoboto();
loadPlayfairDisplay();
loadBebasNeue();
```

- [ ] **Step 5: Swap the import in `ReelComposition.tsx`**

In `remotion/ReelComposition.tsx`, replace the single-font import + call (currently line 3 `import { loadFont } from '@remotion/google-fonts/Poppins';` and the `loadFont();` call near line 11) with a single side-effect import. The result around the top of the file:

```tsx
import type { FC } from 'react';
import { AbsoluteFill, Audio, Sequence, type CalculateMetadataFunction } from 'remotion';
import './brand-fonts'; // loads every brand-allowlisted font (spec 10.4); gates rendering internally
import { ThemeContext, AssetContext, type ResolvedAsset } from '../src/lib/primitives/theme-context';
import type { CompositionSpec } from '../src/lib/composition/spec';
```

Delete the now-removed `loadFont();` statement (the old comment block about registering "the brand font" is replaced by the side-effect import's comment). Leave everything else in the file unchanged.

- [ ] **Step 6: Run the test to verify it passes**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/channels/fonts.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 7: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors (the six `@remotion/google-fonts/<Font>` subpaths resolve; `ReelComposition` compiles with the side-effect import).

**Division of labor (subpath correctness vs presence):** because `brand-fonts.ts` uses *static* imports, this `tsc` step is the real backstop for a *wrong* subpath — a non-existent `@remotion/google-fonts/Xyz` fails module resolution at compile, here, not at render. The drift test (step 1) covers *presence* (every allowlisted family has an import); `tsc` covers *correctness* (each subpath actually exists). A `fontSubpath` bug would make both the renderer import and the test expectation wrong identically, so the drift test could pass — but `tsc` would still reject the bad static import. The render gate is therefore never the first place a bad subpath surfaces.

- [ ] **Step 8: Commit**

```bash
git add src/lib/channels/fonts.ts src/lib/channels/fonts.test.ts remotion/brand-fonts.ts remotion/ReelComposition.tsx
git commit -m "feat(channels): font allowlist + renderer loads all brand fonts + drift test"
```

---

### Task 2: Pure brand core (`parseChannelBrand` + `validateBrandForm`)

**Files:**
- Create: `src/lib/channels/brand.ts`
- Test: `src/lib/channels/brand.test.ts`

**Interfaces:**
- Consumes: `FONT_ALLOWLIST`, `BrandFont`, `isBrandFont` from `./fonts`; `DEFAULT_THEME`, `bakeTheme`, `BrandKit` from `../composition/theme`; `validateChannelName` from `./validate`.
- Produces: `Motion`, `CaptionEmphasisDensity`, `ColorKey` types; `BrandForm`, `BrandSaveValue` interfaces; `parseChannelBrand(row): BrandForm`; `validateBrandForm(input): { ok: true; value: BrandSaveValue } | { ok: false; reason: string }`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/channels/brand.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseChannelBrand, validateBrandForm } from './brand.ts';

const FULL_COLORS = {
  background: '#000000',
  foreground: '#ffffff',
  primary: '#3B82F6',
  secondary: '#1E3A8A',
  accent: '#F59E0B',
  bodyText: '#E2E8F0',
  positive: '#22C55E',
  negative: '#EF4444',
};

const VALID_FORM = {
  name: 'The Signal',
  colors: FULL_COLORS,
  font: 'Montserrat',
  motion: 'punchy',
  tone: '  bold, direct ',
  captionsOn: false,
  density: 'liberal',
  musicOn: true,
};

test('parseChannelBrand: empty brand_kit → defaults (Poppins, standard motion, default colors)', () => {
  const f = parseChannelBrand({ name: 'X', brand_kit: {}, brand_voice: {}, defaults: {} });
  assert.equal(f.name, 'X');
  assert.equal(f.font, 'Poppins');
  assert.equal(f.motion, 'standard');
  assert.equal(f.colors.background, '#0B1F3A'); // DEFAULT_THEME backfill
  assert.equal(f.tone, '');
  assert.equal(f.captionsOn, true);
  assert.equal(f.density, 'sparing');
  assert.equal(f.musicOn, false);
});

test('parseChannelBrand: populated brand_kit → stored values', () => {
  const f = parseChannelBrand({
    name: 'Y',
    brand_kit: { colors: { primary: '#123456' }, typography: { font: 'Inter' }, motion_preset: 'subtle' },
    brand_voice: { tone: 'calm' },
    defaults: { captions_on: false, caption_emphasis_density: 'off', music_on: true },
  });
  assert.equal(f.colors.primary, '#123456');
  assert.equal(f.font, 'Inter');
  assert.equal(f.motion, 'subtle');
  assert.equal(f.tone, 'calm');
  assert.equal(f.captionsOn, false);
  assert.equal(f.density, 'off');
  assert.equal(f.musicOn, true);
});

test('parseChannelBrand: off-allowlist stored font → falls back to Poppins', () => {
  const f = parseChannelBrand({ name: 'Z', brand_kit: { typography: { font: 'Comic Sans' } }, brand_voice: {}, defaults: {} });
  assert.equal(f.font, 'Poppins');
});

test('validateBrandForm: valid form returns the RPC pieces, tone trimmed', () => {
  const r = validateBrandForm(VALID_FORM);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.name, 'The Signal');
  assert.deepEqual(r.value.brandKitPatch.colors, FULL_COLORS);
  assert.deepEqual(r.value.brandKitPatch.typography, { font: 'Montserrat' });
  assert.equal(r.value.brandKitPatch.motion_preset, 'punchy');
  assert.deepEqual(r.value.brandVoice, { tone: 'bold, direct' });
  assert.deepEqual(r.value.defaults, { captions_on: false, caption_emphasis_density: 'liberal', music_on: true });
});

test('validateBrandForm: blank tone is omitted from brandVoice', () => {
  const r = validateBrandForm({ ...VALID_FORM, tone: '   ' });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.value.brandVoice, {});
});

test('validateBrandForm: accepts #fff and #ffffff hex forms', () => {
  assert.equal(validateBrandForm({ ...VALID_FORM, colors: { ...FULL_COLORS, primary: '#fff' } }).ok, true);
  assert.equal(validateBrandForm({ ...VALID_FORM, colors: { ...FULL_COLORS, primary: '#ffffff' } }).ok, true);
});

test('validateBrandForm: rejects missing color key', () => {
  const sevenColors: Record<string, string> = { ...FULL_COLORS };
  delete sevenColors.background;
  assert.equal(validateBrandForm({ ...VALID_FORM, colors: sevenColors }).ok, false);
});

test('validateBrandForm: rejects bad hex, off-allowlist font, bad motion/density, empty name', () => {
  assert.equal(validateBrandForm({ ...VALID_FORM, colors: { ...FULL_COLORS, primary: 'red' } }).ok, false);
  assert.equal(validateBrandForm({ ...VALID_FORM, font: 'Comic Sans' }).ok, false);
  assert.equal(validateBrandForm({ ...VALID_FORM, motion: 'wild' }).ok, false);
  assert.equal(validateBrandForm({ ...VALID_FORM, density: 'lots' }).ok, false);
  assert.equal(validateBrandForm({ ...VALID_FORM, name: '   ' }).ok, false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/channels/brand.test.ts`
Expected: FAIL — cannot find module `./brand.ts`.

- [ ] **Step 3: Write `brand.ts`**

Create `src/lib/channels/brand.ts`:

```ts
// Pure channel-brand parse + validation (Phase 8 — brand editor). No
// react/server/network. Imports only DEFAULT_THEME/bakeTheme (pure: theme.ts has
// a type-only contract import), the font allowlist, and validateChannelName.
import { DEFAULT_THEME, bakeTheme, type BrandKit } from '../composition/theme';
import { isBrandFont, type BrandFont } from './fonts';
import { validateChannelName } from './validate';

export type Motion = 'subtle' | 'standard' | 'punchy';
export type CaptionEmphasisDensity = 'off' | 'sparing' | 'liberal';
export type ColorKey = keyof typeof DEFAULT_THEME.colors;

const MOTIONS: readonly Motion[] = ['subtle', 'standard', 'punchy'];
const DENSITIES: readonly CaptionEmphasisDensity[] = ['off', 'sparing', 'liberal'];
const COLOR_KEYS = Object.keys(DEFAULT_THEME.colors) as ColorKey[];
const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

const DEFAULT_CAPTIONS_ON = true;
const DEFAULT_DENSITY: CaptionEmphasisDensity = 'sparing';
const DEFAULT_MUSIC_ON = false;

export interface BrandForm {
  name: string;
  colors: Record<ColorKey, string>;
  font: BrandFont;
  motion: Motion;
  tone: string;
  captionsOn: boolean;
  density: CaptionEmphasisDensity;
  musicOn: boolean;
}

export interface BrandSaveValue {
  name: string;
  brandKitPatch: {
    colors: Record<ColorKey, string>;
    typography: { font: BrandFont };
    motion_preset: Motion;
  };
  brandVoice: { tone?: string };
  defaults: {
    captions_on: boolean;
    caption_emphasis_density: CaptionEmphasisDensity;
    music_on: boolean;
  };
}

// Build the form's initial model from a channel row, showing CURRENT EFFECTIVE
// values: colors + motion via bakeTheme (stored-or-default). NOTE bakeTheme
// returns `motion` as the PRESET STRING ('subtle'|'standard'|'punchy'), not a
// resolved durations/easings object (see theme.ts), so baked.motion round-trips
// to the form/select directly. font comes from typography.font if allowlisted
// else Poppins; tone/defaults from their columns with code defaults.
export function parseChannelBrand(row: {
  name: string;
  brand_kit: unknown;
  brand_voice: unknown;
  defaults: unknown;
}): BrandForm {
  const brandKit = (row.brand_kit ?? {}) as BrandKit;
  const baked = bakeTheme(brandKit);

  const colors = {} as Record<ColorKey, string>;
  for (const key of COLOR_KEYS) colors[key] = baked.colors[key];

  const storedFont = brandKit.typography?.font;
  const font: BrandFont = isBrandFont(storedFont) ? storedFont : 'Poppins';

  const voice = (row.brand_voice ?? {}) as { tone?: unknown };
  const tone = typeof voice.tone === 'string' ? voice.tone : '';

  const d = (row.defaults ?? {}) as Record<string, unknown>;
  const captionsOn = typeof d.captions_on === 'boolean' ? d.captions_on : DEFAULT_CAPTIONS_ON;
  const density = DENSITIES.includes(d.caption_emphasis_density as CaptionEmphasisDensity)
    ? (d.caption_emphasis_density as CaptionEmphasisDensity)
    : DEFAULT_DENSITY;
  const musicOn = typeof d.music_on === 'boolean' ? d.music_on : DEFAULT_MUSIC_ON;

  return { name: row.name, colors, font, motion: baked.motion, tone, captionsOn, density, musicOn };
}

// Validate a form submission. ALL 8 ColorKeys required (colors is replaced
// wholesale on the || merge). Returns the exact pieces the RPC needs.
export function validateBrandForm(
  input: unknown,
): { ok: true; value: BrandSaveValue } | { ok: false; reason: string } {
  if (!input || typeof input !== 'object') return { ok: false, reason: 'Invalid form.' };
  const f = input as Record<string, unknown>;

  const nameRes = validateChannelName(f.name);
  if (!nameRes.ok) return nameRes;

  if (!f.colors || typeof f.colors !== 'object') return { ok: false, reason: 'Missing colours.' };
  const ci = f.colors as Record<string, unknown>;
  const colors = {} as Record<ColorKey, string>;
  for (const key of COLOR_KEYS) {
    const v = ci[key];
    if (typeof v !== 'string' || !HEX.test(v)) {
      return { ok: false, reason: `Invalid colour for ${key}.` };
    }
    colors[key] = v;
  }

  if (!isBrandFont(f.font)) return { ok: false, reason: 'Pick a font from the list.' };
  if (!MOTIONS.includes(f.motion as Motion)) return { ok: false, reason: 'Invalid motion preset.' };
  if (!DENSITIES.includes(f.density as CaptionEmphasisDensity)) {
    return { ok: false, reason: 'Invalid emphasis density.' };
  }
  if (typeof f.captionsOn !== 'boolean' || typeof f.musicOn !== 'boolean') {
    return { ok: false, reason: 'Invalid default toggle.' };
  }

  const toneRaw = typeof f.tone === 'string' ? f.tone.trim() : '';
  const brandVoice: { tone?: string } = toneRaw ? { tone: toneRaw } : {};

  return {
    ok: true,
    value: {
      name: nameRes.value,
      brandKitPatch: { colors, typography: { font: f.font }, motion_preset: f.motion as Motion },
      brandVoice,
      defaults: {
        captions_on: f.captionsOn,
        caption_emphasis_density: f.density as CaptionEmphasisDensity,
        music_on: f.musicOn,
      },
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/channels/brand.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/channels/brand.ts src/lib/channels/brand.test.ts
git commit -m "feat(channels): pure parseChannelBrand + validateBrandForm + tests"
```

---

### Task 3: `update_channel_brand` migration

**Files:**
- Create: `supabase/migrations/20260618120000_update_channel_brand.sql`

**Interfaces:**
- Produces: SQL function `update_channel_brand(p_channel_id uuid, p_name text, p_brand_kit_patch jsonb, p_brand_voice jsonb, p_defaults jsonb) returns uuid`.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260618120000_update_channel_brand.sql`:

```sql
-- Phase 8 — channel brand editor. One atomic write of the channel's editable
-- brand surface. brand_kit is SHALLOW-MERGED (brand_kit || patch) so sibling
-- keys owned by later slices (caption_emphasis, caption_style, logos) survive;
-- brand_voice and defaults are written wholesale (this editor owns all their
-- keys). SECURITY INVOKER → the caller's RLS on channels applies (acct_isolation
-- with check (auth_owns_account(account_id))), so only the owner's row updates.
-- RETURNS the updated id (NULL when no row matched) so the action can tell a
-- real save from a zero-row miss and never report a phantom "Saved".
create or replace function update_channel_brand(
  p_channel_id      uuid,
  p_name            text,
  p_brand_kit_patch jsonb,
  p_brand_voice     jsonb,
  p_defaults        jsonb
) returns uuid
language sql
security invoker
as $$
  update channels
  set name        = p_name,
      brand_kit   = brand_kit || p_brand_kit_patch,
      brand_voice = p_brand_voice,
      defaults    = p_defaults,
      updated_at  = now()
  where id = p_channel_id
  returning id;
$$;

grant execute on function update_channel_brand(uuid, text, jsonb, jsonb, jsonb) to authenticated;
```

- [ ] **Step 2: Apply the migration**

Run: `npm run db:apply -- supabase/migrations/20260618120000_update_channel_brand.sql`
Expected: "Recorded migration 20260618120000 …" + "Applied …". If it reports BLOCKED (creds/duplicate), report the exact error rather than guessing.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260618120000_update_channel_brand.sql
git commit -m "feat(channels): update_channel_brand RPC (shallow-merge brand_kit, returns id)"
```

---

### Task 4: `saveChannelBrand` server action

**Files:**
- Create: `src/app/(app)/channels/[id]/brand-actions.ts`

**Interfaces:**
- Consumes: `validateBrandForm` from `@/lib/channels/brand`; `createClient` from `@/lib/supabase/server`; the `update_channel_brand` RPC (Task 3).
- Produces: `saveChannelBrand(channelId: string, input: unknown): Promise<{ ok: true } | { ok: false; reason: string }>`.

No unit test (thin orchestration; the logic is the tested `validateBrandForm`). Build, typecheck, commit.

- [ ] **Step 1: Write the action**

Create `src/app/(app)/channels/[id]/brand-actions.ts`:

```ts
'use server';

import { createClient } from '@/lib/supabase/server';
import { validateBrandForm } from '@/lib/channels/brand';

// Validate the brand form, then atomically write it via the update_channel_brand
// RPC. The RPC returns the channel id, or null when zero rows matched (wrong id,
// RLS regression, channel deleted mid-edit) — that is a failure, not a phantom
// "Saved". Mirrors updateVideoSettings (rpc + null check). RLS (SECURITY INVOKER)
// guarantees only the owner's channel updates.
export async function saveChannelBrand(
  channelId: string,
  input: unknown,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const valid = validateBrandForm(input);
  if (!valid.ok) return valid;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc('update_channel_brand', {
    p_channel_id: channelId,
    p_name: valid.value.name,
    p_brand_kit_patch: valid.value.brandKitPatch,
    p_brand_voice: valid.value.brandVoice,
    p_defaults: valid.value.defaults,
  });
  if (error) return { ok: false, reason: error.message };
  if (data == null) return { ok: false, reason: 'Channel not found.' };
  return { ok: true };
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors mentioning `brand-actions.ts`.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(app)/channels/[id]/brand-actions.ts"
git commit -m "feat(channels): saveChannelBrand action (validate + RPC, no phantom save)"
```

---

### Task 5: `BrandEditor` UI + detail page wiring

**Files:**
- Create: `src/app/(app)/channels/[id]/BrandEditor.tsx`
- Modify: `src/app/(app)/channels/[id]/page.tsx` (read full channel, parse, render the editor)

**Interfaces:**
- Consumes: `saveChannelBrand` from `./brand-actions`; `FONT_ALLOWLIST` from `@/lib/channels/fonts`; `parseChannelBrand` + the `BrandForm`/`ColorKey`/`Motion`/`CaptionEmphasisDensity` types from `@/lib/channels/brand`.
- Produces: the working `/channels/[id]` brand editor.

No unit test (client form + server component — verified by the app-run + render gate).

- [ ] **Step 1: Create `BrandEditor.tsx`**

Create `src/app/(app)/channels/[id]/BrandEditor.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { saveChannelBrand } from './brand-actions';
import { FONT_ALLOWLIST } from '@/lib/channels/fonts';
import type {
  BrandForm,
  ColorKey,
  Motion,
  CaptionEmphasisDensity,
} from '@/lib/channels/brand';

const COLOR_ORDER: ColorKey[] = [
  'background',
  'foreground',
  'primary',
  'secondary',
  'accent',
  'bodyText',
  'positive',
  'negative',
];
const COLOR_LABELS: Record<ColorKey, string> = {
  background: 'Background',
  foreground: 'Foreground',
  primary: 'Primary',
  secondary: 'Secondary',
  accent: 'Accent',
  bodyText: 'Body text',
  positive: 'Positive',
  negative: 'Negative',
};
const MOTIONS: Motion[] = ['subtle', 'standard', 'punchy'];
const DENSITIES: CaptionEmphasisDensity[] = ['off', 'sparing', 'liberal'];

// Channel brand editor. A single Save button with dirty-tracking (not per-field
// autosave — it's a coherent form). On {ok:false} edits stay and the reason
// shows; try/catch/finally so the button never stays stuck.
export function BrandEditor({ channelId, initial }: { channelId: string; initial: BrandForm }) {
  const [form, setForm] = useState<BrandForm>(initial);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function update<K extends keyof BrandForm>(key: K, value: BrandForm[K]) {
    setForm((f) => ({ ...f, [key]: value }));
    setDirty(true);
    setSaved(false);
  }
  function setColor(key: ColorKey, value: string) {
    setForm((f) => ({ ...f, colors: { ...f.colors, [key]: value } }));
    setDirty(true);
    setSaved(false);
  }

  async function onSave() {
    setBusy(true);
    setError(null);
    try {
      const res = await saveChannelBrand(channelId, form);
      if (res.ok) {
        setDirty(false);
        setSaved(true);
      } else {
        setError(res.reason);
      }
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  const inputCls =
    'rounded-md border border-black/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-black/40 disabled:opacity-50 dark:border-white/15 dark:focus:border-white/40';

  return (
    <div className="space-y-6">
      <label className="block space-y-1">
        <span className="text-sm font-medium">Channel name</span>
        <input
          value={form.name}
          onChange={(e) => update('name', e.target.value)}
          disabled={busy}
          className={`block w-full max-w-sm ${inputCls}`}
        />
      </label>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Colours</legend>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {COLOR_ORDER.map((key) => (
            <label key={key} className="space-y-1">
              <span className="text-xs opacity-70">{COLOR_LABELS[key]}</span>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={form.colors[key]}
                  onChange={(e) => setColor(key, e.target.value)}
                  disabled={busy}
                  className="h-8 w-8 shrink-0 rounded border border-black/15 dark:border-white/15"
                />
                <input
                  value={form.colors[key]}
                  onChange={(e) => setColor(key, e.target.value)}
                  disabled={busy}
                  className={`w-full px-2 py-1 text-xs ${inputCls}`}
                />
              </div>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="flex flex-wrap gap-6">
        <label className="space-y-1">
          <span className="block text-sm font-medium">Font</span>
          <select
            value={form.font}
            onChange={(e) => update('font', e.target.value as BrandForm['font'])}
            disabled={busy}
            className={inputCls}
          >
            {FONT_ALLOWLIST.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1">
          <span className="block text-sm font-medium">Motion</span>
          <select
            value={form.motion}
            onChange={(e) => update('motion', e.target.value as Motion)}
            disabled={busy}
            className={`capitalize ${inputCls}`}
          >
            {MOTIONS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="block space-y-1">
        <span className="text-sm font-medium">Brand voice (tone)</span>
        <textarea
          value={form.tone}
          onChange={(e) => update('tone', e.target.value)}
          disabled={busy}
          rows={2}
          placeholder="e.g. clear, friendly, concise"
          className={`block w-full resize-y ${inputCls}`}
        />
      </label>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Video defaults</legend>
        <div className="flex flex-wrap items-center gap-6 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={form.captionsOn}
              onChange={(e) => update('captionsOn', e.target.checked)}
              disabled={busy}
            />
            Captions on
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={form.musicOn}
              onChange={(e) => update('musicOn', e.target.checked)}
              disabled={busy}
            />
            Music on
          </label>
          <label className="flex items-center gap-2">
            Emphasis
            <select
              value={form.density}
              onChange={(e) => update('density', e.target.value as CaptionEmphasisDensity)}
              disabled={busy}
              className={`capitalize ${inputCls}`}
            >
              {DENSITIES.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </label>
        </div>
      </fieldset>

      <div className="space-y-2 rounded-lg border border-black/10 p-4 dark:border-white/10">
        <span className="text-xs font-medium opacity-70">Preview</span>
        <div className="flex gap-1">
          {COLOR_ORDER.map((key) => (
            <span
              key={key}
              title={COLOR_LABELS[key]}
              className="h-6 w-6 rounded border border-black/10 dark:border-white/10"
              style={{ backgroundColor: form.colors[key] }}
            />
          ))}
        </div>
        <div
          className="rounded-md p-4"
          style={{ backgroundColor: form.colors.background, color: form.colors.primary, fontFamily: form.font }}
        >
          <span className="text-lg font-semibold">The quick brown fox</span>{' '}
          <span style={{ color: form.colors.positive }}>up</span>{' '}
          <span style={{ color: form.colors.negative }}>down</span>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={onSave}
          disabled={busy || !dirty}
          className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
        {saved && !dirty && <span className="text-sm text-green-600">Saved</span>}
        {error && <span className="text-sm text-red-600">{error}</span>}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Rewrite `page.tsx` to wire the editor**

Replace `src/app/(app)/channels/[id]/page.tsx` entirely:

```tsx
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { parseChannelBrand } from '@/lib/channels/brand';
import { BrandEditor } from './BrandEditor';

// Channel brand editor (Phase 8 slice 2). RLS scopes the read; a miss (not found
// OR not owned) → 404. parseChannelBrand shows current EFFECTIVE values.
export default async function ChannelDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: channel } = await supabase
    .from('channels')
    .select('id, name, brand_kit, brand_voice, defaults')
    .eq('id', id)
    .maybeSingle();

  if (!channel) notFound();

  const initial = parseChannelBrand({
    name: channel.name as string,
    brand_kit: channel.brand_kit,
    brand_voice: channel.brand_voice,
    defaults: channel.defaults,
  });

  return (
    <div className="space-y-6">
      <Link href="/channels" className="text-sm underline opacity-70 hover:opacity-100">
        ← Channels
      </Link>
      <div>
        <h1 className="text-2xl font-semibold">{channel.name as string}</h1>
        <p className="text-sm opacity-70">
          Brand identity — colours, font, motion, voice, and video defaults.
        </p>
      </div>
      <BrandEditor channelId={channel.id as string} initial={initial} />
    </div>
  );
}
```

- [ ] **Step 3: Typecheck + lint**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npx eslint "src/app/(app)/channels/[id]/BrandEditor.tsx" "src/app/(app)/channels/[id]/page.tsx" "src/app/(app)/channels/[id]/brand-actions.ts"`
Expected: clean.

- [ ] **Step 4: App-run e2e (manual) + render gate**

Start the dev server. Verify:
1. Open `/channels/[id]` for an existing channel → all fields show current values (colours, font, motion default to Poppins/standard for a minimal brand_kit; tone/defaults reflect stored or code defaults).
2. Change colours (picker + hex), font, motion, tone, the three defaults → **Save** → "Saved" appears, button disables (not dirty).
3. Reload → the saved values persist.
4. Enter an invalid hex (e.g. `red`) in a colour text field → Save → the reason shows and nothing persists; fix it → Save succeeds.
   - **Known cosmetic quirk (note, not a fix):** the native `<input type="color">` only renders 6-digit hex, so typing a valid 3-digit `#fff` in the text field shows black in the picker swatch (the text value and validation still accept/save `#fff` correctly — data is not corrupted). Native pickers always emit `#rrggbb`, so picking a colour keeps both in sync. A later polish could normalize 3-digit → 6-digit on blur.
5. Confirm a prior slice's `brand_kit` sibling key would survive (the merge is shallow) — not directly visible yet (slices 3–4), reason through the RPC `||`.

**Render gate (required, operator-run before merge):** `npm run deploy:remotion`, then render a video on a channel whose font is NOT Poppins → confirm the output renders in that font with the brand colours, a Poppins channel still renders, and Lambda init time in the logs is unchanged.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/channels/[id]/BrandEditor.tsx" "src/app/(app)/channels/[id]/page.tsx"
git commit -m "feat(channels): brand editor UI (colours, font, motion, tone, defaults) + page wiring"
```

---

## Notes for the implementer

- Commit per task. Tasks 1–2 are TDD (RED→GREEN); 3 is the migration; 4–5 are build + typecheck/lint (verified by the manual app-run + render gate, no unit test).
- The render gate (deploy:remotion + a Lambda render) is the operator's manual step at finish time — it cannot be automated in this flow. Flag it clearly so it's run before merge.
- Do not split display/body/mono fonts — one brand font → `typography.font`; `bakeTheme` applies it to display + body.
