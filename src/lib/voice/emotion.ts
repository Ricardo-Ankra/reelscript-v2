// The fixed internal emotion vocabulary (spec 3.7). The script-generation AI may
// only use tags from this controlled set, so an unmappable tag can never appear.
// A per-model voice profile (Phase 8) maps these onto what a given ElevenLabs
// model actually supports. Until then, the built-in FALLBACK profile below is the
// safe baseline: strip every tag to plain text, converting <pause> to a basic SSML
// break so an unprofiled model still synthesizes correctly (spec 3.7).
//
// Phase 3 is fallback-only: script generation still emits plain narration, so in
// practice these tags rarely appear yet — applyFallbackProfile is the defined
// contract that makes a real profile a drop-in later, and a safety pass meanwhile.
export const EMOTION_TAGS = [
  '<excited>',
  '<pause>',
  '<whisper>',
  '<emphatic>',
  '<calm>',
  '<curious>',
  '<serious>',
] as const;

export type EmotionTag = (typeof EMOTION_TAGS)[number];

// <pause> maps to a short SSML break (eleven_multilingual_v2 honours <break>).
const PAUSE_BREAK = '<break time="0.4s"/>';

// The fallback profile: convert <pause> to an SSML break, strip every other tag to
// plain text, then tidy the whitespace a removed tag leaves behind (collapse runs
// of spaces/tabs, drop spaces hugging a newline) without touching line breaks.
// Returns the exact text sent to ElevenLabs — i.e. the billable characters.
export function applyFallbackProfile(narration: string): string {
  let out = narration;
  for (const tag of EMOTION_TAGS) {
    const replacement = tag === '<pause>' ? PAUSE_BREAK : '';
    out = out.split(tag).join(replacement);
  }
  return out
    .replace(/[ \t]+/g, ' ') // collapse horizontal whitespace
    .replace(/ *\n */g, '\n') // trim spaces around newlines
    .trim();
}
