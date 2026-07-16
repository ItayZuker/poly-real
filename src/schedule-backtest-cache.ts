import path from "path";
import type { MarketDocument, TradingPhaseSetup } from "./types.js";
import type { SchedulePlacementListItem } from "./db/schedule-placement-repository.js";
import { marketDir } from "./db/data-dir.js";
import { readJsonFile, writeJsonFile } from "./db/file-store.js";
import type { PlacementBacktestStats } from "./schedule-backtest-service.js";

/** Bump when simulator/backtest rules change. */
export const SCHEDULE_BACKTEST_CACHE_VERSION = "6";

interface CacheEntry {
  cacheKey: string;
  stats: PlacementBacktestStats;
  computedAt: string;
}

interface MarketStatsCacheFile {
  version: string;
  entries: Record<string, CacheEntry>;
}

const memoryBySeries = new Map<string, MarketStatsCacheFile>();

function cacheFilePath(series: string): string {
  return path.join(marketDir(series), "schedule-backtest-cache.json");
}

function emptyCache(): MarketStatsCacheFile {
  return { version: SCHEDULE_BACKTEST_CACHE_VERSION, entries: {} };
}

async function loadMarketCache(series: string): Promise<MarketStatsCacheFile> {
  const mem = memoryBySeries.get(series);
  if (mem) return mem;

  const disk = await readJsonFile<MarketStatsCacheFile>(cacheFilePath(series));
  const cache =
    disk?.version === SCHEDULE_BACKTEST_CACHE_VERSION && disk.entries
      ? disk
      : emptyCache();
  memoryBySeries.set(series, cache);
  return cache;
}

async function persistMarketCache(series: string, cache: MarketStatsCacheFile): Promise<void> {
  memoryBySeries.set(series, cache);
  await writeJsonFile(cacheFilePath(series), cache);
}

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

export async function getCachedPlacementStats(
  series: string,
  placementId: string,
  cacheKey: string,
): Promise<PlacementBacktestStats | null> {
  const cache = await loadMarketCache(series);
  const entry = cache.entries[placementId];
  if (!entry || entry.cacheKey !== cacheKey) return null;
  return entry.stats;
}

export async function setCachedPlacementStats(
  series: string,
  placementId: string,
  cacheKey: string,
  stats: PlacementBacktestStats,
  livePlacementIds: string[],
): Promise<void> {
  const cache = await loadMarketCache(series);
  const live = new Set(livePlacementIds);
  for (const id of Object.keys(cache.entries)) {
    if (!live.has(id)) delete cache.entries[id];
  }
  cache.entries[placementId] = {
    cacheKey,
    stats,
    computedAt: new Date().toISOString(),
  };
  await persistMarketCache(series, cache);
}

export async function flushPlacementStatsCache(
  series: string,
  updates: Array<{ placementId: string; cacheKey: string; stats: PlacementBacktestStats }>,
  livePlacementIds: string[],
): Promise<void> {
  const cache = await loadMarketCache(series);
  const live = new Set(livePlacementIds);
  for (const id of Object.keys(cache.entries)) {
    if (!live.has(id)) delete cache.entries[id];
  }
  const now = new Date().toISOString();
  for (const { placementId, cacheKey, stats } of updates) {
    cache.entries[placementId] = { cacheKey, stats, computedAt: now };
  }
  await persistMarketCache(series, cache);
}

export async function invalidateSeriesStatsCache(series: string): Promise<void> {
  memoryBySeries.delete(series);
  const cache = emptyCache();
  await persistMarketCache(series, cache);
}
