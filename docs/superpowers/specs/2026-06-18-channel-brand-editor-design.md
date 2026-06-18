# Channel brand editor — design

**Date:** 2026-06-18
**Phase:** 8 (Full surfaces) — channel settings, sub-slice 2 of 5
**Status:** design approved, ready for implementation plan

## Context

Sub-slice 1 (multi-channel foundation, merged) made channels first-class: a
`/channels` list, create, a picker in the video-create flow, and a
`/channels/[id]` **detail shell** that only shows the name + a "Brand settings —
coming next" placeholder. This slice fills that shell with the **brand-identity
editor** — the fields that bake into a render's theme snapshot and feed script
generation.

A render embeds a baked `Theme` snapshot (`bakeTheme(brand_kit)`); the renderer
never re-reads the channel, so editing the brand changes only *future* renders.
`bakeTheme` already reads `brand_kit.colors.*`, `brand_kit.typography.*`, and
`brand_kit.motion_preset`, backfilling anything omitted from `DEFAULT_THEME`
(`src/lib/composition/theme.ts`). Channel `defaults` are render-time fallbacks
under `video.settings`; `brand_voice.tone` is fed to the generation prompt.

The five-slice stack: 1 ✅ foundation; **2 (this) lean-core brand editor**;
3 caption-emphasis tables; 4 logo uploads; 5 voice params.

## Goal

Make the `/channels/[id]` page a working brand editor: rename the channel and
set its colors, font, motion, brand-voice tone, and channel defaults — each
field visibly affecting renders.

## Scope

**In scope — editable fields**

| Field | Stored | Affects |
|---|---|---|
| Channel **name** | `channels.name` | label / `BrandContext.channelName` |
| **8 colors** — background, foreground, primary, secondary, accent, bodyText, positive, negative | `brand_kit.colors.<key>` | theme snapshot → primitives + caption emphasis tones |
| **Font** (curated dropdown) | `brand_kit.typography.font` | theme + renderer (see Font wiring) |
| **Motion** — subtle / standard / punchy | `brand_kit.motion_preset` | theme `motion` |
| **Brand-voice tone** (free text) | `brand_voice.tone` | script-generation prompt |
| **Defaults — captions** on/off | `defaults.captions_on` | per-video render fallback |
| **Defaults — emphasis density** off / sparing / liberal | `defaults.caption_emphasis_density` | per-video render fallback |
| **Defaults — music** on/off | `defaults.music_on` | per-video render fallback |

**Out of scope (later sub-slices)**

- Caption-emphasis role/tone tables (`brand_kit.caption_emphasis`) — slice 3.
- Logo uploads (`brand_kit.logos`) — slice 4.
- Voice params (`voice_tts`) — slice 5.
- Split display/body/mono fonts (this slice exposes ONE brand font →
  `typography.font`, which `bakeTheme` applies to both display and body; mono
  stays default).
- A tri-state "inherit" for channel defaults — defaults become explicit values
  once the brand is saved (YAGNI; the operator is configuring the channel's
  defaults).
- Channel archive / delete.

## Font allowlist + renderer wiring (the nuanced part)

Today the renderer hardcodes `import { loadFont } from
'@remotion/google-fonts/Poppins'; loadFont()` at module top
(`remotion/ReelComposition.tsx`), so only Poppins is ever loaded even though the
caption/body CSS uses `spec.theme.fonts.*`. A brand font must therefore be
**loaded by the renderer** to actually render.

**Shared source of truth:** `src/lib/channels/fonts.ts` exports
`FONT_ALLOWLIST` — the family-name strings used everywhere a font is chosen,
validated, or stored:

```ts
export const FONT_ALLOWLIST = [
  'Poppins',
  'Montserrat',
  'Inter',
  'Roboto',
  'Playfair Display',
  'Bebas Neue',
] as const;
export type BrandFont = (typeof FONT_ALLOWLIST)[number];
```

These exact strings are what `bakeTheme` stores in `typography.font`, what the
editor dropdown offers, what `validateBrandForm` accepts, and what the CSS
`fontFamily` resolves to.

**Renderer change:** a new `remotion/brand-fonts.ts` statically imports each
allowlisted font's `loadFont` (`@remotion/google-fonts/Poppins`,
`/Montserrat`, `/Inter`, `/Roboto`, `/PlayfairDisplay`, `/BebasNeue` — note the
PascalCase, space-less subpaths) and calls every `loadFont()` at module top.
`ReelComposition` imports `remotion/brand-fonts` instead of the single Poppins
import. All six fonts load before the first frame; the CSS `fontFamily` (from
`spec.theme.fonts`) then resolves to whichever the brand picked. The
family-name list in `brand-fonts.ts` **must mirror `FONT_ALLOWLIST`** — a code
comment in each file states this (the two can't share an import: `fonts.ts` is a
pure lib consumed by `node:test`; `brand-fonts.ts` pulls Remotion google-fonts).

**Consequence:** this slice carries a renderer change → a `deploy:remotion`
re-bundle and a render verification (a video using a non-Poppins channel font
renders in that font) are part of the slice's done-criteria, before merge.

## Data model

No new columns — `channels` already has `name`, `brand_kit`, `brand_voice`,
`defaults`. One **migration** adds an atomic update RPC (mirrors
`merge_video_settings`):

```sql
-- Phase 8 — channel brand editor. One atomic write of the channel's editable
-- brand surface. brand_kit is SHALLOW-MERGED (brand_kit || patch) so sibling
-- keys owned by later slices (caption_emphasis, caption_style, logos) survive;
-- brand_voice and defaults are written wholesale (this editor owns all their
-- keys). SECURITY INVOKER → the caller's RLS on channels applies (acct_isolation
-- with check (auth_owns_account(account_id))), so only the owner's row updates.
create or replace function update_channel_brand(
  p_channel_id    uuid,
  p_name          text,
  p_brand_kit_patch jsonb,
  p_brand_voice   jsonb,
  p_defaults      jsonb
) returns void
language sql
security invoker
as $$
  update channels
  set name        = p_name,
      brand_kit   = brand_kit || p_brand_kit_patch,
      brand_voice = p_brand_voice,
      defaults    = p_defaults,
      updated_at  = now()
  where id = p_channel_id;
$$;

grant execute on function update_channel_brand(uuid, text, jsonb, jsonb, jsonb) to authenticated;
```

The `brand_kit` patch this slice sends is `{ colors: {<8 keys>},
typography: { font }, motion_preset }`. The shallow `||` replaces those three
top-level keys and leaves `caption_emphasis` / `caption_style` / `logos`
untouched. (`colors` is replaced wholesale — fine, the editor manages all 8.)

## Components

### Pure core (`src/lib/channels/brand.ts`, unit-tested)

Mirrors `src/lib/videos/settings.ts` (parse + validate split, no
react/server/network — imports only `FONT_ALLOWLIST` from `./fonts`,
`DEFAULT_THEME`/`bakeTheme` from `../composition/theme` (pure: type-only contract
import), `validateChannelName` from `./validate`).

```ts
export type Motion = 'subtle' | 'standard' | 'punchy';
export type CaptionEmphasisDensity = 'off' | 'sparing' | 'liberal';

export interface BrandForm {
  name: string;
  colors: Record<ColorKey, string>;      // all 8 theme color keys, hex strings
  font: BrandFont;
  motion: Motion;
  tone: string;                            // '' when unset
  captionsOn: boolean;
  density: CaptionEmphasisDensity;
  musicOn: boolean;
}

// Build the form's initial model from a channel row, showing CURRENT EFFECTIVE
// values: colors + motion via bakeTheme (stored-or-default); font from
// typography.font if in the allowlist else the default; tone/defaults from their
// columns with code defaults.
export function parseChannelBrand(row: {
  name: string;
  brand_kit: unknown;
  brand_voice: unknown;
  defaults: unknown;
}): BrandForm;

// Validate a form submission: name via validateChannelName; each color a valid
// hex (#RGB or #RRGGBB); font ∈ FONT_ALLOWLIST; motion/density ∈ their enums;
// booleans. On success return the exact pieces the RPC needs.
export function validateBrandForm(input: unknown):
  | { ok: true; value: {
      name: string;
      brandKitPatch: { colors: Record<ColorKey, string>; typography: { font: BrandFont }; motion_preset: Motion };
      brandVoice: { tone?: string };          // tone omitted when blank
      defaults: { captions_on: boolean; caption_emphasis_density: CaptionEmphasisDensity; music_on: boolean };
    } }
  | { ok: false; reason: string };
```

`ColorKey` is the 8 keys of `DEFAULT_THEME.colors`. Default values for the form
and for backfill come from `DEFAULT_THEME` (colors, motion) and code defaults
(`captionsOn: true`, `density: 'sparing'`, `musicOn: false`) — matching what
the renderer falls back to.

### Server action (`src/app/(app)/channels/[id]/brand-actions.ts`, `'use server'`)

```ts
export async function saveChannelBrand(
  channelId: string,
  input: unknown,
): Promise<{ ok: true } | { ok: false; reason: string }>;
```

Validate via `validateBrandForm` (return its `reason` on failure) → call the
`update_channel_brand` RPC with `(channelId, name, brandKitPatch, brandVoice,
defaults)` → on RPC error return `{ ok: false, reason }`, else `{ ok: true }`.
RLS (SECURITY INVOKER) guarantees only the owner's channel updates; a
non-owned/missing id updates zero rows and still returns `{ ok: true }` (benign;
the read on the page already 404s a non-owned channel before the editor renders).

### UI

`/channels/[id]/page.tsx` (server) reads the channel
(`name, brand_kit, brand_voice, defaults`, `maybeSingle` + `notFound()`), runs
`parseChannelBrand`, and passes the `BrandForm` to a client `BrandEditor`.

`BrandEditor` (client) renders: a name input; the 8 colors as
`<input type="color">` + a hex text input each (kept in sync); a font `<select>`
(`FONT_ALLOWLIST`); a motion `<select>`; a tone `<textarea>`; and the three
default controls (two toggles + a density select). A **single Save button** with
dirty-tracking (disabled until a field changes; "Saving…" while busy). A small
live **preview**: the 8 color swatches + a sample line rendered in the chosen
font and colors (`primary` on `background`, plus a `positive`/`negative` chip).
On Save: call `saveChannelBrand`; `{ ok: true }` clears the dirty flag and shows
a brief "Saved"; `{ ok: false }` keeps edits and shows `reason` (try/catch/finally
so the button never stays stuck — the pattern from `VideoSettingsPanel`).

## Data flow

```
/channels/[id] (server) → read channel (RLS) → parseChannelBrand → BrandForm
BrandEditor (client)     → edit → Save → saveChannelBrand(id, form)
saveChannelBrand         → validateBrandForm → update_channel_brand RPC (RLS) → { ok }
later render             → bakeTheme(brand_kit) embeds colors/font/motion in the spec
                         → renderer loads all allowlisted fonts → CSS picks the brand font
```

## Error handling

- `validateBrandForm` returns a friendly `reason` for an invalid name, a
  malformed hex, an off-allowlist font, or a bad enum; `BrandEditor` shows it and
  keeps edits.
- `saveChannelBrand` returns `{ ok: false, reason }` on an RPC error.
- The page `notFound()`s a missing/non-owned channel (RLS) before the editor.
- A thrown action (network) → the editor's catch shows a generic message and
  clears the busy flag.

## Back-compatibility

- Existing channels with a minimal or empty `brand_kit` parse fine —
  `parseChannelBrand` shows effective (default-backfilled) values; the operator's
  first Save writes explicit values.
- The shallow `||` merge means a future `caption_emphasis` / `logos` value (once
  slices 3–4 land) is never clobbered by a brand Save.
- Old renders are unaffected (their theme is already baked).
- The renderer now loads six fonts instead of one; Poppins-using specs are
  unchanged (Poppins is still in the allowlist and still loaded).

## Testing

- **Unit (`src/lib/channels/brand.test.ts`):** `parseChannelBrand` — empty
  brand_kit → all defaults; populated brand_kit → stored colors/font/motion;
  off-allowlist stored font → falls back to default; tone/defaults parsed with
  code defaults. `validateBrandForm` — rejects bad name, bad hex (and accepts
  `#fff` + `#ffffff`), off-allowlist font, bad motion/density; on success returns
  the exact RPC pieces with blank tone omitted. `FONT_ALLOWLIST` non-empty and
  includes `'Poppins'` (the renderer's prior default).
- **Migration:** `npm run db:apply` the RPC; confirm it records + applies.
- **Manual / app-run e2e:** open `/channels/[id]` → fields show current values →
  change colors/font/motion/tone/defaults → Save → reload shows the saved values;
  an invalid hex shows the reason and doesn't save.
- **Render verification (required — renderer change):** `npm run deploy:remotion`
  to re-bundle, then render a video on a channel whose font is NOT Poppins and
  confirm the output renders in that font and the brand colors; confirm a
  Poppins channel still renders correctly.

## Open questions

None. Fonts (curated set + renderer wiring), the save model (single Save), the
brand_kit shallow-merge, and explicit channel defaults are all settled.
