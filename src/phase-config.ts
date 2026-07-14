import type { GapVsPtb, SimPhaseConfig, TradingPhaseSetup } from "./types.js";

const SIDES_ORDER = ["up", "down"] as const;

export function defaultPhaseConfig(): SimPhaseConfig {
  return {
    buyEnabled: true,
    buyShares: 10,
    buyTrigger: 40,
    buyOptimize: false,
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

export { SIDES_ORDER };
