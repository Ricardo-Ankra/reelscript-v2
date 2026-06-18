'use server';

import { createClient } from '@/lib/supabase/server';
import { validateVideoDefaultsForm } from '@/lib/channels/video-defaults';

// Persist the channel's video-format defaults (aspect_ratio / fps / target_length)
// via set_channel_video_defaults, which key-merges them into channels.defaults
// (the brand editor's sibling keys survive). The RPC returns the id, or null when
// zero rows matched — a failure, not a phantom "Saved". Mirrors saveChannelVoiceTts.
export async function saveChannelVideoDefaults(
  channelId: string,
  input: unknown,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const valid = validateVideoDefaultsForm(input);
  if (!valid.ok) return valid;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc('set_channel_video_defaults', {
    p_channel_id: channelId,
    p_value: valid.value,
  });
  if (error) return { ok: false, reason: error.message };
  if (data == null) return { ok: false, reason: 'Channel not found.' };
  return { ok: true };
}
