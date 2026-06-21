// One-off: inspect a video's generation/render state to diagnose a stuck status.
// Run: node --env-file=.env.local --experimental-strip-types --import ./scripts/register-smoke-loader.mjs scripts/inspect-video.ts <videoId>
import { createAdminClient } from '../src/lib/supabase/admin';

async function main(): Promise<void> {
  const videoId = process.argv[2];
  if (!videoId) throw new Error('Usage: inspect-video.ts <videoId>');
  const admin = createAdminClient();

  const { data: video } = await admin
    .from('videos')
    .select('id, title, created_at, settings')
    .eq('id', videoId)
    .maybeSingle();
  console.log('VIDEO:', video ? { id: video.id, title: video.title, created_at: video.created_at } : 'NOT FOUND');

  const { data: jobs } = await admin
    .from('jobs')
    .select('id, type, status, phase, error, created_at, updated_at')
    .eq('video_id', videoId)
    .order('created_at', { ascending: true });
  console.log(`\nJOBS (${jobs?.length ?? 0}):`);
  for (const j of jobs ?? []) {
    console.log(`  ${j.created_at} ${j.type} status=${j.status} phase=${j.phase ?? '-'}${j.error ? ' error=' + JSON.stringify(j.error) : ''}`);
  }

  const { count: sceneCount } = await admin
    .from('scenes')
    .select('id', { count: 'exact', head: true })
    .eq('video_id', videoId);
  console.log(`\nSCENES: ${sceneCount ?? 0}`);

  const { data: renders } = await admin
    .from('renders')
    .select('id, status, output_r2_key, error, created_at')
    .eq('video_id', videoId)
    .order('created_at', { ascending: true });
  console.log(`\nRENDERS (${renders?.length ?? 0}):`);
  for (const r of renders ?? []) {
    console.log(`  ${r.created_at} status=${r.status} out=${r.output_r2_key ?? '-'}${r.error ? ' error=' + JSON.stringify(r.error) : ''}`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
