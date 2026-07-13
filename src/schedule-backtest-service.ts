import {
  getWindowDataVersion,
  listRecordedWindows,
} from "./db/recorded-window-repository.js";
import type { MarketDocument } from "./types.js";
import { getTradingSetupById } from "./db/trading-setup-repository.js";
import type { SchedulePlacementListItem } from "./db/schedule-placement-repository.js";
import { listBookReplayTicks } from "./db/replay-tick-repository.js";
import { getRollingCutoffUtcSec } from "./heatmap-service.js";
import { SimulatorEngine } from "./simulator-engine.js";
import { phaseSetupToSimSetup } from "./simulator-service.js";
import {
  buildPlacementCacheKey,
  getCachedPlacementStats,
  rollingCutoffDayUtc,
  flushPlacementStatsCache,
} from "./schedule-backtest-cache.js";
import os from "os";
import type {
  LiveWindowState,
  RecordedWindowDocument,
  ReplayTickDocument,
  ScheduleDayId,
  SimLastWindow,
  SimMarker,
  SimSetup,
  TradingPhaseSetup,
} from "./types.js";

const UTC_DAY_TO_ID: ScheduleDayId[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** Parallel window sims — capped to limit concurrent disk reads (e.g. Dropbox). */
const WINDOW_SIM_CONCURRENCY = Math.min(
  4,
  Math.max(1, (os.cpus().length || 4) - 1),
);

export interface PlacementBacktestStats {
  placementId: string;
  hasData: boolean;
  green: number;
  red: number;
  blue: number;
  pnl: number;
}

export interface BacktestProgress {
  completed: number;
  total: number;
  /** When true, the UI should show an indeterminate animation. */
  indeterminate?: boolean;
}

export interface BacktestScheduleOptions {
  onProgress?: (progress: BacktestProgress) => void;
  shouldAbort?: () => boolean;
  /** When set, only placements using this setup are simulated; others are read from cache. */
  recomputeSetupId?: string;
  tickCache?: Map<number, ReplayTickDocument[]>;
}

type OutcomeBucket = "green" | "red" | "blue" | "none";

function simSetupCacheKey(setup: SimSetup): string {
  return JSON.stringify(setup);
}

function windowSimCacheKey(windowStart: number, setup: SimSetup): string {
  return `${windowStart}|${simSetupCacheKey(setup)}`;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  return results;
}

function countSimOpsPerWindow(plans: PlacementPlan[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const plan of plans) {
    if (plan.kind !== "simulate") continue;
    for (const window of plan.slotWindows) {
      counts.set(window.windowStart, (counts.get(window.windowStart) ?? 0) + 1);
    }
  }
  return counts;
}

function releaseWindowTicks(
  windowStart: number,
  tickCache: Map<number, ReplayTickDocument[]>,
  tickUseRemaining: Map<number, number>,
): void {
  const left = (tickUseRemaining.get(windowStart) ?? 1) - 1;
  if (left <= 0) {
    tickUseRemaining.delete(windowStart);
    tickCache.delete(windowStart);
    return;
  }
  tickUseRemaining.set(windowStart, left);
}

function latestWeekdayStartUtc(day: ScheduleDayId, cutoffUtc: number, now = new Date()): number | null {
  const targetDow = UTC_DAY_TO_ID.indexOf(day);
  if (targetDow < 0) return null;
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  for (let offset = 0; offset < 7; offset += 1) {
    const date = new Date(Date.UTC(y, m, d - offset));
    if (date.getUTCDay() !== targetDow) continue;
    const dayStart = Math.floor(date.getTime() / 1000);
    if (dayStart + 86400 > cutoffUtc) return dayStart;
  }
  return null;
}

function utcDayStart(windowStart: number): number {
  const date = new Date(windowStart * 1000);
  return Math.floor(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / 1000);
}

function windowStartFallsInSlot(
  windowStart: number,
  dayStartUtc: number,
  startHour: number,
  durationHours: number,
): boolean {
  if (utcDayStart(windowStart) !== dayStartUtc) return false;
  const date = new Date(windowStart * 1000);
  const windowMinutes = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
  const slotStartMinutes = startHour * 60;
  const slotEndMinutes = (startHour + durationHours) * 60;
  return windowMinutes >= slotStartMinutes && windowMinutes < slotEndMinutes;
}

function replayTickToState(
  tick: ReplayTickDocument,
  series: string,
  windowStart: number,
  windowEnd: number,
): LiveWindowState {
  return {
    series,
    windowStart,
    windowEnd,
    lastTickMs: tick.tMs,
    yesBid: tick.yesBid,
    yesAsk: tick.yesAsk,
    noBid: tick.noBid,
    noAsk: tick.noAsk,
    yesBidSize: tick.yesBidSize,
    yesAskSize: tick.yesAskSize,
    noBidSize: tick.noBidSize,
    noAskSize: tick.noAskSize,
    yesBids: tick.yesBids,
    yesAsks: tick.yesAsks,
    noBids: tick.noBids,
    noAsks: tick.noAsks,
    assetPrice: tick.assetPrice,
    prevCloseAsset: tick.prevCloseAsset,
    assetGap: tick.assetGap,
    ptbCrossings: tick.ptbCrossings,
    minAssetPrice: tick.minAssetPrice,
    maxAssetPrice: tick.maxAssetPrice,
    assetRange: tick.assetRange,
    priceHistory: [],
  };
}

export function classifyWindow(result: SimLastWindow | null): OutcomeBucket {
  if (!result || result.plLabel === "No trade") return "none";
  if (result.sold) return result.pl > 0 ? "green" : "red";
  return result.positionWon ? "blue" : "red";
}

export interface RecordedWindowSimulation {
  result: SimLastWindow | null;
  markers: SimMarker[];
  windowStart: number;
  windowEnd: number;
}

export async function simulateRecordedWindow(
  market: MarketDocument,
  series: string,
  window: RecordedWindowDocument,
  setup: SimSetup,
  tickCache?: Map<number, ReplayTickDocument[]>,
  simResultCache?: Map<string, SimLastWindow | null>,
): Promise<RecordedWindowSimulation> {
  const simCacheKey = simResultCache ? windowSimCacheKey(window.windowStart, setup) : null;
  if (simCacheKey && simResultCache!.has(simCacheKey)) {
    const cached = simResultCache!.get(simCacheKey) ?? null;
    return {
      result: cached,
      markers: [],
      windowStart: window.windowStart,
      windowEnd: window.windowEnd,
    };
  }

  let ticks = tickCache?.get(window.windowStart);
  if (!ticks) {
    ticks = await listBookReplayTicks(market, window.windowStart, 50_000);
    tickCache?.set(window.windowStart, ticks);
  }
  const windowEnd = window.windowEnd;
  const windowStart = window.windowStart;

  if (ticks.length === 0) {
    const emptyResult: SimLastWindow = {
      windowKey: `${series}:${windowStart}`,
      windowStart,
      windowEnd,
      sold: false,
      positionWon: null,
      pl: 0,
      plLabel: "No trade",
    };
    simResultCache?.set(simCacheKey!, emptyResult);
    return {
      result: emptyResult,
      markers: [],
      windowStart,
      windowEnd,
    };
  }

  const engine = new SimulatorEngine();

  for (const tick of ticks) {
    if (tick.tMs >= windowEnd * 1000) break;
    const state = replayTickToState(tick, series, windowStart, windowEnd);
    engine.tick(state, setup, tick.tMs);
  }

  const lastInWindow = [...ticks].reverse().find((t) => t.tMs < windowEnd * 1000) ?? ticks[ticks.length - 1];
  const endMs = windowEnd * 1000 - 1;
  const endState = replayTickToState(lastInWindow, series, windowStart, windowEnd);
  engine.tick({ ...endState, lastTickMs: endMs }, setup, endMs);

  // Settle from stored Polymarket outcome in window JSON (backfilled / recorded at finalize).
  const result = engine.finalizeWindow(
    window.windowOutcome ? { outcome: window.windowOutcome } : undefined,
  );

  if (simCacheKey) {
    simResultCache!.set(simCacheKey, result ?? null);
  }

  return {
    result,
    markers: engine.getMarkers(),
    windowStart,
    windowEnd,
  };
}

function emptyStats(placementId: string): PlacementBacktestStats {
  return {
    placementId,
    hasData: false,
    green: 0,
    red: 0,
    blue: 0,
    pnl: 0,
  };
}

function aggregateResult(
  placementId: string,
  results: SimLastWindow[],
): PlacementBacktestStats {
  let green = 0;
  let red = 0;
  let blue = 0;
  let pnl = 0;

  for (const result of results) {
    const bucket = classifyWindow(result);
    if (bucket === "green") green += 1;
    else if (bucket === "red") red += 1;
    else if (bucket === "blue") blue += 1;
    pnl += result.pl ?? 0;
  }

  return {
    placementId,
    hasData: true,
    green,
    red,
    blue,
    pnl,
  };
}

type PlacementPlan =
  | {
      placement: SchedulePlacementListItem;
      cacheKey: string;
      kind: "cached";
      stats: PlacementBacktestStats;
    }
  | {
      placement: SchedulePlacementListItem;
      cacheKey: string;
      kind: "empty";
    }
  | {
      placement: SchedulePlacementListItem;
      cacheKey: string;
      kind: "simulate";
      slotWindows: RecordedWindowDocument[];
      simSetup: SimSetup;
    };

function workUnitsForPlan(plan: PlacementPlan): number {
  if (plan.kind === "simulate") return plan.slotWindows.length;
  return 1;
}

async function buildPlacementPlan(
  placement: SchedulePlacementListItem,
  input: {
    series: string;
    phaseSetup: TradingPhaseSetup | null;
    latencyMs: number;
    heatmapVersion: string;
    cutoffDay: string;
    cutoffUtc: number;
    allWindows: RecordedWindowDocument[];
    allowCached: boolean;
  },
): Promise<PlacementPlan> {
  const { series, phaseSetup, latencyMs, heatmapVersion, cutoffDay, cutoffUtc, allWindows, allowCached } =
    input;
  const cacheKey = buildPlacementCacheKey({
    series,
    placement,
    phaseSetup,
    latencyMs,
    heatmapVersion,
    cutoffDay,
  });

  if (allowCached) {
    const cached = await getCachedPlacementStats(series, placement._id, cacheKey);
    if (cached) {
      return { placement, cacheKey, kind: "cached", stats: cached };
    }
  }

  if (!phaseSetup) {
    return { placement, cacheKey, kind: "empty" };
  }

  const dayStartUtc = latestWeekdayStartUtc(placement.day, cutoffUtc);
  if (dayStartUtc == null) {
    return { placement, cacheKey, kind: "empty" };
  }

  const slotWindows = allWindows.filter((w) =>
    windowStartFallsInSlot(w.windowStart, dayStartUtc, placement.startHour, placement.durationHours),
  );

  if (slotWindows.length === 0) {
    return { placement, cacheKey, kind: "empty" };
  }

  const windowDuration =
    slotWindows[0]?.windowEnd && slotWindows[0]?.windowStart
      ? slotWindows[0].windowEnd - slotWindows[0].windowStart
      : undefined;
  const simSetup = phaseSetupToSimSetup(phaseSetup, latencyMs, windowDuration);
  return { placement, cacheKey, kind: "simulate", slotWindows, simSetup };
}

export async function backtestSchedulePlacements(
  market: MarketDocument,
  placements: SchedulePlacementListItem[],
  latencyMs: number,
  options: BacktestScheduleOptions = {},
): Promise<PlacementBacktestStats[]> {
  if (placements.length === 0) return [];

  options.onProgress?.({ completed: 0, total: 0, indeterminate: true });

  const series = market._id;
  const cutoffUtc = getRollingCutoffUtcSec();
  const cutoffDay = rollingCutoffDayUtc();
  const allWindows = (await listRecordedWindows(market)).filter(
    (w) => w.windowStart >= cutoffUtc,
  );
  const heatmapVersion = await getWindowDataVersion(market, allWindows);
  const livePlacementIds = placements.map((p) => p._id);
  const tickCache = options.tickCache ?? new Map<number, ReplayTickDocument[]>();
  const recomputeSetupId = options.recomputeSetupId;

  const setupCache = new Map<string, TradingPhaseSetup | null>();
  const uniqueSetupIds = [...new Set(placements.map((p) => p.setupId))];
  await Promise.all(
    uniqueSetupIds.map(async (setupId) => {
      const setup = await getTradingSetupById(setupId);
      setupCache.set(setupId, setup?.setup ?? null);
    }),
  );

  const statsById = new Map<string, PlacementBacktestStats>();
  const simulateTargets: SchedulePlacementListItem[] = [];

  if (recomputeSetupId) {
    for (const placement of placements) {
      if (placement.setupId === recomputeSetupId) {
        simulateTargets.push(placement);
        continue;
      }
      const phaseSetup = setupCache.get(placement.setupId) ?? null;
      const cacheKey = buildPlacementCacheKey({
        series,
        placement,
        phaseSetup,
        latencyMs,
        heatmapVersion,
        cutoffDay,
      });
      const cached = await getCachedPlacementStats(series, placement._id, cacheKey);
      if (cached) {
        statsById.set(placement._id, cached);
      } else {
        simulateTargets.push(placement);
      }
    }
  } else {
    simulateTargets.push(...placements);
  }

  const planInput = {
    series,
    latencyMs,
    heatmapVersion,
    cutoffDay,
    cutoffUtc,
    allWindows,
    allowCached: !recomputeSetupId,
  };

  const plans: PlacementPlan[] = [];
  for (const placement of simulateTargets) {
    const phaseSetup = setupCache.get(placement.setupId) ?? null;
    plans.push(
      await buildPlacementPlan(placement, {
        ...planInput,
        phaseSetup,
      }),
    );
  }

  const simResultCache = new Map<string, SimLastWindow | null>();
  const tickUseRemaining = countSimOpsPerWindow(plans);
  const totalUnits = plans.reduce((sum, plan) => sum + workUnitsForPlan(plan), 0);
  let completedUnits = 0;

  const reportProgress = (indeterminate = false) => {
    if (totalUnits <= 0 && !indeterminate) return;
    options.onProgress?.({
      completed: completedUnits,
      total: totalUnits,
      indeterminate,
    });
  };

  if (totalUnits > 0) {
    reportProgress(false);
  }

  const cacheUpdates: Array<{
    placementId: string;
    cacheKey: string;
    stats: PlacementBacktestStats;
  }> = [];

  for (const plan of plans) {
    if (options.shouldAbort?.()) break;

    if (plan.kind === "cached") {
      statsById.set(plan.placement._id, plan.stats);
      completedUnits += 1;
      reportProgress(false);
      continue;
    }

    if (plan.kind === "empty") {
      const computed = emptyStats(plan.placement._id);
      statsById.set(plan.placement._id, computed);
      cacheUpdates.push({ placementId: plan.placement._id, cacheKey: plan.cacheKey, stats: computed });
      completedUnits += 1;
      reportProgress(false);
      continue;
    }

    const windowResults = await mapWithConcurrency(
      plan.slotWindows,
      WINDOW_SIM_CONCURRENCY,
      async (window) => {
        if (options.shouldAbort?.()) return null;
        const { result } = await simulateRecordedWindow(
          market,
          market._id,
          window,
          plan.simSetup,
          tickCache,
          simResultCache,
        );
        releaseWindowTicks(window.windowStart, tickCache, tickUseRemaining);
        completedUnits += 1;
        reportProgress(false);
        return result;
      },
    );

    if (options.shouldAbort?.()) break;

    const results = windowResults.filter((result): result is SimLastWindow => result != null);
    const computed = aggregateResult(plan.placement._id, results);
    statsById.set(plan.placement._id, computed);
    cacheUpdates.push({ placementId: plan.placement._id, cacheKey: plan.cacheKey, stats: computed });
  }

  if (cacheUpdates.length > 0) {
    await flushPlacementStatsCache(series, cacheUpdates, livePlacementIds);
  }

  return placements.map((placement) => {
    const stats = statsById.get(placement._id);
    return stats ?? emptyStats(placement._id);
  });
}
