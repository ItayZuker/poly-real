import type { HeatmapWindowDocument, WindowOutcome } from "./types.js";
import { roundTo4 } from "./tick-compact.js";
import { WindowOutcomeCode } from "./window-compact.js";

/** Numeric BSON keys for heatmap window docs (`heatmap_windows_*`). */
export const HK = {
  windowStart: "1",
  windowEnd: "2",
  savedAt: "3",
  windowOutcome: "4",
  ptbCrossings: "5",
  minAssetPrice: "6",
  maxAssetPrice: "7",
  rangeTop: "8",
  rangeBottom: "9",
  uniqueTraders: "10",
  newWallets: "11",
  knownWallets: "12",
} as const;

export type StoredHeatmapDocument = Record<string, unknown>;

function isCompactStored(doc: StoredHeatmapDocument): boolean {
  return doc[HK.windowStart] != null && doc.windowStart === undefined;
}

function setIfDefined(
  target: StoredHeatmapDocument,
  key: string,
  value: number | undefined,
): void {
  if (value == null || !Number.isFinite(value)) return;
  target[key] = roundTo4(value);
}

function encodeOutcome(outcome?: WindowOutcome): number | undefined {
  if (outcome === "up") return WindowOutcomeCode.up;
  if (outcome === "down") return WindowOutcomeCode.down;
  return undefined;
}

function decodeOutcome(code: unknown): WindowOutcome | undefined {
  if (code === WindowOutcomeCode.up || code === "up") return "up";
  if (code === WindowOutcomeCode.down || code === "down") return "down";
  return undefined;
}

function toUnixMs(iso: string): number {
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? ms : Date.now();
}

function fromUnixMs(ms: unknown): string {
  const value = Number(ms);
  return Number.isFinite(value) ? new Date(value).toISOString() : new Date().toISOString();
}

function expandHeatmapDerived(window: HeatmapWindowDocument): HeatmapWindowDocument {
  const expanded = { ...window };
  if (
    expanded.minAssetPrice != null &&
    expanded.maxAssetPrice != null &&
    Number.isFinite(expanded.minAssetPrice) &&
    Number.isFinite(expanded.maxAssetPrice)
  ) {
    expanded.assetRange = roundTo4(
      Math.max(0, expanded.maxAssetPrice - expanded.minAssetPrice),
    );
  }
  return expanded;
}

export function toStoredHeatmapWindow(doc: HeatmapWindowDocument): StoredHeatmapDocument {
  const stored: StoredHeatmapDocument = {
    _id: String(doc.windowStart),
    [HK.windowStart]: doc.windowStart,
    [HK.windowEnd]: doc.windowEnd,
    [HK.savedAt]: toUnixMs(doc.savedAt),
  };

  const outcome = encodeOutcome(doc.windowOutcome);
  if (outcome != null) stored[HK.windowOutcome] = outcome;

  if (doc.ptbCrossings != null && doc.ptbCrossings > 0) {
    stored[HK.ptbCrossings] = doc.ptbCrossings;
  }
  setIfDefined(stored, HK.minAssetPrice, doc.minAssetPrice);
  setIfDefined(stored, HK.maxAssetPrice, doc.maxAssetPrice);
  if (doc.rangeTop != null && doc.rangeTop > 0) {
    setIfDefined(stored, HK.rangeTop, doc.rangeTop);
  }
  if (doc.rangeBottom != null && doc.rangeBottom > 0) {
    setIfDefined(stored, HK.rangeBottom, doc.rangeBottom);
  }
  if (doc.uniqueTraders != null && doc.uniqueTraders > 0) {
    stored[HK.uniqueTraders] = doc.uniqueTraders;
  }
  if (doc.newWallets != null && doc.newWallets > 0) {
    stored[HK.newWallets] = doc.newWallets;
  }
  if (doc.knownWallets != null && doc.knownWallets > 0) {
    stored[HK.knownWallets] = doc.knownWallets;
  }

  return stored;
}

export function fromStoredHeatmapWindow(doc: StoredHeatmapDocument): HeatmapWindowDocument {
  if (!isCompactStored(doc)) {
    return expandHeatmapDerived({
      _id: String(doc._id),
      windowStart: Number(doc.windowStart),
      windowEnd: Number(doc.windowEnd),
      savedAt: String(doc.savedAt),
      ptbCrossings: doc.ptbCrossings as number | undefined,
      assetRange: doc.assetRange as number | undefined,
      minAssetPrice: doc.minAssetPrice as number | undefined,
      maxAssetPrice: doc.maxAssetPrice as number | undefined,
      rangeTop: doc.rangeTop as number | undefined,
      rangeBottom: doc.rangeBottom as number | undefined,
      uniqueTraders: doc.uniqueTraders as number | undefined,
      newWallets: doc.newWallets as number | undefined,
      knownWallets: doc.knownWallets as number | undefined,
      windowOutcome: doc.windowOutcome as WindowOutcome | undefined,
    });
  }

  return expandHeatmapDerived({
    _id: String(doc._id),
    windowStart: Number(doc[HK.windowStart]),
    windowEnd: Number(doc[HK.windowEnd]),
    savedAt: fromUnixMs(doc[HK.savedAt]),
    ptbCrossings: doc[HK.ptbCrossings] as number | undefined,
    minAssetPrice: doc[HK.minAssetPrice] as number | undefined,
    maxAssetPrice: doc[HK.maxAssetPrice] as number | undefined,
    rangeTop: doc[HK.rangeTop] as number | undefined,
    rangeBottom: doc[HK.rangeBottom] as number | undefined,
    uniqueTraders: doc[HK.uniqueTraders] as number | undefined,
    newWallets: doc[HK.newWallets] as number | undefined,
    knownWallets: doc[HK.knownWallets] as number | undefined,
    windowOutcome: decodeOutcome(doc[HK.windowOutcome]),
  });
}

export function heatmapWindowStartFilter(windowStart: number): Record<string, unknown> {
  return {
    $or: [{ windowStart }, { [HK.windowStart]: windowStart }, { _id: String(windowStart) }],
  };
}

export function heatmapWindowStartBeforeFilter(cutoff: number): Record<string, unknown> {
  return {
    $or: [
      { windowStart: { $lt: cutoff } },
      { [HK.windowStart]: { $lt: cutoff } },
    ],
  };
}
