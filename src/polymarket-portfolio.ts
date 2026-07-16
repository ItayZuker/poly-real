import { fetchWithTimeout, sleepMs } from "./fetch-timeout.js";
import { getTradingAccountStatus } from "./trading-client.js";

const DATA_API_BASE = "https://data-api.polymarket.com";

export interface PolymarketTrade {
  proxyWallet?: string;
  side?: "BUY" | "SELL" | string;
  asset?: string;
  conditionId?: string;
  size?: number;
  price?: number;
  timestamp?: number;
  slug?: string;
  outcome?: string;
  transactionHash?: string;
}

export interface PolymarketPosition {
  proxyWallet?: string;
  asset?: string;
  conditionId?: string;
  size?: number;
  avgPrice?: number;
  initialValue?: number;
  currentValue?: number;
  cashPnl?: number;
  realizedPnl?: number;
  curPrice?: number;
  redeemable?: boolean;
  slug?: string;
  outcome?: string;
  outcomeIndex?: number;
}

export interface PolymarketClosedPosition {
  proxyWallet?: string;
  asset?: string;
  conditionId?: string;
  avgPrice?: number;
  totalBought?: number;
  realizedPnl?: number;
  curPrice?: number;
  timestamp?: number;
  slug?: string;
  outcome?: string;
  outcomeIndex?: number;
}

function funderAddress(userId: string): string | undefined {
  const addr = getTradingAccountStatus(userId).funderAddress?.trim();
  return addr || process.env.FUNDER_ADDRESS?.trim() || undefined;
}

async function fetchJsonArray<T>(url: string): Promise<T[]> {
  const res = await fetchWithTimeout(url, { timeoutMs: 12_000 });
  if (!res.ok) {
    throw new Error(`Data API ${res.status}: ${url}`);
  }
  const payload = (await res.json()) as unknown;
  return Array.isArray(payload) ? (payload as T[]) : [];
}

export async function fetchUserTrades(
  userId: string,
  options: {
    asset?: string;
    conditionId?: string;
    limit?: number;
  },
): Promise<PolymarketTrade[]> {
  const user = funderAddress(userId);
  if (!user) return [];
  const params = new URLSearchParams({
    user,
    limit: String(options.limit ?? 25),
  });
  if (options.asset) params.set("asset", options.asset);
  if (options.conditionId) params.set("market", options.conditionId);
  return fetchJsonArray<PolymarketTrade>(`${DATA_API_BASE}/trades?${params}`);
}

export async function fetchUserPositions(
  userId: string,
  options: {
    conditionId?: string;
    sizeThreshold?: number;
  },
): Promise<PolymarketPosition[]> {
  const user = funderAddress(userId);
  if (!user) return [];
  const params = new URLSearchParams({
    user,
    limit: "100",
    sizeThreshold: String(options.sizeThreshold ?? 0),
  });
  if (options.conditionId) params.set("market", options.conditionId);
  return fetchJsonArray<PolymarketPosition>(`${DATA_API_BASE}/positions?${params}`);
}

export async function fetchClosedPositions(
  userId: string,
  options: {
    conditionId?: string;
    limit?: number;
  },
): Promise<PolymarketClosedPosition[]> {
  const user = funderAddress(userId);
  if (!user) return [];
  const params = new URLSearchParams({
    user,
    limit: String(options.limit ?? 20),
    sortBy: "TIMESTAMP",
    sortDirection: "DESC",
  });
  if (options.conditionId) params.set("market", options.conditionId);
  return fetchJsonArray<PolymarketClosedPosition>(
    `${DATA_API_BASE}/closed-positions?${params}`,
  );
}

export async function pollUntil<T>(
  attempt: () => Promise<T | null>,
  options: { attempts?: number; delayMs?: number } = {},
): Promise<T | null> {
  const attempts = options.attempts ?? 6;
  const delayMs = options.delayMs ?? 800;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const result = await attempt();
      if (result != null) return result;
    } catch {
      // retry
    }
    if (i < attempts - 1) await sleepMs(delayMs);
  }
  return null;
}

export function isValidSharePrice(price: unknown): boolean {
  const n = Number(price);
  return Number.isFinite(n) && n > 0 && n <= 1;
}

export function isValidShareSize(size: unknown): boolean {
  const n = Number(size);
  return Number.isFinite(n) && n > 0;
}

export function findTrade(
  trades: PolymarketTrade[],
  opts: {
    side: "BUY" | "SELL";
    asset?: string;
    conditionId?: string;
    afterTs?: number;
  },
): PolymarketTrade | undefined {
  // Never match an unrelated market — require asset and/or conditionId.
  if (!opts.asset && !opts.conditionId) return undefined;

  const afterTs = opts.afterTs ?? 0;
  return trades.find((t) => {
    if (String(t.side || "").toUpperCase() !== opts.side) return false;
    if (opts.asset) {
      if (!t.asset || t.asset !== opts.asset) return false;
    }
    if (opts.conditionId) {
      if (!t.conditionId || t.conditionId !== opts.conditionId) return false;
    }
    const ts = Number(t.timestamp);
    if (Number.isFinite(ts) && ts + 2 < afterTs) return false;
    return isValidShareSize(t.size) && isValidSharePrice(t.price);
  });
}

export function findPosition(
  positions: PolymarketPosition[],
  opts: { asset?: string; conditionId?: string } = {},
): PolymarketPosition | undefined {
  if (!opts.asset && !opts.conditionId) return undefined;
  return positions.find((p) => {
    if (opts.asset) {
      if (!p.asset || p.asset !== opts.asset) return false;
    }
    if (opts.conditionId) {
      if (!p.conditionId || p.conditionId !== opts.conditionId) return false;
    }
    return isValidShareSize(p.size) && isValidSharePrice(p.avgPrice);
  });
}

export function findClosedPosition(
  closed: PolymarketClosedPosition[],
  opts: { asset?: string; conditionId?: string; afterTs?: number },
): PolymarketClosedPosition | undefined {
  if (!opts.asset && !opts.conditionId) return undefined;
  const afterTs = opts.afterTs ?? 0;
  return closed.find((p) => {
    if (opts.asset) {
      if (!p.asset || p.asset !== opts.asset) return false;
    }
    if (opts.conditionId) {
      if (!p.conditionId || p.conditionId !== opts.conditionId) return false;
    }
    const ts = Number(p.timestamp);
    if (Number.isFinite(ts) && ts + 2 < afterTs) return false;
    if (p.realizedPnl == null || !Number.isFinite(Number(p.realizedPnl))) return false;
    // avgPrice can be missing on some closed rows; if present it must be valid
    if (p.avgPrice != null && !isValidSharePrice(p.avgPrice)) return false;
    return true;
  });
}
