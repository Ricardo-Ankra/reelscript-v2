// Headless generation driver (V2 Slice 1b verification). Triggers generateShots against
// the FAKE provider so keyframe → clip → R2 is proven end-to-end without Higgsfield
// creds. Mirrors drive-render.ts.
//
// PREREQUISITE — the Inngest function runs in the dev-server process, so the fake's
// fixture URLs must be in .env.local (NOT set here; a value set in this process would
// not reach the function). Add these two lines to .env.local, then restart the dev
// server + Inngest dev server before running this script:
//
//   GEN_FAKE_STILL_URL=data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQAY3Y2wAAAAAElFTkSuQmCC
//   GEN_FAKE_CLIP_URL=data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDE=
//
// (Trivial bytes — R2 putObject does not validate content; we only prove the round-trip
// + key write. Node 20+ fetch supports data: URLs.)
//
// Run: npm run drive:generation -- <videoId>
import { createAdminClient } from '../src/lib/supabase/admin';
import { inngest } from '../src/lib/inngest/client';
import { signedGetUrl } from '../src/lib/r2';

async function main(): Promise<void> {
  const videoId = process.argv[2];
  if (!videoId) throw new Error('Usage: npm run drive:generation -- <videoId>');
  const admin = createAdminClient();

  const { data: video, error: vErr } = await admin
    .from('videos')
    .select('account_id, title')
    .eq('id', videoId)
    .single();
  if (vErr || !video) throw new Error(`load video: ${vErr?.message ?? 'not found'}`);
  const accountId = video.account_id as string;
  console.log(`Video: "${video.title}" (${videoId})`);

  // 1b does not author shots — script-gen does. Operate on an existing video.
  const { data: scenes } = await admin.from('scenes').select('id').eq('video_id', videoId);
  const sceneIds = (scenes ?? []).map((s) => s.id as string);
  const genShots = sceneIds.length
    ? (await admin.from('shots').select('id').in('scene_id', sceneIds).eq('kind', 'generative')).data ?? []
    : [];
  if (genShots.length === 0) {
    throw new Error(
      'No generative shots on this video. Pick a video whose script-gen produced kind=generative shots (1b does not fabricate them).',
    );
  }
  console.log(`  ${genShots.length} generative shot(s).`);

  if (!process.env.GEN_FAKE_STILL_URL || !process.env.GEN_FAKE_CLIP_URL) {
    console.warn(
      '  ⚠ GEN_FAKE_STILL_URL / GEN_FAKE_CLIP_URL not visible in THIS process. That is fine —\n' +
        '    they must be in the DEV-SERVER .env.local (see this file header). If the run hangs\n' +
        '    with no clip_key, the fake is returning https://fake.local/… which streamUrlToR2\n' +
        '    cannot fetch; add the two data: URLs to .env.local and restart the dev server.',
    );
  }

  await inngest.send({ name: 'generation/run', data: { videoId, accountId } });
  console.log('  Sent generation/run. Polling for clip_key …');

  const shotIds = genShots.map((s) => s.id as string);
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const { data: rows } = await admin
      .from('shots')
      .select('id, keyframe_first_key, clip_key, routed_model')
      .in('id', shotIds);
    const done = (rows ?? []).filter((r) => r.clip_key);
    console.log(`  [${i}] ${done.length}/${shotIds.length} clips ready`);
    if (done.length === shotIds.length) {
      for (const r of rows ?? []) {
        const kf = r.keyframe_first_key ? await signedGetUrl(r.keyframe_first_key as string, 600) : null;
        const clip = r.clip_key ? await signedGetUrl(r.clip_key as string, 600) : null;
        console.log(`  shot ${r.id}: model=${r.routed_model}`);
        console.log(`    keyframe=${kf}`);
        console.log(`    clip=${clip}`);
      }
      console.log('✓ Generation complete.');
      return;
    }
  }
  throw new Error('Timed out waiting for clips (3 min). Check the Inngest dev server + .env.local fixtures.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
