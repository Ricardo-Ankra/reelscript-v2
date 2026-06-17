import 'server-only';
import { lintPrimitive, formatLintFeedback } from './lint';
import { generateSampleProps } from './sample-props';
import { bundleGateSite, renderGateStill } from './bundle';
import { STRESS_THEMES, stressProps } from './stress-kit';
import { anthropic, COMPOSITION_MODEL } from '../ai/anthropic';
import { buildBrandQaPrompt, parseGate2Verdict } from '../ai/vision';
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
  colors: { background: '#0B1F3A', foreground: '#FFFFFF', primary: '#3B82F6', secondary: '#1E3A8A', accent: '#F59E0B', bodyText: '#E2E8F0', positive: '#22C55E', negative: '#EF4444' },
  fonts: { display: 'Poppins', body: 'Poppins', mono: 'monospace' },
  logos: {},
  motion: 'standard',
};

export async function runGates(input: {
  code: string;
  propSchema: PropSchema;
  theme?: Theme;
  // The brand-gate QA rubric. Defaults to the primitive prompt; the caption-effect
  // seeder passes an animation-aware variant (transient split/scale is intentional).
  brandPrompt?: (stressName: string) => string;
}): Promise<GatesOutcome> {
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

  // 3. Smoke — render default sample props on Lambda; not-blank check. A render error
  // (e.g. an unresolved <Img>) FAILS the gate gracefully — it never crashes the run, so
  // the bounded auto-fix loop gets the reason to fix.
  try {
    let still: Awaited<ReturnType<typeof renderGateStill>>;
    try {
      still = await renderGateStill(site.serveUrl);
    } catch (e) {
      gates.push({ gate: 'smoke', passed: false, reason: `Render error: ${(e as Error).message.slice(0, 500)}` });
      return { passed: false, gates };
    }
    if (still.blank) {
      gates.push({ gate: 'smoke', passed: false, reason: 'Rendered frame is blank — the primitive drew nothing.' });
      return { passed: false, gates, frameUrl: still.frameUrl };
    }
    gates.push({ gate: 'smoke', passed: true });

    // 4. Brand integration — render the SAME bundle against the extreme stress kit with
    // overflowing text + vision-check each for overflow/clipping/clash (spec 9.6).
    let brand: { result: GateResult; frameUrl?: string };
    try {
      brand = await runBrandGate(site.serveUrl, input.propSchema, input.brandPrompt ?? buildBrandQaPrompt);
    } catch (e) {
      gates.push({ gate: 'brand', passed: false, reason: `Render error under the stress kit: ${(e as Error).message.slice(0, 500)}` });
      return { passed: false, gates, frameUrl: still.frameUrl };
    }
    gates.push(brand.result);
    return { passed: brand.result.passed, gates, frameUrl: brand.frameUrl ?? still.frameUrl };
  } finally {
    await site.cleanup();
  }
}

// Render the candidate against each stress theme (same bundle, override inputProps) and
// vision-QA the frame. First failure short-circuits with its frame + reason.
async function runBrandGate(
  serveUrl: string,
  schema: PropSchema,
  brandPrompt: (stressName: string) => string,
): Promise<{ result: GateResult; frameUrl?: string }> {
  const props = stressProps(schema);
  for (const { name, theme } of STRESS_THEMES) {
    const still = await renderGateStill(serveUrl, { props, theme });
    if (still.blank) {
      return { result: { gate: 'brand', passed: false, reason: `Blank under the "${name}" stress kit.` }, frameUrl: still.frameUrl };
    }
    const verdict = await visionQa(still.frameUrl, brandPrompt(name));
    if (verdict && !verdict.pass) {
      return {
        result: { gate: 'brand', passed: false, reason: `Failed the "${name}" stress kit: ${verdict.issues.join('; ') || 'overflow/clipping'}` },
        frameUrl: still.frameUrl,
      };
    }
  }
  return { result: { gate: 'brand', passed: true } };
}

// One Claude-vision QA pass on a rendered frame (download → base64 → vision). An
// unparseable verdict passes by default (don't fail an authoring run on a parser hiccup).
async function visionQa(frameUrl: string, prompt: string): Promise<{ pass: boolean; issues: string[] } | null> {
  const res = await fetch(frameUrl);
  if (!res.ok) return null;
  const b64 = Buffer.from(await res.arrayBuffer()).toString('base64');
  const msg = await anthropic().messages.create({
    model: COMPOSITION_MODEL,
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } },
          { type: 'text', text: prompt },
        ],
      },
    ],
  });
  const text = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  return parseGate2Verdict(text);
}
