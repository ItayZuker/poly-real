import { OrderType, Side, type TickSize } from "@polymarket/clob-client-v2";
import { createPublicClient, getClobHost, getChainId, getMarketInfo } from "./clob-service.js";
import { fetchCurrentUpDownMarket } from "./market-pair.js";
import { logService } from "./log-service.js";
import { getTradingClient, isTradingConfigured } from "./trading-client.js";
import type { LiveWindowState } from "./types.js";

export type TradeSide = "up" | "down";
export type TradeLeg = "buy" | "sell";
export type OrderSizeUnit = "shares" | "usdc";
export type MarketOrderType = "FOK" | "FAK";

export interface PlaceOrderInput {
  series: string;
  side: TradeSide;
  leg: TradeLeg;
  /** Share count or USDC amount depending on sizeUnit (sells are always shares). */
  size: number;
  sizeUnit?: OrderSizeUnit;
  /** Immediate market style; default FOK. */
  orderType?: MarketOrderType;
  state?: LiveWindowState;
}

export interface PlaceLimitOrderInput {
  series: string;
  side: TradeSide;
  /** Share count. */
  size: number;
  /** Limit price in 0–1. */
  price: number;
  /** Unix seconds expiration for GTD. */
  expirationSec: number;
  state?: LiveWindowState;
}

export interface PlaceOrderResult {
  success: boolean;
  orderId?: string;
  error?: string;
  fillPrice?: number;
  fillShares?: number;
  usdcAmount?: number;
  tokenId?: string;
  conditionId?: string;
  slug?: string;
  /** Resting / live order (GTD) that did not fill immediately. */
  resting?: boolean;
  status?: string;
}

export interface OpenOrderSnapshot {
  orderId: string;
  status: string;
  originalSize: number;
  sizeMatched: number;
  price: number;
  side: string;
  assetId?: string;
  market?: string;
}

function tokenForSide(
  pair: Awaited<ReturnType<typeof fetchCurrentUpDownMarket>>,
  side: TradeSide,
): string {
  return side === "up" ? pair.yesTokenId : pair.noTokenId;
}

function quotePrice(state: LiveWindowState | undefined, side: TradeSide, leg: TradeLeg): number | undefined {
  if (!state) return undefined;
  if (side === "up") return leg === "buy" ? state.yesAsk : state.yesBid;
  return leg === "buy" ? state.noAsk : state.noBid;
}

function num(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(n) ? n : undefined;
}

function toClobMarketType(orderType: MarketOrderType | undefined): typeof OrderType.FOK | typeof OrderType.FAK {
  return orderType === "FAK" ? OrderType.FAK : OrderType.FOK;
}

/** Best-effort parse of fill size/price from CLOB market-order response. */
function parseFillFromResponse(
  resp: Record<string, unknown> | null | undefined,
  leg: TradeLeg,
  refPrice: number,
  requestedShares: number,
  usdcAmount: number | undefined,
): { fillPrice: number; fillShares: number; usdcAmount?: number } {
  if (!resp || typeof resp !== "object") {
    return {
      fillPrice: refPrice,
      fillShares: requestedShares,
      usdcAmount: leg === "buy" ? usdcAmount : undefined,
    };
  }

  const taking = num(resp.takingAmount);
  const making = num(resp.makingAmount);

  // BUY: spend `making` USDC, receive `taking` shares
  // SELL: sell `making` shares, receive `taking` USDC
  if (leg === "buy" && taking != null && taking > 0 && making != null && making > 0) {
    return {
      fillPrice: making / taking,
      fillShares: taking,
      usdcAmount: making,
    };
  }
  if (leg === "sell" && taking != null && taking > 0 && making != null && making > 0) {
    return {
      fillPrice: taking / making,
      fillShares: making,
      usdcAmount: taking,
    };
  }

  const avgPrice = num(resp.avgPrice) ?? num(resp.price) ?? refPrice;
  const filled = num(resp.sizeMatched) ?? num(resp.filledSize) ?? requestedShares;
  return {
    fillPrice: avgPrice,
    fillShares: filled,
    usdcAmount:
      leg === "buy"
        ? usdcAmount ?? filled * avgPrice
        : taking ?? filled * avgPrice,
  };
}

function resolveBuyUsdcAmount(size: number, sizeUnit: OrderSizeUnit, refPrice: number): number {
  if (sizeUnit === "usdc") {
    return Math.max(0.01, Math.round(size * 100) / 100);
  }
  // Shares mode: spend just enough USDC to target ~size shares at the reference ask.
  const notional = size * refPrice;
  return Math.max(0.01, Math.round(notional * 100) / 100);
}

function estimatedSharesFromBuy(size: number, sizeUnit: OrderSizeUnit, refPrice: number, usdcAmount: number): number {
  if (sizeUnit === "shares") return size;
  if (refPrice <= 0) return size;
  return Math.max(1, Math.round((usdcAmount / refPrice) * 1000) / 1000);
}

function parseOpenOrder(raw: Record<string, unknown> | null | undefined, fallbackId = ""): OpenOrderSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const orderId = String(raw.id ?? raw.orderID ?? raw.orderId ?? fallbackId);
  if (!orderId) return null;
  return {
    orderId,
    status: String(raw.status ?? ""),
    originalSize: num(raw.original_size) ?? num(raw.originalSize) ?? 0,
    sizeMatched: num(raw.size_matched) ?? num(raw.sizeMatched) ?? 0,
    price: num(raw.price) ?? 0,
    side: String(raw.side ?? ""),
    assetId: raw.asset_id != null ? String(raw.asset_id) : raw.assetId != null ? String(raw.assetId) : undefined,
    market: raw.market != null ? String(raw.market) : undefined,
  };
}

export async function placeMarketOrder(
  userId: string,
  input: PlaceOrderInput,
): Promise<PlaceOrderResult> {
  if (!isTradingConfigured(userId)) {
    return { success: false, error: "Trading account not configured" };
  }

  const client = getTradingClient(userId);
  if (!client) {
    return { success: false, error: "Trading client not initialized" };
  }

  const size = Number(input.size);
  if (!Number.isFinite(size) || size <= 0) {
    return { success: false, error: "Invalid order size" };
  }

  const sizeUnit: OrderSizeUnit =
    input.leg === "sell" ? "shares" : input.sizeUnit === "usdc" ? "usdc" : "shares";
  const clobOrderType = toClobMarketType(input.orderType);

  try {
    const pair = await fetchCurrentUpDownMarket(input.series);
    const tokenID = tokenForSide(pair, input.side);
    const publicClient = await createPublicClient(getClobHost(), getChainId());
    const info = await getMarketInfo(publicClient, tokenID);
    const tickSize = (info.tickSize ?? "0.01") as TickSize;
    const negRisk = info.negRisk ?? false;

    const refPrice = quotePrice(input.state, input.side, input.leg) ?? info.bestAsk ?? info.bestBid;
    if (refPrice == null || !Number.isFinite(refPrice) || refPrice <= 0) {
      return { success: false, error: "No quote available" };
    }

    const clobSide = input.leg === "buy" ? Side.BUY : Side.SELL;
    // CLOB market BUY amount = USDC; market SELL amount = shares.
    const amount =
      input.leg === "buy"
        ? resolveBuyUsdcAmount(size, sizeUnit, refPrice)
        : Math.max(1, Math.floor(size));

    const requestedShares =
      input.leg === "buy"
        ? estimatedSharesFromBuy(size, sizeUnit, refPrice, amount)
        : amount;

    const resp = (await client.createAndPostMarketOrder(
      {
        tokenID,
        amount,
        side: clobSide,
        orderType: clobOrderType,
      },
      { tickSize, negRisk },
      clobOrderType,
    )) as Record<string, unknown> | null;

    if (resp?.success === false || resp?.errorMsg) {
      const err = String(resp?.errorMsg ?? resp?.error ?? "Order rejected");
      logService.error("trading", `${input.leg} ${input.side} failed: ${err}`);
      return { success: false, error: err };
    }

    const fill = parseFillFromResponse(
      resp,
      input.leg,
      refPrice,
      requestedShares,
      input.leg === "buy" ? amount : undefined,
    );

    // FAK may return success with zero fill if nothing available.
    if (!(fill.fillShares > 0)) {
      const err = `${clobOrderType} order not filled`;
      logService.warn("trading", `${input.leg} ${input.side}: ${err}`);
      return { success: false, error: err };
    }

    logService.success(
      "trading",
      `${input.leg.toUpperCase()} ${input.side.toUpperCase()} (${clobOrderType}): ${fill.fillShares} sh @ ~${(fill.fillPrice * 100).toFixed(1)}¢` +
        (input.leg === "buy" ? ` (~$${amount.toFixed(2)} ${sizeUnit === "shares" ? "for " + size + " sh target" : "USDC"})` : ""),
    );

    return {
      success: true,
      orderId: String(resp?.orderID ?? resp?.orderId ?? ""),
      fillPrice: fill.fillPrice,
      fillShares: fill.fillShares,
      usdcAmount: fill.usdcAmount,
      tokenId: tokenID,
      conditionId: pair.conditionId,
      slug: pair.slug,
      status: resp?.status != null ? String(resp.status) : undefined,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logService.error("trading", `${input.leg} ${input.side} error: ${message}`);
    return { success: false, error: message };
  }
}

/** Place a resting GTD limit buy (shares @ price) that expires at expirationSec. */
export async function placeLimitGtdBuy(
  userId: string,
  input: PlaceLimitOrderInput,
): Promise<PlaceOrderResult> {
  if (!isTradingConfigured(userId)) {
    return { success: false, error: "Trading account not configured" };
  }

  const client = getTradingClient(userId);
  if (!client) {
    return { success: false, error: "Trading client not initialized" };
  }

  const size = Math.max(1, Math.floor(Number(input.size)));
  const price = Number(input.price);
  const expiration = Math.floor(Number(input.expirationSec));
  if (!Number.isFinite(price) || price <= 0 || price >= 1) {
    return { success: false, error: "Invalid limit price" };
  }
  if (!Number.isFinite(expiration) || expiration <= 0) {
    return { success: false, error: "Invalid expiration" };
  }

  try {
    const pair = await fetchCurrentUpDownMarket(input.series);
    const tokenID = tokenForSide(pair, input.side);
    const publicClient = await createPublicClient(getClobHost(), getChainId());
    const info = await getMarketInfo(publicClient, tokenID);
    const tickSize = (info.tickSize ?? "0.01") as TickSize;
    const negRisk = info.negRisk ?? false;

    const resp = (await client.createAndPostOrder(
      {
        tokenID,
        price,
        size,
        side: Side.BUY,
        expiration,
      },
      { tickSize, negRisk },
      OrderType.GTD,
    )) as Record<string, unknown> | null;

    if (resp?.success === false || resp?.errorMsg) {
      const err = String(resp?.errorMsg ?? resp?.error ?? "Order rejected");
      logService.error("trading", `GTD buy ${input.side} failed: ${err}`);
      return { success: false, error: err };
    }

    const orderId = String(resp?.orderID ?? resp?.orderId ?? "");
    const status = resp?.status != null ? String(resp.status) : "";
    const fill = parseFillFromResponse(resp, "buy", price, size, size * price);
    const immediateFill = fill.fillShares > 0 && (status === "matched" || Boolean(resp?.takingAmount));

    logService.success(
      "trading",
      immediateFill
        ? `GTD BUY ${input.side.toUpperCase()} filled: ${fill.fillShares} sh @ ~${(fill.fillPrice * 100).toFixed(1)}¢`
        : `GTD BUY ${input.side.toUpperCase()} resting: ${size} sh @ ${(price * 100).toFixed(0)}¢ (exp ${expiration})`,
    );

    return {
      success: true,
      orderId,
      fillPrice: immediateFill ? fill.fillPrice : undefined,
      fillShares: immediateFill ? fill.fillShares : undefined,
      usdcAmount: immediateFill ? fill.usdcAmount : undefined,
      tokenId: tokenID,
      conditionId: pair.conditionId,
      slug: pair.slug,
      resting: !immediateFill,
      status,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logService.error("trading", `GTD buy ${input.side} error: ${message}`);
    return { success: false, error: message };
  }
}

export async function cancelOpenOrder(
  userId: string,
  orderId: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!orderId) return { ok: false, error: "Missing order id" };
  const client = getTradingClient(userId);
  if (!client) return { ok: false, error: "Trading client not initialized" };
  try {
    await client.cancelOrder({ orderID: orderId });
    logService.info("trading", `Cancelled order ${orderId.slice(0, 10)}…`);
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logService.warn("trading", `Cancel ${orderId.slice(0, 10)}… failed: ${message}`);
    return { ok: false, error: message };
  }
}

export async function fetchOpenOrder(
  userId: string,
  orderId: string,
): Promise<OpenOrderSnapshot | null> {
  if (!orderId) return null;
  const client = getTradingClient(userId);
  if (!client) return null;
  try {
    const raw = (await client.getOrder(orderId)) as unknown as Record<string, unknown> | null;
    return parseOpenOrder(raw, orderId);
  } catch (err) {
    logService.warn("trading", `getOrder ${orderId.slice(0, 10)}… failed: ${String(err)}`);
    return null;
  }
}
