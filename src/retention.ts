/** Unzipped tick/window data kept for live sim and replay. */
export const HOT_RETENTION_DAYS = 7;

const SECONDS_PER_DAY = 86_400;

export function hotCutoffSec(nowSec = Math.floor(Date.now() / 1000)): number {
  return nowSec - HOT_RETENTION_DAYS * SECONDS_PER_DAY;
}

/** UTC calendar day for a window start (YYYY-MM-DD). */
export function utcDayKey(windowStartSec: number): string {
  const date = new Date(windowStartSec * 1000);
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
