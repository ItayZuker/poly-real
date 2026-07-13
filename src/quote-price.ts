import type { MarketInfo } from "./clob-service.js";

export type QuotePriceSource =
  | "midpoint"
  | "lastTradePrice"
  | "bookMid"
  | "bestBid"
  | "bestAsk"
  | "none";

export interface QuotePrice {
  price?: number;
  source: QuotePriceSource;
}

export const WINDOW_OPEN_GRACE_SECONDS = 15;
export const MIN_TRUSTED_PRICE = 0.15;
export const MAX_TRUSTED_PRICE = 0.85;
export const MIN_DISPLAY_PRICE = 0.02;
export const MAX_DISPLAY_PRICE = 0.98;
export const MAX_TRUSTED_SPREAD = 0.25;
export const MAX_DISPLAY_SPREAD = 0.5;
export const MAX_MIDPOINT_BOOK_GAP = 0.1;
export const DEEP_DISCOUNT_TRIGGER_THRESHOLD = 0.5;

export function isDisplayRangePrice(price: number): boolean {
  return price >= MIN_DISPLAY_PRICE && price <= MAX_DISPLAY_PRICE;
}

export function isTriggerRangePrice(price: number): boolean {
  return isDisplayRangePrice(price);
}

export function getBookMid(info: MarketInfo): number | undefined {
  if (
    info.bestBid == null ||
    info.bestAsk == null ||
    !Number.isFinite(info.bestBid) ||
    !Number.isFinite(info.bestAsk)
  ) {
    return undefined;
  }
  return (info.bestBid + info.bestAsk) / 2;
}

export function isDisplayBookUsable(info: MarketInfo): boolean {
  const { bestBid, bestAsk } = info;
  if (
    bestBid == null ||
    bestAsk == null ||
    !Number.isFinite(bestBid) ||
    !Number.isFinite(bestAsk) ||
    bestAsk < bestBid ||
    bestAsk - bestBid > MAX_DISPLAY_SPREAD
  ) {
    return false;
  }

  const mid = (bestBid + bestAsk) / 2;
  return isDisplayRangePrice(mid);
}

export function pickDisplayPrice(info: MarketInfo): QuotePrice {
  const bookMid = getBookMid(info);
  const displayBookUsable = isDisplayBookUsable(info);

  if (displayBookUsable && bookMid != null) {
    if (
      info.midpoint != null &&
      Number.isFinite(info.midpoint) &&
      isDisplayRangePrice(info.midpoint) &&
      Math.abs(info.midpoint - bookMid) <= MAX_MIDPOINT_BOOK_GAP
    ) {
      return { price: info.midpoint, source: "midpoint" };
    }
    return { price: bookMid, source: "bookMid" };
  }

  if (
    info.midpoint != null &&
    Number.isFinite(info.midpoint) &&
    isDisplayRangePrice(info.midpoint)
  ) {
    return { price: info.midpoint, source: "midpoint" };
  }

  if (
    info.lastTradePrice != null &&
    Number.isFinite(info.lastTradePrice) &&
    isDisplayRangePrice(info.lastTradePrice)
  ) {
    return { price: info.lastTradePrice, source: "lastTradePrice" };
  }

  return { price: undefined, source: "none" };
}

function isDeepDiscountTriggerPrice(price: number): boolean {
  return price <= DEEP_DISCOUNT_TRIGGER_THRESHOLD;
}

export function isQuoteTrustedForTrigger(
  quote: QuotePrice,
  elapsedSeconds: number,
  info: MarketInfo,
): boolean {
  if (quote.price == null || !Number.isFinite(quote.price)) {
    return false;
  }

  if (!isTriggerRangePrice(quote.price)) {
    return false;
  }

  const displayBookOk = isDisplayBookUsable(info);

  if (elapsedSeconds < WINDOW_OPEN_GRACE_SECONDS) {
    if (
      displayBookOk &&
      (quote.source === "bookMid" ||
        quote.source === "bestAsk" ||
        quote.source === "midpoint")
    ) {
      return true;
    }

    if (
      isDeepDiscountTriggerPrice(quote.price) &&
      (quote.source === "lastTradePrice" || quote.source === "midpoint")
    ) {
      return true;
    }

    return false;
  }

  return (
    quote.source === "bookMid" ||
    quote.source === "midpoint" ||
    quote.source === "lastTradePrice" ||
    quote.source === "bestAsk"
  );
}

export function pickTriggerPrice(
  info: MarketInfo,
  elapsedSeconds: number,
): QuotePrice {
  const displayQuote = pickDisplayPrice(info);
  if (isQuoteTrustedForTrigger(displayQuote, elapsedSeconds, info)) {
    return displayQuote;
  }

  if (
    info.bestAsk != null &&
    Number.isFinite(info.bestAsk) &&
    isTriggerRangePrice(info.bestAsk)
  ) {
    const askQuote: QuotePrice = { price: info.bestAsk, source: "bestAsk" };
    if (isQuoteTrustedForTrigger(askQuote, elapsedSeconds, info)) {
      return askQuote;
    }
  }

  return { price: undefined, source: displayQuote.source };
}
