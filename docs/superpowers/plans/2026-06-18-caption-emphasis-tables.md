# Caption-emphasis Tables Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Caption emphasis" section to `/channels/[id]` that edits `brand_kit.caption_emphasis` — a 4-role typography table and a 3-tone colour table.

**Architecture:** A pure core (`caption-emphasis.ts`) parses the stored config into effective form values and validates a submission into a `CaptionEmphasisConfig`; a `saveCaptionEmphasis` action calls a focused `set_channel_caption_emphasis` RPC that `jsonb_set`s only the `caption_emphasis` key (preserving siblings) and returns the id (no phantom save); a `CaptionEmphasisEditor` client section with its own Save renders below the slice-2 brand editor. No renderer change — `render.ts` already reads `brand_kit.caption_emphasis`.

**Tech Stack:** Next.js 16 App Router (server + client components), Supabase under RLS, TypeScript, `node:test` via the project loader.

Design source: `docs/superpowers/specs/2026-06-18-caption-emphasis-tables-design.md`.

## Global Constraints

- **No schema change, no renderer change.** `render.ts` `loadBrief` already reads `brand_kit.caption_emphasis` (line ~435) → bakes via `resolveWordStyle`. This slice is config + UI only — NO `deploy:remotion` gate.
- **Role table stored FULL** — all 4 roles (`key`,`shout`,`contrast`,`number`) × 4 fields (`font`∈{display,body,mono}, `weight` integer 100–900, `sizeMultiplier` 0.5–3.0, `italic` boolean).
- **Tone table follow/custom** — `positive`/`negative`/`neutral`. `mode:'theme'` (follow) stores NOTHING for that tone; `mode:'custom'` stores `{ color: hex }`. The `tones` key is omitted entirely when no tone is custom.
- **`set_channel_caption_emphasis` RPC** is `security invoker`, writes ONLY `brand_kit.caption_emphasis` via `jsonb_set(brand_kit, '{caption_emphasis}', p_value, true)` (preserves `colors`/`typography`/`motion_preset`/`logos`), and `RETURNING id` (NULL on zero rows).
- **No phantom save:** `saveCaptionEmphasis` returns `{ ok:false, reason:'Channel not found.' }` when the RPC returns null.
- **Pure boundary:** `caption-emphasis.ts` imports only `../captions/emphasis-style` (pure), `../captions/types` (pure), and the `Theme` type from `../primitives/contract` (type-only). No react/server/network. Test imports use explicit `.ts` extensions.
- **Validation bounds:** font ∈ `{display,body,mono}`; weight integer in `[100,900]`; sizeMultiplier in `[0.5,3.0]`; italic boolean; custom tone colour matches `/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/`.
- RLS via `@/lib/supabase/server`'s `createClient()`. Server actions begin with `'use server'`. Tests run via `npm test`.

---

### Task 1: Pure caption-emphasis core (`parse` + `validate` + `defaultToneColors`)

**Files:**
- Create: `src/lib/channels/caption-emphasis.ts`
- Test: `src/lib/channels/caption-emphasis.test.ts`

**Interfaces:**
- Consumes: `DEFAULT_ROLE_TABLE`, `RoleStyle`, `CaptionEmphasisConfig` from `../captions/emphasis-style`; `EMPHASIS_ROLES`, `EMPHASIS_TONES`, `EmphasisRole`, `EmphasisTone` from `../captions/types`; `Theme` type from `../primitives/contract`; `DEFAULT_THEME` from `../composition/theme` (test only).
- Produces: `FontSlot`, `RoleRow`, `ToneRow`, `CaptionEmphasisForm`; `FONT_SLOTS`, `WEIGHT_MIN/MAX`, `SIZE_MIN/MAX`; `parseCaptionEmphasis(brandKit, theme): CaptionEmphasisForm`; `defaultToneColors(theme): Record<EmphasisTone, string>`; `validateCaptionEmphasisForm(input): { ok:true; value: CaptionEmphasisConfig } | { ok:false; reason: string }`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/channels/caption-emphasis.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCaptionEmphasis,
  validateCaptionEmphasisForm,
  defaultToneColors,
} from './caption-emphasis.ts';
import { DEFAULT_THEME } from '../composition/theme.ts';
import { DEFAULT_ROLE_TABLE } from '../captions/emphasis-style.ts';

const T = DEFAULT_THEME; // positive #22C55E, negative #EF4444, accent #F59E0B

test('parseCaptionEmphasis: empty brand_kit → default role table + tones follow theme', () => {
  const f = parseCaptionEmphasis({}, T);
  assert.deepEqual(f.roles.shout, DEFAULT_ROLE_TABLE.shout);
  assert.equal(f.roles.key.weight, DEFAULT_ROLE_TABLE.key.weight);
  assert.deepEqual(f.tones.positive, { mode: 'theme', color: T.colors.positive });
  assert.deepEqual(f.tones.negative, { mode: 'theme', color: T.colors.negative });
  assert.deepEqual(f.tones.neutral, { mode: 'theme', color: T.colors.accent });
});

test('parseCaptionEmphasis: stored role override merges over default', () => {
  const f = parseCaptionEmphasis({ caption_emphasis: { roles: { key: { weight: 900 } } } }, T);
  assert.equal(f.roles.key.weight, 900);
  assert.equal(f.roles.key.font, DEFAULT_ROLE_TABLE.key.font); // untouched field keeps default
});

test('parseCaptionEmphasis: stored custom tone hex → mode custom', () => {
  const f = parseCaptionEmphasis({ caption_emphasis: { tones: { positive: { color: '#abcdef' } } } }, T);
  assert.deepEqual(f.tones.positive, { mode: 'custom', color: '#abcdef' });
});

test('parseCaptionEmphasis: stored tone as a theme-token name → resolved to hex, custom', () => {
  const f = parseCaptionEmphasis({ caption_emphasis: { tones: { neutral: { color: 'primary' } } } }, T);
  assert.deepEqual(f.tones.neutral, { mode: 'custom', color: T.colors.primary });
});

test('defaultToneColors: maps tones to the theme tokens they follow', () => {
  assert.deepEqual(defaultToneColors(T), {
    positive: T.colors.positive,
    negative: T.colors.negative,
    neutral: T.colors.accent,
  });
});

const VALID_FORM = {
  roles: {
    key: { font: 'body', weight: 700, sizeMultiplier: 1.15, italic: false },
    shout: { font: 'display', weight: 800, sizeMultiplier: 1.4, italic: false },
    contrast: { font: 'body', weight: 600, sizeMultiplier: 0.9, italic: true },
    number: { font: 'display', weight: 800, sizeMultiplier: 1.5, italic: false },
  },
  tones: {
    positive: { mode: 'custom', color: '#00ff00' },
    negative: { mode: 'theme', color: '#EF4444' },
    neutral: { mode: 'theme', color: '#F59E0B' },
  },
};

test('validateCaptionEmphasisForm: valid → full roles + only custom tones', () => {
  const r = validateCaptionEmphasisForm(VALID_FORM);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.value.roles?.shout, { font: 'display', weight: 800, sizeMultiplier: 1.4, italic: false });
  assert.equal(Object.keys(r.value.roles ?? {}).length, 4);
  assert.deepEqual(r.value.tones, { positive: { color: '#00ff00' } }); // only the custom one
});

test('validateCaptionEmphasisForm: all tones following theme → tones key omitted', () => {
  const allTheme = {
    ...VALID_FORM,
    tones: {
      positive: { mode: 'theme', color: '#1' },
      negative: { mode: 'theme', color: '#2' },
      neutral: { mode: 'theme', color: '#3' },
    },
  };
  const r = validateCaptionEmphasisForm(allTheme);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal('tones' in r.value, false);
});

test('validateCaptionEmphasisForm: rejects bad font / weight / size / italic / custom hex', () => {
  assert.equal(validateCaptionEmphasisForm({ ...VALID_FORM, roles: { ...VALID_FORM.roles, key: { ...VALID_FORM.roles.key, font: 'serif' } } }).ok, false);
  assert.equal(validateCaptionEmphasisForm({ ...VALID_FORM, roles: { ...VALID_FORM.roles, key: { ...VALID_FORM.roles.key, weight: 99 } } }).ok, false);
  assert.equal(validateCaptionEmphasisForm({ ...VALID_FORM, roles: { ...VALID_FORM.roles, key: { ...VALID_FORM.roles.key, weight: 901 } } }).ok, false);
  assert.equal(validateCaptionEmphasisForm({ ...VALID_FORM, roles: { ...VALID_FORM.roles, key: { ...VALID_FORM.roles.key, weight: 700.5 } } }).ok, false);
  assert.equal(validateCaptionEmphasisForm({ ...VALID_FORM, roles: { ...VALID_FORM.roles, key: { ...VALID_FORM.roles.key, sizeMultiplier: 0.4 } } }).ok, false);
  assert.equal(validateCaptionEmphasisForm({ ...VALID_FORM, roles: { ...VALID_FORM.roles, key: { ...VALID_FORM.roles.key, sizeMultiplier: 3.1 } } }).ok, false);
  assert.equal(validateCaptionEmphasisForm({ ...VALID_FORM, tones: { ...VALID_FORM.tones, positive: { mode: 'custom', color: 'green' } } }).ok, false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/channels/caption-emphasis.test.ts`
Expected: FAIL — cannot find module `./caption-emphasis.ts`.

- [ ] **Step 3: Write `caption-emphasis.ts`**

Create `src/lib/channels/caption-emphasis.ts`:

```ts
// Pure caption-emphasis parse + validation (Phase 8 — caption emphasis tables
// editor). No react/server/network: imports the pure emphasis-style module
// (DEFAULT_ROLE_TABLE / types), the pure caption types, and the Theme type only.
import {
  DEFAULT_ROLE_TABLE,
  type RoleStyle,
  type CaptionEmphasisConfig,
} from '../captions/emphasis-style';
import {
  EMPHASIS_ROLES,
  EMPHASIS_TONES,
  type EmphasisRole,
  type EmphasisTone,
} from '../captions/types';
import type { Theme } from '../primitives/contract';

export type FontSlot = 'display' | 'body' | 'mono';
export const FONT_SLOTS: readonly FontSlot[] = ['display', 'body', 'mono'];
export const WEIGHT_MIN = 100;
export const WEIGHT_MAX = 900;
export const SIZE_MIN = 0.5;
export const SIZE_MAX = 3.0;

export interface RoleRow {
  font: FontSlot;
  weight: number;
  sizeMultiplier: number;
  italic: boolean;
}
export interface ToneRow {
  mode: 'theme' | 'custom';
  color: string; // effective hex (for display)
}
export interface CaptionEmphasisForm {
  roles: Record<EmphasisRole, RoleRow>;
  tones: Record<EmphasisTone, ToneRow>;
}

const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

// The theme token each tone follows when not overridden (mirrors
// resolveToneColor in emphasis-style.ts: positive/negative/accent).
function themeToneColor(tone: EmphasisTone, theme: Theme): string {
  if (tone === 'positive') return theme.colors.positive;
  if (tone === 'negative') return theme.colors.negative;
  return theme.colors.accent; // neutral
}

export function defaultToneColors(theme: Theme): Record<EmphasisTone, string> {
  return {
    positive: themeToneColor('positive', theme),
    negative: themeToneColor('negative', theme),
    neutral: themeToneColor('neutral', theme),
  };
}

// A stored tone override may be a theme-token name or a literal hex.
function resolveColorValue(value: string, theme: Theme): string {
  return value in theme.colors ? theme.colors[value as keyof Theme['colors']] : value;
}

export function parseCaptionEmphasis(brandKit: unknown, theme: Theme): CaptionEmphasisForm {
  const bk = (brandKit && typeof brandKit === 'object' ? brandKit : {}) as {
    caption_emphasis?: CaptionEmphasisConfig;
  };
  const config = bk.caption_emphasis ?? {};

  const roles = {} as Record<EmphasisRole, RoleRow>;
  for (const role of EMPHASIS_ROLES) {
    const merged: RoleStyle = { ...DEFAULT_ROLE_TABLE[role], ...config.roles?.[role] };
    roles[role] = {
      font: merged.font,
      weight: merged.weight,
      sizeMultiplier: merged.sizeMultiplier,
      italic: merged.italic,
    };
  }

  const tones = {} as Record<EmphasisTone, ToneRow>;
  for (const tone of EMPHASIS_TONES) {
    const override = config.tones?.[tone]?.color;
    if (typeof override === 'string' && override) {
      tones[tone] = { mode: 'custom', color: resolveColorValue(override, theme) };
    } else {
      tones[tone] = { mode: 'theme', color: themeToneColor(tone, theme) };
    }
  }

  return { roles, tones };
}

export function validateCaptionEmphasisForm(
  input: unknown,
): { ok: true; value: CaptionEmphasisConfig } | { ok: false; reason: string } {
  if (!input || typeof input !== 'object') return { ok: false, reason: 'Invalid form.' };
  const f = input as { roles?: unknown; tones?: unknown };

  if (!f.roles || typeof f.roles !== 'object') return { ok: false, reason: 'Missing roles.' };
  const rolesIn = f.roles as Record<string, unknown>;
  const roles = {} as Record<EmphasisRole, RoleStyle>;
  for (const role of EMPHASIS_ROLES) {
    const r = rolesIn[role] as Record<string, unknown> | undefined;
    if (!r || typeof r !== 'object') return { ok: false, reason: `Missing settings for ${role}.` };
    if (!(FONT_SLOTS as readonly string[]).includes(r.font as string)) {
      return { ok: false, reason: `Invalid font for ${role}.` };
    }
    const weight = r.weight;
    if (
      typeof weight !== 'number' ||
      !Number.isInteger(weight) ||
      weight < WEIGHT_MIN ||
      weight > WEIGHT_MAX
    ) {
      return { ok: false, reason: `Weight for ${role} must be ${WEIGHT_MIN}–${WEIGHT_MAX}.` };
    }
    const size = r.sizeMultiplier;
    if (typeof size !== 'number' || size < SIZE_MIN || size > SIZE_MAX) {
      return { ok: false, reason: `Size for ${role} must be ${SIZE_MIN}–${SIZE_MAX}.` };
    }
    if (typeof r.italic !== 'boolean') return { ok: false, reason: `Invalid italic for ${role}.` };
    roles[role] = {
      font: r.font as FontSlot,
      weight,
      sizeMultiplier: size,
      italic: r.italic,
    };
  }

  if (!f.tones || typeof f.tones !== 'object') return { ok: false, reason: 'Missing tones.' };
  const tonesIn = f.tones as Record<string, unknown>;
  const tones: Partial<Record<EmphasisTone, { color: string }>> = {};
  for (const tone of EMPHASIS_TONES) {
    const t = tonesIn[tone] as Record<string, unknown> | undefined;
    if (!t || typeof t !== 'object') return { ok: false, reason: `Missing tone ${tone}.` };
    if (t.mode === 'custom') {
      const color = t.color;
      if (typeof color !== 'string' || !HEX.test(color)) {
        return { ok: false, reason: `Invalid colour for ${tone}.` };
      }
      tones[tone] = { color };
    } else if (t.mode !== 'theme') {
      return { ok: false, reason: `Invalid mode for ${tone}.` };
    }
    // mode 'theme' → omit (the tone follows the theme token at render)
  }

  const value: CaptionEmphasisConfig = { roles };
  if (Object.keys(tones).length > 0) value.tones = tones;
  return { ok: true, value };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --experimental-strip-types --import ./scripts/register-loader.mjs --test src/lib/channels/caption-emphasis.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/channels/caption-emphasis.ts src/lib/channels/caption-emphasis.test.ts
git commit -m "feat(channels): pure caption-emphasis parse + validate + tests"
```

---

### Task 2: `set_channel_caption_emphasis` migration

**Files:**
- Create: `supabase/migrations/20260618130000_set_channel_caption_emphasis.sql`

**Interfaces:**
- Produces: SQL function `set_channel_caption_emphasis(p_channel_id uuid, p_value jsonb) returns uuid`.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260618130000_set_channel_caption_emphasis.sql`:

```sql
-- Phase 8 — caption-emphasis tables editor. Writes ONLY brand_kit.caption_emphasis
-- via jsonb_set (create_missing=true), preserving sibling keys (colors, typography,
-- motion_preset, logos) that other slices own. SECURITY INVOKER → the caller's RLS
-- on channels applies (acct_isolation with check (auth_owns_account(account_id))).
-- RETURNS the updated id (NULL when no row matched) so the action never reports a
-- phantom "Saved".
create or replace function set_channel_caption_emphasis(
  p_channel_id uuid,
  p_value      jsonb
) returns uuid
language sql
security invoker
as $$
  update channels
  set brand_kit  = jsonb_set(brand_kit, '{caption_emphasis}', p_value, true),
      updated_at = now()
  where id = p_channel_id
  returning id;
$$;

grant execute on function set_channel_caption_emphasis(uuid, jsonb) to authenticated;
```

- [ ] **Step 2: Apply the migration**

Run: `npm run db:apply -- supabase/migrations/20260618130000_set_channel_caption_emphasis.sql`
Expected: "Recorded migration 20260618130000 …" + "Applied …". If it reports BLOCKED (creds/duplicate), report the exact error rather than guessing.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260618130000_set_channel_caption_emphasis.sql
git commit -m "feat(channels): set_channel_caption_emphasis RPC (jsonb_set, returns id)"
```

---

### Task 3: `saveCaptionEmphasis` server action

**Files:**
- Create: `src/app/(app)/channels/[id]/caption-emphasis-actions.ts`

**Interfaces:**
- Consumes: `validateCaptionEmphasisForm` from `@/lib/channels/caption-emphasis`; `createClient` from `@/lib/supabase/server`; the `set_channel_caption_emphasis` RPC (Task 2).
- Produces: `saveCaptionEmphasis(channelId: string, input: unknown): Promise<{ ok: true } | { ok: false; reason: string }>`.

No unit test (thin orchestration; the logic is the tested `validateCaptionEmphasisForm`).

- [ ] **Step 1: Write the action**

Create `src/app/(app)/channels/[id]/caption-emphasis-actions.ts`:

```ts
'use server';

import { createClient } from '@/lib/supabase/server';
import { validateCaptionEmphasisForm } from '@/lib/channels/caption-emphasis';

// Validate the caption-emphasis form, then write it via the
// set_channel_caption_emphasis RPC (jsonb_set on brand_kit.caption_emphasis only).
// The RPC returns the channel id, or null when zero rows matched — that is a
// failure, not a phantom "Saved". Mirrors saveChannelBrand. RLS (SECURITY INVOKER)
// guarantees only the owner's channel updates.
export async function saveCaptionEmphasis(
  channelId: string,
  input: unknown,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const valid = validateCaptionEmphasisForm(input);
  if (!valid.ok) return valid;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc('set_channel_caption_emphasis', {
    p_channel_id: channelId,
    p_value: valid.value,
  });
  if (error) return { ok: false, reason: error.message };
  if (data == null) return { ok: false, reason: 'Channel not found.' };
  return { ok: true };
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors mentioning `caption-emphasis-actions.ts`.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(app)/channels/[id]/caption-emphasis-actions.ts"
git commit -m "feat(channels): saveCaptionEmphasis action (validate + RPC, no phantom save)"
```

---

### Task 4: `CaptionEmphasisEditor` UI + page wiring

**Files:**
- Create: `src/app/(app)/channels/[id]/CaptionEmphasisEditor.tsx`
- Modify: `src/app/(app)/channels/[id]/page.tsx` (bake theme, parse, render the section below the brand editor)

**Interfaces:**
- Consumes: `saveCaptionEmphasis` from `./caption-emphasis-actions`; `FONT_SLOTS`, `WEIGHT_MIN`, `WEIGHT_MAX`, `SIZE_MIN`, `SIZE_MAX`, `parseCaptionEmphasis`, `defaultToneColors`, and the `CaptionEmphasisForm`/`FontSlot` types from `@/lib/channels/caption-emphasis`; `EMPHASIS_ROLES`, `EMPHASIS_TONES`, `EmphasisTone` from `@/lib/captions/types`; `bakeTheme` from `@/lib/composition/theme`.
- Produces: the working Caption emphasis section.

No unit test (client form + server component).

- [ ] **Step 1: Create `CaptionEmphasisEditor.tsx`**

Create `src/app/(app)/channels/[id]/CaptionEmphasisEditor.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { saveCaptionEmphasis } from './caption-emphasis-actions';
import {
  FONT_SLOTS,
  WEIGHT_MIN,
  WEIGHT_MAX,
  SIZE_MIN,
  SIZE_MAX,
  type CaptionEmphasisForm,
  type FontSlot,
  type RoleRow,
} from '@/lib/channels/caption-emphasis';
import {
  EMPHASIS_ROLES,
  EMPHASIS_TONES,
  type EmphasisRole,
  type EmphasisTone,
} from '@/lib/captions/types';

// Caption-emphasis editor (Phase 8 slice 3). A second Save-section on the channel
// page: a 4-role typography table + a 3-tone colour table (follow theme / custom).
// followColors are the theme tokens each tone follows; fonts maps the role font
// slot to the brand font family (for the preview).
export function CaptionEmphasisEditor({
  channelId,
  initial,
  fonts,
  followColors,
}: {
  channelId: string;
  initial: CaptionEmphasisForm;
  fonts: Record<FontSlot, string>;
  followColors: Record<EmphasisTone, string>;
}) {
  const [form, setForm] = useState<CaptionEmphasisForm>(initial);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function touch() {
    setDirty(true);
    setSaved(false);
  }
  function setRole(role: EmphasisRole, patch: Partial<RoleRow>) {
    setForm((f) => ({ ...f, roles: { ...f.roles, [role]: { ...f.roles[role], ...patch } } }));
    touch();
  }
  function setToneMode(tone: EmphasisTone, mode: 'theme' | 'custom') {
    setForm((f) => ({
      ...f,
      tones: {
        ...f.tones,
        // toggling to theme restores the followed colour; to custom seeds from current
        [tone]: { mode, color: mode === 'theme' ? followColors[tone] : f.tones[tone].color },
      },
    }));
    touch();
  }
  function setToneColor(tone: EmphasisTone, color: string) {
    setForm((f) => ({ ...f, tones: { ...f.tones, [tone]: { mode: 'custom', color } } }));
    touch();
  }

  async function onSave() {
    setBusy(true);
    setError(null);
    try {
      const res = await saveCaptionEmphasis(channelId, form);
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

  const cell =
    'rounded-md border border-black/15 bg-transparent px-2 py-1 text-sm outline-none focus:border-black/40 disabled:opacity-50 dark:border-white/15 dark:focus:border-white/40';

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Caption emphasis</h2>
        <p className="text-sm opacity-70">
          How emphasized words look — typography per role, colour per tone.
        </p>
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Roles</legend>
        <div className="space-y-2">
          {EMPHASIS_ROLES.map((role) => {
            const r = form.roles[role];
            return (
              <div key={role} className="flex flex-wrap items-center gap-3 text-sm">
                <span className="w-20 font-medium capitalize">{role}</span>
                <select
                  value={r.font}
                  onChange={(e) => setRole(role, { font: e.target.value as FontSlot })}
                  disabled={busy}
                  className={`capitalize ${cell}`}
                  aria-label={`${role} font`}
                >
                  {FONT_SLOTS.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
                <label className="flex items-center gap-1">
                  <span className="opacity-60">weight</span>
                  <input
                    type="number"
                    min={WEIGHT_MIN}
                    max={WEIGHT_MAX}
                    step={100}
                    value={r.weight}
                    onChange={(e) => setRole(role, { weight: Number(e.target.value) })}
                    disabled={busy}
                    className={`w-20 ${cell}`}
                  />
                </label>
                <label className="flex items-center gap-1">
                  <span className="opacity-60">size×</span>
                  <input
                    type="number"
                    min={SIZE_MIN}
                    max={SIZE_MAX}
                    step={0.05}
                    value={r.sizeMultiplier}
                    onChange={(e) => setRole(role, { sizeMultiplier: Number(e.target.value) })}
                    disabled={busy}
                    className={`w-20 ${cell}`}
                  />
                </label>
                <label className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={r.italic}
                    onChange={(e) => setRole(role, { italic: e.target.checked })}
                    disabled={busy}
                  />
                  <span className="opacity-60">italic</span>
                </label>
              </div>
            );
          })}
        </div>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Tones</legend>
        <div className="space-y-2">
          {EMPHASIS_TONES.map((tone) => {
            const t = form.tones[tone];
            return (
              <div key={tone} className="flex flex-wrap items-center gap-3 text-sm">
                <span className="w-20 font-medium capitalize">{tone}</span>
                <select
                  value={t.mode}
                  onChange={(e) => setToneMode(tone, e.target.value as 'theme' | 'custom')}
                  disabled={busy}
                  className={cell}
                  aria-label={`${tone} colour mode`}
                >
                  <option value="theme">Follow theme</option>
                  <option value="custom">Custom</option>
                </select>
                {t.mode === 'custom' ? (
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={t.color}
                      onChange={(e) => setToneColor(tone, e.target.value)}
                      disabled={busy}
                      className="h-7 w-7 rounded border border-black/15 dark:border-white/15"
                    />
                    <input
                      value={t.color}
                      onChange={(e) => setToneColor(tone, e.target.value)}
                      disabled={busy}
                      className={`w-28 text-xs ${cell}`}
                    />
                  </div>
                ) : (
                  <span className="flex items-center gap-2 opacity-70">
                    <span
                      className="h-5 w-5 rounded border border-black/10 dark:border-white/10"
                      style={{ backgroundColor: followColors[tone] }}
                    />
                    {followColors[tone]}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </fieldset>

      <div className="space-y-2 rounded-lg border border-black/10 p-4 dark:border-white/10">
        <span className="text-xs font-medium opacity-70">Preview</span>
        <div className="flex flex-wrap items-baseline gap-4">
          {EMPHASIS_ROLES.map((role) => {
            const r = form.roles[role];
            return (
              <span
                key={role}
                style={{
                  fontFamily: fonts[r.font],
                  fontWeight: r.weight,
                  fontSize: `${r.sizeMultiplier}rem`,
                  fontStyle: r.italic ? 'italic' : 'normal',
                }}
              >
                {role}
              </span>
            );
          })}
        </div>
        <div className="flex gap-2">
          {EMPHASIS_TONES.map((tone) => (
            <span
              key={tone}
              className="rounded px-2 py-0.5 text-xs font-medium"
              style={{ color: form.tones[tone].color }}
            >
              {tone}
            </span>
          ))}
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

- [ ] **Step 2: Wire the section into `page.tsx`**

Edit `src/app/(app)/channels/[id]/page.tsx`. Add the imports, bake the theme, parse the emphasis form, and render `<CaptionEmphasisEditor>` below `<BrandEditor>`. The full file:

```tsx
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { parseChannelBrand } from '@/lib/channels/brand';
import { parseCaptionEmphasis, defaultToneColors } from '@/lib/channels/caption-emphasis';
import { bakeTheme } from '@/lib/composition/theme';
import { BrandEditor } from './BrandEditor';
import { CaptionEmphasisEditor } from './CaptionEmphasisEditor';

// Channel brand + caption-emphasis editors (Phase 8 slices 2–3). RLS scopes the
// read; a miss (not found OR not owned) → 404. The parsers show current EFFECTIVE
// values; the two sections save independently.
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

  const theme = bakeTheme(channel.brand_kit as never);
  const emphasisInitial = parseCaptionEmphasis(channel.brand_kit, theme);

  return (
    <div className="space-y-8">
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

      <hr className="border-black/10 dark:border-white/10" />

      <CaptionEmphasisEditor
        channelId={channel.id as string}
        initial={emphasisInitial}
        fonts={theme.fonts}
        followColors={defaultToneColors(theme)}
      />
    </div>
  );
}
```

- [ ] **Step 3: Typecheck + lint**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npx eslint "src/app/(app)/channels/[id]/CaptionEmphasisEditor.tsx" "src/app/(app)/channels/[id]/page.tsx"`
Expected: clean.

- [ ] **Step 4: App-run e2e (manual)**

Start the dev server. Verify:
1. Open `/channels/[id]` → the Caption emphasis section shows the default role table (key/shout/contrast/number) and all three tones as "Follow theme" with the brand's effective colours.
2. Change a role's weight/size/font/italic, and set a tone to **Custom** with a hex → Save → "Saved"; reload → persists.
3. Set that tone back to **Follow theme** → Save → reload: the override is gone (the tone tracks the brand colour again; the stored `caption_emphasis.tones` no longer has that key).
4. Enter an out-of-range weight (e.g. 50) or a bad custom hex → Save → the reason shows and nothing persists.
5. Confirm the slice-2 brand editor above still saves independently (changing a colour there and saving does not disturb the emphasis tables, and vice versa).

No render gate — the renderer already consumes `brand_kit.caption_emphasis`.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/channels/[id]/CaptionEmphasisEditor.tsx" "src/app/(app)/channels/[id]/page.tsx"
git commit -m "feat(channels): caption-emphasis editor UI (role + tone tables) + page wiring"
```

---

## Notes for the implementer

- Commit per task. Tasks 1 is TDD (RED→GREEN); 2 is the migration; 3–4 are build + typecheck/lint (verified by the manual app-run, no unit test).
- No renderer change and NO `deploy:remotion` gate — `render.ts` already reads `brand_kit.caption_emphasis`.
- The two channel-page sections (`BrandEditor`, `CaptionEmphasisEditor`) save through different RPCs touching disjoint `brand_kit` keys; they are independent.
