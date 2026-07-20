import { getWindowDataVersion } from "./db/recorded-window-repository.js";
import {
  listRecordedWindowsSince,
  type HeatmapRecordedWindow,
} from "./db/recorded-window-mongo-repository.js";
import { logService } from "./log-service.js";
import type { RecordedWindowDocument } from "./types.js";

export type HeatmapDayId = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
export type HeatmapMetric = "crossings" | "range" | "wallets" | "newWallets";

export interface HeatmapCellValues {
  crossings: number;
  range: number;
  wallets: number;
  newWallets: number;
}

export interface HeatmapPublicState {
  cutoffUtc: number;
  cells: Record<string, HeatmapCellValues>;
  max: HeatmapCellValues;
  /** Latest recorded window per series — used to invalidate schedule placement stats. */
  seriesDataVersions: Record<string, string>;
}

const UTC_DAY_TO_ID: HeatmapDayId[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

interface StoredHeatmapWindow {
  series: string;
  windowStart: number;
  savedAt: string;
  day: HeatmapDayId;
  hour: number;
  metrics: HeatmapCellValues;
}

interface BucketAccumulator {
  crossingsSum: number;
  rangeSum: number;
  walletsSum: number;
  newWalletsSum: number;
  count: number;
}

let updateListener: ((state: HeatmapPublicState) => void) | null = null;
const windowStore = new Map<string, StoredHeatmapWindow>();

function emptyCell(): HeatmapCellValues {
  return { crossings: 0, range: 0, wallets: 0, newWallets: 0 };
}

function emptyMax(): HeatmapCellValues {
  return { crossings: 0, range: 0, wallets: 0, newWallets: 0 };
}

export function setHeatmapUpdateListener(listener: ((state: HeatmapPublicState) => void) | null): void {
  updateListener = listener;
}

export function getRollingCutoffUtcSec(now = new Date()): number {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  return Math.floor(Date.UTC(y, m, d - 6) / 1000);
}

function windowKey(series: string, windowStart: number): string {
  return `${series}:${windowStart}`;
}

function bucketKey(day: HeatmapDayId, hour: number): string {
  return `${day}:${hour}`;
}

type HeatmapMetricSource = Pick<
  HeatmapRecordedWindow,
  "ptbCrossings" | "rangeTop" | "rangeBottom" | "uniqueTraders" | "newWallets"
>;

function metricsFromWindow(window: HeatmapMetricSource): HeatmapCellValues {
  return {
    crossings: window.ptbCrossings ?? 0,
    range: (window.rangeTop ?? 0) + (window.rangeBottom ?? 0),
    wallets: window.uniqueTraders ?? 0,
    newWallets: window.newWallets ?? 0,
  };
}

function dayHourFromWindowStart(windowStart: number): { day: HeatmapDayId; hour: number } {
  const date = new Date(windowStart * 1000);
  return {
    day: UTC_DAY_TO_ID[date.getUTCDay()] ?? "sun",
    hour: date.getUTCHours(),
  };
}

function isInRollingWindow(windowStart: number, cutoffUtc: number): boolean {
  return windowStart >= cutoffUtc;
}

function toStoredWindow(
  series: string,
  window: HeatmapMetricSource & { windowStart: number; savedAt?: string },
): StoredHeatmapWindow {
  const { day, hour } = dayHourFromWindowStart(window.windowStart);
  return {
    series,
    windowStart: window.windowStart,
    savedAt: window.savedAt ?? String(window.windowStart),
    day,
    hour,
    metrics: metricsFromWindow(window),
  };
}

function seriesDataVersionsFromStore(): Record<string, string> {
  const cutoffUtc = getRollingCutoffUtcSec();
  const latestBySeries = new Map<string, StoredHeatmapWindow>();

  for (const stored of windowStore.values()) {
    if (!isInRollingWindow(stored.windowStart, cutoffUtc)) continue;
    const prev = latestBySeries.get(stored.series);
    if (!prev || stored.windowStart > prev.windowStart) {
      latestBySeries.set(stored.series, stored);
      continue;
    }
    if (stored.windowStart === prev.windowStart && stored.savedAt > prev.savedAt) {
      latestBySeries.set(stored.series, stored);
    }
  }

  const versions: Record<string, string> = {};
  for (const [series, window] of latestBySeries) {
    versions[series] = `${window.windowStart}:${window.savedAt}`;
  }
  return versions;
}

function rebuildState(seriesFilter?: string | null): HeatmapPublicState {
  const cutoffUtc = getRollingCutoffUtcSec();
  const buckets = new Map<string, BucketAccumulator>();
  const filter = seriesFilter ? String(seriesFilter).trim() : "";

  for (const stored of windowStore.values()) {
    if (filter && stored.series !== filter) continue;
    if (!isInRollingWindow(stored.windowStart, cutoffUtc)) continue;
    const key = bucketKey(stored.day, stored.hour);
    const bucket = buckets.get(key) ?? {
      crossingsSum: 0,
      rangeSum: 0,
      walletsSum: 0,
      newWalletsSum: 0,
      count: 0,
    };
    bucket.crossingsSum += stored.metrics.crossings;
    bucket.rangeSum += stored.metrics.range;
    bucket.walletsSum += stored.metrics.wallets;
    bucket.newWalletsSum += stored.metrics.newWallets;
    bucket.count += 1;
    buckets.set(key, bucket);
  }

  const cells: Record<string, HeatmapCellValues> = {};
  const max = emptyMax();

  for (const [key, bucket] of buckets) {
    if (bucket.count === 0) continue;
    const cell: HeatmapCellValues = {
      crossings: bucket.crossingsSum / bucket.count,
      range: bucket.rangeSum / bucket.count,
      wallets: bucket.walletsSum / bucket.count,
      newWallets: bucket.newWalletsSum / bucket.count,
    };
    cells[key] = cell;
    max.crossings = Math.max(max.crossings, cell.crossings);
    max.range = Math.max(max.range, cell.range);
    max.wallets = Math.max(max.wallets, cell.wallets);
    max.newWallets = Math.max(max.newWallets, cell.newWallets);
  }

  return { cutoffUtc, cells, max, seriesDataVersions: seriesDataVersionsFromStore() };
}

function pruneExpiredWindows(): void {
  const cutoffUtc = getRollingCutoffUtcSec();
  for (const [key, stored] of windowStore) {
    if (!isInRollingWindow(stored.windowStart, cutoffUtc)) {
      windowStore.delete(key);
    }
  }
}

export function getHeatmapState(series?: string | null): HeatmapPublicState {
  pruneExpiredWindows();
  return rebuildState(series);
}

export function ingestRecordedWindow(
  series: string,
  window: RecordedWindowDocument,
): HeatmapPublicState {
  const cutoffUtc = getRollingCutoffUtcSec();
  if (!isInRollingWindow(window.windowStart, cutoffUtc)) {
    pruneExpiredWindows();
    return rebuildState();
  }

  windowStore.set(windowKey(series, window.windowStart), toStoredWindow(series, window));
  pruneExpiredWindows();
  const state = rebuildState();
  updateListener?.(state);
  return state;
}

/** @deprecated Use ingestRecordedWindow */
export const ingestHeatmapWindow = ingestRecordedWindow;

export async function loadAllHeatmapWindows(): Promise<HeatmapPublicState> {
  const cutoffUtc = getRollingCutoffUtcSec();
  try {
    const windows = await listRecordedWindowsSince(cutoffUtc);
    windowStore.clear();
    for (const window of windows) {
      if (!isInRollingWindow(window.windowStart, cutoffUtc)) continue;
      windowStore.set(
        windowKey(window.series, window.windowStart),
        toStoredWindow(window.series, window),
      );
    }
    logService.info("heatmap", `Loaded ${windowStore.size} recorded windows from Mongo (since ${cutoffUtc})`);
  } catch (err) {
    logService.warn(
      "heatmap",
      `Failed to load recorded_windows from Mongo — keeping previous cache (${windowStore.size} windows): ${String(err)}`,
    );
  }

  const state = rebuildState();
  updateListener?.(state);
  return state;
}

export { getWindowDataVersion };
