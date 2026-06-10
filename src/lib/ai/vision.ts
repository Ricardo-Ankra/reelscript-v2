// Pure prompt builders + parsers for the fast Claude-vision calls (Gate-2 smoke-frame
// QA now; channel-resource auto-tagging lands here in step 6). No client/network here:
// the server caller attaches the image and makes the Anthropic call (vision pinned to
// the composition model — Sonnet, spec 8.7 / 11.2). Kept pure so prompts + parsing are
// unit-tested, like the Phase 2/3 generation split.

export interface Gate2Verdict {
  pass: boolean;
  issues: string[];
}

// Strip an accidental ```json fence and isolate the JSON object (same tolerance as
// parseComposition). Returns the candidate string; callers JSON.parse + shape-check.
function stripJsonFences(text: string): string {
  const stripped = text
    .replace(/^[\s\S]*?```(?:json)?\s*/i, (m) => (m.includes('```') ? '' : m))
    .replace(/```[\s\S]*$/i, '')
    .trim();
  return stripped.startsWith('{') ? stripped : text.trim();
}

// A frame is "blank" if its PNG is implausibly small — a solid/empty 9:16 frame
// compresses to a few KB, a real composited frame is far larger. A mechanical
// pre-filter (spec 11.2) that catches a wholly broken render before spending a vision
// call. No pixel decode (avoids an image dependency); the byte floor is the proxy.
export const MIN_SMOKE_FRAME_BYTES = 12_000;

export function frameLooksBlank(sizeInBytes: number, minBytes = MIN_SMOKE_FRAME_BYTES): boolean {
  return sizeInBytes < minBytes;
}

// The vision QA instruction shown alongside the mid-video still. Judges only what is
// visible: broken/blank render, overflowing or illegible text, a frame that doesn't
// match the intended moment. Aesthetic nitpicks are not failures (no auto-fix yet).
export function buildGate2QaPrompt(sceneIntent: string): string {
  return [
    'You are a QA reviewer for an auto-composed short-form video. You are shown ONE',
    'still frame from the middle of the video. Judge ONLY what you can see in the frame.',
    '',
    `Intended content of this moment: ${JSON.stringify(sceneIntent)}`,
    '',
    'Fail the frame if any of these are true:',
    '- It is blank, a solid colour, or obviously a broken / empty render.',
    '- On-screen text is cut off, overflowing the frame edges, or overlapping illegibly.',
    '- Text is unreadable against its background (clashing or low-contrast colours).',
    "- The frame clearly does not match the intended content above.",
    'Otherwise pass it. Minor aesthetic preferences are NOT failures.',
    '',
    'Output ONLY a JSON object, no prose, no markdown fences:',
    '{"pass": true|false, "issues": ["short reason", ...]}',
    '(leave issues empty when pass is true)',
  ].join('\n');
}

// Parse the vision verdict, tolerating accidental ```json fences. Returns null on
// malformed JSON or a missing boolean `pass`.
export function parseGate2Verdict(text: string): Gate2Verdict | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFences(text));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o.pass !== 'boolean') return null;
  const issues = Array.isArray(o.issues) ? o.issues.filter((i): i is string => typeof i === 'string') : [];
  return { pass: o.pass, issues };
}

// --- channel-resource auto-tag (spec 4.3 / 13.5) ---------------------------
//
// One fast Claude-vision call describes + tags an uploaded channel image so the
// composition can later match a resource to a scene intent (and an explicit
// source='resource' shot can skip the stock loop). Pure prompt/parser here; the
// server caller (resources/upload.ts) attaches the image and makes the call.

export interface ResourceTag {
  description: string;
  tags: string[];
}

export function buildResourceTagPrompt(): string {
  return [
    'You are cataloguing a brand/channel image so it can be reused in short-form videos.',
    'Look at the image and return:',
    '- description: ONE concise sentence describing what it shows (used to match the',
    '  image to a scene\'s intent later).',
    '- tags: 3 to 8 short lowercase keywords (subjects, setting, mood, dominant colours).',
    '',
    'Output ONLY a JSON object, no prose, no markdown fences:',
    '{"description": "...", "tags": ["...", "..."]}',
  ].join('\n');
}

export function parseResourceTag(text: string): ResourceTag | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFences(text));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o.description !== 'string') return null;
  const tags = Array.isArray(o.tags) ? o.tags.filter((t): t is string => typeof t === 'string') : [];
  return { description: o.description, tags };
}
