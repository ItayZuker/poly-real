export const MIN_PHASE_SECONDS = 10;

const DEFAULT_WINDOW_DURATION_SEC = 300;

export function minPhaseFrac(durationSec?: number): number {
  const duration = Math.max(1, durationSec ?? DEFAULT_WINDOW_DURATION_SEC);
  return Math.min(1 / 3, MIN_PHASE_SECONDS / duration);
}

export function clampPhaseSplits(
  s0: number,
  s1: number,
  durationSec?: number,
): [number, number] {
  const minF = minPhaseFrac(durationSec);
  let a = Math.min(s0, s1);
  let b = Math.max(s0, s1);
  a = Math.max(minF, Math.min(1 - minF * 2, a));
  b = Math.max(a + minF, Math.min(1 - minF, b));
  return [a, b];
}
