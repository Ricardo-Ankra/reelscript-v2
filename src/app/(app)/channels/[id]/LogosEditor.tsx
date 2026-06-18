'use client';

import { useState } from 'react';
import { createLogoUpload, saveChannelLogos } from './logo-actions';
import { LOGO_SLOTS, MAX_LOGO_BYTES, type Logos, type LogoSlot } from '@/lib/channels/logos';

const SLOT_LABELS: Record<LogoSlot, string> = {
  primary: 'Primary',
  monoLight: 'Mono (light)',
  monoDark: 'Mono (dark)',
  icon: 'Icon',
};
const ACCEPT = 'image/png,image/jpeg,image/webp,image/svg+xml';

// Channel logos editor (Phase 8 slice 4). Per-slot upload (client PUTs to a signed
// URL) + remove; one dirty-tracked Save persists the slot→key map. Stored only —
// not yet shown in videos. The "monoDark" preview sits on a dark swatch so a
// light/transparent mark stays visible.
export function LogosEditor({
  channelId,
  initial,
  initialPreviewUrls,
}: {
  channelId: string;
  initial: Logos;
  initialPreviewUrls: Partial<Record<LogoSlot, string>>;
}) {
  const [keys, setKeys] = useState<Logos>(initial);
  const [previews, setPreviews] = useState<Partial<Record<LogoSlot, string>>>(initialPreviewUrls);
  const [slotBusy, setSlotBusy] = useState<Partial<Record<LogoSlot, boolean>>>({});
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function onPick(slot: LogoSlot, file: File | undefined) {
    if (!file) return;
    setError(null);
    setSaved(false);
    if (file.size > MAX_LOGO_BYTES) {
      setError('Logo must be under 2 MB.');
      return;
    }
    setSlotBusy((b) => ({ ...b, [slot]: true }));
    try {
      const res = await createLogoUpload(channelId, slot, {
        filename: file.name,
        contentType: file.type,
      });
      if (!res.ok) {
        setError(res.reason);
        return;
      }
      const put = await fetch(res.uploadUrl, {
        method: 'PUT',
        body: file,
        headers: { 'Content-Type': file.type },
      });
      if (!put.ok) {
        setError(`Upload failed (${put.status}).`);
        return;
      }
      setKeys((k) => ({ ...k, [slot]: res.key }));
      setPreviews((p) => ({ ...p, [slot]: URL.createObjectURL(file) }));
      setDirty(true);
    } catch {
      setError('Upload failed. Please try again.');
    } finally {
      setSlotBusy((b) => ({ ...b, [slot]: false }));
    }
  }

  function onRemove(slot: LogoSlot) {
    setKeys((k) => {
      const next = { ...k };
      delete next[slot];
      return next;
    });
    setPreviews((p) => {
      const next = { ...p };
      delete next[slot];
      return next;
    });
    setDirty(true);
    setSaved(false);
  }

  async function onSave() {
    setBusy(true);
    setError(null);
    try {
      const res = await saveChannelLogos(channelId, keys);
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

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Logos</h2>
        <p className="text-sm opacity-70">
          Brand marks for this channel. Stored for now — not yet shown in videos.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {LOGO_SLOTS.map((slot) => {
          const url = previews[slot];
          return (
            <div
              key={slot}
              className="flex items-center gap-3 rounded-lg border border-black/10 p-3 dark:border-white/10"
            >
              <div
                className={`flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded border border-black/10 dark:border-white/10 ${
                  slot === 'monoDark' ? 'bg-neutral-800' : 'bg-black/5 dark:bg-white/5'
                }`}
              >
                {url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={url} alt={`${SLOT_LABELS[slot]} logo`} className="max-h-full max-w-full object-contain" />
                ) : (
                  <span className="text-xs opacity-40">none</span>
                )}
              </div>
              <div className="min-w-0 flex-1 space-y-1">
                <span className="text-sm font-medium">{SLOT_LABELS[slot]}</span>
                <div className="flex items-center gap-2">
                  <input
                    type="file"
                    accept={ACCEPT}
                    disabled={slotBusy[slot] || busy}
                    onChange={(e) => onPick(slot, e.target.files?.[0])}
                    className="block w-full text-xs file:mr-2 file:rounded file:border-0 file:bg-foreground file:px-2 file:py-1 file:text-background disabled:opacity-50"
                  />
                  {url && (
                    <button
                      type="button"
                      onClick={() => onRemove(slot)}
                      disabled={slotBusy[slot] || busy}
                      className="shrink-0 text-xs underline opacity-70 hover:opacity-100 disabled:opacity-40"
                    >
                      Remove
                    </button>
                  )}
                </div>
                {slotBusy[slot] && <span className="text-xs opacity-60">Uploading…</span>}
              </div>
            </div>
          );
        })}
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
