import type { PropSchema, PropDef, Theme } from './contract';
import { validationSchema } from './contract';

// Brand stress kit (Phase 7, spec 9.6) — a fixed, platform-maintained set of extreme but
// VALID brand kits + overflowing sample text. A primitive that adapts (sizes relative to
// the frame, wraps, reads tokens) survives any real channel. Pure + tested; the gate
// renders the candidate against these and vision-checks for overflow/clipping/clash.

// Deliberately long, multi-word strings to force overflow/wrapping handling.
const OVERFLOW_TEXT =
  'Pneumonoultramicroscopicsilicovolcanoconiosis Antidisestablishmentarianism Supercalifragilisticexpialidocious';

export interface StressTheme {
  name: string;
  theme: Theme;
}

// Light + dark extremes (both with readable foreground — a real brand would), very long
// display font names, and vivid accents. Two variants cover both contrast directions.
export const STRESS_THEMES: StressTheme[] = [
  {
    name: 'very-light',
    theme: {
      colors: { background: '#FFFFFF', foreground: '#0A0A0A', primary: '#111827', secondary: '#E5E7EB', accent: '#FF0099', bodyText: '#1F2937' },
      fonts: { display: 'Playfair Display Extra Bold Italic', body: 'Source Serif 4 SemiBold', mono: 'monospace' },
      logos: {},
      motion: 'punchy',
    },
  },
  {
    name: 'very-dark',
    theme: {
      colors: { background: '#000000', foreground: '#FAFAFA', primary: '#0EA5E9', secondary: '#1F2937', accent: '#00E5FF', bodyText: '#E5E7EB' },
      fonts: { display: 'Archivo Black Condensed Ultra', body: 'IBM Plex Sans Medium', mono: 'monospace' },
      logos: {},
      motion: 'punchy',
    },
  },
];

// Props that stress layout: overflowing text for strings; otherwise the same sensible
// samples (respecting declared defaults for numbers so a percent stays in range).
export function stressProps(schema: PropSchema): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const def of validationSchema(schema)) {
    const v = stressFor(def);
    if (v !== undefined) props[def.name] = v;
  }
  return props;
}

function stressFor(def: PropDef): unknown {
  switch (def.type) {
    case 'string':
      return OVERFLOW_TEXT;
    case 'number':
      return def.default !== undefined ? def.default : 100;
    case 'boolean':
      return true;
    case 'enum':
      return def.enumValues?.[0] ?? '';
    case 'token':
      return def.tokenGroup === 'fonts' ? 'display' : 'accent';
    case 'asset':
      return 'sample-asset';
    default:
      return def.default;
  }
}
