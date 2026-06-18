'use server';

import { randomUUID } from 'node:crypto';
import { createClient } from '@/lib/supabase/server';
import { signedPutUrl } from '@/lib/r2';
import { validateLogoUpload, sanitizeLogos } from '@/lib/channels/logos';

// Reserve a signed PUT URL + R2 key for a logo upload. Does NOT touch brand_kit;
// the client PUTs the file bytes, then saveChannelLogos persists the keys. The
// account id is resolved from the session for the key path; ownership is enforced
// by the save RPC's RLS (and the page already 404s a non-owned channel).
export async function createLogoUpload(
  channelId: string,
  slot: string,
  input: { filename: string; contentType: string },
): Promise<{ ok: true; uploadUrl: string; key: string } | { ok: false; reason: string }> {
  const valid = validateLogoUpload({ slot, contentType: input.contentType });
  if (!valid.ok) return valid;

  const supabase = await createClient();
  const { data: account } = await supabase.from('accounts').select('id').maybeSingle();
  if (!account) return { ok: false, reason: 'No account found.' };

  const key = `logos/${account.id as string}/${channelId}/${slot}-${randomUUID()}.${valid.ext}`;
  const uploadUrl = await signedPutUrl(key, input.contentType);
  return { ok: true, uploadUrl, key };
}

// Persist the channel's logo set (slot → R2 key) via the set_channel_logos RPC.
// sanitizeLogos keeps only the 4 known slots with string keys. The RPC returns
// the id, or null when zero rows matched — a failure, not a phantom "Saved".
export async function saveChannelLogos(
  channelId: string,
  logos: unknown,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const clean = sanitizeLogos(logos);
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('set_channel_logos', {
    p_channel_id: channelId,
    p_logos: clean,
  });
  if (error) return { ok: false, reason: error.message };
  if (data == null) return { ok: false, reason: 'Channel not found.' };
  return { ok: true };
}
