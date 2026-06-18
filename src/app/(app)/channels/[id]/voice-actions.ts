'use server';

import { createClient } from '@/lib/supabase/server';
import { validateVoiceForm } from '@/lib/channels/voice';
import {
  listVoices,
  listModels,
  type CatalogVoice,
  type CatalogModel,
} from '@/lib/voice/elevenlabs';

// Fetch the live ElevenLabs voice + model catalog. Server action so the API key
// (server-only) never reaches the client — the client gets only { id, name }[].
// A network / non-2xx failure → a friendly reason; the editor stays usable.
export async function loadVoiceCatalog(): Promise<
  { ok: true; voices: CatalogVoice[]; models: CatalogModel[] } | { ok: false; reason: string }
> {
  try {
    const [voices, models] = await Promise.all([listVoices(), listModels()]);
    return { ok: true, voices, models };
  } catch {
    return { ok: false, reason: "Couldn't reach ElevenLabs — check the API key and try again." };
  }
}

// Persist the channel's voice params (wholesale voice_tts) via set_channel_voice_tts.
// validateVoiceForm builds the snake_case stored object. The RPC returns the id, or
// null when zero rows matched — a failure, not a phantom "Saved".
export async function saveChannelVoiceTts(
  channelId: string,
  input: unknown,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const valid = validateVoiceForm(input);
  if (!valid.ok) return valid;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc('set_channel_voice_tts', {
    p_channel_id: channelId,
    p_value: valid.value,
  });
  if (error) return { ok: false, reason: error.message };
  if (data == null) return { ok: false, reason: 'Channel not found.' };
  return { ok: true };
}
