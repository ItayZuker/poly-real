import type { WindowOutcome } from "./types.js";

/** Polymarket up/down rule: close at or above open/PTB is Up. */
export function resolveWindowOutcome(
  assetPrice?: number,
  prevCloseAsset?: number,
  assetGap?: number,
): WindowOutcome | undefined {
  if (
    assetPrice != null &&
    Number.isFinite(assetPrice) &&
    prevCloseAsset != null &&
    Number.isFinite(prevCloseAsset)
  ) {
    return assetPrice >= prevCloseAsset ? "up" : "down";
  }
  if (assetGap != null && Number.isFinite(assetGap)) {
    return assetGap >= 0 ? "up" : "down";
  }
  return undefined;
}

export function outcomeFromOpenClose(
  openPrice?: number,
  closePrice?: number,
): WindowOutcome | undefined {
  return resolveWindowOutcome(closePrice, openPrice);
}
