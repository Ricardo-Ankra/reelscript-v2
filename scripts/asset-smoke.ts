// Phase 5 — step-2 smoke proof: a hand-written composition spec that references a
// REAL downloaded stock IMAGE and VIDEO renders on Lambda through the new
// Image/Video primitives (+ the attribution overlay). Throwaway harness — it does
// not touch the DB or Inngest; it exercises the real adapters, R2, signing, and the
// Lambda spine end to end so we know the primitives render before building the
// agentic loop on top of them.
//
// Run: npm run smoke:assets   (needs PEXELS/PIXABAY keys + AWS/R2/Remotion env)
import {
  renderMediaOnLambda,
  getRenderProgress,
  type AwsRegion,
} from '@remotion/lambda/client';
import { serverEnv } from '../src/lib/env.server';
import { searchPexels } from '../src/lib/assets/pexels';
import { searchPixabay } from '../src/lib/assets/pixabay';
import { putObject, signedGetUrl } from '../src/lib/r2';
import type { StockCandidate, StockKind } from '../src/lib/assets/candidate';
import type { CompositionSpec } from '../src/lib/composition/spec';

// Prefer Pexels, fall back to Pixabay; first candidate with usable URLs wins.
async function pick(kind: StockKind, query: string): Promise<StockCandidate> {
  for (const search of [searchPexels, searchPixabay]) {
    const cands = await search({ query, kind, orientation: 'portrait' }).catch(() => [] as StockCandidate[]);
    const hit = cands.find((c) => c.downloadUrl && c.thumbnailUrl);
    if (hit) return hit;
  }
  throw new Error(`No ${kind} candidate found for "${query}"`);
}

function extFor(url: string, kind: StockKind): string {
  const m = url.split('?')[0].match(/\.(jpg|jpeg|png|webp|mp4)$/i);
  if (m) return m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
  return kind === 'video' ? 'mp4' : 'jpg';
}

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${res.status}: ${url.slice(0, 100)}`);
  return Buffer.from(await res.arrayBuffer());
}

async function main(): Promise<void> {
  console.log('1) searching stock (Pexels → Pixabay)…');
  const img = await pick('image', 'mountain sunrise landscape');
  const vid = await pick('video', 'ocean waves slow motion');
  console.log(`   image: ${img.assetId} — ${img.attribution}`);
  console.log(`   video: ${vid.assetId} — ${vid.attribution}`);

  console.log('2) downloading bytes + uploading to R2…');
  const imgKey = `smoke/${img.assetId}.${extFor(img.downloadUrl, 'image')}`;
  const vidKey = `smoke/${vid.assetId}.${extFor(vid.downloadUrl, 'video')}`;
  const imgBytes = await download(img.downloadUrl);
  const vidBytes = await download(vid.downloadUrl);
  await putObject(imgKey, imgBytes, 'image/jpeg');
  await putObject(vidKey, vidBytes, 'video/mp4');
  console.log(`   image ${(imgBytes.length / 1024).toFixed(0)}KB → ${imgKey}`);
  console.log(`   video ${(vidBytes.length / 1024 / 1024).toFixed(1)}MB → ${vidKey}`);

  console.log('3) signing + building the spec…');
  const [imgUrl, vidUrl] = await Promise.all([
    signedGetUrl(imgKey, 6 * 3600),
    signedGetUrl(vidKey, 6 * 3600),
  ]);
  const theme = {
    colors: { background: '#0B1F3A', foreground: '#FFFFFF', primary: '#3B82F6', secondary: '#1E3A8A', accent: '#F59E0B', bodyText: '#E2E8F0' },
    fonts: { display: 'Poppins', body: 'Poppins', mono: 'monospace' },
    logos: {},
    motion: 'standard',
  } as unknown as CompositionSpec['theme'];

  const spec: CompositionSpec = {
    version: 2,
    metadata: { width: 1080, height: 1920, fps: 30, durationInFrames: 180 },
    theme,
    assets: [
      { id: img.assetId, kind: 'image', r2Key: imgKey, url: imgUrl, attribution: img.attribution },
      { id: vid.assetId, kind: 'video', r2Key: vidKey, url: vidUrl, attribution: vid.attribution },
    ],
    scenes: [
      {
        id: 'scene-img',
        durationInFrames: 90,
        instances: [
          { primitive: 'Image', props: { asset: img.assetId, fit: 'cover', pan: true }, layer: 0, startFrame: 0, durationInFrames: 90 },
          { primitive: 'Text', props: { text: 'Image primitive', colorToken: 'foreground', fontSizePx: 96, align: 'center' }, layer: 1, startFrame: 6, durationInFrames: 84 },
        ],
      },
      {
        id: 'scene-vid',
        durationInFrames: 90,
        instances: [
          { primitive: 'Video', props: { asset: vid.assetId, fit: 'cover', mute: true }, layer: 0, startFrame: 0, durationInFrames: 90 },
          { primitive: 'Text', props: { text: 'Video primitive', colorToken: 'foreground', fontSizePx: 96, align: 'center' }, layer: 1, startFrame: 6, durationInFrames: 84 },
        ],
      },
    ],
  };

  const specKey = 'smoke/asset-smoke-spec.render.json';
  await putObject(specKey, JSON.stringify(spec), 'application/json');
  const specUrl = await signedGetUrl(specKey, 6 * 3600);

  console.log('4) rendering on Lambda…');
  const region = serverEnv.aws.region as AwsRegion;
  const functionName = serverEnv.remotion.functionName;
  const { renderId, bucketName } = await renderMediaOnLambda({
    region,
    functionName,
    serveUrl: serverEnv.remotion.serveUrl,
    composition: 'Reel',
    inputProps: { specUrl },
    codec: 'h264',
    privacy: 'private',
    framesPerLambda: 90,
  });
  console.log(`   lambda renderId: ${renderId}`);

  for (let i = 0; i < 150; i++) {
    const p = await getRenderProgress({ renderId, bucketName, functionName, region });
    if (p.fatalErrorEncountered) throw new Error(`Lambda fatal error: ${JSON.stringify(p.errors)}`);
    if (p.done && p.outputFile) {
      const out = await download(p.outputFile);
      console.log(`\n✅ DONE — MP4 ${(out.length / 1024 / 1024).toFixed(2)}MB rendered on Lambda`);
      console.log(`   outputFile: ${p.outputFile}`);
      console.log(`   render cost: $${(p.costs?.accruedSoFar ?? 0).toFixed(4)}`);
      return;
    }
    process.stdout.write(`\r   progress ${((p.overallProgress ?? 0) * 100).toFixed(0)}%   `);
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error('Lambda render timed out');
}

main().catch((e) => {
  console.error('\nsmoke failed:', e);
  process.exit(1);
});
