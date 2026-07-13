import { fetchWithTimeout, sleepMs } from "./fetch-timeout.js";
import { fetchMarketPairFromSlug } from "./market-pair.js";
import { registerWindowTraders } from "./wallet-registry.js";

const DATA_API_BASE = "https://data-api.polymarket.com";
const TRADES_PAGE_SIZE = 500;
const MAX_TRADE_PAGES = 20;
const POST_WINDOW_SETTLE_MS = 2_000;

interface PolymarketTrade {
  proxyWallet?: string;
  timestamp?: number | string;
  slug?: string;
}

function tradeTimestampSec(trade: PolymarketTrade): number | null {
  const raw = trade.timestamp;
  if (raw == null) return null;
  const value = typeof raw === "string" ? Number(raw) : raw;
  if (!Number.isFinite(value)) return null;
  return value > 1_000_000_000_000 ? Math.floor(value / 1000) : Math.floor(value);
}

function normalizeConditionId(conditionId: string): string {
  const trimmed = conditionId.trim();
  if (!trimmed) return trimmed;
  return trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
}

async function fetchTradesPage(
  conditionId: string,
  offset: number,
): Promise<PolymarketTrade[]> {
  const params = new URLSearchParams({
    market: normalizeConditionId(conditionId),
    limit: String(TRADES_PAGE_SIZE),
    offset: String(offset),
    takerOnly: "false",
  });
  const res = await fetchWithTimeout(`${DATA_API_BASE}/trades?${params.toString()}`, {
    timeoutMs: 20_000,
  });
  if (!res.ok) {
    throw new Error(`Polymarket Data API trades error (${res.status})`);
  }
  const payload = (await res.json()) as unknown;
  if (!Array.isArray(payload)) return [];
  return payload as PolymarketTrade[];
}

function tradeBelongsToWindow(
  trade: PolymarketTrade,
  windowStart: number,
  windowEnd: number,
  slug?: string,
): boolean {
  if (slug && trade.slug) {
    return trade.slug === slug;
  }

  const ts = tradeTimestampSec(trade);
  if (ts == null) return false;
  return ts >= windowStart && ts < windowEnd;
}

export async function resolveConditionIdForSlug(slug: string): Promise<string | undefined> {
  const trimmed = slug.trim();
  if (!trimmed) return undefined;
  const pair = await fetchMarketPairFromSlug(trimmed);
  return pair.conditionId;
}

export async function listUniqueTradersForWindow(options: {
  conditionId: string;
  windowStart: number;
  windowEnd: number;
  slug?: string;
  waitForSettle?: boolean;
}): Promise<string[]> {
  const { conditionId, windowStart, windowEnd, slug, waitForSettle = true } = options;
  if (waitForSettle) {
    await sleepMs(POST_WINDOW_SETTLE_MS);
  }

  const wallets = new Set<string>();
  let offset = 0;

  for (let page = 0; page < MAX_TRADE_PAGES; page += 1) {
    const trades = await fetchTradesPage(conditionId, offset);
    if (trades.length === 0) break;

    for (const trade of trades) {
      if (!tradeBelongsToWindow(trade, windowStart, windowEnd, slug)) continue;

      const wallet = trade.proxyWallet?.trim().toLowerCase();
      if (wallet) wallets.add(wallet);
    }

    if (trades.length < TRADES_PAGE_SIZE) break;
    offset += TRADES_PAGE_SIZE;
  }

  return [...wallets];
}

export async function countUniqueTradersForWindow(options: {
  conditionId: string;
  windowStart: number;
  windowEnd: number;
  slug?: string;
  waitForSettle?: boolean;
}): Promise<number> {
  const wallets = await listUniqueTradersForWindow(options);
  return wallets.length;
}

export async function enrichWindowWithUniqueTraders<T extends {
  windowStart: number;
  windowEnd: number;
  slug?: string;
  conditionId?: string;
  uniqueTraders?: number;
  newWallets?: number;
  knownWallets?: number;
}>(
  window: T,
  marketSeries: string,
  options?: { force?: boolean; waitForSettle?: boolean },
): Promise<T> {
  if (
    !options?.force &&
    window.uniqueTraders != null &&
    Number.isFinite(window.uniqueTraders) &&
    window.newWallets != null &&
    window.knownWallets != null
  ) {
    return window;
  }

  const conditionId =
    window.conditionId ??
    (window.slug ? await resolveConditionIdForSlug(window.slug) : undefined);
  if (!conditionId) return window;

  try {
    const wallets = await listUniqueTradersForWindow({
      conditionId,
      windowStart: window.windowStart,
      windowEnd: window.windowEnd,
      slug: window.slug,
      waitForSettle: options?.waitForSettle ?? true,
    });
    const { newWallets, knownWallets } = await registerWindowTraders(marketSeries, wallets);
    return {
      ...window,
      conditionId,
      uniqueTraders: wallets.length,
      newWallets,
      knownWallets,
    };
  } catch {
    return conditionId !== window.conditionId ? { ...window, conditionId } : window;
  }
}
