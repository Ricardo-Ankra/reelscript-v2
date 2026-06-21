'use server';

import { createClient } from '@/lib/supabase/server';
import { inngest } from '@/lib/inngest/client';
import { rerollMusicTrack, selectMusicTrack, type MusicTrack } from '@/lib/music/select';
import { canonicalizeMusicParams, type MusicParams } from '@/lib/music/params';

// Phase 6 Music panel surface (spec 6.6, minimal). The panel acts on a video's
// CURRENT render: reroll the track / nudge master volume, then Save → an audio-only
// re-mux (music/remux), never a re-render. Reselection only — it picks from the
// seeded library, never generates (spec 4.2.3).

export interface MusicPanelState {
  available: boolean; // false ⇒ no completed render with a base, or empty library
  renderId?: string;
  trackId?: string | null;
  trackTitle?: string | null;
  params?: MusicParams;
  trackDurationSec?: number | null;
  tracks?: { id: string; title: string }[];
  status?: string;
}

export async function getMusicPanel(videoId: string): Promise<MusicPanelState> {
  const supabase = await createClient();

  const { data: video } = await supabase
    .from('videos')
    .select('current_render_id, channel_id, settings')
    .eq('id', videoId)
    .maybeSingle();
  const renderId = video?.current_render_id as string | undefined;
  const channelId = video?.channel_id as string | undefined;
  if (!renderId || !channelId) return { available: false };

  const { data: render } = await supabase
    .from('renders')
    .select('id, status, music_track_id, music_params, base_output_r2_key')
    .eq('id', renderId)
    .maybeSingle();
  // Re-mux needs a voiceover-only base; pre-Phase-6 renders lack one.
  if (!render?.base_output_r2_key) return { available: false };

  const { data: trackRows } = await supabase
    .from('music_tracks')
    .select('id, title, duration_seconds')
    .eq('channel_id', channelId)
    .order('created_at');
  const tracks = (trackRows ?? []).map((t) => ({ id: t.id as string, title: (t.title as string) ?? 'Untitled' }));
  if (tracks.length === 0) return { available: false };

  const params = canonicalizeMusicParams((render.music_params as Partial<MusicParams>) ?? {});
  const currentId = (render.music_track_id as string | null) ?? null;
  const currentRow = (trackRows ?? []).find((t) => (t.id as string) === currentId);
  const trackDurationSec =
    currentRow && currentRow.duration_seconds != null ? Number(currentRow.duration_seconds) : null;
  return {
    available: true,
    renderId,
    trackId: currentId,
    trackTitle: tracks.find((t) => t.id === currentId)?.title ?? null,
    params,
    trackDurationSec,
    tracks,
    status: render.status as string,
  };
}

// Apply a music change to the current render and kick the audio-only re-mux.
export async function applyMusic(
  renderId: string,
  opts: { reroll?: boolean; params?: Partial<MusicParams> },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const supabase = await createClient();

  const { data: render, error } = await supabase
    .from('renders')
    .select('account_id, video_id, music_track_id, music_params')
    .eq('id', renderId)
    .single();
  if (error || !render) return { ok: false, reason: 'render not found' };
  const accountId = render.account_id as string;
  const videoId = render.video_id as string;

  const { data: video } = await supabase
    .from('videos')
    .select('channel_id, settings')
    .eq('id', videoId)
    .single();
  const channelId = video?.channel_id as string | undefined;
  const mood = ((video?.settings as Record<string, unknown>)?.mood as string) ?? 'neutral';
  if (!channelId) return { ok: false, reason: 'no channel' };

  const { data: trackRows } = await supabase.from('music_tracks').select('id, mood_tags').eq('channel_id', channelId);
  const tracks: MusicTrack[] = (trackRows ?? []).map((t) => ({ id: t.id as string, moodTags: (t.mood_tags as string[]) ?? [] }));
  if (tracks.length === 0) return { ok: false, reason: 'no music in library' };

  const currentId = (render.music_track_id as string | null) ?? null;
  const trackId = opts.reroll
    ? (rerollMusicTrack(mood, tracks, currentId)?.id ?? currentId)
    : (currentId ?? selectMusicTrack(mood, tracks)?.id ?? null);
  if (!trackId) return { ok: false, reason: 'no track to apply' };

  const params = canonicalizeMusicParams({
    ...((render.music_params as Partial<MusicParams>) ?? {}),
    ...(opts.params ?? {}),
  });

  // Persist the tuning to the video FIRST (so a future re-render inherits it). Do
  // this before flipping the render to 'encoding' so a settings-write failure can't
  // strand the render mid-encode — the operator just retries.
  const { error: sErr } = await supabase.rpc('merge_video_settings', {
    p_video_id: videoId,
    p_patch: { music_params: params },
  });
  if (sErr) return { ok: false, reason: sErr.message };

  const { error: upErr } = await supabase
    .from('renders')
    .update({ music_track_id: trackId, music_params: params, status: 'encoding' })
    .eq('id', renderId);
  if (upErr) return { ok: false, reason: upErr.message };

  await inngest.send({ name: 'music/remux', data: { renderId, accountId, videoId } });
  return { ok: true };
}
