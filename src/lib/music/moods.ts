// The single mood-tag vocabulary (Phase 6, spec 4.2.3 / 4.3). Enumerated ONCE here
// so both sides share it and can't drift:
//   * scripts/seed-music.ts generates one instrumental bed per tag (what exists),
//   * music/select.ts matches a video's mood against the library (what we look for).
// Keep this list and the seed set in lockstep — a tag the library never seeds can
// never be matched, and the fallback (NEUTRAL_MOOD) would always win.

export const MOOD_TAGS = [
  'upbeat',
  'calm',
  'dramatic',
  'inspirational',
  'energetic',
  'somber',
  'playful',
  'neutral',
] as const;

export type MoodTag = (typeof MOOD_TAGS)[number];

// The fallback bed when nothing matches (spec 4.2.3: "falling back to a neutral
// seeded track if none match"). The seed script MUST produce a track tagged this.
export const NEUTRAL_MOOD: MoodTag = 'neutral';

export function isMoodTag(s: string): s is MoodTag {
  return (MOOD_TAGS as readonly string[]).includes(s);
}

// A short generation brief per mood, used by the seed script's ElevenLabs prompt.
// Kept beside the vocabulary so adding a mood forces a prompt for it.
export const MOOD_PROMPTS: Record<MoodTag, string> = {
  upbeat: 'An upbeat, bright instrumental background bed with a steady modern beat. No vocals.',
  calm: 'A calm, gentle ambient instrumental bed, soft pads, unobtrusive. No vocals.',
  dramatic: 'A dramatic, cinematic instrumental bed with building tension. No vocals.',
  inspirational: 'An inspirational, uplifting instrumental bed, warm and hopeful. No vocals.',
  energetic: 'An energetic, driving instrumental bed with strong rhythm. No vocals.',
  somber: 'A somber, reflective instrumental bed, slow and minor-key. No vocals.',
  playful: 'A playful, light instrumental bed, quirky and fun. No vocals.',
  neutral: 'A neutral, understated instrumental background bed that suits any topic. No vocals.',
};
