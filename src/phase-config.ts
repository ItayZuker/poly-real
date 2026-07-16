import type { BuyOrderType, GapVsPtb, LiveWindowState, SimPhaseConfig, TradingPhaseSetup } from "./types.js";

const SIDES_ORDER = ["up", "down"] as const;

export function defaultPhaseConfig(): SimPhaseConfig {
  return {
    buyEnabled: true,
    buyShares: 10,
    buyTrigger: 40,
    buyOptimize: false,
    buyOrderType: "GTD",
    minGap: 0,
    maxGap: 0,
    gapVsPtb: "opposite",
    sellProfitCents: 20,
  };
}

function asGapVsPtb(value: unknown, fallback: GapVsPtb = "opposite"): GapVsPtb {
  return value === "with" || value === "opposite" ? value : fallback;
}

function asMoneyGap(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * 100) / 100;
}

/** Resolve order type from optimize flag (migrates legacy FOK → FAK). */
export function resolveBuyOrderType(buyOptimize: boolean): BuyOrderType {
  return buyOptimize ? "FAK" : "GTD";
}

/** Coerce legacy numeric buyOptimize / missing gap fields into the current shape. */
export function normalizePhaseConfig(raw: Partial<SimPhaseConfig> | null | undefined): SimPhaseConfig {
  const base = defaultPhaseConfig();
  if (!raw || typeof raw !== "object") return base;

  let buyOptimize = base.buyOptimize;
  if (typeof raw.buyOptimize === "boolean") {
    buyOptimize = raw.buyOptimize;
  } else if (typeof raw.buyOptimize === "number") {
    buyOptimize = raw.buyOptimize > 0;
  }

  return {
    buyEnabled: Boolean(raw.buyEnabled ?? base.buyEnabled),
    buyShares: Math.max(1, Math.floor(Number(raw.buyShares)) || base.buyShares),
    buyTrigger: Math.max(1, Math.min(99, Math.floor(Number(raw.buyTrigger)) || base.buyTrigger)),
    buyOptimize,
    buyOrderType: resolveBuyOrderType(buyOptimize),
    minGap: asMoneyGap(raw.minGap),
    maxGap: asMoneyGap(raw.maxGap),
    gapVsPtb: asGapVsPtb(raw.gapVsPtb, base.gapVsPtb),
    sellProfitCents: Math.max(
      1,
      Math.min(99, Math.floor(Number(raw.sellProfitCents)) || base.sellProfitCents),
    ),
  };
}

export function normalizeTradingPhaseSetup(setup: TradingPhaseSetup): TradingPhaseSetup | null {
  if (!setup?.phaseSplit || !Array.isArray(setup.phases) || setup.phases.length !== 3) return null;
  const [a, b] = setup.phaseSplit;
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b >= 1 || a >= b) return null;
  return {
    phaseSplit: [a, b],
    phases: [
      normalizePhaseConfig(setup.phases[0]),
      normalizePhaseConfig(setup.phases[1]),
      normalizePhaseConfig(setup.phases[2]),
    ],
  };
}

/** |asset−PTB| + direction filter. Returns false when PTB gap is required but missing. */
export function gapAllowsBuy(
  side: "up" | "down",
  phase: SimPhaseConfig,
  assetGap: number | null | undefined,
): boolean {
  if (assetGap == null || !Number.isFinite(assetGap)) return false;

  const abs = Math.abs(assetGap);
  if (phase.minGap > 0 && abs + 1e-9 < phase.minGap) return false;
  if (phase.maxGap > 0 && abs - 1e-9 > phase.maxGap) return false;

  const wantAbovePtb =
    side === "up" ? phase.gapVsPtb === "with" : phase.gapVsPtb === "opposite";
  if (wantAbovePtb) return assetGap > 0;
  return assetGap < 0;
}

export function priceToCents(price: number): number {
  return Math.round(price * 100);
}

export function centsToPrice(cents: number): number {
  return Math.max(0.01, Math.min(0.99, cents / 100));
}

export function elapsedFrac(state: LiveWindowState, nowSec: number): number {
  if (!state.windowStart || !state.windowEnd) return 0;
  const duration = state.windowEnd - state.windowStart;
  if (duration <= 0) return 0;
  return Math.min(1, Math.max(0, (nowSec - state.windowStart) / duration));
}

export function phaseIndexForFrac(frac: number, phaseSplit: [number, number]): number {
  if (frac < phaseSplit[0]) return 0;
  if (frac < phaseSplit[1]) return 1;
  return 2;
}

export function phaseIndexForState(
  state: LiveWindowState,
  phaseSplit: [number, number],
  nowSec?: number,
): number {
  const t = nowSec ?? Math.floor((state.lastTickMs ?? Date.now()) / 1000);
  return phaseIndexForFrac(elapsedFrac(state, t), phaseSplit);
}

/**
 * GTD stated expiration (unix sec). Exchange expires ~60s before this value.
 * Must be ≥ now+180; if window end is sooner we still meet the floor and cancel ourselves.
 */
export function gtdExpirationUnix(windowEndSec: number, nowSec = Math.floor(Date.now() / 1000)): number {
  const target = (Number.isFinite(windowEndSec) ? windowEndSec : nowSec + 300) + 60;
  return Math.max(target, nowSec + 180);
}

export { SIDES_ORDER };
