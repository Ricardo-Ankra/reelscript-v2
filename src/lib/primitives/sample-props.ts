import type { PropSchema, PropDef } from './contract';
import { validationSchema } from './contract';

// Generate sample props from a prop schema (Phase 7) — drives the studio preview and the
// smoke gate so neither has to invent props. Prefers a prop's declared default; otherwise
// a sensible per-type sample. Fills active + deprecated (the validation view), so the
// component receives every prop it might read.
//
// Pure + tested. Numbers without a default are ambiguous (size? percent?), so a
// well-authored primitive should declare defaults — the skill encourages it.
function sampleFor(def: PropDef): unknown {
  if (def.default !== undefined) return def.default;
  switch (def.type) {
    case 'string':
      return sampleString(def.name);
    case 'number':
      return 1;
    case 'boolean':
      return true;
    case 'enum':
      return def.enumValues?.[0] ?? '';
    case 'token':
      return def.tokenGroup === 'fonts' ? 'display' : 'accent';
    case 'asset':
      return 'sample-asset';
    default:
      return undefined;
  }
}

// A readable string sample, lightly hinted by the prop name so the preview looks real.
function sampleString(name: string): string {
  const n = name.toLowerCase();
  if (n.includes('label') || n.includes('caption')) return 'Sample label';
  if (n.includes('value') || n.includes('stat') || n.includes('number')) return '73%';
  if (n.includes('title') || n.includes('heading')) return 'Sample Title';
  return 'Sample text';
}

export function generateSampleProps(schema: PropSchema): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const def of validationSchema(schema)) {
    const v = sampleFor(def);
    if (v !== undefined) props[def.name] = v;
  }
  return props;
}
