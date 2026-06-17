// shatter — the word's top and bottom halves fly in from opposite corners and
// converge (for "broken", "shatter", "destroy"). Two layers: each clips the word
// to one half and offsets it, meeting at t=1. Import-free + deterministic.
export const shatter = (t: number) => {
  if (t >= 1) return [{ opacity: 1 }];
  const k = 1 - t;
  const opacity = Math.min(1, t * 2);
  return [
    { clipPath: 'inset(0 0 50% 0)', transform: `translate(${-26 * k}px, ${-22 * k}px) rotate(${-8 * k}deg)`, opacity },
    { clipPath: 'inset(50% 0 0 0)', transform: `translate(${26 * k}px, ${22 * k}px) rotate(${8 * k}deg)`, opacity },
  ];
};
