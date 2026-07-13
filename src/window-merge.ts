import type { HeatmapWindowDocument, RecordedWindowDocument } from "./types.js";

function pickDefined<T>(primary: T | undefined, fallback: T | undefined): T | undefined {
  return primary ?? fallback;
}

/** Merge heatmap stats into a window record; window fields win when both are set. */
export function mergeHeatmapIntoRecordedWindow(
  recorded: RecordedWindowDocument | null,
  heatmap: HeatmapWindowDocument,
): Omit<RecordedWindowDocument, "_id" | "updatedAt"> {
  const savedAt = recorded?.savedAt ?? heatmap.savedAt ?? new Date().toISOString();
  return {
    windowStart: recorded?.windowStart ?? heatmap.windowStart,
    windowEnd: recorded?.windowEnd ?? heatmap.windowEnd,
    savedAt,
    slug: recorded?.slug,
    question: recorded?.question,
    conditionId: recorded?.conditionId,
    assetPrice: recorded?.assetPrice,
    prevCloseAsset: recorded?.prevCloseAsset,
    assetGap: recorded?.assetGap,
    windowOutcome: pickDefined(recorded?.windowOutcome, heatmap.windowOutcome),
    yesPrice: recorded?.yesPrice,
    noPrice: recorded?.noPrice,
    ptbCrossings: pickDefined(recorded?.ptbCrossings, heatmap.ptbCrossings),
    minAssetPrice: pickDefined(recorded?.minAssetPrice, heatmap.minAssetPrice),
    maxAssetPrice: pickDefined(recorded?.maxAssetPrice, heatmap.maxAssetPrice),
    assetRange: pickDefined(recorded?.assetRange, heatmap.assetRange),
    rangeTop: pickDefined(recorded?.rangeTop, heatmap.rangeTop),
    rangeBottom: pickDefined(recorded?.rangeBottom, heatmap.rangeBottom),
    uniqueTraders: pickDefined(recorded?.uniqueTraders, heatmap.uniqueTraders),
    newWallets: pickDefined(recorded?.newWallets, heatmap.newWallets),
    knownWallets: pickDefined(recorded?.knownWallets, heatmap.knownWallets),
    tickCount: recorded?.tickCount ?? 0,
    clobRawCount: recorded?.clobRawCount,
    clobBookCount: recorded?.clobBookCount,
    chainlinkCount: recorded?.chainlinkCount,
  };
}
