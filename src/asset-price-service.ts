import { getUpDownDuration, type MarketPairInfo } from "./market-pair.js";
import { chainlinkPriceFeed } from "./chainlink-price-feed.js";
import { fetchWithTimeout } from "./fetch-timeout.js";
import { outcomeFromOpenClose } from "./window-outcome.js";
import type { WindowOutcome } from "./types.js";

const CRYPTO_PRICE_API = "https://polymarket.com/api/crypto/crypto-price";
const REST_POLL_CACHE_MS = 1_200;
const OPEN_MATCH_EPSILON = 0.05;
const SETTLEMENT_MAX_WAIT_MS = 20_000;
const SETTLEMENT_RETRY_MS = 500;

const SYMBOL_BY_ASSET: Record<string, string> = {
  btc: "BTC",
  eth: "ETH",
  sol: "SOL",
};

const VARIANT_BY_TIMEFRAME: Record<string, string> = {
  "5m": "five",
  "15m": "fifteen",
};

export interface PolymarketCryptoPriceResponse {
  openPrice?: number;
  closePrice?: number | null;
  timestamp?: number;
  completed?: boolean;
  incomplete?: boolean;
  cached?: boolean;
}

export interface MarketWindowPriceContext {
  eventStartTimeIso: string;
  eventEndTimeIso: string;
  windowStart?: number;
  windowEnd?: number;
}

export type AssetPriceSource = "chainlink-rtds" | "polymarket-rest";
export type PriceToBeatSource =
  | "chainlink-boundary"
  | "polymarket-openPrice"
  | "polymarket-priorClose";

export interface WindowAssetPrices {
  assetPrice?: number;
  prevCloseAsset?: number;
  assetGap?: number;
  assetPriceSource: AssetPriceSource;
  priceToBeatSource: PriceToBeatSource;
}

/** Final window settlement from Polymarket crypto-price open/close (not live RTDS). */
export interface WindowSettlementPrices {
  openPrice: number;
  closePrice: number;
  outcome: WindowOutcome;
  incomplete: boolean;
  assetPrice: number;
  prevCloseAsset: number;
  assetGap: number;
  assetPriceSource: "polymarket-rest";
  priceToBeatSource: "polymarket-openPrice";
}

interface WindowRestCache {
  openPrice: number;
  closePrice?: number;
  incomplete?: boolean;
  fetchedAtMs: number;
}

const windowRestCache = new Map<string, WindowRestCache>();
const inFlight = new Map<string, Promise<WindowAssetPrices>>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function priceCacheKey(asset: string, timeframe: string, eventStartTimeIso: string): string {
  return `${asset.toLowerCase()}:${timeframe}:${eventStartTimeIso}`;
}

function toPolymarketIso(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function normalizePolymarketIso(iso: string): string {
  return iso.replace(/\.\d{3}Z$/, "Z");
}

function parsePrice(value: unknown): number | undefined {
  if (value == null) return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isCryptoPriceComplete(data: PolymarketCryptoPriceResponse): boolean {
  const closePrice = parsePrice(data.closePrice);
  if (closePrice == null) return false;
  if (data.completed === true) return true;
  if (data.incomplete === false) return true;
  return false;
}

function getRtdsLiveAssetPrice(asset: string): number | undefined {
  return chainlinkPriceFeed.getLivePrice(asset.toLowerCase())?.value;
}

function pricesMatch(a: number, b: number): boolean {
  return Math.abs(a - b) <= OPEN_MATCH_EPSILON;
}

function getChainlinkPriceToBeat(
  asset: string,
  timeframe: string,
  window: MarketWindowPriceContext,
): number | undefined {
  if (window.windowStart == null) {
    return undefined;
  }

  const duration = getUpDownDuration(timeframe);
  const prevWindowStart = window.windowStart - duration;
  chainlinkPriceFeed.tryCaptureEarlyWindowOpen(asset, window.windowStart);
  return chainlinkPriceFeed.getPriceToBeat(asset, window.windowStart, prevWindowStart);
}

function resolvePriceToBeat(
  chainlinkPtb: number | undefined,
  rest: WindowRestCache | undefined,
  priorClose: number | undefined,
): { priceToBeat?: number; priceToBeatSource: PriceToBeatSource } {
  if (chainlinkPtb != null) {
    return { priceToBeat: chainlinkPtb, priceToBeatSource: "chainlink-boundary" };
  }

  const apiOpen = rest?.openPrice;
  if (apiOpen != null) {
    const openLooksStale =
      rest?.incomplete !== false &&
      priorClose != null &&
      !pricesMatch(apiOpen, priorClose);

    if (openLooksStale) {
      return { priceToBeat: priorClose, priceToBeatSource: "polymarket-priorClose" };
    }

    return { priceToBeat: apiOpen, priceToBeatSource: "polymarket-openPrice" };
  }

  if (priorClose != null) {
    return { priceToBeat: priorClose, priceToBeatSource: "polymarket-priorClose" };
  }

  return { priceToBeat: undefined, priceToBeatSource: "polymarket-openPrice" };
}

function buildPrices(
  asset: string,
  priceToBeat?: number,
  priceToBeatSource: PriceToBeatSource = "polymarket-openPrice",
  restClosePrice?: number,
): WindowAssetPrices {
  const rtdsPrice = getRtdsLiveAssetPrice(asset);
  const assetPrice = rtdsPrice ?? restClosePrice;
  return {
    assetPrice,
    prevCloseAsset: priceToBeat,
    assetGap:
      assetPrice != null && priceToBeat != null
        ? assetPrice - priceToBeat
        : undefined,
    assetPriceSource: rtdsPrice != null ? "chainlink-rtds" : "polymarket-rest",
    priceToBeatSource,
  };
}

export function applyRtdsLivePrice(
  asset: string,
  prices: WindowAssetPrices,
): WindowAssetPrices {
  const live = getRtdsLiveAssetPrice(asset);
  if (live == null) return prices;
  return {
    ...prices,
    assetPrice: live,
    assetGap:
      prices.prevCloseAsset != null ? live - prices.prevCloseAsset : undefined,
    assetPriceSource: "chainlink-rtds",
  };
}

export function getPolymarketSymbol(asset: string): string {
  const symbol = SYMBOL_BY_ASSET[asset.toLowerCase()];
  if (!symbol) {
    throw new Error(`Unsupported asset for Polymarket crypto price: ${asset}`);
  }
  return symbol;
}

export function getPolymarketVariant(timeframe: string): string {
  const variant = VARIANT_BY_TIMEFRAME[timeframe];
  if (!variant) {
    throw new Error(`Unsupported timeframe for Polymarket crypto price: ${timeframe}`);
  }
  return variant;
}

export function marketPairToPriceContext(pair: MarketPairInfo): MarketWindowPriceContext {
  if (!pair.eventStartTimeIso || !pair.eventEndTimeIso) {
    throw new Error(`Market ${pair.slug} is missing event window times`);
  }
  return {
    eventStartTimeIso: normalizePolymarketIso(pair.eventStartTimeIso),
    eventEndTimeIso: normalizePolymarketIso(pair.eventEndTimeIso),
    windowStart: pair.windowStart,
    windowEnd: pair.windowEnd,
  };
}

async function fetchPolymarketCryptoPriceResponse(
  asset: string,
  timeframe: string,
  eventStartTimeIso: string,
  eventEndTimeIso: string,
  signal?: AbortSignal,
): Promise<PolymarketCryptoPriceResponse> {
  const symbol = getPolymarketSymbol(asset);
  const variant = getPolymarketVariant(timeframe);
  const params = new URLSearchParams({
    symbol,
    variant,
    eventStartTime: normalizePolymarketIso(eventStartTimeIso),
    endDate: normalizePolymarketIso(eventEndTimeIso),
  });

  let lastError: Error | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const res = await fetchWithTimeout(`${CRYPTO_PRICE_API}?${params.toString()}`, {
      signal,
      headers: {
        Accept: "application/json",
        Referer: "https://polymarket.com/",
      },
    });

    if (res.status === 429) {
      lastError = new Error(`Polymarket crypto-price API error (${res.status})`);
      await sleep(350 * (attempt + 1));
      continue;
    }

    if (!res.ok) {
      throw new Error(`Polymarket crypto-price API error (${res.status})`);
    }

    return (await res.json()) as PolymarketCryptoPriceResponse;
  }

  throw lastError ?? new Error("Polymarket crypto-price API error (429)");
}

async function fetchWindowRestPrices(
  asset: string,
  timeframe: string,
  window: MarketWindowPriceContext,
): Promise<WindowRestCache | undefined> {
  const cacheKey = priceCacheKey(asset, timeframe, window.eventStartTimeIso);
  const cached = windowRestCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAtMs < REST_POLL_CACHE_MS) {
    return cached;
  }

  try {
    const data = await fetchPolymarketCryptoPriceResponse(
      asset,
      timeframe,
      window.eventStartTimeIso,
      window.eventEndTimeIso,
    );
    const openPrice = parsePrice(data.openPrice);
    if (openPrice == null) {
      return undefined;
    }

    const next: WindowRestCache = {
      openPrice,
      closePrice: parsePrice(data.closePrice),
      incomplete: data.incomplete,
      fetchedAtMs: Date.now(),
    };
    windowRestCache.set(cacheKey, next);
    return next;
  } catch {
    return undefined;
  }
}

interface PriorCloseCache {
  closePrice: number;
  fetchedAtMs: number;
}

const priorCloseCache = new Map<string, PriorCloseCache>();

function priorCloseCacheKey(asset: string, timeframe: string, windowStartSec: number): string {
  return `${asset.toLowerCase()}:${timeframe}:prior:${windowStartSec}`;
}

async function fetchPriorWindowClosePrice(
  asset: string,
  timeframe: string,
  window: MarketWindowPriceContext,
): Promise<number | undefined> {
  if (window.windowStart == null) {
    return undefined;
  }

  const cacheKey = priorCloseCacheKey(asset, timeframe, window.windowStart);
  const cached = priorCloseCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAtMs < REST_POLL_CACHE_MS) {
    return cached.closePrice;
  }

  try {
    const data = await fetchPolymarketCryptoPriceResponse(
      asset,
      timeframe,
      toPolymarketIso(window.windowStart - getUpDownDuration(timeframe)),
      window.eventStartTimeIso,
    );
    const closePrice = parsePrice(data.closePrice);
    if (closePrice == null) {
      return undefined;
    }

    priorCloseCache.set(cacheKey, { closePrice, fetchedAtMs: Date.now() });
    return closePrice;
  } catch {
    return undefined;
  }
}

async function loadWindowAssetPrices(
  asset: string,
  timeframe: string,
  window: MarketWindowPriceContext,
): Promise<WindowAssetPrices> {
  const chainlinkPtb = getChainlinkPriceToBeat(asset, timeframe, window);
  const [rest, priorClose] = await Promise.all([
    fetchWindowRestPrices(asset, timeframe, window),
    fetchPriorWindowClosePrice(asset, timeframe, window),
  ]);

  const { priceToBeat, priceToBeatSource } = resolvePriceToBeat(
    chainlinkPtb,
    rest,
    priorClose,
  );

  return buildPrices(asset, priceToBeat, priceToBeatSource, rest?.closePrice);
}

export async function getPolymarketWindowAssetPrices(
  asset: string,
  timeframe: string,
  window: MarketWindowPriceContext,
): Promise<WindowAssetPrices> {
  const cacheKey = priceCacheKey(asset, timeframe, window.eventStartTimeIso);
  const pending = inFlight.get(cacheKey);
  if (pending) {
    return pending;
  }

  const request = loadWindowAssetPrices(asset, timeframe, window).finally(() => {
    inFlight.delete(cacheKey);
  });
  inFlight.set(cacheKey, request);
  return request;
}

export async function getPolymarketWindowAssetPricesForPair(
  asset: string,
  timeframe: string,
  pair: MarketPairInfo,
): Promise<WindowAssetPrices> {
  return getPolymarketWindowAssetPrices(asset, timeframe, marketPairToPriceContext(pair));
}

/**
 * Wait for Polymarket's official crypto-price open/close for a finished window.
 * Does not use live Chainlink RTDS — avoids stale feed overriding settlement.
 */
export async function getPolymarketWindowSettlement(
  asset: string,
  timeframe: string,
  window: MarketWindowPriceContext,
  options: { maxWaitMs?: number; intervalMs?: number } = {},
): Promise<WindowSettlementPrices | null> {
  const maxWaitMs = options.maxWaitMs ?? SETTLEMENT_MAX_WAIT_MS;
  const intervalMs = options.intervalMs ?? SETTLEMENT_RETRY_MS;
  const startedAt = Date.now();
  let lastIncomplete: PolymarketCryptoPriceResponse | null = null;

  while (Date.now() - startedAt <= maxWaitMs) {
    try {
      const data = await fetchPolymarketCryptoPriceResponse(
        asset,
        timeframe,
        window.eventStartTimeIso,
        window.eventEndTimeIso,
      );
      const openPrice = parsePrice(data.openPrice);
      const closePrice = parsePrice(data.closePrice);
      lastIncomplete = data;

      if (openPrice != null && closePrice != null && isCryptoPriceComplete(data)) {
        const outcome = outcomeFromOpenClose(openPrice, closePrice);
        if (!outcome) return null;

        const cacheKey = priceCacheKey(asset, timeframe, window.eventStartTimeIso);
        windowRestCache.set(cacheKey, {
          openPrice,
          closePrice,
          incomplete: false,
          fetchedAtMs: Date.now(),
        });

        return {
          openPrice,
          closePrice,
          outcome,
          incomplete: false,
          assetPrice: closePrice,
          prevCloseAsset: openPrice,
          assetGap: closePrice - openPrice,
          assetPriceSource: "polymarket-rest",
          priceToBeatSource: "polymarket-openPrice",
        };
      }
    } catch {
      // retry until timeout
    }

    await sleep(intervalMs);
  }

  const openPrice = parsePrice(lastIncomplete?.openPrice);
  const closePrice = parsePrice(lastIncomplete?.closePrice);
  if (openPrice == null || closePrice == null) return null;
  const outcome = outcomeFromOpenClose(openPrice, closePrice);
  if (!outcome) return null;

  return {
    openPrice,
    closePrice,
    outcome,
    incomplete: true,
    assetPrice: closePrice,
    prevCloseAsset: openPrice,
    assetGap: closePrice - openPrice,
    assetPriceSource: "polymarket-rest",
    priceToBeatSource: "polymarket-openPrice",
  };
}

export async function getPolymarketWindowSettlementForPair(
  asset: string,
  timeframe: string,
  pair: MarketPairInfo,
  options?: { maxWaitMs?: number; intervalMs?: number },
): Promise<WindowSettlementPrices | null> {
  return getPolymarketWindowSettlement(
    asset,
    timeframe,
    marketPairToPriceContext(pair),
    options,
  );
}
