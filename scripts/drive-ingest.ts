// Headless ingest driver (V2 Slice 2b verification). Triggers ingestShots, which conforms
// the video's resource-pinned live-action shots via the REAL ffmpeg Lambda. Mirrors
// drive-generation.ts / drive-remux.ts.
//
// PREREQUISITES (operator):
//   1. The ffmpeg Lambda is redeployed with 2a's probe mode (node scripts/deploy-music-lambda.mjs).
//   2. The dev server + Inngest dev server are running (the function runs in the dev-server process).
//   3. The target video has at least one source='resource', kind='live_action' shot (pin
//      one in the editor first — this script never fabricates shots).
//
// Run: npm run drive:ingest -- <videoId>
import { createAdminClient } from '../src/lib/supabase/admin';
import { inngest } from '../src/lib/inngest/client';
import { signedGetUrl } from '../src/lib/r2';

async function main(): Promise<void> {
  const videoId = process.argv[2];
  if (!videoId) throw new Error('Usage: npm run drive:ingest -- <videoId>');
  const admin = createAdminClient();

  const { data: video, error: vErr } = await admin
    .from('videos')
    .select('account_id, title')
    .eq('id', videoId)
    .single();
  if (vErr || !video) throw new Error(`load video: ${vErr?.message ?? 'not found'}`);
  const accountId = video.account_id as string;
  console.log(`Video: "${video.title}" (${videoId})`);

  const { data: scenes } = await admin.from('scenes').select('id').eq('video_id', videoId);
  const sceneIds = (scenes ?? []).map((s) => s.id as string);
  const ingestShotsRows = sceneIds.length
    ? (await admin
        .from('shots')
        .select('id')
        .in('scene_id', sceneIds)
        .eq('kind', 'live_action')
        .eq('source', 'resource')
        .not('resource_id', 'is', null)).data ?? []
    : [];
  if (ingestShotsRows.length === 0) {
    throw new Error(
      'No resource-pinned live-action shots on this video. Pin an uploaded image/video to a shot in the editor first (2b does not fabricate shots).',
    );
  }
  console.log(`  ${ingestShotsRows.length} resource live-action shot(s).`);

  await inngest.send({ name: 'ingest/run', data: { videoId, accountId } });
  console.log('  Sent ingest/run. Polling for footage_key …');

  const shotIds = ingestShotsRows.map((s) => s.id as string);
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const { data: rows } = await admin
      .from('shots')
      .select('id, footage_key, style_ref_key')
      .in('id', shotIds);
    const done = (rows ?? []).filter((r) => r.footage_key);
    console.log(`  [${i}] ${done.length}/${shotIds.length} conformed`);
    if (done.length === shotIds.length) {
      for (const r of rows ?? []) {
        const footage = r.footage_key ? await signedGetUrl(r.footage_key as string, 600) : null;
        const styleRef = r.style_ref_key ? await signedGetUrl(r.style_ref_key as string, 600) : null;
        console.log(`  shot ${r.id}:`);
        console.log(`    footage=${footage}`);
        console.log(`    styleRef=${styleRef}`);
      }
      console.log('✓ Ingest complete.');
      return;
    }
  }
  throw new Error('Timed out waiting for conform (3 min). Check the Inngest dev server + that the probe Lambda is redeployed.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
