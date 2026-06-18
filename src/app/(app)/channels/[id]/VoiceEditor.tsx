'use client';

import { useState } from 'react';
import { loadVoiceCatalog, saveChannelVoiceTts } from './voice-actions';
import { VOICE_PARAM_MIN, VOICE_PARAM_MAX, type VoiceForm } from '@/lib/channels/voice';
import type { CatalogVoice, CatalogModel } from '@/lib/voice/elevenlabs';

// Channel voice editor (Phase 8 slice 5). Renders instantly from stored voice_tts;
// "Load voices & models" fetches the live catalog (server action — the API key
// stays server-side) and turns the voice/model fields into selects. The current
// stored id is always kept selectable. Tuning sliders work without a fetch.
const SLIDERS: Array<{ key: 'stability' | 'similarityBoost' | 'style'; label: string }> = [
  { key: 'stability', label: 'Stability' },
  { key: 'similarityBoost', label: 'Similarity boost' },
  { key: 'style', label: 'Style' },
];

export function VoiceEditor({ channelId, initial }: { channelId: string; initial: VoiceForm }) {
  const [form, setForm] = useState<VoiceForm>(initial);
  const [voices, setVoices] = useState<CatalogVoice[] | null>(null);
  const [models, setModels] = useState<CatalogModel[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function patch(p: Partial<VoiceForm>) {
    setForm((f) => ({ ...f, ...p }));
    setDirty(true);
    setSaved(false);
  }

  async function onLoadCatalog() {
    setLoading(true);
    setError(null);
    try {
      const res = await loadVoiceCatalog();
      if (res.ok) {
        setVoices(res.voices);
        setModels(res.models);
      } else {
        setError(res.reason);
      }
    } catch {
      setError('Something went wrong loading the catalog.');
    } finally {
      setLoading(false);
    }
  }

  async function onSave() {
    setBusy(true);
    setError(null);
    try {
      const res = await saveChannelVoiceTts(channelId, form);
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

  // The options for a picker: the catalog if loaded, with the current id prepended
  // as "(current)" when the catalog doesn't already include it (so a custom/cloned
  // voice or model is never lost).
  function optionsWithCurrent(
    catalog: Array<{ id: string; name: string }> | null,
    currentId: string,
  ): Array<{ id: string; name: string }> | null {
    if (!catalog) return null;
    if (catalog.some((o) => o.id === currentId)) return catalog;
    return [{ id: currentId, name: `${currentId} (current)` }, ...catalog];
  }

  const voiceOptions = optionsWithCurrent(voices, form.voiceId);
  const modelOptions = optionsWithCurrent(models, form.model);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Voice</h2>
        <p className="text-sm opacity-70">
          The ElevenLabs voice, model, and tuning used to narrate this channel&apos;s videos.
        </p>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onLoadCatalog}
          disabled={loading}
          className="rounded-md border border-black/15 px-3 py-1.5 text-sm dark:border-white/15 disabled:opacity-50"
        >
          {loading ? 'Loading…' : 'Load voices & models'}
        </button>
        {voices && <span className="text-xs opacity-60">Catalog loaded.</span>}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="space-y-1">
          <span className="text-sm font-medium">Voice</span>
          {voiceOptions ? (
            <select
              value={form.voiceId}
              onChange={(e) => patch({ voiceId: e.target.value })}
              className="block w-full rounded border border-black/15 bg-transparent px-2 py-1.5 text-sm dark:border-white/15"
            >
              {voiceOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          ) : (
            <span className="block truncate rounded border border-black/10 px-2 py-1.5 text-sm opacity-70 dark:border-white/10">
              {form.voiceId}
            </span>
          )}
        </label>

        <label className="space-y-1">
          <span className="text-sm font-medium">Model</span>
          {modelOptions ? (
            <select
              value={form.model}
              onChange={(e) => patch({ model: e.target.value })}
              className="block w-full rounded border border-black/15 bg-transparent px-2 py-1.5 text-sm dark:border-white/15"
            >
              {modelOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          ) : (
            <span className="block truncate rounded border border-black/10 px-2 py-1.5 text-sm opacity-70 dark:border-white/10">
              {form.model}
            </span>
          )}
        </label>
      </div>

      <div className="space-y-3">
        {SLIDERS.map(({ key, label }) => (
          <label key={key} className="block space-y-1">
            <span className="text-sm font-medium">
              {label}: {form[key].toFixed(2)}
            </span>
            <input
              type="range"
              min={VOICE_PARAM_MIN}
              max={VOICE_PARAM_MAX}
              step={0.05}
              value={form[key]}
              onChange={(e) => patch({ [key]: Number(e.target.value) } as Partial<VoiceForm>)}
              className="block w-full"
            />
          </label>
        ))}
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.useSpeakerBoost}
            onChange={(e) => patch({ useSpeakerBoost: e.target.checked })}
          />
          <span className="font-medium">Speaker boost</span>
        </label>
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
