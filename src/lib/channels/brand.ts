// Pure channel-brand parse + validation (Phase 8 — brand editor). No
// react/server/network. Imports only DEFAULT_THEME/bakeTheme (pure: theme.ts has
// a type-only contract import), the font allowlist, and validateChannelName.
import { DEFAULT_THEME, bakeTheme, type BrandKit } from '../composition/theme';
import { isBrandFont, type BrandFont } from './fonts';
import { validateChannelName } from './validate';
import { type ColorLook, COLOR_LOOKS, DEFAULT_COLOR_LOOK } from '../color/looks';

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
  colorLook: ColorLook;
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
    color_look: ColorLook;
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
  const colorLook = COLOR_LOOKS.includes(d.color_look as ColorLook)
    ? (d.color_look as ColorLook)
    : DEFAULT_COLOR_LOOK;

  return { name: row.name, colors, font, motion: baked.motion, tone, captionsOn, density, musicOn, colorLook };
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
  if (!COLOR_LOOKS.includes(f.colorLook as ColorLook)) {
    return { ok: false, reason: 'Invalid colour look.' };
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
        color_look: f.colorLook as ColorLook,
      },
    },
  };
}
