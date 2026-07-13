import type { WindowHitRecord } from "./types.js";

export const PTB_CROSSING_EPSILON = 0.01;

export type PtbSide = "above" | "below";

export interface WindowDynamicsTracker {
  lastPtbSide: PtbSide | null;
}

export function createWindowDynamicsTracker(): WindowDynamicsTracker {
  return { lastPtbSide: null };
}

export function getPtbSide(
  assetPrice: number,
  prevCloseAsset: number,
  epsilon = PTB_CROSSING_EPSILON,
): PtbSide | null {
  const diff = assetPrice - prevCloseAsset;
  if (Math.abs(diff) <= epsilon) return null;
  return diff > 0 ? "above" : "below";
}

export function syncWindowAssetRange(window: WindowHitRecord): void {
  if (
    window.minAssetPrice != null &&
    window.maxAssetPrice != null &&
    Number.isFinite(window.minAssetPrice) &&
    Number.isFinite(window.maxAssetPrice)
  ) {
    window.assetRange = Math.max(0, window.maxAssetPrice - window.minAssetPrice);
  }
}

export function syncWindowRangeFromPtb(window: WindowHitRecord): void {
  syncWindowAssetRange(window);
  if (window.prevCloseAsset == null || !Number.isFinite(window.prevCloseAsset)) {
    return;
  }
  if (window.maxAssetPrice != null && Number.isFinite(window.maxAssetPrice)) {
    window.rangeTop = Math.max(0, window.maxAssetPrice - window.prevCloseAsset);
  }
  if (window.minAssetPrice != null && Number.isFinite(window.minAssetPrice)) {
    window.rangeBottom = Math.max(0, window.prevCloseAsset - window.minAssetPrice);
  }
}

export function finalizeWindowDynamics(window: WindowHitRecord): void {
  syncWindowRangeFromPtb(window);
}

export function updateWindowDynamics(
  window: WindowHitRecord,
  tracker: WindowDynamicsTracker,
  assetPrice?: number,
  prevCloseAsset?: number,
): void {
  if (
    assetPrice == null ||
    prevCloseAsset == null ||
    !Number.isFinite(assetPrice) ||
    !Number.isFinite(prevCloseAsset)
  ) {
    return;
  }

  if (window.minAssetPrice == null || assetPrice < window.minAssetPrice) {
    window.minAssetPrice = assetPrice;
  }
  if (window.maxAssetPrice == null || assetPrice > window.maxAssetPrice) {
    window.maxAssetPrice = assetPrice;
  }

  window.prevCloseAsset = prevCloseAsset;
  syncWindowRangeFromPtb(window);

  const side = getPtbSide(assetPrice, prevCloseAsset);
  if (side == null) return;

  if (tracker.lastPtbSide != null && tracker.lastPtbSide !== side) {
    window.ptbCrossings = (window.ptbCrossings ?? 0) + 1;
  }
  tracker.lastPtbSide = side;
}

export function getWindowRangeFromPtb(
  window: WindowHitRecord,
  ptbFallback?: number,
): { rangeTop?: number; rangeBottom?: number } {
  const ptb = window.prevCloseAsset ?? ptbFallback;
  if (ptb == null || !Number.isFinite(ptb)) {
    return {
      rangeTop: window.rangeTop,
      rangeBottom: window.rangeBottom,
    };
  }

  const rangeTop =
    window.maxAssetPrice != null && Number.isFinite(window.maxAssetPrice)
      ? Math.max(0, window.maxAssetPrice - ptb)
      : undefined;
  const rangeBottom =
    window.minAssetPrice != null && Number.isFinite(window.minAssetPrice)
      ? Math.max(0, ptb - window.minAssetPrice)
      : undefined;

  return { rangeTop, rangeBottom };
}

export function getWindowAssetRange(window: WindowHitRecord): number | null {
  if (window.assetRange != null && Number.isFinite(window.assetRange)) {
    return window.assetRange;
  }
  if (
    window.minAssetPrice != null &&
    window.maxAssetPrice != null &&
    Number.isFinite(window.minAssetPrice) &&
    Number.isFinite(window.maxAssetPrice)
  ) {
    return Math.max(0, window.maxAssetPrice - window.minAssetPrice);
  }
  return null;
}
