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
