'use server';

import { createClient } from '@/lib/supabase/server';
import { sanitizeSettingsPatch, type VideoSettingsPatch } from '@/lib/videos/settings';

// Update a video's render settings via the atomic merge RPC (settings || patch) and
// return the WRITTEN settings so the panel reconciles to the truth. RLS-scoped
// server client; the SECURITY INVOKER RPC enforces ownership. Matches music-actions.ts.
export async function updateVideoSettings(
  videoId: string,
  patch: VideoSettingsPatch,
): Promise<{ ok: true; settings: Record<string, unknown> } | { ok: false; reason: string }> {
  const clean = sanitizeSettingsPatch(patch);
  const supabase = await createClient();

  // Nothing valid to write → return current settings unchanged (still honest).
  if (Object.keys(clean).length === 0) {
    const { data } = await supabase.from('videos').select('settings').eq('id', videoId).maybeSingle();
    if (!data) return { ok: false, reason: 'video not found' };
    return { ok: true, settings: (data.settings as Record<string, unknown>) ?? {} };
  }

  const { data, error } = await supabase.rpc('merge_video_settings', {
    p_video_id: videoId,
    p_patch: clean,
  });
  if (error) return { ok: false, reason: error.message };
  if (data == null) return { ok: false, reason: 'video not found' };
  return { ok: true, settings: data as Record<string, unknown> };
}
