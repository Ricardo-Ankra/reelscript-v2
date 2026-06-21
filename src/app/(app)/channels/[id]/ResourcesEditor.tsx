'use client';

import { useState } from 'react';
import { MAX_RESOURCE_BYTES } from '@/lib/resources/library';
import { createResource, confirmResource, updateResource, deleteResource } from './resource-actions';

export type ResourceItem = {
  id: string;
  kind: 'image' | 'video';
  description: string;
  tags: string[];
  filename: string;
  previewUrl: string | null;
};

const ACCEPT = 'image/jpeg,image/png,image/webp,video/mp4';

// One resource card: preview + editable description/tags (dirty-tracked Save) + Delete.
function ResourceCard({
  item,
  onDeleted,
}: {
  item: ResourceItem;
  onDeleted: (id: string) => void;
}) {
  const [description, setDescription] = useState(item.description);
  const [tagsText, setTagsText] = useState(item.tags.join(', '));
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function onSave() {
    setBusy(true);
    setError(null);
    try {
      const tags = tagsText.split(',').map((t) => t.trim()).filter(Boolean);
      const res = await updateResource(item.id, { description, tags });
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

  async function onDelete() {
    setBusy(true);
    setError(null);
    try {
      const res = await deleteResource(item.id);
      if (res.ok) {
        if (item.previewUrl && item.previewUrl.startsWith('blob:')) URL.revokeObjectURL(item.previewUrl);
        onDeleted(item.id);
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
    <div className="space-y-2 rounded-lg border border-black/10 p-3 dark:border-white/10">
      <div className="flex h-32 items-center justify-center overflow-hidden rounded bg-black/5 dark:bg-white/5">
        {item.previewUrl ? (
          item.kind === 'video' ? (
            <video src={item.previewUrl} muted className="max-h-full max-w-full object-contain" />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={item.previewUrl} alt={item.description || item.filename} className="max-h-full max-w-full object-contain" />
          )
        ) : (
          <span className="text-xs opacity-40">{item.kind}</span>
        )}
      </div>

      <textarea
        value={description}
        onChange={(e) => {
          setDescription(e.target.value);
          setDirty(true);
          setSaved(false);
        }}
        rows={2}
        placeholder="Description"
        className="w-full rounded border border-black/15 bg-transparent px-2 py-1 text-sm dark:border-white/15"
      />
      <input
        type="text"
        value={tagsText}
        onChange={(e) => {
          setTagsText(e.target.value);
          setDirty(true);
          setSaved(false);
        }}
        placeholder="tags, comma, separated"
        className="w-full rounded border border-black/15 bg-transparent px-2 py-1 text-sm dark:border-white/15"
      />

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onSave}
          disabled={busy || !dirty}
          className="rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={busy}
          className="text-sm text-red-600 disabled:opacity-50"
        >
          Delete
        </button>
        {saved && !dirty && <span className="text-sm text-green-600">Saved</span>}
        {error && <span className="text-sm text-red-600">{error}</span>}
      </div>
    </div>
  );
}

export function ResourcesEditor({ channelId, initial }: { channelId: string; initial: ResourceItem[] }) {
  const [items, setItems] = useState<ResourceItem[]>(initial);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onPick(file: File | undefined) {
    if (!file) return;
    setError(null);
    setStatus(null);
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
      setStatus('Analyzing…');
      const confirmed = await confirmResource(created.resourceId);
      const kind = file.type === 'video/mp4' ? 'video' : 'image';
      const item: ResourceItem = {
        id: created.resourceId,
        kind,
        description: confirmed.ok ? confirmed.description : file.name,
        tags: confirmed.ok ? confirmed.tags : [],
        filename: file.name,
        previewUrl: URL.createObjectURL(file),
      };
      setItems((xs) => [item, ...xs]);
      if (!confirmed.ok) setError(confirmed.reason);
      setStatus(null);
    } catch {
      setError('Upload failed. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  function onDeleted(id: string) {
    setItems((xs) => xs.filter((x) => x.id !== id));
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Resources</h2>
        <p className="text-sm opacity-70">
          Pinned images and video for this channel. Stored + auto-tagged — placement in
          videos comes next.
        </p>
      </div>

      <div className="flex items-center gap-3">
        <input
          type="file"
          accept={ACCEPT}
          disabled={busy}
          onChange={(e) => onPick(e.target.files?.[0])}
          className="block text-sm file:mr-2 file:rounded file:border-0 file:bg-foreground file:px-3 file:py-1.5 file:text-background disabled:opacity-50"
        />
        {status && <span className="text-sm opacity-60">{status}</span>}
        {error && <span className="text-sm text-red-600">{error}</span>}
      </div>

      {items.length === 0 ? (
        <p className="text-sm opacity-70">No resources yet.</p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((item) => (
            <ResourceCard key={item.id} item={item} onDeleted={onDeleted} />
          ))}
        </div>
      )}
    </div>
  );
}
