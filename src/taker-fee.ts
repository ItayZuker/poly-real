import type { ClobClient } from "@polymarket/clob-client-v2";

/** Polymarket crypto taker fee rate (official docs) when market metadata is unavailable. */
export const DEFAULT_CRYPTO_TAKER_FEE_RATE = 0.07;
export const DEFAULT_TAKER_FEE_EXPONENT = 1;

const FEE_DECIMALS = 5;
const MIN_CHARGED_FEE_USDC = 0.00001;

export interface TakerFeeParams {
  feeRate: number;
  feeExponent: number;
}

export const DEFAULT_CRYPTO_TAKER_FEE_PARAMS: TakerFeeParams = {
  feeRate: DEFAULT_CRYPTO_TAKER_FEE_RATE,
  feeExponent: DEFAULT_TAKER_FEE_EXPONENT,
};

type ClientFeeInfos = {
  feeInfos?: Record<string, { rate: number; exponent: number }>;
};

const takerFeeCache = new Map<string, TakerFeeParams>();

/** Polymarket: fee = C × feeRate × (p × (1 − p))^exponent, rounded to 5 decimals. */
export function estimateTakerFeeUsd(
  shares: number,
  price: number,
  { feeRate, feeExponent }: TakerFeeParams,
): number {
  if (shares <= 0 || price <= 0 || price >= 1 || feeRate <= 0) {
    return 0;
  }
  const uncertainty = price * (1 - price);
  if (uncertainty <= 0) {
    return 0;
  }
  const raw = shares * feeRate * uncertainty ** feeExponent;
  const scale = 10 ** FEE_DECIMALS;
  const rounded = Math.round(raw * scale) / scale;
  if (rounded <= 0) return 0;
  if (rounded < MIN_CHARGED_FEE_USDC) return 0;
  return rounded;
}

/** Sum taker fees across fill legs (per-level, as Polymarket applies at match time). */
export function sumLegFees(
  legs: Array<{ shares: number; price: number }>,
  feeParams: TakerFeeParams,
): number {
  const scale = 10 ** FEE_DECIMALS;
  const total = legs.reduce(
    (sum, leg) => sum + estimateTakerFeeUsd(leg.shares, leg.price, feeParams),
    0,
  );
  const rounded = Math.round(total * scale) / scale;
  if (rounded <= 0) return 0;
  if (rounded < MIN_CHARGED_FEE_USDC) return 0;
  return rounded;
}

/** Load taker fee params from CLOB market metadata (cached on the client after getFeeExponent). */
export async function resolveTakerFeeParams(
  client: ClobClient,
  tokenId: string,
): Promise<TakerFeeParams> {
  const cached = takerFeeCache.get(tokenId);
  if (cached) {
    return cached;
  }

  try {
    await client.getFeeExponent(tokenId);
    const info = (client as unknown as ClientFeeInfos).feeInfos?.[tokenId];
    const params: TakerFeeParams = {
      feeRate: info?.rate ?? DEFAULT_CRYPTO_TAKER_FEE_RATE,
      feeExponent: info?.exponent ?? DEFAULT_TAKER_FEE_EXPONENT,
    };
    takerFeeCache.set(tokenId, params);
    return params;
  } catch {
    const fallback: TakerFeeParams = { ...DEFAULT_CRYPTO_TAKER_FEE_PARAMS };
    takerFeeCache.set(tokenId, fallback);
    return fallback;
  }
}
