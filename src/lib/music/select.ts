// Music track selection (Phase 6, spec 4.2.3). Pure: given the video's mood and the
// channel's seeded library, pick a track by mood-tag match — the deterministic V1
// form of "the composition AI selects an initial track by matching the video's mood
// tag against the channel music library's mood tags (falling back to a neutral
// seeded track if none match)". No DB, no network — render.ts loads the library and
// stores the chosen id on the render row.
//
// Reroll is RESELECTION ONLY — it cycles to a different existing track; it never
// regenerates. Generation happens once, in the seed script (keeps spend ledgered at
// seed time and the reroll loop free).
import { NEUTRAL_MOOD } from './moods';

export interface MusicTrack {
  id: string;
  moodTags: string[];
}

// Rank tracks for a desired mood: a direct mood-tag hit first, then neutral-tagged
// beds, then everything else — stable within each tier (seed/library order). The
// caller takes [0] for an initial pick or steps through for a reroll.
export function rankTracksByMood(mood: string, tracks: MusicTrack[]): MusicTrack[] {
  const tier = (t: MusicTrack): number => {
    if (mood && t.moodTags.includes(mood)) return 0;
    if (t.moodTags.includes(NEUTRAL_MOOD)) return 1;
    return 2;
  };
  // Stable sort by tier (Array.prototype.sort is stable in V8/Node).
  return tracks.map((t, i) => ({ t, i })).sort((a, b) => tier(a.t) - tier(b.t) || a.i - b.i).map((x) => x.t);
}

// The initial pick for a video's mood: the best-ranked track, or null for an empty
// library (render.ts then leaves music off rather than inventing one).
export function selectMusicTrack(mood: string, tracks: MusicTrack[]): MusicTrack | null {
  if (tracks.length === 0) return null;
  return rankTracksByMood(mood, tracks)[0];
}

// Reroll: the next track in mood-rank order after the current one, wrapping. With a
// single-track library it returns that same track (nothing else to pick). Reselection
// only — the returned track already exists in the seeded library.
export function rerollMusicTrack(
  mood: string,
  tracks: MusicTrack[],
  currentId: string | null,
): MusicTrack | null {
  if (tracks.length === 0) return null;
  const ranked = rankTracksByMood(mood, tracks);
  if (currentId === null) return ranked[0];
  const idx = ranked.findIndex((t) => t.id === currentId);
  if (idx === -1) return ranked[0];
  return ranked[(idx + 1) % ranked.length];
}
