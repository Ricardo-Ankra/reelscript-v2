// Pure render-timing helpers for the AnimatedCaptionTrack (caption emphasis
// revision, 2026-06-16). Kept out of the Remotion component so the timing logic
// is unit-tested; the component supplies the current frame from useCurrentFrame().
import type { CaptionChunk, CaptionFocus } from './types';

// The chunk visible at this frame (fromFrame inclusive, toFrame exclusive).
export function findActiveChunk(chunks: CaptionChunk[], frame: number): CaptionChunk | undefined {
  return chunks.find((c) => frame >= c.fromFrame && frame < c.toFrame);
}

// A word's entrance progress 0 → 1 over `entranceFrames` from its reveal frame.
// 0 at/before reveal, clamped to 1 after; a non-positive window settles at once.
export function entranceProgress(fromFrame: number, frame: number, entranceFrames: number): number {
  if (entranceFrames <= 0) return 1;
  const t = (frame - fromFrame) / entranceFrames;
  return t <= 0 ? 0 : t >= 1 ? 1 : t;
}

export interface FocusPlacement {
  sizeScale: number; // multiplies the base caption font size
  justify: 'center' | 'flex-end'; // vertical anchor within the frame
  paddingBottomPct: number; // gap from the bottom when flex-end
}

// Resolve a scene's caption focus to a vertical band + size scale (caption emphasis
// revision addendum). Fixed defaults in V1; structured to become brand-configurable
// later like the emphasis tables. The renderer applies sizeScale on top of each
// word's emphasis sizeMultiplier.
export function resolveFocusPlacement(focus: CaptionFocus | undefined): FocusPlacement {
  switch (focus) {
    case 'visual': // footage is the point — drop captions to the lower third + shrink
      return { sizeScale: 0.85, justify: 'flex-end', paddingBottomPct: 8 };
    case 'text': // the words are the point — center and enlarge slightly
      return { sizeScale: 1.05, justify: 'center', paddingBottomPct: 0 };
    case 'balanced':
    default:
      return { sizeScale: 1, justify: 'flex-end', paddingBottomPct: 20 };
  }
}
