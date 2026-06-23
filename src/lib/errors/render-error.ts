// A normalized composition-/render-error shape for display. The pipeline writes
// either a structured object ({phase, issues[], message, frameUrl}) or a plain
// string into renders.error / jobs.error; this normalizes both for the UI.
export interface ParsedRenderError {
  phase: string | null;
  message: string;
  issues: string[];
  frameUrl: string | null;
}

const FALLBACK_MESSAGE = 'Something went wrong during composition or rendering.';

export function parseRenderError(value: unknown): ParsedRenderError {
  // Plain string error (e.g. "Render failed.", or a thrown Error's message).
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return { phase: null, message: trimmed || FALLBACK_MESSAGE, issues: [], frameUrl: null };
  }
  // Structured object error.
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    const phase = typeof o.phase === 'string' && o.phase.trim() ? o.phase.trim() : null;
    const message =
      typeof o.message === 'string' && o.message.trim() ? o.message.trim() : FALLBACK_MESSAGE;
    const issues = Array.isArray(o.issues)
      ? o.issues.filter((i): i is string => typeof i === 'string' && i.trim().length > 0)
      : [];
    const frameUrl =
      typeof o.frameUrl === 'string' && o.frameUrl.trim() ? o.frameUrl.trim() : null;
    return { phase, message, issues, frameUrl };
  }
  // null / undefined / number / anything else.
  return { phase: null, message: FALLBACK_MESSAGE, issues: [], frameUrl: null };
}

// Human label for a known pipeline phase (renders.status / error.phase), with a
// passthrough for unknown phases and null for absent.
export function phaseLabel(phase: string | null): string | null {
  if (!phase) return null;
  switch (phase) {
    case 'gate1':
      return 'Spec validation';
    case 'gate2':
      return 'Smoke-frame QA';
    case 'composing':
      return 'Composition';
    case 'resolving_assets':
      return 'Asset resolution';
    case 'rendering':
      return 'Rendering';
    default:
      return phase;
  }
}
