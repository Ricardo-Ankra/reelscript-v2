import ts from 'typescript';
import { IMPORT_WHITELIST } from './contract';

// Lint gate (Phase 7, spec 9.6) — the SECURITY BOUNDARY. A static AST check of the
// primitive contract (the rules documented in contract.ts §7, made executable). Runs
// first and is safe anywhere (no execution). Untrusted code only ever *executes* in the
// Lambda sandbox; this gate is what keeps `fetch`/`eval`/non-whitelist imports out of it.
//
// Pure (parses with the TS compiler, no network/secrets) so it is unit-tested and runs
// in ms. Errs toward REJECT (false-positives over false-negatives) — a security gate.

export interface LintViolation {
  rule: string;
  detail: string;
  line: number;
}
export interface LintResult {
  ok: boolean;
  violations: LintViolation[];
}

// Exact property-access chains that are nondeterministic / wall-clock.
const BANNED_MEMBER = new Map<string, string>([
  ['Math.random', 'Math.random() is nondeterministic — derive motion from useCurrentFrame().'],
  ['Date.now', 'Date.now() is wall-clock time — derive motion from useCurrentFrame().'],
  ['performance.now', 'performance.now() is wall-clock time — use useCurrentFrame().'],
]);
// Bare identifiers that mean network / IO / escape hatches.
const BANNED_IDENT = new Map<string, string>([
  ['fetch', 'Network access (fetch) is forbidden in a primitive.'],
  ['XMLHttpRequest', 'Network access (XMLHttpRequest) is forbidden.'],
  ['eval', 'eval is forbidden.'],
  ['require', 'require() is forbidden — use a whitelisted import.'],
]);
// Raw media tags — primitives must use Remotion's <Img>/<OffthreadVideo>.
const RAW_MEDIA = new Map<string, string>([
  ['img', 'Use Remotion <Img>, not a raw <img>.'],
  ['video', 'Use Remotion <OffthreadVideo>, not a raw <video>.'],
]);
const COLOR_RE = /#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla)\s*\(/;
const FRAME_DIMS = new Set([1080, 1920]); // hardcoded frame dimensions → useVideoConfig()

export function lintPrimitive(code: string): LintResult {
  const sf = ts.createSourceFile('Candidate.tsx', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const violations: LintViolation[] = [];
  const lineOf = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const push = (rule: string, detail: string, node: ts.Node) => violations.push({ rule, detail, line: lineOf(node) });

  const visit = (node: ts.Node): void => {
    // Import whitelist (the security-critical rule).
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const m = node.moduleSpecifier.text;
      const allowed = IMPORT_WHITELIST.some((w) => m === w || m.startsWith(w + '/'));
      if (!allowed) push('import', `Import "${m}" is not on the whitelist (${IMPORT_WHITELIST.join(', ')}).`, node);
    }
    // Dynamic import().
    if (node.kind === ts.SyntaxKind.ImportKeyword && node.parent && ts.isCallExpression(node.parent) && node.parent.expression === node) {
      push('dynamic-import', 'Dynamic import() is forbidden.', node.parent);
    }
    // new Date()
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Date') {
      push('nondeterministic', 'new Date() is wall-clock time — derive motion from useCurrentFrame().', node);
    }
    // Banned member chains (Math.random, Date.now, performance.now).
    if (ts.isPropertyAccessExpression(node)) {
      const why = BANNED_MEMBER.get(node.getText(sf));
      if (why) push('nondeterministic', why, node);
    }
    // Banned bare identifiers (fetch/eval/require/XHR), when not a member name.
    if (ts.isIdentifier(node) && BANNED_IDENT.has(node.text)) {
      const isMemberName = ts.isPropertyAccessExpression(node.parent) && node.parent.name === node;
      const isDeclName =
        (ts.isVariableDeclaration(node.parent) || ts.isParameter(node.parent) || ts.isFunctionDeclaration(node.parent)) &&
        (node.parent as { name?: ts.Node }).name === node;
      if (!isMemberName && !isDeclName) push('forbidden-call', BANNED_IDENT.get(node.text)!, node);
    }
    // Raw <img>/<video> JSX tags.
    const tag =
      ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node) ? node.tagName.getText(sf) : undefined;
    if (tag && RAW_MEDIA.has(tag)) push('raw-media', RAW_MEDIA.get(tag)!, node);
    // Hardcoded colours.
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && COLOR_RE.test(node.text)) {
      push('hardcoded-color', `Hardcoded colour ${JSON.stringify(node.text)} — read it from useTheme().`, node);
    }
    // Hardcoded frame dimensions.
    if (ts.isNumericLiteral(node) && FRAME_DIMS.has(Number(node.text))) {
      push('hardcoded-dimension', `Hardcoded frame dimension ${node.text} — read useVideoConfig().`, node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  return { ok: violations.length === 0, violations };
}

// One-line summary for the gate result / auto-fix feedback.
export function formatLintFeedback(violations: LintViolation[]): string {
  return violations.map((v) => `- [${v.rule}] line ${v.line}: ${v.detail}`).join('\n');
}
