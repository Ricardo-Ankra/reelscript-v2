import type { AssetManifestEntry } from './spec';

// Pure assembly cores (Slice 3a). Deterministic timeline math — no media inspection, no
// AI — so the renderer stays declarative and the logic is unit-tested.

export interface ShotTiming {
  shotId: string;
  from: number;
  durationInFrames: number;
}

// Partition a scene's frames among its shots proportionally to duration_seconds, tiling
// [0, sceneFrames) exactly: floor each share, give the accumulated rounding remainder to
// the last shot. All-zero (or absent) weights ⇒ an equal split. No shots ⇒ [].
export function partitionSceneFrames(
  sceneFrames: number,
  shots: { shotId: string; durationSeconds: number }[],
): ShotTiming[] {
  if (shots.length === 0) return [];
  const weights = shots.map((s) => (s.durationSeconds > 0 ? s.durationSeconds : 0));
  const total = weights.reduce((a, b) => a + b, 0);
  // Equal split when every weight is 0.
  const shares = total > 0 ? weights.map((w) => w / total) : shots.map(() => 1 / shots.length);

  const out: ShotTiming[] = [];
  let from = 0;
  for (let i = 0; i < shots.length; i++) {
    const isLast = i === shots.length - 1;
    const dur = isLast ? sceneFrames - from : Math.floor(sceneFrames * shares[i]);
    out.push({ shotId: shots[i].shotId, from, durationInFrames: dur });
    from += dur;
  }
  return out;
}

export function fitForSegment(nativeFrames: number, allottedFrames: number): 'trim' | 'freeze' {
  return nativeFrames >= allottedFrames ? 'trim' : 'freeze';
}

export function segmentAssetId(shotId: string): string {
  return `seg-${shotId}`;
}

// Build the kind:'video' manifest entries for clip/footage segments. The key IS the durable
// r2Key (own content — no attribution, no DB lookup; the keys were loaded with the shots).
export function buildSegmentAssets(shots: { shotId: string; key: string }[]): AssetManifestEntry[] {
  return shots.map((s) => ({ id: segmentAssetId(s.shotId), kind: 'video' as const, r2Key: s.key }));
}
