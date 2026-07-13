import { ClobClient } from "@polymarket/clob-client-v2";

const DEFAULT_HOST = "https://clob.polymarket.com";
const DEFAULT_CHAIN_ID = 137;

export interface BookLevel {
  price: number;
  size: number;
}

export interface MarketInfo {
  tokenId: string;
  tickSize: string;
  negRisk: boolean;
  midpoint?: number;
  bestBid?: number;
  bestAsk?: number;
  bestBidSize?: number;
  bestAskSize?: number;
  lastTradePrice?: number;
  bids?: BookLevel[];
  asks?: BookLevel[];
}

function parsePrice(value: unknown): number | undefined {
  if (value == null) return undefined;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["mid", "price", "midpoint"]) {
      if (key in record) {
        return parsePrice(record[key]);
      }
    }
  }
  return undefined;
}

function parseBookSize(value: unknown): number {
  if (value == null) return 0;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

type RawBookLevel = { price?: unknown; size?: unknown };

function topBidLevel(
  bids: RawBookLevel[] | undefined,
): { price: number; size: number } | null {
  if (!bids?.length) return null;
  let bestPrice: number | undefined;
  let bestSize = 0;
  for (const level of bids) {
    const price = parsePrice(level.price);
    const size = parseBookSize(level.size);
    if (price == null || size <= 0) continue;
    if (bestPrice == null || price > bestPrice) {
      bestPrice = price;
      bestSize = size;
    }
  }
  return bestPrice == null ? null : { price: bestPrice, size: bestSize };
}

function topAskLevel(
  asks: RawBookLevel[] | undefined,
): { price: number; size: number } | null {
  if (!asks?.length) return null;
  let bestPrice: number | undefined;
  let bestSize = 0;
  for (const level of asks) {
    const price = parsePrice(level.price);
    const size = parseBookSize(level.size);
    if (price == null || size <= 0) continue;
    if (bestPrice == null || price < bestPrice) {
      bestPrice = price;
      bestSize = size;
    }
  }
  return bestPrice == null ? null : { price: bestPrice, size: bestSize };
}

export function parseBookSide(
  levels: Array<{ price?: unknown; size?: unknown; amount?: unknown }> | undefined,
  side: "bid" | "ask",
): BookLevel[] {
  if (!levels?.length) return [];
  const parsed: BookLevel[] = [];
  for (const level of levels) {
    const price = parsePrice(level.price);
    const size = parseBookSize(level.size ?? level.amount);
    if (price == null) continue;
    parsed.push({ price, size: size > 0 ? size : 0 });
  }
  if (side === "bid") {
    parsed.sort((a, b) => b.price - a.price);
  } else {
    parsed.sort((a, b) => a.price - b.price);
  }
  return parsed;
}

export function mergeBestLevelsIntoDepth(depth: {
  bids: BookLevel[];
  asks: BookLevel[];
  bestBid?: number;
  bestAsk?: number;
  bestBidSize?: number;
  bestAskSize?: number;
}): {
  bids: BookLevel[];
  asks: BookLevel[];
  bestBid?: number;
  bestAsk?: number;
  bestBidSize?: number;
  bestAskSize?: number;
} {
  let bids = [...depth.bids];
  let asks = [...depth.asks];

  if (depth.bestBid != null) {
    const size = depth.bestBidSize ?? bids.find((l) => l.price === depth.bestBid)?.size ?? 0;
    bids = [{ price: depth.bestBid, size }, ...bids.filter((l) => l.price !== depth.bestBid)].sort(
      (a, b) => b.price - a.price,
    );
  }

  if (depth.bestAsk != null) {
    const size = depth.bestAskSize ?? asks.find((l) => l.price === depth.bestAsk)?.size ?? 0;
    asks = [{ price: depth.bestAsk, size }, ...asks.filter((l) => l.price !== depth.bestAsk)].sort(
      (a, b) => a.price - b.price,
    );
  }

  return {
    bids,
    asks,
    bestBid: depth.bestBid,
    bestAsk: depth.bestAsk,
    bestBidSize: depth.bestBidSize,
    bestAskSize: depth.bestAskSize,
  };
}

export function isSuspiciousBook(info: Pick<MarketInfo, "bestBid" | "bestAsk">): boolean {
  const { bestBid, bestAsk } = info;
  if (
    bestBid == null ||
    bestAsk == null ||
    !Number.isFinite(bestBid) ||
    !Number.isFinite(bestAsk)
  ) {
    return false;
  }
  return bestAsk < bestBid || bestAsk - bestBid > 0.5;
}

export async function createPublicClient(
  host?: string,
  chainId?: number,
): Promise<ClobClient> {
  return new ClobClient({
    host: host || DEFAULT_HOST,
    chain: chainId || DEFAULT_CHAIN_ID,
    throwOnError: true,
  });
}

export async function getMarketInfo(
  client: ClobClient,
  tokenId: string,
): Promise<MarketInfo> {
  const [tickSize, negRisk, midpoint, orderBook, lastTradePrice] = await Promise.all([
    client.getTickSize(tokenId),
    client.getNegRisk(tokenId),
    client.getMidpoint(tokenId).catch(() => undefined),
    client.getOrderBook(tokenId).catch(() => undefined),
    client.getLastTradePrice(tokenId).catch(() => undefined),
  ]);

  const bids = parseBookSide(orderBook?.bids, "bid");
  const asks = parseBookSide(orderBook?.asks, "ask");
  const bidLevel = bids[0] ?? topBidLevel(orderBook?.bids);
  const askLevel = asks[0] ?? topAskLevel(orderBook?.asks);

  return {
    tokenId,
    tickSize,
    negRisk,
    midpoint: parsePrice(midpoint),
    bestBid: bidLevel?.price,
    bestAsk: askLevel?.price,
    bestBidSize: bidLevel?.size,
    bestAskSize: askLevel?.size,
    lastTradePrice: parsePrice(lastTradePrice),
    bids,
    asks,
  };
}

export function getClobHost(): string {
  return process.env.CLOB_HOST || DEFAULT_HOST;
}

export function getChainId(): number {
  const raw = process.env.CHAIN_ID;
  if (!raw) return DEFAULT_CHAIN_ID;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : DEFAULT_CHAIN_ID;
}
