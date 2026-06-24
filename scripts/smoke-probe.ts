// Operator probe smoke (V2 Slice 2a). After redeploying the ffmpeg/ffprobe Lambda, verify
// the probe mode end-to-end: sign a GET for an R2 key, invokeProbe, print the parsed
// ProbeResult. Mirrors drive:remux (operator-run against the real Lambda).
//
// Run: npm run smoke:probe -- <r2-key>
import { signedGetUrl } from '../src/lib/r2';
import { invokeProbe } from '../src/lib/music/remux-invoke';
import { parseProbe } from '../src/lib/ingest/probe';

async function main(): Promise<void> {
  const key = process.argv[2];
  if (!key) throw new Error('Usage: npm run smoke:probe -- <r2-key>');
  const url = await signedGetUrl(key, 600);
  const raw = await invokeProbe(url);
  console.log('raw ffprobe (truncated):', JSON.stringify(raw).slice(0, 400));
  console.log('parsed ProbeResult:', parseProbe(raw));
  console.log('✓ probe ok');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
