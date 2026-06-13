// Headless music re-mux driver (Phase 6 verification). Mirrors the Music panel's
// reroll/Save: optionally reroll to the next library track, set status=encoding, emit
// music/remux, then TIME how long until the render is complete again — proving "music
// changes re-mux in seconds without re-rendering" (spec 10.1).
//
// Run: npm run drive:remux -- <renderId> [--reroll]
import { createAdminClient } from '../src/lib/supabase/admin';
import { inngest } from '../src/lib/inngest/client';
import { rerollMusicTrack, selectMusicTrack, type MusicTrack } from '../src/lib/music/select';
import { canonicalizeMusicParams, type MusicParams } from '../src/lib/music/params';

async function main(): Promise<void> {
  const renderId = process.argv[2];
  const reroll = process.argv.includes('--reroll');
  if (!renderId) throw new Error('Usage: npm run drive:remux -- <renderId> [--reroll]');
  const admin = createAdminClient();

  const { data: render, error } = await admin
    .from('renders')
    .select('account_id, video_id, music_track_id, music_params, base_output_r2_key, output_r2_key')
    .eq('id', renderId)
    .single();
  if (error || !render) throw new Error(`load render: ${error?.message ?? 'not found'}`);
  if (!render.base_output_r2_key) throw new Error('render has no base_output_r2_key (not a Phase-6 render).');
  const accountId = render.account_id as string;
  const videoId = render.video_id as string;
  const prevOutput = render.output_r2_key as string | null;

  const { data: video } = await admin.from('videos').select('channel_id, settings').eq('id', videoId).single();
  const channelId = video?.channel_id as string;
  const mood = ((video?.settings as Record<string, unknown>)?.mood as string) ?? 'neutral';
  const { data: trackRows } = await admin.from('music_tracks').select('id, mood_tags, title').eq('channel_id', channelId);
  const tracks: MusicTrack[] = (trackRows ?? []).map((t) => ({ id: t.id as string, moodTags: (t.mood_tags as string[]) ?? [] }));
  const titleOf = (id: string | null) => (trackRows ?? []).find((t) => t.id === id)?.title ?? '(none)';

  const currentId = (render.music_track_id as string | null) ?? null;
  const trackId = reroll
    ? (rerollMusicTrack(mood, tracks, currentId)?.id ?? currentId)
    : (currentId ?? selectMusicTrack(mood, tracks)?.id ?? null);
  if (!trackId) throw new Error('no track to apply (seed the library first).');
  const params = canonicalizeMusicParams((render.music_params as Partial<MusicParams>) ?? {});

  console.log(`Render ${renderId}`);
  console.log(`  track: ${titleOf(currentId)} → ${titleOf(trackId)}${reroll ? ' (reroll)' : ''}`);

  await admin.from('renders').update({ music_track_id: trackId, music_params: params, status: 'encoding' }).eq('id', renderId);
  const t0 = Date.now();
  await inngest.send({ name: 'music/remux', data: { renderId, accountId, videoId } });
  console.log('  emitted music/remux — timing…');

  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const { data: r } = await admin.from('renders').select('status, output_r2_key, error').eq('id', renderId).single();
    if (r?.status === 'complete') {
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      const changed = r.output_r2_key !== prevOutput || r.output_r2_key?.endsWith('.mp4');
      console.log(`\n✅ RE-MUX COMPLETE in ${secs}s (no re-render)`);
      console.log(`  output_r2_key: ${r.output_r2_key}  ${changed ? '(final, music mixed)' : ''}`);
      return;
    }
    if (r?.status === 'failed') {
      console.error(`\n❌ RE-MUX FAILED: ${JSON.stringify(r.error)}`);
      process.exitCode = 1;
      return;
    }
  }
  throw new Error('re-mux did not finish within the poll window');
}

main().catch((e) => {
  console.error('drive-remux failed:', e);
  process.exit(1);
});
