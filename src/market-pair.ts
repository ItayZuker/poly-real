import { fetchWithTimeout } from "./fetch-timeout.js";

export interface MarketPairInfo {
  question: string;
  slug: string;
  yesTokenId: string;
  noTokenId: string;
  conditionId?: string;
  yesPrice?: number;
  noPrice?: number;
  negRisk?: boolean;
  windowStart?: number;
  windowEnd?: number;
  eventStartTimeIso?: string;
  eventEndTimeIso?: string;
}

const UP_DOWN_DURATIONS: Record<string, number> = {
  "5m": 300,
  "15m": 900,
};

const UP_DOWN_ASSETS = new Set(["btc", "eth", "sol"]);

const UP_DOWN_SERIES_SLUG: Record<string, Record<string, string>> = {
  btc: { "5m": "btc-up-or-down-5m", "15m": "btc-up-or-down-15m" },
  eth: { "5m": "eth-up-or-down-5m", "15m": "eth-up-or-down-15m" },
  sol: { "5m": "sol-up-or-down-5m", "15m": "sol-up-or-down-15m" },
};

function parseJsonArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function parseIsoToUnixSeconds(value: unknown): number | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return undefined;
  return Math.floor(ms / 1000);
}

function parseMarketRecord(record: Record<string, unknown>): MarketPairInfo | null {
  const tokens = parseJsonArray<string>(record.clobTokenIds);
  if (tokens.length < 2) return null;

  const prices = parseJsonArray<string>(record.outcomePrices).map(Number);
  const eventStartTimeIso =
    typeof record.eventStartTime === "string" && record.eventStartTime
      ? record.eventStartTime
      : undefined;
  const eventEndTimeIso =
    typeof record.endDate === "string" && record.endDate ? record.endDate : undefined;

  return {
    question: String(record.question ?? ""),
    slug: String(record.slug ?? ""),
    yesTokenId: tokens[0],
    noTokenId: tokens[1],
    conditionId:
      typeof record.conditionId === "string" && record.conditionId.trim()
        ? record.conditionId.trim()
        : undefined,
    yesPrice: Number.isFinite(prices[0]) ? prices[0] : undefined,
    noPrice: Number.isFinite(prices[1]) ? prices[1] : undefined,
    negRisk: record.negRisk != null ? Boolean(record.negRisk) : undefined,
    eventStartTimeIso,
    eventEndTimeIso,
    windowStart: eventStartTimeIso ? parseIsoToUnixSeconds(eventStartTimeIso) : undefined,
    windowEnd: eventEndTimeIso ? parseIsoToUnixSeconds(eventEndTimeIso) : undefined,
  };
}

async function fetchJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetchWithTimeout(url, { signal });
  if (!res.ok) {
    throw new Error(`Gamma API error (${res.status})`);
  }
  return res.json();
}

export async function fetchMarketPairFromSlug(
  slug: string,
  signal?: AbortSignal,
): Promise<MarketPairInfo> {
  const trimmed = slug.trim().replace(/^\/+|\/+$/g, "");
  if (!trimmed) {
    throw new Error("Market slug is required");
  }

  const slugOnly = trimmed.includes("polymarket.com")
    ? trimmed.split("/").filter(Boolean).pop() ?? trimmed
    : trimmed;

  const events = (await fetchJson(
    `https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slugOnly)}`,
    signal,
  )) as Record<string, unknown>[];

  if (Array.isArray(events) && events[0]?.markets) {
    const markets = events[0].markets as Record<string, unknown>[];
    if (markets.length === 1) {
      const pair = parseMarketRecord(markets[0]);
      if (pair) return pair;
    }
    if (markets.length > 1) {
      throw new Error(
        `Event has ${markets.length} markets — use a specific market slug from polymarket.com/market/...`,
      );
    }
  }

  const markets = (await fetchJson(
    `https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(slugOnly)}`,
    signal,
  )) as Record<string, unknown>[];

  if (!Array.isArray(markets) || markets.length === 0) {
    throw new Error(`No market found for slug: ${slugOnly}`);
  }

  const pair = parseMarketRecord(markets[0]);
  if (!pair) {
    throw new Error("Market found but clobTokenIds are missing");
  }
  return pair;
}

export function parseMarketSeries(series: string): { asset: string; timeframe: string } {
  const trimmed = series.trim().toLowerCase();

  const fromSlug = trimmed.match(/^([a-z]+)-updown-(5m|15m)-\d+$/);
  if (fromSlug) {
    return { asset: fromSlug[1], timeframe: fromSlug[2] };
  }

  const fromSeries = trimmed.match(/^([a-z]+)-(5m|15m)$/);
  if (fromSeries && UP_DOWN_ASSETS.has(fromSeries[1])) {
    return { asset: fromSeries[1], timeframe: fromSeries[2] };
  }

  throw new Error(
    `Unknown market series "${series}". Use btc-5m, eth-5m, sol-5m, btc-15m, eth-15m, or sol-15m.`,
  );
}

export function canonicalMarketSeries(series: string): string {
  const trimmed = series.trim();
  if (!trimmed) return "";
  try {
    const { asset, timeframe } = parseMarketSeries(trimmed);
    return `${asset}-${timeframe}`;
  } catch {
    return trimmed.toLowerCase();
  }
}

export function formatTimeframeLabel(timeframe: string): string {
  const seconds = UP_DOWN_DURATIONS[timeframe];
  if (!seconds) return timeframe;
  const minutes = seconds / 60;
  return minutes >= 60 ? `${minutes / 60} hour` : `${minutes} min`;
}

export function getUpDownWindowStart(timeframe: string, nowSeconds = Math.floor(Date.now() / 1000)): number {
  const duration = UP_DOWN_DURATIONS[timeframe];
  if (!duration) {
    throw new Error(`Unsupported timeframe: ${timeframe}`);
  }
  return Math.floor(nowSeconds / duration) * duration;
}

export function getUpDownDuration(timeframe: string): number {
  const duration = UP_DOWN_DURATIONS[timeframe];
  if (!duration) {
    throw new Error(`Unsupported timeframe: ${timeframe}`);
  }
  return duration;
}

export function buildUpDownSlug(asset: string, timeframe: string, windowStart: number): string {
  return `${asset}-updown-${timeframe}-${windowStart}`;
}

export function getUpDownSeriesSlug(asset: string, timeframe: string): string {
  const slug = UP_DOWN_SERIES_SLUG[asset.toLowerCase()]?.[timeframe];
  if (!slug) {
    throw new Error(`No Polymarket series slug for ${asset}-${timeframe}`);
  }
  return slug;
}

export function isUpDownWindowActive(
  pair: Pick<MarketPairInfo, "windowStart" | "windowEnd">,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  return (
    pair.windowStart != null &&
    pair.windowEnd != null &&
    nowSeconds >= pair.windowStart &&
    nowSeconds < pair.windowEnd
  );
}

export interface FetchUpDownMarketRetryOptions {
  maxWaitMs?: number;
  intervalMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function resolveMarketWindowBounds(
  pair: Pick<MarketPairInfo, "windowStart" | "windowEnd" | "eventStartTimeIso" | "eventEndTimeIso">,
  fallbackStart: number,
  duration: number,
): { windowStart: number; windowEnd: number } {
  const windowStart =
    pair.windowStart ??
    (pair.eventStartTimeIso ? parseIsoToUnixSeconds(pair.eventStartTimeIso) : undefined) ??
    fallbackStart;
  const windowEnd =
    pair.windowEnd ??
    (pair.eventEndTimeIso ? parseIsoToUnixSeconds(pair.eventEndTimeIso) : undefined) ??
    windowStart + duration;

  return { windowStart, windowEnd };
}

export async function fetchUpDownMarketAtWindow(
  series: string,
  windowStart: number,
  signal?: AbortSignal,
): Promise<MarketPairInfo> {
  const { asset, timeframe } = parseMarketSeries(series);
  const duration = UP_DOWN_DURATIONS[timeframe];
  const pair = await fetchMarketPairFromSlug(
    buildUpDownSlug(asset, timeframe, windowStart),
    signal,
  );
  const bounds = resolveMarketWindowBounds(pair, windowStart, duration);
  return {
    ...pair,
    eventStartTimeIso: pair.eventStartTimeIso,
    eventEndTimeIso: pair.eventEndTimeIso,
    windowStart: bounds.windowStart,
    windowEnd: bounds.windowEnd,
  };
}

async function fetchCurrentUpDownFromSeries(
  series: string,
  nowSeconds: number,
): Promise<MarketPairInfo | null> {
  const { asset, timeframe } = parseMarketSeries(series);
  const duration = UP_DOWN_DURATIONS[timeframe];
  const seriesSlug = getUpDownSeriesSlug(asset, timeframe);

  const events = (await fetchJson(
    `https://gamma-api.polymarket.com/events?series_slug=${encodeURIComponent(seriesSlug)}&active=true&closed=false&limit=40&order=startTime&ascending=false`,
  )) as Record<string, unknown>[];

  if (!Array.isArray(events)) return null;

  for (const event of events) {
    const markets = event.markets as Record<string, unknown>[] | undefined;
    const market = markets?.[0];
    if (!market) continue;

    const pair = parseMarketRecord(market);
    if (!pair) continue;

    const bounds = resolveMarketWindowBounds(pair, 0, duration);
    const loaded: MarketPairInfo = {
      ...pair,
      windowStart: bounds.windowStart,
      windowEnd: bounds.windowEnd,
    };

    if (isUpDownWindowActive(loaded, nowSeconds)) {
      return loaded;
    }
  }

  return null;
}

export async function fetchCurrentUpDownMarket(series: string): Promise<MarketPairInfo> {
  const { timeframe } = parseMarketSeries(series);
  const duration = UP_DOWN_DURATIONS[timeframe];
  const nowSeconds = Math.floor(Date.now() / 1000);
  const baseStart = getUpDownWindowStart(timeframe, nowSeconds);

  const loadWindow = async (start: number): Promise<MarketPairInfo> =>
    fetchUpDownMarketAtWindow(series, start);

  const tryStarts = [
    baseStart,
    baseStart - duration,
    baseStart + duration,
  ];

  let lastError: Error | undefined;
  for (const start of [...new Set(tryStarts)]) {
    try {
      const loaded = await loadWindow(start);
      if (isUpDownWindowActive(loaded, nowSeconds)) {
        return loaded;
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  const fromSeries = await fetchCurrentUpDownFromSeries(series, nowSeconds);
  if (fromSeries) return fromSeries;

  throw lastError ?? new Error(`No current market for ${series}`);
}

export async function fetchCurrentUpDownMarketWithRetry(
  series: string,
  options: FetchUpDownMarketRetryOptions = {},
): Promise<MarketPairInfo> {
  const maxWaitMs = options.maxWaitMs ?? 30_000;
  const intervalMs = options.intervalMs ?? 500;
  const deadline = Date.now() + maxWaitMs;
  let lastError: Error | undefined;

  while (Date.now() < deadline) {
    try {
      return await fetchCurrentUpDownMarket(series);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(intervalMs, remaining));
    }
  }

  throw lastError ?? new Error(`Could not load market for ${series}`);
}
