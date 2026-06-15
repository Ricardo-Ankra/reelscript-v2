// Inspect a finished render's Phase-6 artifacts: the durable spec's captions +
// KineticText instances, the SRT/VTT sidecars in R2, and the cost ledger.
// Run: npm run inspect:render -- <renderId>
import { createAdminClient } from '../src/lib/supabase/admin';
import { signedGetUrl } from '../src/lib/r2';
import type { CompositionSpec } from '../src/lib/composition/spec';

async function head(key: string): Promise<string> {
  try {
    const url = await signedGetUrl(key, 120);
    const res = await fetch(url);
    if (!res.ok) return `MISSING (${res.status})`;
    const len = res.headers.get('content-length');
    return `OK (${len ?? '?'} bytes)`;
  } catch (e) {
    return `ERR ${(e as Error).message}`;
  }
}

async function main(): Promise<void> {
  const renderId = process.argv[2];
  if (!renderId) throw new Error('Usage: npm run inspect:render -- <renderId>');
  const admin = createAdminClient();

  const { data: r } = await admin
    .from('renders')
    .select('composition_spec_r2_key, output_r2_key, base_output_r2_key, account_id')
    .eq('id', renderId)
    .single();
  if (!r?.composition_spec_r2_key) throw new Error('no spec key on render');

  const specUrl = await signedGetUrl(r.composition_spec_r2_key as string, 120);
  const spec = (await (await fetch(specUrl)).json()) as CompositionSpec;

  const kinetic: { scene: number; text: string; animation: unknown; position: unknown }[] = [];
  spec.scenes.forEach((s, i) => {
    for (const inst of s.instances) {
      if (inst.primitive === 'KineticText') {
        kinetic.push({ scene: i, text: String(inst.props.text), animation: inst.props.animation, position: inst.props.position });
      }
    }
  });

  console.log(`\n=== Render ${renderId} ===`);
  console.log(`scenes: ${spec.scenes.length}, durationInFrames: ${spec.metadata.durationInFrames} @ ${spec.metadata.fps}fps`);
  console.log(`\nCAPTIONS (burnt track): ${spec.captions?.length ?? 0} segments`);
  (spec.captions ?? []).slice(0, 4).forEach((c) => console.log(`  [${c.fromFrame}-${c.toFrame}] ${c.text}`));
  console.log(`captionStyle: ${JSON.stringify(spec.captionStyle ?? '(theme defaults)')}`);

  console.log(`\nKINETIC TEXT: ${kinetic.length} instance(s)`);
  kinetic.forEach((k) => console.log(`  scene ${k.scene}: "${k.text}" — ${k.animation} @ ${k.position}`));

  console.log(`\nSIDECARS:`);
  console.log(`  captions/${renderId}.srt → ${await head(`captions/${renderId}.srt`)}`);
  console.log(`  captions/${renderId}.vtt → ${await head(`captions/${renderId}.vtt`)}`);
  console.log(`  ${r.output_r2_key} → ${await head(r.output_r2_key as string)}`);

  const { data: costs } = await admin
    .from('cost_events')
    .select('operation, provider, units, cost_usd')
    .eq('render_id', renderId)
    .order('created_at');
  console.log(`\nCOST EVENTS:`);
  for (const c of costs ?? []) console.log(`  ${c.operation} (${c.provider}): ${c.units} units, $${Number(c.cost_usd).toFixed(5)}`);
}

main().catch((e) => {
  console.error('inspect failed:', e);
  process.exit(1);
});
