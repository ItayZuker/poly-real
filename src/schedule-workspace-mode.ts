/** Live trading schedule vs historical Replay workspace (separate Mongo collections). */
export type ScheduleWorkspaceMode = "live" | "replay";

export function parseScheduleWorkspaceMode(raw: unknown): ScheduleWorkspaceMode {
  const first = Array.isArray(raw) ? raw[0] : raw;
  const value = String(first ?? "live").trim().toLowerCase();
  return value === "replay" ? "replay" : "live";
}

export function tradingSetupsCollection(mode: ScheduleWorkspaceMode): string {
  return mode === "replay" ? "trading_setups_replay" : "trading_setups_real";
}

export function schedulePlacementsCollection(mode: ScheduleWorkspaceMode): string {
  return mode === "replay" ? "schedual_setups_replay" : "schedual_setups_real";
}
