import type { BookLevel } from "./clob-service.js";
import {
  DEFAULT_CRYPTO_TAKER_FEE_PARAMS,
  sumLegFees,
  type TakerFeeParams,
} from "./taker-fee.js";

export const BOOK_DEPTH_LEVELS = 5;

export interface FillLeg {
  price: number;
  shares: number;
  fee: number;
}

export interface WalkFillResult {
  shares: number;
  avgPrice: number;
  cost: number;
  proceeds: number;
  fees: number;
  legs: FillLeg[];
}

export function takeLevels(
  levels: BookLevel[] | undefined,
  depth = BOOK_DEPTH_LEVELS,
): BookLevel[] {
  if (!levels?.length) return [];
  return levels
    .filter((l) => l.price != null && l.size != null && l.size > 0)
    .slice(0, depth)
    .map((l) => ({ price: l.price, size: l.size }));
}

export function totalLevelSize(levels: BookLevel[]): number {
  return levels.reduce((sum, l) => sum + (l.size > 0 ? l.size : 0), 0);
}

export function canFillAsks(asks: BookLevel[], shares: number): boolean {
  if (!shares || shares <= 0) return false;
  return totalLevelSize(asks) >= shares;
}

export function canFillBids(bids: BookLevel[], shares: number): boolean {
  if (!shares || shares <= 0) return false;
  return totalLevelSize(bids) >= shares;
}

function asksAtOrBelow(asks: BookLevel[], limitPrice: number): BookLevel[] {
  return asks.filter((l) => l.price <= limitPrice + 1e-9);
}

function bidsAtOrAbove(bids: BookLevel[], limitPrice: number): BookLevel[] {
  return bids.filter((l) => l.price >= limitPrice - 1e-9);
}

/**
 * Maker limit buy: resting order at limitPrice, filled when book has liquidity at or below limit.
 * Makers pay no Polymarket trading fees. Requires full size (legacy).
 */
export function fillMakerLimitBuy(
  asks: BookLevel[],
  shares: number,
  limitPrice: number,
): WalkFillResult | null {
  if (!shares || shares <= 0 || !Number.isFinite(limitPrice) || limitPrice <= 0) return null;
  const eligible = asksAtOrBelow(asks, limitPrice);
  if (!canFillAsks(eligible, shares)) return null;

  const cost = shares * limitPrice;
  return {
    shares,
    avgPrice: limitPrice,
    cost,
    proceeds: 0,
    fees: 0,
    legs: [{ price: limitPrice, shares, fee: 0 }],
  };
}

/**
 * Maker limit buy that accepts partial size (GTD-style resting fills).
 * Fills up to `maxShares` at `limitPrice` from asks at or below the limit.
 */
export function fillMakerLimitBuyAvailable(
  asks: BookLevel[],
  maxShares: number,
  limitPrice: number,
): WalkFillResult | null {
  if (!maxShares || maxShares <= 0 || !Number.isFinite(limitPrice) || limitPrice <= 0) return null;
  const eligible = asksAtOrBelow(asks, limitPrice);
  const available = totalLevelSize(eligible);
  if (available <= 0) return null;
  const shares = Math.min(maxShares, available);
  if (shares <= 0) return null;
  const cost = shares * limitPrice;
  return {
    shares,
    avgPrice: limitPrice,
    cost,
    proceeds: 0,
    fees: 0,
    legs: [{ price: limitPrice, shares, fee: 0 }],
  };
}

/**
 * Maker limit sell: resting order at limitPrice, filled when book has liquidity at or above limit.
 * Makers pay no Polymarket trading fees.
 */
export function fillMakerLimitSell(
  bids: BookLevel[],
  shares: number,
  limitPrice: number,
): WalkFillResult | null {
  if (!shares || shares <= 0 || !Number.isFinite(limitPrice) || limitPrice <= 0) return null;
  const eligible = bidsAtOrAbove(bids, limitPrice);
  if (!canFillBids(eligible, shares)) return null;

  const proceeds = shares * limitPrice;
  return {
    shares,
    avgPrice: limitPrice,
    cost: 0,
    proceeds,
    fees: 0,
    legs: [{ price: limitPrice, shares, fee: 0 }],
  };
}

/** Walk ask levels (taker buy). Fees computed per level using Polymarket formula. */
export function walkAsks(
  asks: BookLevel[],
  shares: number,
  chargeTakerFee: boolean,
  feeParams: TakerFeeParams = DEFAULT_CRYPTO_TAKER_FEE_PARAMS,
): WalkFillResult | null {
  if (!shares || shares <= 0) return null;
  let remaining = shares;
  let totalCost = 0;
  const legs: FillLeg[] = [];

  for (const level of asks) {
    if (remaining <= 0) break;
    if (level.size <= 0 || !Number.isFinite(level.price)) continue;
    const take = Math.min(remaining, level.size);
    if (take <= 0) continue;
    totalCost += take * level.price;
    legs.push({ price: level.price, shares: take, fee: 0 });
    remaining -= take;
  }

  if (remaining > 0) return null;

  const cost = totalCost;
  const fees = chargeTakerFee ? sumLegFees(legs, feeParams) : 0;
  if (fees > 0) {
    for (const leg of legs) {
      leg.fee =
        sumLegFees([{ shares: leg.shares, price: leg.price }], feeParams);
    }
  }

  return {
    shares,
    avgPrice: cost / shares,
    cost,
    proceeds: 0,
    fees,
    legs,
  };
}

/** FAK-style taker buy: fill up to maxShares from available asks; partial OK. */
export function walkAsksAvailable(
  asks: BookLevel[],
  maxShares: number,
  chargeTakerFee: boolean,
  feeParams: TakerFeeParams = DEFAULT_CRYPTO_TAKER_FEE_PARAMS,
): WalkFillResult | null {
  if (!maxShares || maxShares <= 0) return null;
  let remaining = maxShares;
  let totalCost = 0;
  const legs: FillLeg[] = [];

  for (const level of asks) {
    if (remaining <= 0) break;
    if (level.size <= 0 || !Number.isFinite(level.price)) continue;
    const take = Math.min(remaining, level.size);
    if (take <= 0) continue;
    totalCost += take * level.price;
    legs.push({ price: level.price, shares: take, fee: 0 });
    remaining -= take;
  }

  const filled = maxShares - remaining;
  if (filled <= 0) return null;

  const fees = chargeTakerFee ? sumLegFees(legs, feeParams) : 0;
  if (fees > 0) {
    for (const leg of legs) {
      leg.fee = sumLegFees([{ shares: leg.shares, price: leg.price }], feeParams);
    }
  }

  return {
    shares: filled,
    avgPrice: totalCost / filled,
    cost: totalCost,
    proceeds: 0,
    fees,
    legs,
  };
}

/** Walk bid levels (taker sell). Fees computed per level using Polymarket formula. */
export function walkBids(
  bids: BookLevel[],
  shares: number,
  chargeTakerFee = false,
  feeParams: TakerFeeParams = DEFAULT_CRYPTO_TAKER_FEE_PARAMS,
): WalkFillResult | null {
  if (!shares || shares <= 0) return null;
  let remaining = shares;
  let totalProceeds = 0;
  const legs: FillLeg[] = [];

  for (const level of bids) {
    if (remaining <= 0) break;
    if (level.size <= 0 || !Number.isFinite(level.price)) continue;
    const take = Math.min(remaining, level.size);
    if (take <= 0) continue;
    totalProceeds += take * level.price;
    legs.push({ price: level.price, shares: take, fee: 0 });
    remaining -= take;
  }

  if (remaining > 0) return null;

  const fees = chargeTakerFee ? sumLegFees(legs, feeParams) : 0;
  if (fees > 0) {
    for (const leg of legs) {
      leg.fee =
        sumLegFees([{ shares: leg.shares, price: leg.price }], feeParams);
    }
  }

  return {
    shares,
    avgPrice: totalProceeds / shares,
    cost: 0,
    proceeds: totalProceeds,
    fees,
    legs,
  };
}

export function bestPrice(levels: BookLevel[]): number | undefined {
  return levels[0]?.price;
}
