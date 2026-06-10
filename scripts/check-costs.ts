// Throwaway step-8 verification: inspect the latest render + its cost_events and
// whether its stored spec references real media. Run:
//   node --env-file=.env.local --experimental-strip-types \
//     --import ./scripts/register-smoke-loader.mjs scripts/check-costs.ts
import { createAdminClient } from '../src/lib/supabase/admin';
import { signedGetUrl } from '../src/lib/r2';

const admin = createAdminClient();

const { data: render, error } = await admin
  .from('renders')
  .select('id, status, created_at, composition_spec_r2_key, output_r2_key, error')
  .order('created_at', { ascending: false })
  .limit(1)
  .single();
if (error || !render) throw new Error(`no render: ${error?.message}`);
console.log('latest render:', { id: render.id, status: render.status, hasOutput: !!render.output_r2_key, error: render.error });

const { data: costs } = await admin
  .from('cost_events')
  .select('operation, provider, units, cost_usd')
  .eq('render_id', render.id)
  .order('created_at');
console.log('cost_events:');
for (const c of costs ?? []) console.log(`  ${c.operation} (${c.provider}) units=${c.units} $${c.cost_usd}`);

// Confirm the durable spec referenced real image/video assets (stock-rich, not procedural).
if (render.composition_spec_r2_key) {
  const url = await signedGetUrl(render.composition_spec_r2_key as string, 300);
  const spec = await (await fetch(url)).json();
  const media = (spec.assets ?? []).filter((a: { kind: string }) => a.kind === 'image' || a.kind === 'video');
  console.log(`media assets in spec: ${media.length}`);
  for (const a of media) console.log(`  ${a.kind} ${a.id} — ${a.attribution ?? '(no attribution)'}`);
}
