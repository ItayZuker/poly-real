import type { BuyOrderType, GapVsPtb, LiveWindowState, SimPhaseConfig, TradingPhaseSetup } from "./types.js";

const SIDES_ORDER = ["up", "down"] as const;
const MAX_STABILIZE_TICKS = 500;
export const MAX_ASK_CENTS_SAMPLES = 2000;

export function defaultPhaseConfig(): SimPhaseConfig {
  return {
    buyEnabled: true,
    buyShares: 10,
    buyTrigger: 40,
    buyOptimize: false,
    buyOrderType: "GTD",
    minGap: 0,
    maxGap: 0,
    gapVsPtb: "with",
    buyStabilizeTicks: 1,
    buyStabilizeRange: 0,
    buyAbortOnCrossing: 0,
    sellProfitCents: 20,
  };
}

function asGapVsPtb(value: unknown, fallback: GapVsPtb = "none"): GapVsPtb {
  return value === "with" || value === "opposite" || value === "none" ? value : fallback;
}

function asMoneyGap(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * 100) / 100;
}

function asStabilizeTicks(value: unknown): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(MAX_STABILIZE_TICKS, n);
}

function asStabilizeRange(ticks: number, value: unknown): number {
  if (ticks <= 1) return 0;
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.max(1, Math.min(99, n));
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

  const buyStabilizeTicks = asStabilizeTicks(raw.buyStabilizeTicks ?? base.buyStabilizeTicks);
  const gapVsPtb = asGapVsPtb(
    raw.gapVsPtb,
    buyOptimize ? "none" : "with",
  );
  return {
    buyEnabled: Boolean(raw.buyEnabled ?? base.buyEnabled),
    buyShares: Math.max(1, Math.floor(Number(raw.buyShares)) || base.buyShares),
    buyTrigger: Math.max(1, Math.min(99, Math.floor(Number(raw.buyTrigger)) || base.buyTrigger)),
    buyOptimize,
    buyOrderType: resolveBuyOrderType(buyOptimize),
    minGap: asMoneyGap(raw.minGap),
    maxGap: asMoneyGap(raw.maxGap),
    gapVsPtb: !buyOptimize && gapVsPtb === "none" ? "with" : gapVsPtb,
    buyStabilizeTicks,
    buyStabilizeRange: asStabilizeRange(buyStabilizeTicks, raw.buyStabilizeRange),
    buyAbortOnCrossing: Math.max(
      0,
      Math.min(1000, Math.floor(Number(raw.buyAbortOnCrossing)) || 0),
    ),
    sellProfitCents: Math.max(
      1,
      Math.min(100, Math.floor(Number(raw.sellProfitCents)) || base.sellProfitCents),
    ),
  };
}

/** False when profit-from-buy is 100 (hold to settlement, no sell). */
export function sellEnabledForPhase(phase: Pick<SimPhaseConfig, "sellProfitCents">): boolean {
  return Math.floor(Number(phase.sellProfitCents)) < 100;
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

/**
 * Gap bounds always use |asset−PTB|. With/opposite independently constrain
 * direction in both GTD and FAK; only FAK "none" ignores direction.
 */
export function gapAllowsBuy(
  side: "up" | "down",
  phase: SimPhaseConfig,
  assetGap: number | null | undefined,
): boolean {
  const hasMagnitude = phase.minGap > 0 || phase.maxGap > 0;
  if (assetGap == null || !Number.isFinite(assetGap)) {
    return phase.buyOptimize && phase.gapVsPtb === "none" && !hasMagnitude;
  }

  const abs = Math.abs(assetGap);
  if (phase.minGap > 0 && abs + 1e-9 < phase.minGap) return false;
  if (phase.maxGap > 0 && abs - 1e-9 > phase.maxGap) return false;
  if (phase.gapVsPtb === "none") return phase.buyOptimize;

  const wantAbovePtb =
    side === "up" ? phase.gapVsPtb === "with" : phase.gapVsPtb === "opposite";
  if (wantAbovePtb) return assetGap >= 0;
  return assetGap <= 0;
}

/** Human-readable cancel reason when a resting GTD fails the gap filter. */
export function describeGapFilterCancelReason(
  side: "up" | "down",
  phase: SimPhaseConfig,
  assetGap: number | null | undefined,
): string {
  const sideLabel = side.toUpperCase();
  if (assetGap == null || !Number.isFinite(assetGap)) {
    return `gap filter: no gap (${sideLabel})`;
  }

  const gapLabel = assetGap >= 0 ? `+${assetGap.toFixed(2)}` : assetGap.toFixed(2);
  const abs = Math.abs(assetGap);
  if (phase.minGap > 0 && abs + 1e-9 < phase.minGap) {
    return `gap filter: |gap| ${abs.toFixed(2)} < min ${phase.minGap}`;
  }
  if (phase.maxGap > 0 && abs - 1e-9 > phase.maxGap) {
    return `gap filter: |gap| ${abs.toFixed(2)} > max ${phase.maxGap}`;
  }
  if (phase.gapVsPtb === "none") {
    return `gap filter: none (${sideLabel}, gap ${gapLabel})`;
  }

  return `gap filter: PTB side flip (${sideLabel}, gap ${gapLabel})`;
}

/** Append best-ask ¢ samples from the current book snapshot (one sample per side per book tick). */
export function recordAskSamples(state: LiveWindowState): void {
  state.bookTickSequence = Math.max(0, Math.floor(state.bookTickSequence ?? 0)) + 1;
  if (state.yesAsk != null && Number.isFinite(state.yesAsk)) {
    if (!state.upAskCentsSamples) state.upAskCentsSamples = [];
    state.upAskCentsSamples.push(Math.round(state.yesAsk * 100));
    if (state.upAskCentsSamples.length > MAX_ASK_CENTS_SAMPLES) {
      state.upAskCentsSamples.splice(0, state.upAskCentsSamples.length - MAX_ASK_CENTS_SAMPLES);
    }
  }
  if (state.noAsk != null && Number.isFinite(state.noAsk)) {
    if (!state.downAskCentsSamples) state.downAskCentsSamples = [];
    state.downAskCentsSamples.push(Math.round(state.noAsk * 100));
    if (state.downAskCentsSamples.length > MAX_ASK_CENTS_SAMPLES) {
      state.downAskCentsSamples.splice(0, state.downAskCentsSamples.length - MAX_ASK_CENTS_SAMPLES);
    }
  }
}

export function askCentsSamplesForSide(
  state: Pick<LiveWindowState, "upAskCentsSamples" | "downAskCentsSamples"> | null | undefined,
  side: "up" | "down",
): number[] {
  if (!state) return [];
  return side === "up" ? (state.upAskCentsSamples ?? []) : (state.downAskCentsSamples ?? []);
}

/**
 * Stabilize filter: last N best-ask ¢ samples for the buy side must span ≤ buyStabilizeRange.
 * ticks ≤ 1 → off (allow). Fewer than N samples → block.
 */
export function stabilizeAllowsBuy(phase: SimPhaseConfig, askCentsSamples: ReadonlyArray<number>): boolean {
  const ticks = Math.max(1, Math.floor(phase.buyStabilizeTicks || 1));
  if (ticks <= 1) return true;
  const range = Math.max(1, Math.floor(phase.buyStabilizeRange || 1));
  if (askCentsSamples.length < ticks) return false;

  let min = Infinity;
  let max = -Infinity;
  for (let i = askCentsSamples.length - ticks; i < askCentsSamples.length; i++) {
    const p = askCentsSamples[i]!;
    if (!Number.isFinite(p)) return false;
    min = Math.min(min, p);
    max = Math.max(max, p);
  }
  return max - min <= range;
}

export function stabilizeAllowsBuyForSide(
  phase: SimPhaseConfig,
  state: Pick<LiveWindowState, "upAskCentsSamples" | "downAskCentsSamples"> | null | undefined,
  side: "up" | "down",
): boolean {
  return stabilizeAllowsBuy(phase, askCentsSamplesForSide(state, side));
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
