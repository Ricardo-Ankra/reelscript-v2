// Emphasis style resolution (caption emphasis revision, 2026-06-16).
//
// Resolves the AI's emphasis LABELS into concrete styling, deterministically and
// from baked brand tables — the "code styles" half of "AI picks words + intent,
// code styles". role → typography (font slot, weight, size×, italic); tone →
// colour. Both are brand-overridable via CaptionEmphasisConfig (baked into the
// theme snapshot at render time, step 8); unspecified fields fall back to the
// documented defaults.
//
// Pure (no react, no server-only, no network).
import type { Theme } from '../primitives/contract';
import type { EmphasisRole, EmphasisTone, WordEmphasis } from './types';

export interface RoleStyle {
  font: 'display' | 'body' | 'mono';
  weight: number;
  sizeMultiplier: number;
  italic: boolean;
}

// Defaults (each field brand-overridable). Mirrors the spec's role table.
export const DEFAULT_ROLE_TABLE: Record<EmphasisRole, RoleStyle> = {
  key: { font: 'body', weight: 700, sizeMultiplier: 1.15, italic: false },
  shout: { font: 'display', weight: 800, sizeMultiplier: 1.4, italic: false },
  contrast: { font: 'body', weight: 600, sizeMultiplier: 0.9, italic: true },
  number: { font: 'display', weight: 800, sizeMultiplier: 1.5, italic: false },
};

export interface CaptionEmphasisConfig {
  roles?: Partial<Record<EmphasisRole, Partial<RoleStyle>>>;
  tones?: Partial<Record<EmphasisTone, { color: string }>>; // theme token name or hex
}

export interface ResolvedWordStyle {
  fontFamily: string;
  fontWeight: number;
  sizeMultiplier: number;
  italic: boolean;
  color: string;
}

// A config tone colour may be a theme token name (e.g. "primary") or a literal.
function resolveColorValue(value: string, theme: Theme): string {
  return value in theme.colors ? theme.colors[value as keyof Theme['colors']] : value;
}

// tone → baked theme token: positive/negative resolve to the theme's sentiment
// tokens (default green/red, brand-overridable in brand_kit.colors), neutral to the
// accent. A brand_kit.caption_emphasis.tones override (token name or hex) wins.
function resolveToneColor(
  tone: EmphasisTone | undefined,
  theme: Theme,
  config?: CaptionEmphasisConfig,
): string {
  const t = tone ?? 'neutral';
  const override = config?.tones?.[t]?.color;
  if (override) return resolveColorValue(override, theme);
  if (t === 'positive') return theme.colors.positive;
  if (t === 'negative') return theme.colors.negative;
  return theme.colors.accent; // neutral
}

export function resolveWordStyle(
  emphasis: WordEmphasis | undefined,
  theme: Theme,
  config?: CaptionEmphasisConfig,
): ResolvedWordStyle {
  if (!emphasis) {
    return {
      fontFamily: theme.fonts.body,
      fontWeight: 400,
      sizeMultiplier: 1,
      italic: false,
      color: theme.colors.foreground,
    };
  }
  const role: RoleStyle = { ...DEFAULT_ROLE_TABLE[emphasis.role], ...config?.roles?.[emphasis.role] };
  return {
    fontFamily: theme.fonts[role.font],
    fontWeight: role.weight,
    sizeMultiplier: role.sizeMultiplier,
    italic: role.italic,
    color: resolveToneColor(emphasis.tone, theme, config),
  };
}
