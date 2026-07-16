/**
 * Heroku (or any live trader) sets TRADING_EXECUTOR=1|true|yes.
 * Without it, the process may edit Mongo settings but must not place orders.
 */
export function isTradingExecutor(): boolean {
  const raw = process.env.TRADING_EXECUTOR?.trim().toLowerCase();
  if (!raw) return false;
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}
