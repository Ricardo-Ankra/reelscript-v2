// Deterministic, stable per-video seed for generative continuity (V2 Slice 1b). All
// generative shots in a video share this seed — recorded on each clip's provenance —
// so a re-run reproduces the same look. FNV-1a over the id's char codes → a
// non-negative 32-bit integer; same id → same seed across runs and processes.
export function videoSeed(videoId: string): number {
  let hash = 0x811c9dc5; // FNV-1a offset basis
  for (let i = 0; i < videoId.length; i++) {
    hash ^= videoId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193); // FNV-1a prime
  }
  return hash >>> 0; // coerce to a non-negative 32-bit integer
}
