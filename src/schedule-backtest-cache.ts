import type { TradingPhaseSetup } from "./types.js";
import type { SchedulePlacementListItem } from "./db/schedule-placement-repository.js";
import type { PlacementBacktestStats } from "./schedule-backtest-service.js";

/** Bump when simulator/backtest rules change. */
export const SCHEDULE_BACKTEST_CACHE_VERSION = "6";

export function rollingCutoffDayUtc(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function buildPlacementCacheKey(input: {
  series: string;
  placement: SchedulePlacementListItem;
  phaseSetup: TradingPhaseSetup | null | undefined;
  latencyMs: number;
  heatmapVersion: string;
  cutoffDay: string;
}): string {
  const { series, placement, phaseSetup, latencyMs, heatmapVersion, cutoffDay } = input;
  const setupSig = phaseSetup ? JSON.stringify(phaseSetup) : `missing:${placement.setupId}`;
  return [
    SCHEDULE_BACKTEST_CACHE_VERSION,
    series,
    placement._id,
    placement.day,
    placement.startHour,
    placement.durationHours,
    placement.setupId,
    setupSig,
    latencyMs,
    heatmapVersion,
    cutoffDay,
  ].join("|");
}

/** Server no longer caches user placement stats — browser is the cache. */
export async function getCachedPlacementStats(
  _series: string,
  _placementId: string,
  _cacheKey: string,
): Promise<PlacementBacktestStats | null> {
  return null;
}

export async function setCachedPlacementStats(
  _series: string,
  _placementId: string,
  _cacheKey: string,
  _stats: PlacementBacktestStats,
  _livePlacementIds: string[],
): Promise<void> {
  /* no-op */
}

export async function flushPlacementStatsCache(
  _series: string,
  _updates: Array<{ placementId: string; cacheKey: string; stats: PlacementBacktestStats }>,
  _livePlacementIds: string[],
): Promise<void> {
  /* no-op */
}

export async function invalidateSeriesStatsCache(_series: string): Promise<void> {
  /* no-op */
}
