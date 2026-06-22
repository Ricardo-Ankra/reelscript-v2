'use server';

import { createClient } from '@/lib/supabase/server';
import { deleteObject } from '@/lib/r2';

// Hard-delete a video: best-effort R2 cleanup (the FK cascade removes DB rows but
// not R2 objects), then delete the row. Cascade removes scenes/shots/renders/jobs/
// script_revisions; cost_events.video_id → NULL (ledger preserved). Refuses while a
// job is in flight (cancel first). Never throws to the client.
export async function deleteVideo(
  videoId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const supabase = await createClient();
  const { data: account } = await supabase.from('accounts').select('id').maybeSingle();
  if (!account) return { ok: false, reason: 'No account found.' };
  const accountId = account.id as string;

  const { data: video } = await supabase
    .from('videos')
    .select('id')
    .eq('id', videoId)
    .eq('account_id', accountId)
    .maybeSingle();
  if (!video) return { ok: false, reason: 'Video not found.' };

  // In-flight guard: do not delete out from under a running function.
  const { data: inflight } = await supabase
    .from('jobs')
    .select('id')
    .eq('video_id', videoId)
    .in('status', ['queued', 'running'])
    .limit(1);
  if (inflight && inflight.length > 0) {
    return { ok: false, reason: 'Cancel the running job before deleting.' };
  }

  // Best-effort R2 cleanup. Scene audio first.
  const { data: scenes } = await supabase.from('scenes').select('id').eq('video_id', videoId);
  for (const s of scenes ?? []) {
    try {
      await deleteObject(`audio/${s.id as string}.mp3`);
    } catch (e) {
      console.warn(`[deleteVideo] audio delete failed for ${s.id}: ${(e as Error).message}`);
    }
  }
  // Render outputs (output / voiceover-only base / composition spec). NOT
  // music_remux_key — that column is a cache-guard hash, not an R2 object key.
  const { data: renders } = await supabase
    .from('renders')
    .select('output_r2_key, base_output_r2_key, composition_spec_r2_key')
    .eq('video_id', videoId);
  for (const r of renders ?? []) {
    for (const key of [r.output_r2_key, r.base_output_r2_key, r.composition_spec_r2_key]) {
      if (typeof key === 'string' && key) {
        try {
          await deleteObject(key);
        } catch (e) {
          console.warn(`[deleteVideo] r2 delete failed for ${key}: ${(e as Error).message}`);
        }
      }
    }
  }

  // Delete the row; the cascade does the rest.
  const { data: deleted, error } = await supabase
    .from('videos')
    .delete()
    .eq('id', videoId)
    .eq('account_id', accountId)
    .select('id');
  if (error) return { ok: false, reason: error.message };
  if (!deleted || deleted.length === 0) return { ok: false, reason: 'Video not found.' };
  return { ok: true };
}
