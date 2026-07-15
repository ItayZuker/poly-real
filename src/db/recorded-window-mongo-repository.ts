import type { WindowOutcome } from "../types.js";
import { getMongoClient, getMongoDbName } from "./mongo-client.js";

const COLLECTION = "recorded_windows";

/** Slim window summary fields used by the heatmap (Mongo read-only consumer). */
export interface HeatmapRecordedWindow {
  series: string;
  windowStart: number;
  windowEnd: number;
  savedAt: string;
  ptbCrossings?: number;
  rangeTop?: number;
  rangeBottom?: number;
  uniqueTraders?: number;
  newWallets?: number;
  windowOutcome?: WindowOutcome;
}

type MongoRecordedWindowDoc = {
  _id?: string;
  series?: string;
  marketSeries?: string;
  windowStart?: number;
  windowEnd?: number;
  savedAt?: string | Date;
  ptbCrossings?: number;
  rangeTop?: number;
  rangeBottom?: number;
  uniqueTraders?: number;
  newWallets?: number;
  windowOutcome?: WindowOutcome | null;
  /** Legacy nested payload from older sim writers. */
  window?: {
    windowStart?: number;
    windowEnd?: number;
    savedAt?: string;
    ptbCrossings?: number;
    rangeTop?: number;
    rangeBottom?: number;
    uniqueTraders?: number;
    newWallets?: number;
    windowOutcome?: WindowOutcome | null;
  };
};

const HEATMAP_PROJECTION = {
  _id: 1,
  series: 1,
  marketSeries: 1,
  windowStart: 1,
  windowEnd: 1,
  savedAt: 1,
  ptbCrossings: 1,
  rangeTop: 1,
  rangeBottom: 1,
  uniqueTraders: 1,
  newWallets: 1,
  windowOutcome: 1,
  "window.windowStart": 1,
  "window.windowEnd": 1,
  "window.savedAt": 1,
  "window.ptbCrossings": 1,
  "window.rangeTop": 1,
  "window.rangeBottom": 1,
  "window.uniqueTraders": 1,
  "window.newWallets": 1,
  "window.windowOutcome": 1,
} as const;

function seriesFromDoc(doc: MongoRecordedWindowDoc): string | null {
  if (typeof doc.series === "string" && doc.series.length > 0) return doc.series;
  if (typeof doc.marketSeries === "string" && doc.marketSeries.length > 0) return doc.marketSeries;
  if (typeof doc._id === "string" && doc._id.includes(":")) {
    return doc._id.slice(0, doc._id.lastIndexOf(":"));
  }
  return null;
}

function savedAtToString(value: string | Date | undefined, fallback: number): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.length > 0) return value;
  return String(fallback);
}

function normalizeDoc(doc: MongoRecordedWindowDoc): HeatmapRecordedWindow | null {
  const nested = doc.window;
  const series = seriesFromDoc(doc);
  const windowStart = doc.windowStart ?? nested?.windowStart;
  if (!series || windowStart == null || !Number.isFinite(windowStart)) return null;

  const windowEnd = doc.windowEnd ?? nested?.windowEnd ?? windowStart;
  const savedAt = savedAtToString(doc.savedAt ?? nested?.savedAt, windowStart);
  const windowOutcome = doc.windowOutcome ?? nested?.windowOutcome;

  const out: HeatmapRecordedWindow = {
    series,
    windowStart,
    windowEnd,
    savedAt,
  };

  const ptbCrossings = doc.ptbCrossings ?? nested?.ptbCrossings;
  const rangeTop = doc.rangeTop ?? nested?.rangeTop;
  const rangeBottom = doc.rangeBottom ?? nested?.rangeBottom;
  const uniqueTraders = doc.uniqueTraders ?? nested?.uniqueTraders;
  const newWallets = doc.newWallets ?? nested?.newWallets;

  if (ptbCrossings != null) out.ptbCrossings = ptbCrossings;
  if (rangeTop != null) out.rangeTop = rangeTop;
  if (rangeBottom != null) out.rangeBottom = rangeBottom;
  if (uniqueTraders != null) out.uniqueTraders = uniqueTraders;
  if (newWallets != null) out.newWallets = newWallets;
  if (windowOutcome === "up" || windowOutcome === "down") out.windowOutcome = windowOutcome;

  return out;
}

/**
 * Fetch rolling-window summaries for the heatmap.
 * Projects only heatmap fields — never ticks.
 */
export async function listRecordedWindowsSince(
  cutoffUtc: number,
): Promise<HeatmapRecordedWindow[]> {
  const mongo = await getMongoClient();
  const docs = await mongo
    .db(getMongoDbName())
    .collection<MongoRecordedWindowDoc>(COLLECTION)
    .find(
      { windowStart: { $gte: cutoffUtc } },
      { projection: HEATMAP_PROJECTION },
    )
    .sort({ windowStart: 1 })
    .batchSize(5_000)
    .toArray();

  const out: HeatmapRecordedWindow[] = [];
  for (const doc of docs) {
    const normalized = normalizeDoc(doc);
    if (normalized) out.push(normalized);
  }
  return out;
}
