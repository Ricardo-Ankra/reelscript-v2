'use server';

import { createClient } from '@/lib/supabase/server';
import { validateBrandForm } from '@/lib/channels/brand';

// Validate the brand form, then atomically write it via the update_channel_brand
// RPC. The RPC returns the channel id, or null when zero rows matched (wrong id,
// RLS regression, channel deleted mid-edit) — that is a failure, not a phantom
// "Saved". Mirrors updateVideoSettings (rpc + null check). RLS (SECURITY INVOKER)
// guarantees only the owner's channel updates.
export async function saveChannelBrand(
  channelId: string,
  input: unknown,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const valid = validateBrandForm(input);
  if (!valid.ok) return valid;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc('update_channel_brand', {
    p_channel_id: channelId,
    p_name: valid.value.name,
    p_brand_kit_patch: valid.value.brandKitPatch,
    p_brand_voice: valid.value.brandVoice,
    p_defaults: valid.value.defaults,
  });
  if (error) return { ok: false, reason: error.message };
  if (data == null) return { ok: false, reason: 'Channel not found.' };
  return { ok: true };
}
