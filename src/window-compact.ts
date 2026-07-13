import type { RecordedWindowDocument, WindowOutcome } from "./types.js";
import { roundTo4 } from "./tick-compact.js";

/** Numeric BSON keys for recorded window docs (`recorded_windows_*`). */
export const WK = {
  windowStart: "1",
  windowEnd: "2",
  savedAt: "3",
  updatedAt: "4",
  slug: "5",
  question: "6",
  conditionId: "7",
  assetPrice: "8",
  prevCloseAsset: "9",
  windowOutcome: "10",
  yesPrice: "11",
  noPrice: "12",
  ptbCrossings: "13",
  minAssetPrice: "14",
  maxAssetPrice: "15",
  uniqueTraders: "16",
  tickCount: "17",
  newWallets: "18",
  knownWallets: "19",
  rangeTop: "20",
  rangeBottom: "21",
} as const;

export const WindowOutcomeCode = {
  up: 1,
  down: 2,
} as const;

export type StoredWindowDocument = Record<string, unknown>;

function isCompactStored(doc: StoredWindowDocument): boolean {
  return doc[WK.windowStart] != null && doc.windowStart === undefined;
}

function setIfDefined(
  target: StoredWindowDocument,
  key: string,
  value: number | string | undefined,
): void {
  if (value == null) return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return;
    target[key] = roundTo4(value);
    return;
  }
  if (typeof value === "string" && value.length > 0) {
    target[key] = value;
  }
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

function expandWindowDerived(
  window: RecordedWindowDocument,
): RecordedWindowDocument {
  const expanded = { ...window };
  if (expanded.assetPrice != null && expanded.prevCloseAsset != null) {
    expanded.assetGap = roundTo4(expanded.assetPrice - expanded.prevCloseAsset);
  }
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
  if (expanded.prevCloseAsset != null && Number.isFinite(expanded.prevCloseAsset)) {
    if (
      expanded.rangeTop == null &&
      expanded.maxAssetPrice != null &&
      Number.isFinite(expanded.maxAssetPrice)
    ) {
      expanded.rangeTop = roundTo4(
        Math.max(0, expanded.maxAssetPrice - expanded.prevCloseAsset),
      );
    }
    if (
      expanded.rangeBottom == null &&
      expanded.minAssetPrice != null &&
      Number.isFinite(expanded.minAssetPrice)
    ) {
      expanded.rangeBottom = roundTo4(
        Math.max(0, expanded.prevCloseAsset - expanded.minAssetPrice),
      );
    }
  }
  return expanded;
}

export function toStoredRecordedWindow(
  doc: Omit<RecordedWindowDocument, "_id" | "updatedAt"> & { updatedAt?: string },
): StoredWindowDocument {
  const stored: StoredWindowDocument = {
    _id: String(doc.windowStart),
    [WK.windowStart]: doc.windowStart,
    [WK.windowEnd]: doc.windowEnd,
    [WK.savedAt]: toUnixMs(doc.savedAt),
    [WK.updatedAt]: toUnixMs(doc.updatedAt ?? doc.savedAt),
    [WK.tickCount]: doc.tickCount,
  };

  setIfDefined(stored, WK.slug, doc.slug);
  setIfDefined(stored, WK.question, doc.question);
  setIfDefined(stored, WK.conditionId, doc.conditionId);
  setIfDefined(stored, WK.assetPrice, doc.assetPrice);
  setIfDefined(stored, WK.prevCloseAsset, doc.prevCloseAsset);

  const outcome = encodeOutcome(doc.windowOutcome);
  if (outcome != null) stored[WK.windowOutcome] = outcome;

  setIfDefined(stored, WK.yesPrice, doc.yesPrice);
  setIfDefined(stored, WK.noPrice, doc.noPrice);
  if (doc.ptbCrossings != null && doc.ptbCrossings > 0) {
    stored[WK.ptbCrossings] = doc.ptbCrossings;
  }
  setIfDefined(stored, WK.minAssetPrice, doc.minAssetPrice);
  setIfDefined(stored, WK.maxAssetPrice, doc.maxAssetPrice);
  if (doc.rangeTop != null && doc.rangeTop > 0) {
    setIfDefined(stored, WK.rangeTop, doc.rangeTop);
  }
  if (doc.rangeBottom != null && doc.rangeBottom > 0) {
    setIfDefined(stored, WK.rangeBottom, doc.rangeBottom);
  }
  if (doc.uniqueTraders != null && doc.uniqueTraders > 0) {
    stored[WK.uniqueTraders] = doc.uniqueTraders;
  }
  if (doc.newWallets != null && doc.newWallets > 0) {
    stored[WK.newWallets] = doc.newWallets;
  }
  if (doc.knownWallets != null && doc.knownWallets > 0) {
    stored[WK.knownWallets] = doc.knownWallets;
  }

  return stored;
}

export function fromStoredRecordedWindow(doc: StoredWindowDocument): RecordedWindowDocument {
  if (!isCompactStored(doc)) {
    return expandWindowDerived({
      _id: String(doc._id),
      windowStart: Number(doc.windowStart),
      windowEnd: Number(doc.windowEnd),
      savedAt: String(doc.savedAt),
      updatedAt: String(doc.updatedAt ?? doc.savedAt),
      slug: doc.slug as string | undefined,
      question: doc.question as string | undefined,
      conditionId: doc.conditionId as string | undefined,
      assetPrice: doc.assetPrice as number | undefined,
      prevCloseAsset: doc.prevCloseAsset as number | undefined,
      assetGap: doc.assetGap as number | undefined,
      windowOutcome: doc.windowOutcome as WindowOutcome | undefined,
      yesPrice: doc.yesPrice as number | undefined,
      noPrice: doc.noPrice as number | undefined,
      ptbCrossings: doc.ptbCrossings as number | undefined,
      minAssetPrice: doc.minAssetPrice as number | undefined,
      maxAssetPrice: doc.maxAssetPrice as number | undefined,
      assetRange: doc.assetRange as number | undefined,
      rangeTop: doc.rangeTop as number | undefined,
      rangeBottom: doc.rangeBottom as number | undefined,
      uniqueTraders: doc.uniqueTraders as number | undefined,
      newWallets: doc.newWallets as number | undefined,
      knownWallets: doc.knownWallets as number | undefined,
      tickCount: Number(doc.tickCount),
    });
  }

  return expandWindowDerived({
    _id: String(doc._id),
    windowStart: Number(doc[WK.windowStart]),
    windowEnd: Number(doc[WK.windowEnd]),
    savedAt: fromUnixMs(doc[WK.savedAt]),
    updatedAt: fromUnixMs(doc[WK.updatedAt] ?? doc[WK.savedAt]),
    slug: doc[WK.slug] as string | undefined,
    question: doc[WK.question] as string | undefined,
    conditionId: doc[WK.conditionId] as string | undefined,
    assetPrice: doc[WK.assetPrice] as number | undefined,
    prevCloseAsset: doc[WK.prevCloseAsset] as number | undefined,
    windowOutcome: decodeOutcome(doc[WK.windowOutcome]),
    yesPrice: doc[WK.yesPrice] as number | undefined,
    noPrice: doc[WK.noPrice] as number | undefined,
    ptbCrossings: doc[WK.ptbCrossings] as number | undefined,
    minAssetPrice: doc[WK.minAssetPrice] as number | undefined,
    maxAssetPrice: doc[WK.maxAssetPrice] as number | undefined,
    rangeTop: doc[WK.rangeTop] as number | undefined,
    rangeBottom: doc[WK.rangeBottom] as number | undefined,
    uniqueTraders: doc[WK.uniqueTraders] as number | undefined,
    newWallets: doc[WK.newWallets] as number | undefined,
    knownWallets: doc[WK.knownWallets] as number | undefined,
    tickCount: Number(doc[WK.tickCount]),
  });
}

export function recordedWindowStartFilter(windowStart: number): Record<string, unknown> {
  return {
    $or: [{ windowStart }, { [WK.windowStart]: windowStart }, { _id: String(windowStart) }],
  };
}

export function recordedWindowStartBeforeFilter(cutoff: number): Record<string, unknown> {
  return {
    $or: [
      { windowStart: { $lt: cutoff } },
      { [WK.windowStart]: { $lt: cutoff } },
    ],
  };
}
