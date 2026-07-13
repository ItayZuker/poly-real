import { fetchWithTimeout, sleepMs } from "./fetch-timeout.js";
import { roundTo4 } from "./tick-compact.js";
import type { WindowOutcome } from "./types.js";

const GAMMA_EVENTS_URL = "https://gamma-api.polymarket.com/events";

export interface GammaWindowResolution {
  outcome: WindowOutcome;
  finalPrice?: number;
  priceToBeat?: number;
  yesPrice?: number;
  noPrice?: number;
}

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

/** Resolved Gamma markets expose ~1 / ~0 on the winning side. */
export function outcomeFromGammaPrices(
  yesPrice?: number,
  noPrice?: number,
): WindowOutcome | undefined {
  if (yesPrice != null && Number.isFinite(yesPrice) && yesPrice >= 0.95) return "up";
  if (noPrice != null && Number.isFinite(noPrice) && noPrice >= 0.95) return "down";
  if (
    yesPrice != null &&
    noPrice != null &&
    Number.isFinite(yesPrice) &&
    Number.isFinite(noPrice)
  ) {
    if (yesPrice > noPrice && yesPrice >= 0.8) return "up";
    if (noPrice > yesPrice && noPrice >= 0.8) return "down";
  }
  return undefined;
}

/** One-shot Gamma lookup by market/event slug. Returns null if not resolved yet. */
export async function fetchGammaWindowResolution(
  slug: string,
  signal?: AbortSignal,
): Promise<GammaWindowResolution | null> {
  const trimmed = slug.trim();
  if (!trimmed) return null;

  const res = await fetchWithTimeout(
    `${GAMMA_EVENTS_URL}?slug=${encodeURIComponent(trimmed)}`,
    { signal },
  );
  if (!res.ok) {
    throw new Error(`Gamma events error (${res.status})`);
  }

  const events = (await res.json()) as Record<string, unknown>[];
  if (!Array.isArray(events) || events.length === 0) return null;

  const event = events[0];
  const markets = event.markets as Record<string, unknown>[] | undefined;
  const market = markets?.[0];
  if (!market) return null;

  const prices = parseJsonArray<string>(market.outcomePrices).map(Number);
  const yesPrice = Number.isFinite(prices[0]) ? prices[0] : undefined;
  const noPrice = Number.isFinite(prices[1]) ? prices[1] : undefined;
  const outcome = outcomeFromGammaPrices(yesPrice, noPrice);
  if (!outcome) return null;

  const meta = event.eventMetadata as
    | { finalPrice?: number; priceToBeat?: number }
    | undefined;
  const finalPrice =
    meta?.finalPrice != null && Number.isFinite(meta.finalPrice)
      ? roundTo4(meta.finalPrice)
      : undefined;
  const priceToBeat =
    meta?.priceToBeat != null && Number.isFinite(meta.priceToBeat)
      ? roundTo4(meta.priceToBeat)
      : undefined;

  return { outcome, finalPrice, priceToBeat, yesPrice, noPrice };
}

/**
 * Wait until Gamma marks the market resolved (outcomePrices ~1/0).
 * Used at live window finalize — resolution can lag a few seconds.
 */
export async function waitForGammaWindowResolution(
  slug: string,
  options: { maxWaitMs?: number; intervalMs?: number } = {},
): Promise<GammaWindowResolution | null> {
  const maxWaitMs = options.maxWaitMs ?? 25_000;
  const intervalMs = options.intervalMs ?? 500;
  const startedAt = Date.now();

  while (Date.now() - startedAt <= maxWaitMs) {
    try {
      const resolution = await fetchGammaWindowResolution(slug);
      if (resolution) return resolution;
    } catch {
      // keep polling until maxWaitMs
    }
    await sleepMs(intervalMs);
  }

  return null;
}
