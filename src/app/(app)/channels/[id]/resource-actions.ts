'use server';

import { createClient } from '@/lib/supabase/server';
import { deleteObject } from '@/lib/r2';
import { createResourceUpload, confirmResourceUpload } from '@/lib/resources/upload';
import { validateResourceUpload, sanitizeResourceFields } from '@/lib/resources/library';

// Channel resource library actions (Phase 8 slice 1). channel_resources is a
// first-class RLS table, so update/delete are direct RLS writes scoped by account_id,
// confirmed via .select('id') (no row → not found, never a phantom "Saved"). Create +
// confirm reuse the Phase-5 server functions. Account resolved from the session.

async function resolveAccountId(
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<string | null> {
  const { data } = await supabase.from('accounts').select('id').maybeSingle();
  return (data?.id as string | undefined) ?? null;
}

// Reserve a channel_resources row + a signed PUT URL. The kind is derived from the
// content type server-side (never trusted from the client).
export async function createResource(
  channelId: string,
  input: { filename: string; contentType: string },
): Promise<{ ok: true; resourceId: string; uploadUrl: string } | { ok: false; reason: string }> {
  const valid = validateResourceUpload({ contentType: input.contentType });
  if (!valid.ok) return valid;

  const supabase = await createClient();
  const accountId = await resolveAccountId(supabase);
  if (!accountId) return { ok: false, reason: 'No account found.' };

  try {
    const { resourceId, uploadUrl } = await createResourceUpload(supabase, accountId, channelId, {
      filename: input.filename,
      contentType: input.contentType,
      kind: valid.kind,
    });
    return { ok: true, resourceId, uploadUrl };
  } catch {
    return { ok: false, reason: 'Could not start the upload. Please try again.' };
  }
}

// After the client PUTs the bytes: hash for dedupe + (images) one vision call to
// auto-describe + tag. Wrapped so a vision/network failure degrades gracefully — the
// row already exists with the filename, editable by hand.
export async function confirmResource(
  resourceId: string,
): Promise<{ ok: true; description: string; tags: string[] } | { ok: false; reason: string }> {
  const supabase = await createClient();
  const accountId = await resolveAccountId(supabase);
  if (!accountId) return { ok: false, reason: 'No account found.' };

  try {
    const { description, tags } = await confirmResourceUpload(supabase, accountId, resourceId);
    return { ok: true, description, tags };
  } catch {
    return { ok: false, reason: 'Uploaded, but auto-tagging failed. You can edit it manually.' };
  }
}

// Update the editable fields (description + tags). sanitizeResourceFields enforces the
// caps before the write.
export async function updateResource(
  resourceId: string,
  fields: unknown,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const clean = sanitizeResourceFields(fields as { description?: unknown; tags?: unknown });

  const supabase = await createClient();
  const accountId = await resolveAccountId(supabase);
  if (!accountId) return { ok: false, reason: 'No account found.' };

  const { data, error } = await supabase
    .from('channel_resources')
    .update({ description: clean.description, tags: clean.tags })
    .eq('id', resourceId)
    .eq('account_id', accountId)
    .select('id');
  if (error) return { ok: false, reason: error.message };
  if (!data || data.length === 0) return { ok: false, reason: 'Resource not found.' };
  return { ok: true };
}

// Delete a resource: best-effort remove the R2 object, then the row (RLS-scoped).
export async function deleteResource(
  resourceId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const supabase = await createClient();
  const accountId = await resolveAccountId(supabase);
  if (!accountId) return { ok: false, reason: 'No account found.' };

  const { data: row } = await supabase
    .from('channel_resources')
    .select('r2_key')
    .eq('id', resourceId)
    .eq('account_id', accountId)
    .maybeSingle();

  const r2Key = (row?.r2_key as string | null) ?? null;
  if (r2Key) {
    try {
      await deleteObject(r2Key);
    } catch {
      // best-effort: a stale/absent object must not block removing the row
    }
  }

  const { data, error } = await supabase
    .from('channel_resources')
    .delete()
    .eq('id', resourceId)
    .eq('account_id', accountId)
    .select('id');
  if (error) return { ok: false, reason: error.message };
  if (!data || data.length === 0) return { ok: false, reason: 'Resource not found.' };
  return { ok: true };
}
