// Phase 7 step-1 de-risk: prove a primitive CODE STRING bundles into a Remotion site
// and renders a non-blank still on Lambda (the studio's central capability — smoke gate
// + live re-bundle both rest on this). Throwaway harness; no DB, no studio.
//
// Run: npm run smoke:primitive
import { bundleGateSite, renderGateStill } from '../src/lib/primitives/bundle';
import type { Theme } from '../src/lib/primitives/contract';

// A hand-written candidate primitive (a labelled progress bar) — obeys the contract:
// colours/fonts from useTheme, motion from useCurrentFrame, whitelist imports only.
const CODE = `import { AbsoluteFill, useCurrentFrame, interpolate } from 'remotion';
import { useTheme } from './theme';

export default function ProgressBar({ label, percent }: { label: string; percent: number }) {
  const theme = useTheme();
  const frame = useCurrentFrame();
  const w = interpolate(frame, [0, 20], [0, percent], { extrapolateRight: 'clamp' });
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ width: '70%' }}>
        <div style={{ fontFamily: theme.fonts.display, color: theme.colors.foreground, fontSize: 56, marginBottom: 20 }}>{label}</div>
        <div style={{ height: 44, background: theme.colors.secondary, borderRadius: 22, overflow: 'hidden' }}>
          <div style={{ width: w + '%', height: '100%', background: theme.colors.accent }} />
        </div>
      </div>
    </AbsoluteFill>
  );
}
`;

const THEME: Theme = {
  colors: { background: '#0B1F3A', foreground: '#FFFFFF', primary: '#3B82F6', secondary: '#1E3A8A', accent: '#F59E0B', bodyText: '#E2E8F0' },
  fonts: { display: 'Poppins', body: 'Poppins', mono: 'monospace' },
  logos: {},
  motion: 'standard',
};

async function main(): Promise<void> {
  console.log('1) bundling candidate primitive into an isolated gate site…');
  const t0 = Date.now();
  const site = await bundleGateSite(CODE, { label: 'Progress', percent: 70 }, THEME);
  console.log(`   deployed in ${((Date.now() - t0) / 1000).toFixed(1)}s → ${site.serveUrl}`);

  console.log('2) rendering a still on Lambda…');
  const t1 = Date.now();
  const r = await renderGateStill(site.serveUrl);
  console.log(`   rendered in ${((Date.now() - t1) / 1000).toFixed(1)}s`);
  console.log(`   blank: ${r.blank}  |  cost $${r.costUsd.toFixed(4)}`);
  console.log(`   frame: ${r.frameUrl}`);

  await site.cleanup();
  if (r.blank) {
    console.error('\n❌ Frame is blank — the candidate did not render.');
    process.exit(1);
  }
  console.log('\n✅ DONE — a code-string primitive bundled + rendered on Lambda. Spine works.');
}

main().catch((e) => {
  console.error('\nprimitive bundle smoke failed:', e);
  process.exit(1);
});
