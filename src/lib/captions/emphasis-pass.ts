// Emphasis pass prompts + parsing (caption emphasis revision, 2026-06-16). Pure —
// the Haiku call lives in the server caller (emphasis-annotate.ts), like the
// compose/script split. The model is given the scene's canonical spoken words +
// the scene script and returns emphasis annotations; nothing is trusted until the
// coherence validator runs (here, in the parser), so a bad pass degrades to "no
// emphasis", never an error.
//
// The prompt's rules are DERIVED from the shared constants the validator enforces
// (EMPHASIS_EFFECT_CEILING, INCOHERENT_TONE_EFFECT), so prompt guidance and
// validation cannot drift.
import type { SpokenWord } from './tokenize';
import type { WordEmphasis } from './types';
import { EMPHASIS_EFFECT_CEILING, INCOHERENT_TONE_EFFECT, validateEmphasisCoherence } from './coherence';

export type EmphasisDensity = 'sparing' | 'liberal';

// Effect vocabulary with the meaning that should trigger each (the AI selects by
// meaning). Order follows the EmphasisEffect enum.
const EFFECT_HINTS: Record<string, string> = {
  pop: 'generic emphasis (the default)',
  topple: 'falling / collapse — "drop", "fall", "crash", "plummet"',
  shatter: 'breaking apart — "broken", "shatter", "destroy"',
  shake: 'alarm / instability — "shocking", "danger", "warning"',
  rise: 'upward / growth — "rise", "grow", "boost", "soar"',
  zoom: 'a hard attention hit / shout',
  glitch: 'malfunction / deceit — "lie", "fake", "error"',
};

export function buildEmphasisSystemPrompt(): string {
  const ceilingPct = Math.round(EMPHASIS_EFFECT_CEILING * 100);
  const forbidden = Object.entries(INCOHERENT_TONE_EFFECT)
    .filter(([, tones]) => tones.length > 0)
    .map(([effect, tones]) => `  - never pair effect "${effect}" with tone ${tones.map((t) => `"${t}"`).join(' or ')}`)
    .join('\n');
  const effects = Object.entries(EFFECT_HINTS)
    .map(([name, hint]) => `  - ${name}: ${hint}`)
    .join('\n');

  return [
    'You mark emphasis on the words of a short-form video caption. The caption is shown',
    'word-by-word; your job is to pick the few words that deserve visual emphasis and tag',
    'each with up to three INDEPENDENT axes. Emit LABELS only — never styling values.',
    '',
    'role (REQUIRED on every emphasized word) — drives typography:',
    '  - key: an important term / noun',
    '  - shout: the peak word, a hook or punch',
    '  - contrast: a connective or aside ("or", "but", "really", "that")',
    '  - number: a quantity or numeric value',
    '',
    'tone (optional) — drives colour by sentiment:',
    '  - positive: good / uplifting (rendered green)',
    '  - negative: bad / alarming / dramatic (rendered red)',
    '  - neutral: default (omit tone for neutral)',
    '',
    'effect (optional, RARE) — a meaning-matched entrance animation. Use it for AT MOST',
    `  ~${ceilingPct}% of the emphasized words, and ONLY when the word's MEANING has obvious`,
    '  motion. Choose from:',
    effects,
    '  Forbidden tone↔effect pairings (a contradiction in sentiment):',
    forbidden,
    '',
    'Most emphasized words should carry role + tone only. Pick ACTUAL words by their given',
    'index. Do not emphasize filler. Output ONLY a JSON array, no prose, no markdown fences:',
    '[{"index":N,"role":"key|shout|contrast|number","tone":"positive|negative|neutral","effect":"<name>"}]',
    '(tone and effect are optional; omit them when not needed)',
  ].join('\n');
}

export function buildEmphasisUserPrompt(
  words: SpokenWord[],
  sceneScript: string,
  density: EmphasisDensity,
): string {
  const indexed = words.map((x, i) => `${i}:${x.text}`).join(' ');
  const guidance =
    density === 'liberal'
      ? 'Emphasize LIBERALLY but purposefully — several words per caption may be emphasized.'
      : 'Emphasize SPARINGLY — only the words that truly carry the moment.';
  return [
    `Scene script: ${JSON.stringify(sceneScript)}`,
    '',
    'Spoken words (index:word):',
    indexed,
    '',
    guidance,
  ].join('\n');
}

// Parse the model's annotations, tolerating ```json fences and an {"emphasis":[...]}
// wrapper, then run the coherence validator. Returns [] on anything malformed.
export function parseEmphasisAnnotations(text: string, tokenCount: number): WordEmphasis[] {
  const stripped = text
    .replace(/^[\s\S]*?```(?:json)?\s*/i, (m) => (m.includes('```') ? '' : m))
    .replace(/```[\s\S]*$/i, '')
    .trim();
  const start = stripped.search(/[[{]/);
  const candidate = start >= 0 ? stripped.slice(start) : text.trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return [];
  }
  const arr = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { emphasis?: unknown }).emphasis)
      ? (parsed as { emphasis: unknown[] }).emphasis
      : null;
  if (!arr) return [];

  // Coerce to the raw WordEmphasis shape; the validator does the real cleaning.
  const raw = arr
    .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
    .map((e) => ({
      index: e.index as number,
      role: e.role as WordEmphasis['role'],
      tone: e.tone as WordEmphasis['tone'],
      effect: e.effect as WordEmphasis['effect'],
    }));
  return validateEmphasisCoherence(raw, tokenCount);
}
