// Seed/verify the starter caption effects through the SAME four authoring gates
// as studio primitives (lint → compile → smoke → brand). One trust class: no
// hand-written exemption. Proves the registry the AnimatedCaptionTrack renderer
// depends on is gate-validated before anything reads it.
//
// Requires AWS (Remotion Lambda) + Anthropic creds (compile/smoke/brand deploy a
// site, render on Lambda, and run a vision QA). The lint gate alone is covered by
// `npm test` (src/lib/captions/effect-probe.test.ts).
//
// Run: npm run seed:effects
import { gateEffect } from '../src/lib/captions/effect-gate';
import { EMPHASIS_EFFECTS } from '../src/lib/captions/types';

async function main(): Promise<void> {
  let allPassed = true;
  for (const name of EMPHASIS_EFFECTS) {
    console.log(`\n▶ ${name}: running gates (lint → compile → smoke → brand)…`);
    const t0 = Date.now();
    const outcome = await gateEffect(name);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    for (const g of outcome.gates) {
      console.log(`   ${g.passed ? '✅' : '❌'} ${g.gate}${g.reason ? ` — ${g.reason}` : ''}`);
    }
    console.log(
      `   ${outcome.passed ? '✅ PASS' : '❌ FAIL'} in ${secs}s` +
        (outcome.frameUrl ? `  | frame: ${outcome.frameUrl}` : ''),
    );
    if (!outcome.passed) allPassed = false;
  }

  if (!allPassed) {
    console.error('\n❌ One or more starter effects failed the gates.');
    process.exit(1);
  }
  console.log(
    `\n✅ All ${EMPHASIS_EFFECTS.length} starter effects pass the same four gates as studio primitives. One trust class.`,
  );
}

main().catch((e) => {
  console.error('\nseed:effects failed:', e);
  process.exit(1);
});
