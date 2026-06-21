'use server';

import { createClient } from '@/lib/supabase/server';
import { validateTagMappings } from '@/lib/voice/profile';
import { listModels, type CatalogModel } from '@/lib/voice/elevenlabs';

// Fetch the live ElevenLabs model catalog (on demand, like the channel voice editor).
// Server action so the API key (server-only) never reaches the client — the client
// gets only { id, name }[]. A network / non-2xx failure → a friendly reason.
export async function loadModelCatalog(): Promise<
  { ok: true; models: CatalogModel[] } | { ok: false; reason: string }
> {
  try {
    const models = await listModels();
    return { ok: true, models };
  } catch {
    return { ok: false, reason: "Couldn't reach ElevenLabs — check the API key and try again." };
  }
}

// Upsert the caller's voice profile for a model. validateTagMappings rejects a bad
// submission before it reaches the DB. The RPC returns the id, or null when no
// account matched — a failure, not a phantom "Saved".
export async function saveVoiceProfile(
  modelId: string,
  modelName: string,
  input: unknown,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const valid = validateTagMappings(input);
  if (!valid.ok) return valid;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc('upsert_voice_profile', {
    p_model_id: modelId,
    p_model_name: modelName,
    p_tag_mappings: valid.value,
  });
  if (error) return { ok: false, reason: error.message };
  if (data == null) return { ok: false, reason: 'Account not found.' };
  return { ok: true };
}

// Delete the caller's voice profile for a model. The RPC returns the id, or null when
// no row matched.
export async function deleteVoiceProfile(
  modelId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('delete_voice_profile', {
    p_model_id: modelId,
  });
  if (error) return { ok: false, reason: error.message };
  if (data == null) return { ok: false, reason: 'Profile not found.' };
  return { ok: true };
}
