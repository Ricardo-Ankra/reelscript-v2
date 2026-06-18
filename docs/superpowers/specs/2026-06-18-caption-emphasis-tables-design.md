# Caption-emphasis tables editor — design

**Date:** 2026-06-18
**Phase:** 8 (Full surfaces) — channel settings, sub-slice 3 of 5
**Status:** design approved, ready for implementation plan

## Context

The DOAC-style animated caption track styles emphasized words from baked brand
tables (caption emphasis revision, 2026-06-16): `role` → typography, `tone` →
colour. `resolveWordStyle` (`src/lib/captions/emphasis-style.ts`) merges the
brand's `brand_kit.caption_emphasis` (`CaptionEmphasisConfig`) over
`DEFAULT_ROLE_TABLE` and the theme's sentiment tokens. Today there is no UI for
it — the tables are defaults-only.

This slice (3 of 5 in the channel-settings stack: 1 ✅ foundation, 2 ✅ brand
editor) adds the editor for those tables as a second section on the channel
detail page. **No renderer change** — `render.ts`'s `loadBrief` already reads
`brand_kit.caption_emphasis` and bakes it into the spec, so this is pure config
+ UI (no `deploy:remotion` gate).

## Goal

Let an operator tune how each emphasis role looks (typography) and how each tone
is coloured, per channel, from the channel page — overriding the code defaults.

## Scope

**In scope** — a "Caption emphasis" section on `/channels/[id]`, below the
brand editor, with its **own Save**:

- **Role table** — 4 rows (`key`, `shout`, `contrast`, `number`), each:
  **font slot** (`display`/`body`/`mono`), **weight** (integer 100–900),
  **size×** (`sizeMultiplier`, 0.5–3.0), **italic** (toggle). Shows
  `DEFAULT_ROLE_TABLE` values initially. **Stored as the full table** (all 4
  roles × 4 fields) — roles have no external linkage, so full-store is simplest
  and predictable.
- **Tone table** — 3 rows (`positive`, `negative`, `neutral`), each a **Follow
  theme / Custom** choice:
  - *Follow theme* (default): stored as **no override** → the tone tracks the
    brand colour at render (`positive` → theme `positive`, `negative` → theme
    `negative`, `neutral` → `accent`). Changing a brand colour (slice 2) moves
    the matching emphasis tone automatically.
  - *Custom*: pins a hex.
  - The row shows the **effective** colour either way.

**Out of scope (later sub-slices / not table-driven)**

- Logo uploads (slice 4), voice params (slice 5).
- The `effect` axis — its animation registry is gate-validated separately and is
  not a brand table; unchanged here.
- The AI emphasis pass (which words get which role/tone) — unchanged.
- Per-field "follow default" for the role table (roles store full; only tones
  use follow/custom).

## Data model

No schema change. One **migration** adds a focused RPC (symmetric with slice
2's `update_channel_brand`, but writes only the `caption_emphasis` key):

```sql
-- Phase 8 — caption-emphasis tables editor. Writes ONLY brand_kit.caption_emphasis
-- via jsonb_set (create_missing=true), preserving sibling keys (colors,
-- typography, motion_preset, logos) that other slices own. SECURITY INVOKER → the
-- caller's RLS on channels applies. RETURNS the updated id (NULL when no row
-- matched) so the action never reports a phantom "Saved".
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

`brand_kit` is `not null default '{}'`, so `jsonb_set` always has a non-null
left operand. This write and slice 2's `brand_kit || patch` touch disjoint keys,
so they never clobber each other.

## Components

### Pure core (`src/lib/channels/caption-emphasis.ts`, unit-tested)

Mirrors `brand.ts`. Imports `DEFAULT_ROLE_TABLE`, `RoleStyle`,
`CaptionEmphasisConfig` from `../captions/emphasis-style`;
`EMPHASIS_ROLES`, `EMPHASIS_TONES`, types from `../captions/types`; `Theme` type
from `../primitives/contract`. All pure (those modules are pure — no
react/server/network).

```ts
export type FontSlot = 'display' | 'body' | 'mono';
export interface RoleRow { font: FontSlot; weight: number; sizeMultiplier: number; italic: boolean }
export interface ToneRow { mode: 'theme' | 'custom'; color: string } // color = effective hex
export interface CaptionEmphasisForm {
  roles: Record<EmphasisRole, RoleRow>;   // all 4
  tones: Record<EmphasisTone, ToneRow>;   // all 3
}

export const WEIGHT_MIN = 100, WEIGHT_MAX = 900;
export const SIZE_MIN = 0.5, SIZE_MAX = 3.0;
export const FONT_SLOTS: readonly FontSlot[] = ['display', 'body', 'mono'];

// Build the form model showing EFFECTIVE values. Roles: DEFAULT_ROLE_TABLE
// merged with stored overrides. Tones: a stored override → { mode:'custom',
// color: resolved-to-hex }; no override → { mode:'theme', color: the theme
// token the tone follows (positive→colors.positive, negative→colors.negative,
// neutral→colors.accent) }.
export function parseCaptionEmphasis(brandKit: unknown, theme: Theme): CaptionEmphasisForm;

// Validate a form submission and produce the CaptionEmphasisConfig to store:
//   roles: the full 4×4 table; tones: ONLY the 'custom' rows as { color: hex }
//   (follow-theme rows omitted; tones key omitted entirely if none custom).
// Rejects: font ∉ FONT_SLOTS; weight not an integer in [100,900]; sizeMultiplier
// not in [0.5,3.0]; italic non-boolean; a custom tone colour not a valid hex.
export function validateCaptionEmphasisForm(input: unknown):
  | { ok: true; value: CaptionEmphasisConfig }
  | { ok: false; reason: string };
```

`parseCaptionEmphasis` resolves a stored tone override that is a **theme token
name** (e.g. `"primary"`) to its hex for display (via the theme), and marks the
row `custom`. A row only stays `theme` when there is no stored override.

### Server action (`src/app/(app)/channels/[id]/caption-emphasis-actions.ts`, `'use server'`)

```ts
export async function saveCaptionEmphasis(
  channelId: string,
  input: unknown,
): Promise<{ ok: true } | { ok: false; reason: string }>;
```

Validate via `validateCaptionEmphasisForm` (return its `reason` on failure) →
`supabase.rpc('set_channel_caption_emphasis', { p_channel_id, p_value })` with
the built `CaptionEmphasisConfig` → RPC error → `{ ok:false, reason }`; `data ==
null` (zero rows) → `{ ok:false, reason:'Channel not found.' }`; else
`{ ok:true }`. RLS-scoped client; mirrors `saveChannelBrand`.

### UI

`/channels/[id]/page.tsx` already reads `brand_kit` (slice 2). It additionally
bakes the theme (`bakeTheme(brand_kit)`) and runs
`parseCaptionEmphasis(brand_kit, theme)`, passing the form + the baked theme
colours to a client `CaptionEmphasisEditor` rendered **below** `<BrandEditor>`.

`CaptionEmphasisEditor` renders the role table (4 rows: a font `<select>`, a
weight number input, a size× number input, an italic checkbox) and the tone
table (3 rows: a Follow-theme/Custom control + a colour input enabled when
Custom), a single dirty-tracked **Save** (try/catch/finally so the button never
sticks; `{ ok:false }` keeps edits + shows the reason; `{ ok:true }` clears
dirty + shows "Saved"), and a small **preview**: each role rendered as a sample
word in its font slot/weight/size/italic, and each tone shown as a chip in its
effective colour. The preview's "follow theme" colours use the **page's
server-baked theme** (the saved palette), independent of any unsaved edits in
the slice-2 brand editor above it (the two sections save independently).

## Data flow

```
/channels/[id] (server) → read brand_kit → bakeTheme + parseCaptionEmphasis → form + theme
CaptionEmphasisEditor (client) → edit → Save → saveCaptionEmphasis(id, form)
saveCaptionEmphasis → validateCaptionEmphasisForm → set_channel_caption_emphasis RPC (RLS) → { ok }
later render → loadBrief reads brand_kit.caption_emphasis → resolveWordStyle bakes it into the spec
```

## Error handling

- `validateCaptionEmphasisForm` returns a friendly `reason` for a bad font slot,
  out-of-range weight/size, or a malformed custom hex; the editor shows it and
  keeps edits.
- `saveCaptionEmphasis` returns `{ ok:false, reason }` on RPC error; `data ==
  null` → `'Channel not found.'` (no phantom save).
- A thrown action (network) → the editor's catch shows a generic message and
  clears busy.

## Back-compatibility

- A channel with no `brand_kit.caption_emphasis` parses to the full default role
  table + all tones following the theme — exactly today's rendered behaviour.
- `jsonb_set` preserves the slice-2 keys; the slice-2 `||` merge preserves
  `caption_emphasis`. The two write paths are independent (disjoint keys).
- Old renders are unaffected (their emphasis config is already baked).
- A previously-stored override written as a theme-token name still resolves
  (parse resolves it to a hex for display; re-saving pins the hex).

## Testing

- **Unit (`src/lib/channels/caption-emphasis.test.ts`):**
  `parseCaptionEmphasis` — empty `brand_kit` → default role table + all tones
  `mode:'theme'` with the theme's effective colours; stored role overrides →
  merged values; a stored custom tone → `mode:'custom'` + its hex; a stored
  token-name tone → resolved to hex + `custom`.
  `validateCaptionEmphasisForm` — rejects bad font slot, weight 99 / 901 /
  non-integer, size 0.4 / 3.1, non-boolean italic, bad custom hex; on success
  the value has the full 4-role table and `tones` containing ONLY custom rows
  (or omitted when none custom).
- **Migration:** `npm run db:apply` the RPC; confirm recorded + applied.
- **Manual / app-run e2e:** open `/channels/[id]` → the Caption emphasis section
  shows defaults → change a role's weight/size/font/italic and pin a tone to
  custom → Save → reload persists; set a tone back to Follow theme → Save →
  override removed (the tone tracks the brand colour again); an out-of-range
  weight shows the reason and doesn't save. **No render gate** (the renderer
  already consumes `brand_kit.caption_emphasis`; nothing changed there).

## Open questions

None. Location (second section), tone follow/custom semantics, role full-store,
and bounds (weight 100–900, size 0.5–3.0) are settled.
