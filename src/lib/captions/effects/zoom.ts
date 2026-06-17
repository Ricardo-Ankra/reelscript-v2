// zoom — the word punches in from oversized down to rest (for hard attention
// hits / shouts). Valence-free. Import-free + deterministic for the lint gate.
export const zoom = (t: number) => {
  if (t >= 1) return [{ opacity: 1 }];
  return [{ transform: `scale(${1.6 - 0.6 * t})`, opacity: Math.min(1, t * 3) }];
};
