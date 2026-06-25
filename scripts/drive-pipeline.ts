// Headless master-pipeline driver (V2 Slice 6a verification). Triggers reelscript.pipeline
// against the FAKE generation provider, AUTO-APPROVES the G1 storyboard gate when it opens,
// and confirms the job completes — proving step.invoke fan-out/fan-in + the gate cascade
// end-to-end without Higgsfield creds. Mirrors drive-generation.ts.
//
// PREREQUISITE — the fake's fixture URLs must be in the DEV-SERVER .env.local (the function
// runs in the dev-server process, not this script's): see scripts/drive-generation.ts header
// for GEN_FAKE_STILL_URL / GEN_FAKE_CLIP_URL. The video must have synthesized voice (the
// pipeline's completeness gate requires it) and ≥1 kind='generative' shot.
//
// Run: npm run drive:pipeline -- <videoId>
import { createAdminClient } from '../src/lib/supabase/admin';
import { inngest } from '../src/lib/inngest/client';

async function main(): Promise<void> {
  const videoId = process.argv[2];
  if (!videoId) throw new Error('Usage: npm run drive:pipeline -- <videoId>');
  const admin = createAdminClient();

  const { data: video, error: vErr } = await admin.from('videos').select('account_id, title').eq('id', videoId).single();
  if (vErr || !video) throw new Error(`load video: ${vErr?.message ?? 'not found'}`);
  const accountId = video.account_id as string;
  console.log(`Video: "${video.title}" (${videoId})`);

  // Completeness: no not_synthesized scenes (the pipeline requires voice done).
  const { data: scenes } = await admin.from('scenes').select('id, audio_status').eq('video_id', videoId);
  const sceneRows = scenes ?? [];
  if (sceneRows.length === 0) throw new Error('No scenes. Run script-gen first.');
  if (sceneRows.some((s) => s.audio_status === 'not_synthesized')) {
    throw new Error('Some scenes are not synthesized. Synthesize voice before driving the pipeline.');
  }
  const sceneIds = sceneRows.map((s) => s.id as string);
  const { count: genCount } = await admin.from('shots').select('id', { count: 'exact', head: true })
    .in('scene_id', sceneIds).eq('kind', 'generative');
  console.log(`  ${genCount ?? 0} generative shot(s) — G1 storyboard ${(genCount ?? 0) > 0 ? 'WILL' : 'will NOT'} pause.`);

  // Create the render row + the pipeline job, then fire pipeline/start.
  const rev = await admin.from('script_revisions')
    .insert({ account_id: accountId, video_id: videoId, content: { scenes: [] }, edit_summary: 'drive:pipeline' })
    .select('id').single();
  if (rev.error || !rev.data) throw new Error(`revision: ${rev.error?.message}`);
  const render = await admin.from('renders')
    .insert({ account_id: accountId, video_id: videoId, script_revision_id: rev.data.id, status: 'queued', idempotency_key: `drive-pipeline-${rev.data.id}` })
    .select('id').single();
  if (render.error || !render.data) throw new Error(`render: ${render.error?.message}`);
  const renderId = render.data.id as string;
  const job = await admin.from('jobs')
    .insert({ account_id: accountId, video_id: videoId, render_id: renderId, type: 'pipeline', status: 'queued' })
    .select('id').single();
  if (job.error || !job.data) throw new Error(`job: ${job.error?.message}`);
  const jobId = job.data.id as string;

  await inngest.send({ name: 'pipeline/start', data: { jobId, videoId, accountId, renderId } });
  console.log(`  Sent pipeline/start (job ${jobId}). Polling …`);

  let approved = false;
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const { data: j } = await admin.from('jobs').select('status, phase').eq('id', jobId).single();
    const { data: r } = await admin.from('renders').select('status').eq('id', renderId).single();
    console.log(`  [${i}] job=${j?.status}/${j?.phase} render=${r?.status}`);
    if (!approved && j?.status === 'paused' && j?.phase === 'awaiting_storyboard_review') {
      await inngest.send({ name: 'pipeline/gate.resolved', data: { jobId, accountId, decision: 'approve' } });
      console.log('  → auto-approved the G1 storyboard gate.');
      approved = true;
    }
    if (j?.status === 'complete' || r?.status === 'complete') { console.log('✓ Pipeline complete.'); return; }
    if (j?.status === 'failed' || j?.status === 'cancelled') throw new Error(`Pipeline ${j?.status} at phase ${j?.phase}.`);
  }
  throw new Error('Timed out (6 min). Check the Inngest dev server + .env.local fixtures.');
}

main().catch((e) => { console.error(e); process.exit(1); });
