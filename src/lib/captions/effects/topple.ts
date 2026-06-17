// topple — the word falls in from above and rights itself (for "drop", "fall",
// "crash", "collapse"). Import-free + deterministic for the lint gate.
export const topple = (t: number) => {
  if (t >= 1) return [{ opacity: 1 }];
  const k = 1 - t;
  return [{ transform: `translateY(${-36 * k}px) rotate(${-14 * k}deg)`, opacity: Math.min(1, t * 2) }];
};
