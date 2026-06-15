// Primitive drafting prompts + parsing (Phase 7, spec 9.5). Pure — the Opus call lives
// in the server action, like the compose/script split. The drafting model is given the
// primitive skill and returns a single JSON envelope { meta, propSchema, code }; nothing
// is saved or trusted here — the gates gate.
import type { PropSchema, PrimitiveMeta } from '../primitives/contract';
import { PRIMITIVE_SKILL } from '../primitives/skill';

export interface DraftResult {
  code: string;
  proposedSchema: PropSchema;
  meta: PrimitiveMeta;
}

export function buildDraftSystemPrompt(): string {
  return [
    PRIMITIVE_SKILL,
    '',
    '---',
    'Output ONLY a single JSON object, no prose, no markdown fences:',
    '{"meta":{"name":"PascalCaseName","description":"one sentence","version":1},',
    ' "propSchema":[ ...PropDef objects... ],',
    ' "code":"<the full TSX source as a JSON string>"}',
    'The code MUST default-export the component and obey every rule above so it passes the gates first try.',
  ].join('\n');
}

export function buildDraftUserPrompt(input: {
  instruction: string;
  currentCode?: string;
  currentSchema?: PropSchema;
  feedback?: string;
}): string {
  const parts: string[] = [];
  if (input.currentCode) {
    parts.push('You are REFINING an existing primitive. Current code:');
    parts.push('```tsx');
    parts.push(input.currentCode);
    parts.push('```');
    if (input.currentSchema) parts.push(`Current propSchema: ${JSON.stringify(input.currentSchema)}`);
    parts.push('');
  }
  parts.push(`Request: ${input.instruction}`);
  if (input.feedback) {
    parts.push('');
    parts.push(`The previous attempt failed the gates:\n${input.feedback}\nFix it and return the corrected JSON.`);
  }
  return parts.join('\n');
}

// Parse the JSON envelope, tolerating accidental ```json fences (same tolerance as
// parseComposition). Returns null on malformed JSON or a missing code/schema.
export function parseDraft(text: string): DraftResult | null {
  const stripped = text
    .replace(/^[\s\S]*?```(?:json)?\s*/i, (m) => (m.includes('```') ? '' : m))
    .replace(/```[\s\S]*$/i, '')
    .trim();
  const candidate = stripped.startsWith('{') ? stripped : text.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o.code !== 'string' || !o.code.trim()) return null;
  if (!Array.isArray(o.propSchema)) return null;
  const meta = o.meta as Partial<PrimitiveMeta> | undefined;
  if (!meta || typeof meta.name !== 'string') return null;
  return {
    code: o.code,
    proposedSchema: o.propSchema as PropSchema,
    meta: { name: meta.name, description: meta.description ?? '', version: typeof meta.version === 'number' ? meta.version : 1 },
  };
}
