import type { BookLevel } from "./clob-service.js";
import { takeLevels } from "./book-depth.js";
import type { BookTickDocument, ChainlinkTickDocument } from "./types.js";

/** Tick kind stored in key `0` (1 = book, 2 = chainlink). */
export const TK = {
  type: "0",
} as const;

export const TickType = {
  book: 1,
  chainlink: 2,
} as const;

/** Numeric BSON keys for book tick fields. */
export const BK = {
  windowStart: "1",
  tMs: "2",
  yesPrice: "3",
  yesBid: "4",
  yesAsk: "5",
  yesBidSize: "6",
  yesAskSize: "7",
  noPrice: "8",
  noBid: "9",
  noAsk: "10",
  noBidSize: "11",
  noAskSize: "12",
} as const;

/** Numeric BSON keys for chainlink ticks (`chainlink_ticks_*` collections). */
export const CK = {
  windowStart: "1",
  tMs: "2",
  assetPrice: "3",
  prevCloseAsset: "4",
  ptbCrossings: "5",
  minAssetPrice: "6",
  maxAssetPrice: "7",
} as const;

/** @deprecated Old compact chainlink key layout (pre-derived-field removal). */
const CK_LEGACY = {
  windowStart: "1",
  tMs: "2",
  assetPrice: "3",
  prevCloseAsset: "4",
  assetGap: "5",
  ptbCrossings: "6",
  minAssetPrice: "7",
  maxAssetPrice: "8",
  assetRange: "9",
  rangeTop: "10",
  rangeBottom: "11",
} as const;

export type StoredTickDocument = Record<string, unknown>;

export function roundTo4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function roundOptional(value: number | undefined): number | undefined {
  if (value == null || !Number.isFinite(value)) return undefined;
  return roundTo4(value);
}

export function makeStoredTickId(windowStart: number, seq: number): string {
  return `${windowStart}:${seq}`;
}

function isCompactStored(doc: StoredTickDocument): boolean {
  return doc["1"] != null && doc.windowStart === undefined;
}

function setIfDefined(
  target: StoredTickDocument,
  key: string,
  value: number | undefined,
): void {
  const rounded = roundOptional(value);
  if (rounded !== undefined) {
    target[key] = rounded;
  }
}

function levelFromTop(price?: number, size?: number): BookLevel[] {
  if (price == null || size == null || !Number.isFinite(price) || !Number.isFinite(size) || size <= 0) {
    return [];
  }
  return [{ price, size }];
}

export function toStoredBookTick(tick: BookTickDocument): StoredTickDocument {
  return { ...tick };
}

export function fromStoredBookTick(doc: StoredTickDocument): BookTickDocument {
  if (Array.isArray(doc.yesBids) || Array.isArray(doc.yesAsks)) {
    return {
      _id: String(doc._id),
      windowStart: Number(doc.windowStart),
      windowEnd: Number(doc.windowEnd),
      tMs: Number(doc.tMs),
      yesPrice: doc.yesPrice as number | undefined,
      noPrice: doc.noPrice as number | undefined,
      yesBids: takeLevels(doc.yesBids as BookLevel[]),
      yesAsks: takeLevels(doc.yesAsks as BookLevel[]),
      noBids: takeLevels(doc.noBids as BookLevel[]),
      noAsks: takeLevels(doc.noAsks as BookLevel[]),
    };
  }

  if (!isCompactStored(doc)) {
    return {
      _id: String(doc._id),
      windowStart: Number(doc.windowStart),
      windowEnd: Number(doc.windowEnd ?? 0),
      tMs: Number(doc.tMs),
      yesPrice: doc.yesPrice as number | undefined,
      noPrice: doc.noPrice as number | undefined,
      yesBids: levelFromTop(doc.yesBid as number | undefined, doc.yesBidSize as number | undefined),
      yesAsks: levelFromTop(doc.yesAsk as number | undefined, doc.yesAskSize as number | undefined),
      noBids: levelFromTop(doc.noBid as number | undefined, doc.noBidSize as number | undefined),
      noAsks: levelFromTop(doc.noAsk as number | undefined, doc.noAskSize as number | undefined),
    };
  }

  return {
    _id: String(doc._id),
    windowStart: Number(doc[BK.windowStart]),
    windowEnd: Number(doc.windowEnd ?? 0),
    tMs: Number(doc[BK.tMs]),
    yesPrice: doc[BK.yesPrice] as number | undefined,
    noPrice: doc[BK.noPrice] as number | undefined,
    yesBids: levelFromTop(doc[BK.yesBid] as number | undefined, doc[BK.yesBidSize] as number | undefined),
    yesAsks: levelFromTop(doc[BK.yesAsk] as number | undefined, doc[BK.yesAskSize] as number | undefined),
    noBids: levelFromTop(doc[BK.noBid] as number | undefined, doc[BK.noBidSize] as number | undefined),
    noAsks: levelFromTop(doc[BK.noAsk] as number | undefined, doc[BK.noAskSize] as number | undefined),
  };
}

function isLegacyCompactChainlink(doc: StoredTickDocument): boolean {
  return (
    doc["1"] != null &&
    doc.windowStart === undefined &&
    (doc[CK_LEGACY.maxAssetPrice] != null || doc[CK_LEGACY.assetRange] != null)
  );
}

function expandChainlinkDerived(tick: ChainlinkTickDocument): ChainlinkTickDocument {
  const expanded = { ...tick };
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
    if (expanded.maxAssetPrice != null && Number.isFinite(expanded.maxAssetPrice)) {
      expanded.rangeTop = roundTo4(
        Math.max(0, expanded.maxAssetPrice - expanded.prevCloseAsset),
      );
    }
    if (expanded.minAssetPrice != null && Number.isFinite(expanded.minAssetPrice)) {
      expanded.rangeBottom = roundTo4(
        Math.max(0, expanded.prevCloseAsset - expanded.minAssetPrice),
      );
    }
  }
  return expanded;
}

export function toStoredChainlinkTick(tick: ChainlinkTickDocument): StoredTickDocument {
  return { ...tick };
}

export function fromStoredChainlinkTick(doc: StoredTickDocument): ChainlinkTickDocument {
  if (!isCompactStored(doc)) {
    return expandChainlinkDerived({
      _id: String(doc._id),
      windowStart: Number(doc.windowStart),
      windowEnd: Number(doc.windowEnd ?? 0),
      tMs: Number(doc.tMs),
      assetPrice: doc.assetPrice as number | undefined,
      prevCloseAsset: doc.prevCloseAsset as number | undefined,
      assetGap: doc.assetGap as number | undefined,
      ptbCrossings: doc.ptbCrossings as number | undefined,
      minAssetPrice: doc.minAssetPrice as number | undefined,
      maxAssetPrice: doc.maxAssetPrice as number | undefined,
      assetRange: doc.assetRange as number | undefined,
      rangeTop: doc.rangeTop as number | undefined,
      rangeBottom: doc.rangeBottom as number | undefined,
    });
  }

  if (isLegacyCompactChainlink(doc)) {
    return expandChainlinkDerived({
      _id: String(doc._id),
      windowStart: Number(doc[CK_LEGACY.windowStart]),
      windowEnd: Number(doc.windowEnd ?? 0),
      tMs: Number(doc[CK_LEGACY.tMs]),
      assetPrice: doc[CK_LEGACY.assetPrice] as number | undefined,
      prevCloseAsset: doc[CK_LEGACY.prevCloseAsset] as number | undefined,
      assetGap: doc[CK_LEGACY.assetGap] as number | undefined,
      ptbCrossings: doc[CK_LEGACY.ptbCrossings] as number | undefined,
      minAssetPrice: doc[CK_LEGACY.minAssetPrice] as number | undefined,
      maxAssetPrice: doc[CK_LEGACY.maxAssetPrice] as number | undefined,
      assetRange: doc[CK_LEGACY.assetRange] as number | undefined,
      rangeTop: doc[CK_LEGACY.rangeTop] as number | undefined,
      rangeBottom: doc[CK_LEGACY.rangeBottom] as number | undefined,
    });
  }

  return expandChainlinkDerived({
    _id: String(doc._id),
    windowStart: Number(doc[CK.windowStart]),
    windowEnd: Number(doc.windowEnd ?? 0),
    tMs: Number(doc[CK.tMs]),
    assetPrice: doc[CK.assetPrice] as number | undefined,
    prevCloseAsset: doc[CK.prevCloseAsset] as number | undefined,
    ptbCrossings: doc[CK.ptbCrossings] as number | undefined,
    minAssetPrice: doc[CK.minAssetPrice] as number | undefined,
    maxAssetPrice: doc[CK.maxAssetPrice] as number | undefined,
  });
}

export function isStoredChainlinkTick(doc: StoredTickDocument): boolean {
  if (doc[TK.type] === TickType.chainlink) return true;
  if (doc[TK.type] === TickType.book) return false;
  if (doc.source === "chainlink-tick") return true;
  if (doc.assetPrice != null && doc.yesBid == null && doc.yesPrice == null) return true;
  if (isLegacyCompactChainlink(doc)) return true;
  if (
    isCompactStored(doc) &&
    doc[BK.yesBid] == null &&
    doc[BK.noPrice] == null &&
    (doc[CK.maxAssetPrice] != null || doc[CK_LEGACY.maxAssetPrice] != null)
  ) {
    return true;
  }
  return false;
}

export function fromStoredTick(
  doc: StoredTickDocument,
): BookTickDocument | ChainlinkTickDocument {
  return isStoredChainlinkTick(doc) ? fromStoredChainlinkTick(doc) : fromStoredBookTick(doc);
}

export function windowStartFilter(windowStart: number): Record<string, unknown> {
  return {
    $or: [{ windowStart }, { [BK.windowStart]: windowStart }, { [CK.windowStart]: windowStart }],
  };
}

export function windowStartBeforeFilter(cutoff: number): Record<string, unknown> {
  return {
    $or: [
      { windowStart: { $lt: cutoff } },
      { [BK.windowStart]: { $lt: cutoff } },
      { [CK.windowStart]: { $lt: cutoff } },
    ],
  };
}

export function tickTiming(tMs: number, windowStart: number): { t: number; elapsedSec: number } {
  return {
    t: Math.floor(tMs / 1000),
    elapsedSec: roundTo4(tMs / 1000 - windowStart),
  };
}
