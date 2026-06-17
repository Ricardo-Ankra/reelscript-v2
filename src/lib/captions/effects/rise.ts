// rise — the word floats up into place (for "rise", "grow", "boost", "soar").
// Import-free + deterministic for the lint gate.
export const rise = (t: number) => {
  if (t >= 1) return [{ opacity: 1 }];
  return [{ transform: `translateY(${34 * (1 - t)}px)`, opacity: Math.min(1, t * 2) }];
};
