import 'server-only';
import { lintPrimitive, formatLintFeedback } from './lint';
import { generateSampleProps } from './sample-props';
import { bundleGateSite, renderGateStill } from './bundle';
import type { PropSchema, Theme } from './contract';

// Authoring gate orchestration (Phase 7, spec 9.6). Lint (static, the security boundary)
// runs first; if it passes, the candidate is bundled (compile) and rendered with sample
// props on the isolated Lambda (smoke). The brand stress-kit gate is Phase-7 step 2.
//
// "compile" = the bundle succeeding — it surfaces syntax/import/resolution errors before
// the expensive render, and the bundle is what smoke then renders.

export type GateName = 'lint' | 'compile' | 'smoke' | 'brand';
export interface GateResult {
  gate: GateName;
  passed: boolean;
  reason?: string;
}
export interface GatesOutcome {
  passed: boolean;
  gates: GateResult[];
  // The smoke-gate still — present whenever smoke ran (pass OR fail). Doubles as the
  // studio preview, so no in-browser compiler is needed.
  frameUrl?: string;
}

// A neutral brand kit to render the gate against (the brand stress kit is step 2).
const DEFAULT_GATE_THEME: Theme = {
  colors: { background: '#0B1F3A', foreground: '#FFFFFF', primary: '#3B82F6', secondary: '#1E3A8A', accent: '#F59E0B', bodyText: '#E2E8F0' },
  fonts: { display: 'Poppins', body: 'Poppins', mono: 'monospace' },
  logos: {},
  motion: 'standard',
};

export async function runGates(input: { code: string; propSchema: PropSchema; theme?: Theme }): Promise<GatesOutcome> {
  const gates: GateResult[] = [];

  // 1. Lint — static AST (server, safe). The security boundary; stop here on failure.
  const lint = lintPrimitive(input.code);
  gates.push({ gate: 'lint', passed: lint.ok, reason: lint.ok ? undefined : formatLintFeedback(lint.violations) });
  if (!lint.ok) return { passed: false, gates };

  const theme = input.theme ?? DEFAULT_GATE_THEME;
  const sampleProps = generateSampleProps(input.propSchema);

  // 2. Compile — bundle the candidate into an isolated site.
  let site: Awaited<ReturnType<typeof bundleGateSite>>;
  try {
    site = await bundleGateSite(input.code, sampleProps, theme);
    gates.push({ gate: 'compile', passed: true });
  } catch (e) {
    gates.push({ gate: 'compile', passed: false, reason: `Bundle/compile failed: ${(e as Error).message.slice(0, 600)}` });
    return { passed: false, gates };
  }

  // 3. Smoke — render sample props on Lambda; not-blank check. The frame is returned
  // either way (pass = preview, fail = the failing frame).
  try {
    const still = await renderGateStill(site.serveUrl);
    if (still.blank) {
      gates.push({ gate: 'smoke', passed: false, reason: 'Rendered frame is blank — the primitive drew nothing.' });
      return { passed: false, gates, frameUrl: still.frameUrl };
    }
    gates.push({ gate: 'smoke', passed: true });
    return { passed: true, gates, frameUrl: still.frameUrl };
  } finally {
    await site.cleanup();
  }
}
