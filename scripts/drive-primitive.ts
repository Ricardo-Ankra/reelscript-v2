// Headless Phase 7 E2E: author a primitive by describing it → gates → save → deploy →
// the composition AI can use it. Mirrors the studio's server actions + the
// primitive/deploy job with the admin client (like drive-render), so it proves the whole
// milestone backend without the UI or the dev stack.
//
// Run: npm run drive:primitive -- "a labelled progress bar that fills to a percent"
import { createAdminClient } from '../src/lib/supabase/admin';
import { anthropic, PRIMITIVE_DRAFT_MODEL } from '../src/lib/ai/anthropic';
import { buildDraftSystemPrompt, buildDraftUserPrompt, parseDraft } from '../src/lib/ai/primitive-draft';
import { lintPrimitive } from '../src/lib/primitives/lint';
import { runGates } from '../src/lib/primitives/gates';
import { deployLiveSite } from '../src/lib/primitives/bundle';
import { loadComposeRegistry } from '../src/lib/primitives/registry-load';
import { buildCompositionSystemPrompt } from '../src/lib/composition/compose';

async function main(): Promise<void> {
  const instruction = process.argv[2] ?? 'a labelled progress bar that fills to a given percent';
  const admin = createAdminClient();

  const { data: channel } = await admin.from('channels').select('id, account_id, name').order('created_at').limit(1).single();
  if (!channel) throw new Error('no channel');
  const accountId = channel.account_id as string;
  console.log(`Account ${accountId} (channel "${channel.name}")`);

  // 1. Draft with Opus + the primitive skill.
  console.log(`\n1) drafting: "${instruction}"`);
  const msg = await anthropic().messages.create({
    model: PRIMITIVE_DRAFT_MODEL,
    max_tokens: 16000,
    system: buildDraftSystemPrompt(),
    messages: [{ role: 'user', content: buildDraftUserPrompt({ instruction }) }],
  });
  const text = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  const draft = parseDraft(text);
  if (!draft) throw new Error('draft did not parse as a primitive envelope');
  console.log(`   → ${draft.meta.name}: ${draft.meta.description}`);
  console.log(`   props: ${draft.proposedSchema.map((p) => p.name).join(', ')}`);

  // 2. Lint preview + the full gates (lint → compile → smoke on Lambda).
  const lint = lintPrimitive(draft.code);
  console.log(`\n2) lint: ${lint.ok ? 'clean' : lint.violations.length + ' violations'}`);
  console.log('   running gates (compile + smoke on Lambda)…');
  const gates = await runGates({ code: draft.code, propSchema: draft.proposedSchema });
  for (const g of gates.gates) console.log(`   ${g.passed ? '✓' : '✗'} ${g.gate}${g.reason ? ' — ' + g.reason.slice(0, 120) : ''}`);
  if (!gates.passed) {
    console.error(`\n❌ gates failed${gates.failingFrameUrl ? ' (frame: ' + gates.failingFrameUrl + ')' : ''}`);
    process.exit(1);
  }

  // 3. Save (insert the primitive; new primitive so no schema-evolution check).
  console.log(`\n3) saving "${draft.meta.name}"…`);
  await admin.from('primitives').delete().eq('account_id', accountId).eq('name', draft.meta.name); // idempotent re-runs
  const { data: saved, error } = await admin
    .from('primitives')
    .insert({ account_id: accountId, name: draft.meta.name, description: draft.meta.description, code: draft.code, prop_schema: draft.proposedSchema, version: 1, status: 'active' })
    .select('id')
    .single();
  if (error || !saved) throw new Error(`save: ${error?.message}`);

  // 4. Deploy the live site (mirrors primitive/deploy) + mark deployed.
  console.log('4) re-bundling the live site with the new primitive…');
  const { data: actives } = await admin.from('primitives').select('id, name, code, version').eq('account_id', accountId).eq('status', 'active');
  const t0 = Date.now();
  await deployLiveSite((actives ?? []).map((p) => ({ name: p.name as string, code: p.code as string })));
  for (const p of actives ?? []) await admin.from('primitives').update({ deployed_version: p.version }).eq('id', p.id);
  console.log(`   deployed in ${((Date.now() - t0) / 1000).toFixed(1)}s (${actives?.length} active primitives in the bundle)`);

  // 5. Confirm the composition AI is now offered it.
  const registry = await loadComposeRegistry(admin, accountId);
  const offered = draft.meta.name in registry;
  const prompt = buildCompositionSystemPrompt(registry);
  const inPrompt = prompt.includes(draft.meta.name);
  console.log(`\n5) compose registry includes "${draft.meta.name}": ${offered}`);
  console.log(`   composition system prompt lists it: ${inPrompt}`);

  if (offered && inPrompt) {
    console.log('\n✅ MILESTONE: described → drafted → passed gates → saved → deployed → the composition AI can place it.');
  } else {
    console.error('\n❌ primitive deployed but not offered to compose.');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('\ndrive-primitive failed:', e);
  process.exit(1);
});
