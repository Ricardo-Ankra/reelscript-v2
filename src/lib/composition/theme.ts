// Theme baking (spec 8.2): turn a channel's brand_kit into the complete Theme
// snapshot embedded in the composition spec. The renderer only ever reads this
// snapshot, so editing the channel later never changes an old render.
//
// The Phase-2 seed brand_kit is minimal ({ colors:{primary}, typography:{font} }),
// so baking fills every token the brand omits with a sensible default — a brand
// value always wins, defaults only backfill. Pure + deterministic (unit-testable).
import type { Theme } from '../primitives/contract';

const MOTIONS = ['subtle', 'standard', 'punchy'] as const;

// Conservative, broadly-legible defaults (dark background, light text).
export const DEFAULT_THEME: Theme = {
  colors: {
    background: '#0B1F3A',
    foreground: '#FFFFFF',
    primary: '#3B82F6',
    secondary: '#1E3A8A',
    accent: '#F59E0B',
    bodyText: '#E2E8F0',
  },
  fonts: { display: 'Poppins', body: 'Poppins', mono: 'monospace' },
  logos: {},
  motion: 'standard',
};

// A loose view of the stored brand_kit JSON (any subset may be present).
export interface BrandKit {
  colors?: Partial<Theme['colors']> & Record<string, string>;
  typography?: { font?: string; display?: string; body?: string; mono?: string };
  fonts?: Partial<Theme['fonts']>;
  motion_preset?: string;
  // logos (R2 keys) are signed at asset-resolution time and unused in Phase 4.
}

export function bakeTheme(brandKit: BrandKit | null | undefined): Theme {
  const bk = brandKit ?? {};

  const colors: Theme['colors'] = { ...DEFAULT_THEME.colors };
  if (bk.colors) {
    for (const key of Object.keys(DEFAULT_THEME.colors) as (keyof Theme['colors'])[]) {
      const v = bk.colors[key];
      if (typeof v === 'string' && v) colors[key] = v;
    }
  }

  // One brand font drives display + body unless explicitly split; mono stays default.
  const brandFont = bk.typography?.font ?? bk.fonts?.display;
  const fonts: Theme['fonts'] = {
    display: bk.typography?.display ?? bk.fonts?.display ?? brandFont ?? DEFAULT_THEME.fonts.display,
    body: bk.typography?.body ?? bk.fonts?.body ?? brandFont ?? DEFAULT_THEME.fonts.body,
    mono: bk.typography?.mono ?? bk.fonts?.mono ?? DEFAULT_THEME.fonts.mono,
  };

  const motion = (MOTIONS as readonly string[]).includes(bk.motion_preset ?? '')
    ? (bk.motion_preset as Theme['motion'])
    : DEFAULT_THEME.motion;

  return { colors, fonts, logos: {}, motion };
}
