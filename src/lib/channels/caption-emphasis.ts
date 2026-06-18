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
