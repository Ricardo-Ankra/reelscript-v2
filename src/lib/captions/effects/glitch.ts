// glitch — the word stutters with a horizontal jitter + skew that resolves (for
// "lie", "fake", "error", "broken system"). Deterministic (sin of t, no
// wall-clock) and import-free for the lint gate.
export const glitch = (t: number) => {
  if (t >= 1) return [{ opacity: 1 }];
  const k = 1 - t;
  return [{ transform: `translateX(${Math.sin(t * 50) * 6 * k}px) skewX(${4 * k}deg)`, opacity: Math.min(1, t * 1.5) }];
};
