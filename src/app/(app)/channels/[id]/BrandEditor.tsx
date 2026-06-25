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
import { COLOR_LOOKS, LOOK_LABELS } from '@/lib/color/looks';

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
          <label className="flex items-center gap-2">
            Look
            <select
              value={form.colorLook}
              onChange={(e) => update('colorLook', e.target.value as BrandForm['colorLook'])}
              disabled={busy}
              className={inputCls}
            >
              {COLOR_LOOKS.map((l) => (
                <option key={l} value={l}>
                  {LOOK_LABELS[l]}
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
