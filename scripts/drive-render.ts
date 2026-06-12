// Headless "Generate Video" driver (Phase 6 verification). Mirrors the
// startVideoRender server action with the admin client so a render can be triggered
// without the browser: snapshot the scenes → create render + job rows → send
// render/start to the local Inngest dev server. Then poll the render to completion.
//
// Run: npm run drive:render -- <videoId>
import { createAdminClient } from '../src/lib/supabase/admin';
import { inngest } from '../src/lib/inngest/client';
import { renderIdempotencyKey } from '../src/lib/composition/idempotency';

async function main(): Promise<void> {
  const videoId = process.argv[2];
  if (!videoId) throw new Error('Usage: npm run drive:render -- <videoId>');
  const admin = createAdminClient();

  const { data: video, error: vErr } = await admin.from('videos').select('account_id, title').eq('id', videoId).single();
  if (vErr || !video) throw new Error(`load video: ${vErr?.message ?? 'not found'}`);
  const accountId = video.account_id as string;
  console.log(`Video: "${video.title}" (${videoId})`);

  const { data: sceneRows } = await admin
    .from('scenes')
    .select('id, position, narration, duration_seconds, audio_status')
    .eq('video_id', videoId)
    .order('position');
  const scenes = sceneRows ?? [];
  const notSynth = scenes.filter((s) => s.audio_status !== 'synthesized');
  if (scenes.length === 0) throw new Error('no scenes');
  if (notSynth.length) console.warn(`  ⚠ ${notSynth.length} scene(s) not synthesized — rendering anyway (override).`);

  const ids = scenes.map((s) => s.id as string);
  const { data: shotRows } = await admin.from('shots').select('id, scene_id, position, description, source, stock_query').in('scene_id', ids).order('position');
  const shotsByScene = new Map<string, unknown[]>();
  for (const sh of shotRows ?? []) {
    const list = shotsByScene.get(sh.scene_id as string) ?? [];
    list.push(sh);
    shotsByScene.set(sh.scene_id as string, list);
  }

  const content = {
    scenes: scenes.map((s) => ({
      id: s.id,
      position: s.position,
      narration: s.narration,
      duration_seconds: s.duration_seconds,
      audio_status: s.audio_status,
      shots: shotsByScene.get(s.id as string) ?? [],
    })),
  };
  const rev = await admin
    .from('script_revisions')
    .insert({ account_id: accountId, video_id: videoId, content, edit_summary: 'Phase 6 verification render' })
    .select('id')
    .single();
  if (rev.error || !rev.data) throw new Error(`snapshot: ${rev.error?.message}`);
  const revisionId = rev.data.id as string;

  const render = await admin
    .from('renders')
    .insert({ account_id: accountId, video_id: videoId, script_revision_id: revisionId, status: 'queued', idempotency_key: renderIdempotencyKey(revisionId) })
    .select('id')
    .single();
  if (render.error || !render.data) throw new Error(`render insert: ${render.error?.message}`);
  const renderId = render.data.id as string;

  const job = await admin
    .from('jobs')
    .insert({ account_id: accountId, video_id: videoId, render_id: renderId, type: 'render', status: 'queued' })
    .select('id')
    .single();
  if (job.error || !job.data) throw new Error(`job insert: ${job.error?.message}`);
  const jobId = job.data.id as string;

  await inngest.send({ name: 'render/start', data: { jobId, renderId, videoId } });
  console.log(`Sent render/start — renderId=${renderId} jobId=${jobId}\nPolling…`);

  let last = '';
  for (let i = 0; i < 200; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const { data: r } = await admin.from('renders').select('status, output_r2_key, base_output_r2_key, music_track_id, error').eq('id', renderId).single();
    if (!r) continue;
    const status = r.status as string;
    if (status !== last) {
      console.log(`  [${new Date().toISOString().slice(11, 19)}] status=${status}`);
      last = status;
    }
    if (status === 'complete') {
      console.log(`\n✅ COMPLETE\n  base_output_r2_key: ${r.base_output_r2_key}\n  output_r2_key:      ${r.output_r2_key}\n  music_track_id:     ${r.music_track_id ?? '(none — music off)'}`);
      return;
    }
    if (status === 'failed') {
      console.error(`\n❌ FAILED\n  error: ${JSON.stringify(r.error)}`);
      process.exitCode = 1;
      return;
    }
  }
  throw new Error('render did not finish within the poll window');
}

main().catch((e) => {
  console.error('drive-render failed:', e);
  process.exit(1);
});
