import { OrderType, Side, type TickSize } from "@polymarket/clob-client-v2";
import { createPublicClient, getClobHost, getChainId, getMarketInfo } from "./clob-service.js";
import { fetchCurrentUpDownMarket } from "./market-pair.js";
import { logService } from "./log-service.js";
import { getTradingClient, isTradingConfigured } from "./trading-client.js";
import type { LiveWindowState } from "./types.js";

export type TradeSide = "up" | "down";
export type TradeLeg = "buy" | "sell";

export interface PlaceOrderInput {
  series: string;
  side: TradeSide;
  leg: TradeLeg;
  shares: number;
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

export async function placeMarketOrder(input: PlaceOrderInput): Promise<PlaceOrderResult> {
  if (!isTradingConfigured()) {
    return { success: false, error: "Trading account not configured" };
  }

  const client = getTradingClient();
  if (!client) {
    return { success: false, error: "Trading client not initialized" };
  }

  const shares = Math.max(1, Math.floor(input.shares));
  if (!Number.isFinite(shares) || shares <= 0) {
    return { success: false, error: "Invalid share amount" };
  }

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
    const amount =
      input.leg === "buy"
        ? Math.max(1, Math.round(shares * refPrice * 100) / 100)
        : shares;

    const resp = (await client.createAndPostMarketOrder(
      {
        tokenID,
        amount,
        side: clobSide,
        orderType: OrderType.FOK,
      },
      { tickSize, negRisk },
      OrderType.FOK,
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
      shares,
      input.leg === "buy" ? amount : undefined,
    );

    logService.success(
      "trading",
      `${input.leg.toUpperCase()} ${input.side.toUpperCase()}: ${fill.fillShares} sh @ ~${(fill.fillPrice * 100).toFixed(1)}¢`,
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
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logService.error("trading", `${input.leg} ${input.side} error: ${message}`);
    return { success: false, error: message };
  }
}
