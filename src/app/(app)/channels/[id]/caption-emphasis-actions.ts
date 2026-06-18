'use server';

import { createClient } from '@/lib/supabase/server';
import { validateCaptionEmphasisForm } from '@/lib/channels/caption-emphasis';

// Validate the caption-emphasis form, then write it via the
// set_channel_caption_emphasis RPC (jsonb_set on brand_kit.caption_emphasis only).
// The RPC returns the channel id, or null when zero rows matched — that is a
// failure, not a phantom "Saved". Mirrors saveChannelBrand. RLS (SECURITY INVOKER)
// guarantees only the owner's channel updates.
export async function saveCaptionEmphasis(
  channelId: string,
  input: unknown,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const valid = validateCaptionEmphasisForm(input);
  if (!valid.ok) return valid;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc('set_channel_caption_emphasis', {
    p_channel_id: channelId,
    p_value: valid.value,
  });
  if (error) return { ok: false, reason: error.message };
  if (data == null) return { ok: false, reason: 'Channel not found.' };
  return { ok: true };
}
