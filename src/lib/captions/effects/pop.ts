// pop — the default effect: the word scales up from 60% and fades in.
// Import-free + deterministic so it passes the authoring lint gate unchanged.
export const pop = (t: number) => {
  if (t >= 1) return [{ opacity: 1 }];
  return [{ transform: `scale(${0.6 + 0.4 * t})`, opacity: Math.min(1, t * 2) }];
};
