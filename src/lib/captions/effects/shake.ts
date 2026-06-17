// shake — the word jitters horizontally with a damping amplitude (for "shocking",
// "danger", "warning", urgency). Deterministic (sin of t, no wall-clock) and
// import-free for the lint gate.
export const shake = (t: number) => {
  if (t >= 1) return [{ opacity: 1 }];
  const k = 1 - t;
  return [{ transform: `translateX(${Math.sin(t * 40) * 8 * k}px)`, opacity: Math.min(1, t * 3) }];
};
