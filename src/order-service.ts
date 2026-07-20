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
  /** Maximum execution price for a FAK buy (0–1). */
  maxPrice?: number;
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
  /** Optional tag appended to success logs (e.g. "phase 2", "override"). */
  logTag?: string;
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
  /**
   * True when we cannot prove the order is unfilled (timeout, missing id, unclear status).
   * Callers must not submit another buy until they reconcile on-chain state.
   */
  ambiguous?: boolean;
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

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fillFromOpenOrder(
  snap: OpenOrderSnapshot,
  leg: TradeLeg,
  refPrice: number,
  requestedShares: number,
  usdcAmount: number | undefined,
): { fillPrice: number; fillShares: number; usdcAmount?: number } | null {
  const status = snap.status.toLowerCase();
  const matched = snap.sizeMatched;
  if (!(matched > 0 || status === "matched")) return null;
  const fillShares = matched > 0 ? matched : requestedShares;
  if (!(fillShares > 0)) return null;
  const fillPrice = snap.price > 0 ? snap.price : refPrice;
  return {
    fillPrice,
    fillShares,
    usdcAmount:
      leg === "buy" ? (usdcAmount ?? fillShares * fillPrice) : fillShares * fillPrice,
  };
}

/** Poll CLOB order state after a post when the immediate response is unclear. */
async function resolveOrderFillAfterPost(
  userId: string,
  orderId: string,
  leg: TradeLeg,
  refPrice: number,
  requestedShares: number,
  usdcAmount: number | undefined,
): Promise<{
  outcome: "filled" | "unfilled" | "ambiguous";
  fill?: { fillPrice: number; fillShares: number; usdcAmount?: number };
  status?: string;
}> {
  let lastStatus = "";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const snap = await fetchOpenOrder(userId, orderId);
    if (!snap) {
      await waitMs(250);
      continue;
    }
    lastStatus = snap.status;
    const fill = fillFromOpenOrder(snap, leg, refPrice, requestedShares, usdcAmount);
    if (fill) return { outcome: "filled", fill, status: snap.status };

    const status = snap.status.toLowerCase();
    if (status === "live" || status === "delayed") {
      await waitMs(250);
      continue;
    }
    if (
      status === "cancelled" ||
      status === "canceled" ||
      status === "unmatched" ||
      status === "expired"
    ) {
      return { outcome: "unfilled", status: snap.status };
    }
    break;
  }
  return { outcome: "ambiguous", status: lastStatus || undefined };
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

const MIN_MARKET_BUY_USDC = 1;

function resolveBuyUsdcAmount(size: number, sizeUnit: OrderSizeUnit, refPrice: number): number {
  if (sizeUnit === "usdc") {
    return Math.max(MIN_MARKET_BUY_USDC, Math.ceil(size * 100) / 100);
  }
  // Shares mode: spend enough USDC for the requested shares, while satisfying
  // Polymarket's $1 minimum for marketable BUY orders.
  const notional = size * refPrice;
  return Math.max(MIN_MARKET_BUY_USDC, Math.ceil(notional * 100) / 100);
}

function estimatedSharesFromBuy(size: number, refPrice: number, usdcAmount: number): number {
  if (refPrice <= 0) return size;
  // The submitted BUY amount is USDC. If it was raised to the $1 minimum,
  // reflect the corresponding larger share estimate in fallback fill parsing.
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
    const isCappedFakBuy =
      input.leg === "buy" &&
      input.orderType === "FAK" &&
      input.maxPrice != null &&
      Number.isFinite(input.maxPrice) &&
      input.maxPrice > 0 &&
      input.maxPrice < 1;

    const currentQuote = quotePrice(input.state, input.side, input.leg) ?? info.bestAsk ?? info.bestBid;
    if (isCappedFakBuy && (currentQuote == null || currentQuote > input.maxPrice! + 1e-9)) {
      return { success: false, error: "Ask is above FAK trigger" };
    }
    const refPrice = isCappedFakBuy ? input.maxPrice! : currentQuote;
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
      isCappedFakBuy
        ? size
        : input.leg === "buy"
          ? estimatedSharesFromBuy(size, refPrice, amount)
          : amount;
    const submittedBuyNotional = isCappedFakBuy ? size * refPrice : amount;

    if (input.leg === "buy" && !isCappedFakBuy) {
      const requestedUsdc = sizeUnit === "usdc" ? size : size * refPrice;
      if (amount > requestedUsdc + 1e-9) {
        logService.info(
          "trading",
          `Raised BUY to Polymarket $${MIN_MARKET_BUY_USDC.toFixed(2)} minimum: ` +
            `${requestedShares} sh estimated @ ${(refPrice * 100).toFixed(1)}¢`,
        );
      }
    }

    const resp = (isCappedFakBuy
      ? await client.createOrder(
          {
            tokenID,
            price: input.maxPrice!,
            size,
            side: Side.BUY,
          },
          { tickSize, negRisk },
        ).then((order) => client.postOrder(order, OrderType.FAK))
      : await client.createAndPostMarketOrder(
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
      const rejectedOrderId = String(resp?.orderID ?? resp?.orderId ?? "");
      if (rejectedOrderId) {
        const verified = await resolveOrderFillAfterPost(
          userId,
          rejectedOrderId,
          input.leg,
          refPrice,
          requestedShares,
          input.leg === "buy" ? submittedBuyNotional : undefined,
        );
        if (verified.outcome === "filled" && verified.fill) {
          logService.success(
            "trading",
            `${input.leg.toUpperCase()} ${input.side.toUpperCase()} recovered fill after reject payload: ${verified.fill.fillShares} sh`,
          );
          return {
            success: true,
            orderId: rejectedOrderId,
            fillPrice: verified.fill.fillPrice,
            fillShares: verified.fill.fillShares,
            usdcAmount: verified.fill.usdcAmount,
            tokenId: tokenID,
            conditionId: pair.conditionId,
            slug: pair.slug,
            status: verified.status,
          };
        }
        await cancelOpenOrder(userId, rejectedOrderId);
      }
      logService.error("trading", `${input.leg} ${input.side} failed: ${err}`);
      return { success: false, orderId: rejectedOrderId || undefined, error: err, ambiguous: false };
    }

    const orderId = String(resp?.orderID ?? resp?.orderId ?? "");
    const status = String(resp?.status ?? "").toLowerCase();
    const takingAmount = num(resp?.takingAmount);
    const makingAmount = num(resp?.makingAmount);
    const reportedFill = num(resp?.sizeMatched) ?? num(resp?.filledSize);
    const hasConfirmedFill =
      status === "matched" ||
      (takingAmount != null && takingAmount > 0 && makingAmount != null && makingAmount > 0) ||
      (reportedFill != null && reportedFill > 0);

    if (!hasConfirmedFill) {
      if (orderId) {
        const beforeCancel = await resolveOrderFillAfterPost(
          userId,
          orderId,
          input.leg,
          refPrice,
          requestedShares,
          input.leg === "buy" ? submittedBuyNotional : undefined,
        );
        if (beforeCancel.outcome === "filled" && beforeCancel.fill) {
          logService.success(
            "trading",
            `${input.leg.toUpperCase()} ${input.side.toUpperCase()} (${clobOrderType}) verified via getOrder: ${beforeCancel.fill.fillShares} sh`,
          );
          return {
            success: true,
            orderId,
            fillPrice: beforeCancel.fill.fillPrice,
            fillShares: beforeCancel.fill.fillShares,
            usdcAmount: beforeCancel.fill.usdcAmount,
            tokenId: tokenID,
            conditionId: pair.conditionId,
            slug: pair.slug,
            status: beforeCancel.status,
          };
        }

        await cancelOpenOrder(userId, orderId);

        const afterCancel = await resolveOrderFillAfterPost(
          userId,
          orderId,
          input.leg,
          refPrice,
          requestedShares,
          input.leg === "buy" ? submittedBuyNotional : undefined,
        );
        if (afterCancel.outcome === "filled" && afterCancel.fill) {
          logService.success(
            "trading",
            `${input.leg.toUpperCase()} ${input.side.toUpperCase()} (${clobOrderType}) filled before cancel landed: ${afterCancel.fill.fillShares} sh`,
          );
          return {
            success: true,
            orderId,
            fillPrice: afterCancel.fill.fillPrice,
            fillShares: afterCancel.fill.fillShares,
            usdcAmount: afterCancel.fill.usdcAmount,
            tokenId: tokenID,
            conditionId: pair.conditionId,
            slug: pair.slug,
            status: afterCancel.status,
          };
        }

        const clearlyUnfilled =
          afterCancel.outcome === "unfilled" || beforeCancel.outcome === "unfilled";
        const err = `${clobOrderType} order not settled`;
        logService.warn("trading", `${input.leg} ${input.side}: ${err}`);
        return {
          success: false,
          orderId,
          status: afterCancel.status ?? beforeCancel.status ?? status,
          error: err,
          ambiguous: !clearlyUnfilled,
        };
      }

      const err = `${clobOrderType} order not settled`;
      logService.warn("trading", `${input.leg} ${input.side}: ${err}`);
      return { success: false, status, error: err, ambiguous: true };
    }

    const fill = parseFillFromResponse(
      resp,
      input.leg,
      refPrice,
      requestedShares,
      input.leg === "buy" ? submittedBuyNotional : undefined,
    );

    // FAK may return success with zero fill if nothing available.
    if (!(fill.fillShares > 0)) {
      if (orderId) await cancelOpenOrder(userId, orderId);
      const err = `${clobOrderType} order not filled`;
      logService.warn("trading", `${input.leg} ${input.side}: ${err}`);
      return { success: false, orderId: orderId || undefined, error: err, ambiguous: false };
    }

    logService.success(
      "trading",
      `${input.leg.toUpperCase()} ${input.side.toUpperCase()} (${clobOrderType}): ${fill.fillShares} sh @ ~${(fill.fillPrice * 100).toFixed(1)}¢` +
        (input.leg === "buy"
          ? isCappedFakBuy
            ? ` (limit ${(refPrice * 100).toFixed(0)}¢)`
            : ` (~$${amount.toFixed(2)} ${sizeUnit === "shares" ? "for " + size + " sh target" : "USDC"})`
          : ""),
    );

    return {
      success: true,
      orderId,
      fillPrice: fill.fillPrice,
      fillShares: fill.fillShares,
      usdcAmount: fill.usdcAmount,
      tokenId: tokenID,
      conditionId: pair.conditionId,
      slug: pair.slug,
      status: status || undefined,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logService.error("trading", `${input.leg} ${input.side} error: ${message}`);
    // Network/timeout after a possible post — do not allow blind re-buys.
    return { success: false, error: message, ambiguous: true };
  }
}

/** Place a resting GTD limit buy (shares @ price) that expires at expirationSec. */
export async function placeLimitGtdBuy(
  userId: string,
  input: PlaceLimitOrderInput,
): Promise<PlaceOrderResult> {
  return placeLimitGtdOrder(userId, { ...input, leg: "buy" });
}

/** Place a resting GTD limit sell (shares @ price) that expires at expirationSec. */
export async function placeLimitGtdSell(
  userId: string,
  input: PlaceLimitOrderInput,
): Promise<PlaceOrderResult> {
  return placeLimitGtdOrder(userId, { ...input, leg: "sell" });
}

async function placeLimitGtdOrder(
  userId: string,
  input: PlaceLimitOrderInput & { leg: TradeLeg },
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
  const leg = input.leg;
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
    const clobSide = leg === "buy" ? Side.BUY : Side.SELL;

    const resp = (await client.createAndPostOrder(
      {
        tokenID,
        price,
        size,
        side: clobSide,
        expiration,
      },
      { tickSize, negRisk },
      OrderType.GTD,
    )) as Record<string, unknown> | null;

    if (resp?.success === false || resp?.errorMsg) {
      const err = String(resp?.errorMsg ?? resp?.error ?? "Order rejected");
      if (!/expiration/i.test(err)) {
        logService.error("trading", `GTD ${leg} ${input.side} failed: ${err}`);
      }
      return { success: false, error: err };
    }

    const orderId = String(resp?.orderID ?? resp?.orderId ?? "");
    const status = resp?.status != null ? String(resp.status) : "";
    const fill = parseFillFromResponse(resp, leg, price, size, size * price);
    const immediateFill = fill.fillShares > 0 && (status === "matched" || Boolean(resp?.takingAmount));

    const tag = input.logTag ? ` [${input.logTag}]` : "";
    logService.success(
      "trading",
      immediateFill
        ? `GTD ${leg.toUpperCase()} ${input.side.toUpperCase()} filled: ${fill.fillShares} sh @ ~${(fill.fillPrice * 100).toFixed(1)}¢${tag}`
        : `GTD ${leg.toUpperCase()} ${input.side.toUpperCase()} resting: ${size} sh @ ${(price * 100).toFixed(0)}¢ (exp ${expiration})${tag}`,
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
    if (!/expiration/i.test(message)) {
      logService.error("trading", `GTD ${leg} ${input.side} error: ${message}`);
    }
    return { success: false, error: message };
  }
}

export async function cancelOpenOrder(
  userId: string,
  orderId: string,
  opts?: { quiet?: boolean },
): Promise<{ ok: boolean; error?: string }> {
  if (!orderId) return { ok: false, error: "Missing order id" };
  const client = getTradingClient(userId);
  if (!client) return { ok: false, error: "Trading client not initialized" };
  try {
    await client.cancelOrder({ orderID: orderId });
    if (!opts?.quiet) {
      logService.info("trading", `Cancelled order ${orderId.slice(0, 10)}…`);
    }
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!opts?.quiet) {
      logService.warn("trading", `Cancel ${orderId.slice(0, 10)}… failed: ${message}`);
    }
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
