'use client';

import { useRef, useState } from 'react';
import { MAX_RESOURCE_BYTES } from '@/lib/resources/library';
import { createResource, confirmResource } from '@/app/(app)/channels/[id]/resource-actions';
import type { ResourceOption } from './SceneCard';

// Upload an image/video straight from the editor and hand the resulting channel
// resource back to the caller (which pins it to a shot). Reuses the channel-resource
// signed-PUT flow: createResource → PUT bytes → confirmResource. Bytes go client→R2
// directly; the frontend never proxies the file.
export function SceneAssetUploader({
  channelId,
  onUploaded,
  disabled,
}: {
  channelId: string;
  onUploaded: (resource: ResourceOption) => void;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onPick(file: File | undefined) {
    if (!file) return;
    setError(null);
    if (file.size > MAX_RESOURCE_BYTES) {
      setError('File must be under 100 MB.');
      return;
    }
    setBusy(true);
    try {
      const created = await createResource(channelId, { filename: file.name, contentType: file.type });
      if (!created.ok) {
        setError(created.reason);
        return;
      }
      const put = await fetch(created.uploadUrl, {
        method: 'PUT',
        body: file,
        headers: { 'Content-Type': file.type },
      });
      if (!put.ok) {
        setError(`Upload failed (${put.status}).`);
        return;
      }
      const confirmed = await confirmResource(created.resourceId);
      const kind = file.type === 'video/mp4' ? 'video' : 'image';
      onUploaded({
        id: created.resourceId,
        kind,
        description: confirmed.ok ? confirmed.description : file.name,
      });
      if (!confirmed.ok) setError(confirmed.reason);
    } catch {
      setError('Upload failed. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-1">
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,video/mp4"
        className="hidden"
        onChange={(e) => {
          void onPick(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      <button
        type="button"
        disabled={disabled || busy}
        onClick={() => inputRef.current?.click()}
        className="shrink-0 rounded border border-black/10 px-1 py-px text-[10px] enabled:hover:bg-black/[0.04] disabled:opacity-40 dark:border-white/10 dark:enabled:hover:bg-white/[0.06]"
        title="Upload an image/video and attach it to this shot"
      >
        {busy ? 'Uploading…' : 'Upload'}
      </button>
      {error && <span className="text-[10px] text-red-600">{error}</span>}
    </span>
  );
}
