import type { BookLevel } from "./clob-service.js";
import {
  bestPrice,
  fillMakerLimitBuyAvailable,
  fillMakerLimitSell,
  takeLevels,
  totalLevelSize,
  walkAsksAvailable,
  walkBids,
} from "./book-depth.js";
import { DEFAULT_CRYPTO_TAKER_FEE_PARAMS, type TakerFeeParams } from "./taker-fee.js";
import type { LiveWindowState, SimMarker, SimQuoteLocks, SimSetup, SimLastWindow } from "./types.js";
import {
  describeGapFilterCancelReason,
  gapAllowsBuy,
  priceToCents,
  sellEnabledForPhase,
  shouldPreCancelGtdForNextPhase,
  SIDES_ORDER,
} from "./phase-config.js";
import { resolveWindowOutcome } from "./window-outcome.js";
import { logService } from "./log-service.js";

type Side = "up" | "down";

interface DepthQuote {
  upAsks: BookLevel[];
  upBids: BookLevel[];
  downAsks: BookLevel[];
  downBids: BookLevel[];
}

interface Position {
  side: Side;
  buyPrice: number;
  buyT: number;
  phaseIndex: number;
  totalShares: number;
  remainingShares: number;
  buyCost: number;
  buyFees: number;
}

interface BuyWatch {
  side: Side;
  phaseIdx: number;
  shares: number;
  triggerCents: number;
  optimize: boolean;
  /** True after ask has touched the trigger (optimize path). */
  armed: boolean;
  /** Gap already validated at arm time. */
  gapChecked: boolean;
  stallCents: number | null;
  stallTicks: number;
  prevAskCents: number | null;
  lastBookSampleCount: number;
}

/** Resting GTD limit buy (optimize off) — mirrors live phase-enter limit. */
interface RestingGtdBuy {
  side: Side;
  /** Remaining shares to fill. */
  shares: number;
  limitPrice: number;
  phaseIdx: number;
}

interface SellWatch {
  target: number;
}

interface PendingBuy {
  side: Side;
  shares: number;
  executeAtMs: number;
  phaseIdx: number;
  /** Max price for FAK re-check after latency (¢ → used as trigger). */
  triggerCents: number;
}

interface WindowCloseSnapshot {
  outcome?: "up" | "down";
  prevCloseAsset?: number;
  assetPrice?: number;
  assetGap?: number;
  windowEnd?: number;
}

interface WindowTradeResult {
  side: Side;
  shares: number;
  positionCost: number;
  proceeds: number;
  net: number;
}

function centsToPrice(cents: number): number {
  return cents / 100;
}

function fmtCents(price: number): string {
  return `${(price * 100).toFixed(1)}¢`;
}

function sessionKeyFor(state: LiveWindowState): string {
  return `${state.series || ""}:${state.windowStart || ""}`;
}

/** Quiet period after gap-filter cancel before placing another resting GTD. */
const GTD_FILTER_REPRESS_MS = 2500;

function isRoutineGtdCancelReason(reason: string): boolean {
  return reason.startsWith("gap filter");
}

function depthFromState(state: LiveWindowState): DepthQuote {
  const upAsks = takeLevels(state.yesAsks);
  const upBids = takeLevels(state.yesBids);
  const downAsks = takeLevels(state.noAsks);
  const downBids = takeLevels(state.noBids);

  if (upAsks.length === 0 && state.yesAsk != null && state.yesAskSize != null && state.yesAskSize > 0) {
    upAsks.push({ price: state.yesAsk, size: state.yesAskSize });
  }
  if (upBids.length === 0 && state.yesBid != null && state.yesBidSize != null && state.yesBidSize > 0) {
    upBids.push({ price: state.yesBid, size: state.yesBidSize });
  }
  if (downAsks.length === 0 && state.noAsk != null && state.noAskSize != null && state.noAskSize > 0) {
    downAsks.push({ price: state.noAsk, size: state.noAskSize });
  }
  if (downBids.length === 0 && state.noBid != null && state.noBidSize != null && state.noBidSize > 0) {
    downBids.push({ price: state.noBid, size: state.noBidSize });
  }

  return { upAsks, upBids, downAsks, downBids };
}

function asksForSide(quote: DepthQuote, side: Side): BookLevel[] {
  return side === "up" ? quote.upAsks : quote.downAsks;
}

function bidsForSide(quote: DepthQuote, side: Side): BookLevel[] {
  return side === "up" ? quote.upBids : quote.downBids;
}

function bestAskForSide(quote: DepthQuote, side: Side): number | undefined {
  return bestPrice(asksForSide(quote, side));
}

function bestBidForSide(quote: DepthQuote, side: Side): number | undefined {
  return bestPrice(bidsForSide(quote, side));
}

function elapsedFrac(state: LiveWindowState, nowSec: number): number {
  if (!state.windowStart || !state.windowEnd) return 0;
  const duration = state.windowEnd - state.windowStart;
  if (duration <= 0) return 0;
  return Math.min(1, Math.max(0, (nowSec - state.windowStart) / duration));
}

function phaseIndexForFrac(frac: number, setup: SimSetup): number {
  if (frac < setup.phaseSplit[0]) return 0;
  if (frac < setup.phaseSplit[1]) return 1;
  return 2;
}

/** Server-side trading simulator — runs on every book update. */
export class SimulatorEngine {
  private sessionKey: string | null = null;
  private position: Position | null = null;
  private buyWatch: BuyWatch | null = null;
  private restingGtd: RestingGtdBuy | null = null;
  private sellWatch: SellWatch | null = null;
  private pendingBuy: PendingBuy | null = null;
  private pendingPhaseAborts = new Map<number, number>();
  private abortedBuyPhases = new Set<number>();
  private completedPhaseAbortCancellations = new Set<number>();
  private externalBuyPaused = false;
  private sellsSuppressed = false;
  private trackedPhaseIdx = -1;
  private phaseCrossingBaseline = 0;
  private lastPtbCrossings = 0;
  private markers: SimMarker[] = [];
  private boughtThisWindow = false;
  private windowTrade: WindowTradeResult | null = null;
  private windowEndSnapshot: WindowCloseSnapshot | null = null;
  private lastWindow: SimLastWindow | null = null;
  private quoteLocks: SimQuoteLocks = {
    upBuy: null,
    upSell: null,
    downBuy: null,
    downSell: null,
  };
  /** After gap-filter cancels, wait before re-placing to avoid tick thrash. */
  private gtdRepressUntilMs = 0;
  /** Last phase index seen this window — used to clear repress on phase change. */
  private lastGtdPhaseIdx = -1;

  getMarkers(): SimMarker[] {
    return [...this.markers];
  }

  getQuoteLocks(): SimQuoteLocks {
    return { ...this.quoteLocks };
  }

  getWindowResult(): SimLastWindow | null {
    return this.lastWindow ? { ...this.lastWindow } : null;
  }

  getLastWindow(): SimLastWindow | null {
    return this.getWindowResult();
  }

  isPhaseBuyAborted(phaseIdx: number): boolean {
    return this.abortedBuyPhases.has(phaseIdx);
  }

  isPhaseAbortCancellationDue(phaseIdx: number): boolean {
    return this.completedPhaseAbortCancellations.has(phaseIdx);
  }

  /** Temporarily pause all automatic buys without stopping an existing sell path. */
  setExternalBuyPaused(paused: boolean): void {
    this.externalBuyPaused = paused;
    if (!paused) return;
    this.buyWatch = null;
    this.pendingBuy = null;
    this.restingGtd = null;
  }

  /** Permanently suppress all three phase buy paths for the current window. */
  suppressBuysForWindow(): void {
    this.setExternalBuyPaused(false);
    this.abortedBuyPhases.add(0);
    this.abortedBuyPhases.add(1);
    this.abortedBuyPhases.add(2);
    this.buyWatch = null;
    this.pendingBuy = null;
    this.restingGtd = null;
  }

  /** Hold an adopted position to settlement — no demo/live sell markers this window. */
  suppressSellsForWindow(): void {
    this.sellsSuppressed = true;
    this.sellWatch = null;
  }

  /** Adopt a real manual fill so configured phase sell logic can manage it. */
  adoptExternalBuy(
    state: LiveWindowState,
    side: Side,
    shares: number,
    price: number,
    phaseIdx: number,
    nowSec = Math.floor(Date.now() / 1000),
  ): void {
    this.resetRuntime(state);
    this.buyWatch = null;
    this.pendingBuy = null;
    this.restingGtd = null;
    this.sellWatch = null;
    this.position = {
      side,
      buyPrice: price,
      buyT: nowSec,
      phaseIndex: phaseIdx,
      totalShares: shares,
      remainingShares: shares,
      buyCost: shares * price,
      buyFees: 0,
    };
    this.boughtThisWindow = true;
    this.captureWindowSnapshot(state);
  }

  /** Reflect a manual sell in the simulator so stale sell markers are not emitted. */
  clearExternalPosition(side: Side): void {
    if (this.position?.side !== side) return;
    this.position = null;
    this.sellWatch = null;
    this.boughtThisWindow = false;
  }

  /**
   * Commit the prior window result and reset runtime when the live window
   * changes — even if we lack a setup to tick (e.g. between schedule slots).
   */
  rollWindowIfNeeded(state: LiveWindowState): SimLastWindow | null {
    if (!state.windowStart || !state.windowEnd) return this.getLastWindow();
    const key = sessionKeyFor(state);
    if (this.sessionKey !== null && this.sessionKey !== key) {
      this.commitLastWindow();
    }
    this.resetRuntime(state);
    return this.getLastWindow();
  }

  finalizeWindow(settlement?: {
    outcome?: "up" | "down";
    assetPrice?: number;
    prevCloseAsset?: number;
    assetGap?: number;
  }): SimLastWindow | null {
    if (settlement?.outcome) {
      const prev = this.windowEndSnapshot;
      const assetPrice = settlement.assetPrice ?? prev?.assetPrice;
      const prevCloseAsset = settlement.prevCloseAsset ?? prev?.prevCloseAsset;
      const assetGap =
        settlement.assetGap ??
        (assetPrice != null && prevCloseAsset != null
          ? assetPrice - prevCloseAsset
          : prev?.assetGap);
      this.windowEndSnapshot = {
        outcome: settlement.outcome,
        assetPrice,
        prevCloseAsset,
        assetGap,
        windowEnd: prev?.windowEnd,
      };
    }
    this.commitLastWindow();
    return this.getLastWindow();
  }

  private resetQuoteLocks(): void {
    this.quoteLocks = { upBuy: null, upSell: null, downBuy: null, downSell: null };
  }

  private lockQuoteBox(side: Side, leg: "buy" | "sell", price: number): void {
    if (!Number.isFinite(price)) return;
    if (side === "up") {
      if (leg === "buy") this.quoteLocks.upBuy = price;
      else this.quoteLocks.upSell = price;
      return;
    }
    if (leg === "buy") this.quoteLocks.downBuy = price;
    else this.quoteLocks.downSell = price;
  }

  private resetRuntime(state: LiveWindowState): void {
    const key = sessionKeyFor(state);
    if (this.sessionKey === key) return;
    this.sessionKey = key;
    this.position = null;
    this.buyWatch = null;
    this.restingGtd = null;
    this.sellWatch = null;
    this.pendingBuy = null;
    this.pendingPhaseAborts.clear();
    this.abortedBuyPhases.clear();
    this.completedPhaseAbortCancellations.clear();
    this.externalBuyPaused = false;
    this.sellsSuppressed = false;
    this.trackedPhaseIdx = -1;
    this.phaseCrossingBaseline = 0;
    this.lastPtbCrossings = 0;
    this.markers = [];
    this.boughtThisWindow = false;
    this.windowTrade = null;
    this.windowEndSnapshot = null;
    this.resetQuoteLocks();
    this.gtdRepressUntilMs = 0;
    this.lastGtdPhaseIdx = -1;
    logService.info("sim", `New window ${state.windowStart}`);
  }

  private captureWindowSnapshot(state: LiveWindowState): void {
    const outcome = resolveWindowOutcome(
      state.assetPrice,
      state.prevCloseAsset,
      state.assetGap,
    );
    this.windowEndSnapshot = {
      outcome,
      prevCloseAsset: state.prevCloseAsset,
      assetPrice: state.assetPrice,
      assetGap: state.assetGap,
      windowEnd: state.windowEnd,
    };
  }

  private snapshotFields(): Pick<
    SimLastWindow,
    "outcome" | "prevCloseAsset" | "assetPrice" | "assetGap" | "windowEnd"
  > {
    return {
      outcome: this.windowEndSnapshot?.outcome,
      prevCloseAsset: this.windowEndSnapshot?.prevCloseAsset,
      assetPrice: this.windowEndSnapshot?.assetPrice,
      assetGap: this.windowEndSnapshot?.assetGap,
      windowEnd: this.windowEndSnapshot?.windowEnd,
    };
  }

  private positionWon(
    side: Side | undefined,
    outcome: "up" | "down" | undefined,
  ): boolean | null {
    if (!side || !outcome) return null;
    return (side === "up" && outcome === "up") || (side === "down" && outcome === "down");
  }

  private commitLastWindow(): void {
    if (!this.sessionKey) return;

    const windowStart = Number(this.sessionKey.split(":")[1]) || 0;
    const snap = this.snapshotFields();
    const buyMarker = this.markers.find((m) => m.type === "buy");
    const sellMarker = this.markers.find((m) => m.type === "sell");

    if (!buyMarker) {
      this.lastWindow = {
        windowKey: this.sessionKey,
        windowStart,
        ...snap,
        sold: false,
        positionWon: null,
        pl: 0,
        plLabel: "No trade",
      };
      logService.info(
        "sim",
        `Last window ${windowStart}: ${snap.outcome?.toUpperCase() ?? "?"} — no trade`,
      );
      return;
    }

    const side = buyMarker.side;
    const shares = buyMarker.shares;
    const positionCost = (buyMarker.cost ?? 0) + (buyMarker.fees ?? 0);
    const won = this.positionWon(side, snap.outcome);

    if (sellMarker && this.windowTrade) {
      this.lastWindow = {
        windowKey: this.sessionKey,
        windowStart,
        ...snap,
        side,
        shares,
        buyPrice: buyMarker.price,
        buyCost: buyMarker.cost,
        buyFees: buyMarker.fees,
        positionCost,
        sold: true,
        sellPrice: sellMarker.price,
        sellProceeds: sellMarker.proceeds,
        positionWon: won,
        pl: this.windowTrade.net,
        plLabel: "Trade",
      };
      logService.info(
        "sim",
        `Last window ${windowStart}: ${snap.outcome?.toUpperCase() ?? "?"} — sold, P/L $${this.windowTrade.net.toFixed(2)}`,
      );
      return;
    }

    const payout = won ? shares : 0;
    const pl = payout - positionCost;

    this.lastWindow = {
      windowKey: this.sessionKey,
      windowStart,
      ...snap,
      side,
      shares,
      buyPrice: buyMarker.price,
      buyCost: buyMarker.cost,
      buyFees: buyMarker.fees,
      positionCost,
      sold: false,
      positionWon: won,
      pl,
      plLabel: "Settlement",
    };
    logService.info(
      "sim",
      `Last window ${windowStart}: ${snap.outcome?.toUpperCase() ?? "?"} — held, P/L $${pl.toFixed(2)}`,
    );
  }

  private latencyMs(setup: SimSetup): number {
    return Math.max(0, setup.latencyMs ?? 150);
  }

  private feeParams(setup: SimSetup): TakerFeeParams {
    return setup.feeParams ?? DEFAULT_CRYPTO_TAKER_FEE_PARAMS;
  }

  /** Schedule FAK-style taker buy after simulated latency. */
  private scheduleFakBuy(
    side: Side,
    shares: number,
    triggerCents: number,
    nowSec: number,
    state: LiveWindowState,
    setup: SimSetup,
    simNowMs: number,
    quote: DepthQuote,
    phaseIdx: number,
  ): void {
    const latency = this.latencyMs(setup);
    if (latency <= 0) {
      this.executeFakBuy(side, shares, triggerCents, nowSec, state, setup, quote);
      return;
    }
    if (this.pendingBuy) return;
    this.pendingBuy = { side, shares, executeAtMs: simNowMs + latency, phaseIdx, triggerCents };
    logService.info(
      "sim",
      `FAK buy scheduled: ${side} up to ${shares} sh, latency ${latency} ms (ask ${fmtCents(bestAskForSide(quote, side) ?? 0)})`,
    );
  }

  private executePhaseAbortCancellation(phaseIdx: number): void {
    if (this.position?.phaseIndex === phaseIdx) {
      logService.warn(
        "sim",
        `Phase ${phaseIdx + 1} PTB-crossing abort lost race to a buy fill; cancelling remainder`,
      );
    }
    if (this.restingGtd?.phaseIdx === phaseIdx) this.cancelRestingGtd("PTB crossing abort");
    if (this.pendingBuy?.phaseIdx === phaseIdx) this.pendingBuy = null;
    this.completedPhaseAbortCancellations.add(phaseIdx);
    logService.info("sim", `Phase ${phaseIdx + 1} PTB-crossing cancellation executed`);
  }

  private syncPhaseCrossingAbort(
    phase: SimSetup["phases"][number],
    phaseIdx: number,
    state: LiveWindowState,
    setup: SimSetup,
    simNowMs: number,
  ): void {
    const crossings = Math.max(0, Math.floor(state.ptbCrossings ?? 0));
    if (this.trackedPhaseIdx !== phaseIdx) {
      const firstObservedPhase = this.trackedPhaseIdx < 0;
      this.trackedPhaseIdx = phaseIdx;
      this.phaseCrossingBaseline = firstObservedPhase ? crossings : this.lastPtbCrossings;
    }
    this.lastPtbCrossings = crossings;

    const threshold = Math.max(0, Math.min(1000, Math.floor(phase.buyAbortOnCrossing || 0)));
    if (
      threshold <= 0 ||
      this.abortedBuyPhases.has(phaseIdx) ||
      this.pendingPhaseAborts.has(phaseIdx) ||
      crossings - this.phaseCrossingBaseline < threshold
    ) {
      return;
    }

    // Stop new buys and clear an armed watch immediately. Existing GTD/pending
    // FAK cancellation is delayed below so it can still fill during latency.
    this.abortedBuyPhases.add(phaseIdx);
    if (this.buyWatch?.phaseIdx === phaseIdx) this.buyWatch = null;
    logService.info("sim", `Phase ${phaseIdx + 1} buys aborted after PTB crossing threshold`);

    const latency = this.latencyMs(setup);
    if (latency <= 0) {
      this.executePhaseAbortCancellation(phaseIdx);
      return;
    }
    this.pendingPhaseAborts.set(phaseIdx, simNowMs + latency);
    logService.info(
      "sim",
      `Phase ${phaseIdx + 1} buy abort scheduled, latency ${latency} ms`,
    );
  }

  private processPendingPhaseAbort(simNowMs: number): void {
    for (const [phaseIdx, executeAtMs] of this.pendingPhaseAborts) {
      if (simNowMs < executeAtMs) continue;
      this.pendingPhaseAborts.delete(phaseIdx);
      this.executePhaseAbortCancellation(phaseIdx);
    }
  }

  /** Drop every in-flight phase buy when the clock leaves a phase. */
  private cancelBuysAtPhaseEnd(simNowMs: number): void {
    if (this.pendingBuy) {
      logService.info(
        "sim",
        `FAK pending cancelled (phase change, was phase ${this.pendingBuy.phaseIdx + 1})`,
      );
      this.pendingBuy = null;
    }
    if (this.buyWatch) {
      logService.info(
        "sim",
        `FAK watch cancelled (phase change, was phase ${this.buyWatch.phaseIdx + 1})`,
      );
      this.buyWatch = null;
    }
    if (this.restingGtd) {
      this.cancelRestingGtd("phase change", simNowMs);
    }
    // Re-evaluate sell target from the new phase's sell settings.
    this.sellWatch = null;
  }

  private processPendingFills(
    state: LiveWindowState,
    setup: SimSetup,
    quote: DepthQuote,
    nowSec: number,
    simNowMs: number,
  ): void {
    if (this.pendingBuy && simNowMs >= this.pendingBuy.executeAtMs) {
      const pending = this.pendingBuy;
      this.pendingBuy = null;
      const phaseIdx = phaseIndexForFrac(elapsedFrac(state, nowSec), setup);
      const phase = setup.phases[phaseIdx];
      // Never fill a FAK that belongs to a prior phase, or after buy was turned off.
      if (pending.phaseIdx !== phaseIdx || !phase?.buyEnabled || !phase.buyOptimize) {
        logService.info(
          "sim",
          `FAK pending dropped at execute (phase ${pending.phaseIdx + 1} → ${phaseIdx + 1})`,
        );
        return;
      }
      if (!this.position) {
        this.executeFakBuy(
          pending.side,
          pending.shares,
          pending.triggerCents,
          nowSec,
          state,
          setup,
          quote,
          true,
        );
      }
    }
  }

  /** FAK taker: take whatever size is available up to maxShares (partial OK). */
  private executeFakBuy(
    side: Side,
    maxShares: number,
    triggerCents: number,
    nowSec: number,
    state: LiveWindowState,
    setup: SimSetup,
    quote: DepthQuote,
    allowAbortedPending = false,
  ): void {
    if (this.position) return;

    const phaseIdx = phaseIndexForFrac(elapsedFrac(state, nowSec), setup);
    const phase = setup.phases[phaseIdx];
    if (!phase?.buyEnabled || !phase.buyOptimize) return;
    if (!allowAbortedPending && this.isPhaseBuyAborted(phaseIdx)) return;
    const ask = bestAskForSide(quote, side);
    if (ask == null || !Number.isFinite(ask) || priceToCents(ask) > triggerCents) {
      logService.error("sim", `FAK buy skipped after latency (ask above trigger or missing)`);
      return;
    }

    const feeParams = this.feeParams(setup);
    const fill = walkAsksAvailable(
      asksForSide(quote, side),
      maxShares,
      true,
      feeParams,
      centsToPrice(triggerCents),
    );
    if (!fill || fill.shares <= 0) {
      logService.error("sim", `FAK buy skipped after latency (no size available)`);
      return;
    }

    this.applyBuyFill(side, fill, nowSec, state, phaseIdx, "taker", triggerCents);
    this.buyWatch = null;
  }

  private applyBuyFill(
    side: Side,
    fill: { shares: number; avgPrice: number; cost: number; fees: number },
    nowSec: number,
    state: LiveWindowState,
    phaseIdx: number,
    style: "maker" | "taker",
    triggerCents?: number,
  ): void {
    const shares = fill.shares;
    if (!(shares > 0)) return;

    if (this.position && this.position.side === side) {
      const totalShares = this.position.totalShares + shares;
      const totalCost = this.position.buyCost + fill.cost;
      const totalFees = this.position.buyFees + fill.fees;
      this.position.totalShares = totalShares;
      this.position.remainingShares += shares;
      this.position.buyCost = totalCost;
      this.position.buyFees = totalFees;
      this.position.buyPrice = totalShares > 0 ? totalCost / totalShares : fill.avgPrice;
    } else if (!this.position) {
      this.position = {
        side,
        buyPrice: fill.avgPrice,
        buyT: nowSec,
        phaseIndex: phaseIdx,
        totalShares: shares,
        remainingShares: shares,
        buyCost: fill.cost,
        buyFees: fill.fees,
      };
      this.sellWatch = null;
    } else {
      return;
    }

    this.boughtThisWindow = true;
    this.markers.push({
      type: "buy",
      side,
      t: nowSec,
      y: state.assetPrice ?? null,
      shares,
      price: fill.avgPrice,
      triggerCents,
      phaseIndex: phaseIdx,
      cost: fill.cost,
      fees: fill.fees,
      total: fill.cost + fill.fees,
      windowKey: sessionKeyFor(state),
    });
    this.lockQuoteBox(side, "buy", fill.avgPrice);
    logService.success(
      "sim",
      `Buy filled: ${side} ${shares} sh @ ${fmtCents(fill.avgPrice)}, cost $${fill.cost.toFixed(2)}${fill.fees > 0 ? `, fees $${fill.fees.toFixed(5)}` : ""} (${style})`,
    );
  }

  /** Sync sell limit to the clock phase's sell settings (not the buy phase). */
  private syncSellWatchForPhase(phase: SimSetup["phases"][number]): void {
    if (!this.position || this.sellsSuppressed) {
      this.sellWatch = null;
      return;
    }
    if (!sellEnabledForPhase(phase)) {
      this.sellWatch = null;
      return;
    }
    const target = this.position.buyPrice + centsToPrice(phase.sellProfitCents);
    if (this.sellWatch && Math.abs(this.sellWatch.target - target) < 1e-9) return;
    this.sellWatch = { target };
    logService.info("sim", `Sell watch updated for clock phase, limit ${fmtCents(target)}`);
  }

  private executeSell(
    quote: DepthQuote,
    nowSec: number,
    state: LiveWindowState,
    setup: SimSetup,
  ): void {
    if (!this.position || !this.boughtThisWindow) return;

    const side = this.position.side;
    const limitPrice = this.sellWatch?.target;
    const feeParams = this.feeParams(setup);
    const shares = this.position.remainingShares;
    const fill =
      limitPrice == null
        ? walkBids(bidsForSide(quote, side), shares, true, feeParams)
        : fillMakerLimitSell(bidsForSide(quote, side), shares, limitPrice);
    if (!fill) return;

    const positionCost = this.position.buyCost + this.position.buyFees;
    const sellNet = fill.proceeds - fill.fees;
    const profit = sellNet - positionCost;
    const sellT = Math.max(nowSec, this.position.buyT);

    this.position.remainingShares -= fill.shares;
    this.markers.push({
      type: "sell",
      side,
      t: sellT,
      y: state.assetPrice ?? null,
      shares: fill.shares,
      price: fill.avgPrice,
      proceeds: fill.proceeds,
      fees: fill.fees,
      profit,
      total: sellNet,
      windowKey: sessionKeyFor(state),
    });
    this.lockQuoteBox(side, "sell", fill.avgPrice);
    const feeNote = fill.fees > 0 ? `, fees $${fill.fees.toFixed(5)}` : "";
    logService.success(
      "sim",
      `Sell filled: ${side} ${fill.shares} sh @ ${fmtCents(fill.avgPrice)}, net $${sellNet.toFixed(2)}${feeNote}, P/L $${profit.toFixed(2)}`,
    );

    if (this.position.remainingShares <= 0) {
      this.windowTrade = {
        side,
        shares: fill.shares,
        positionCost,
        proceeds: sellNet,
        net: sellNet - positionCost,
      };
      this.position = null;
      this.sellWatch = null;
      return;
    }

    this.sellWatch = null;
  }

  private fireFakBuy(
    side: Side,
    maxShares: number,
    triggerCents: number,
    nowSec: number,
    state: LiveWindowState,
    setup: SimSetup,
    simNowMs: number,
    quote: DepthQuote,
  ): void {
    this.buyWatch = null;
    const available = totalLevelSize(asksForSide(quote, side));
    const shares = Math.min(maxShares, available);
    if (!(shares > 0)) return;
    const phaseIdx = phaseIndexForFrac(elapsedFrac(state, nowSec), setup);
    if (this.isPhaseBuyAborted(phaseIdx)) return;
    this.scheduleFakBuy(side, shares, triggerCents, nowSec, state, setup, simNowMs, quote, phaseIdx);
  }

  /** Place resting GTD at phase enter when gap allows (optimize off). */
  private tryPlaceRestingGtd(
    phase: SimSetup["phases"][number],
    phaseIdx: number,
    state: LiveWindowState,
    simNowMs: number,
    preCancelForNextPhase = false,
  ): void {
    if (this.externalBuyPaused || phase.buyOptimize || !phase.buyEnabled) return;
    if (preCancelForNextPhase) return;
    if (this.isPhaseBuyAborted(phaseIdx)) return;
    if (this.position || this.restingGtd || this.pendingBuy) return;
    if (simNowMs < this.gtdRepressUntilMs) return;

    let chosenSide: Side | null = null;
    for (const side of SIDES_ORDER) {
      if (gapAllowsBuy(side, phase, state.assetGap)) {
        chosenSide = side;
        break;
      }
    }
    if (!chosenSide) return;

    const shares = Math.max(1, phase.buyShares || 1);
    const limitPrice = centsToPrice(phase.buyTrigger);
    this.restingGtd = {
      side: chosenSide,
      shares,
      limitPrice,
      phaseIdx,
    };
    logService.info(
      "sim",
      `GTD resting placed: ${chosenSide} ${shares} sh @ ${fmtCents(limitPrice)} (phase ${phaseIdx + 1})`,
    );
  }

  private cancelRestingGtd(reason: string, nowMs?: number): void {
    if (!this.restingGtd) return;
    if (isRoutineGtdCancelReason(reason)) {
      // Price flickering around PTB — don't log every tick cancel.
      this.gtdRepressUntilMs = (nowMs ?? Date.now()) + GTD_FILTER_REPRESS_MS;
    } else {
      logService.info("sim", `GTD resting cancelled (${reason})`);
    }
    this.restingGtd = null;
  }

  private syncRestingGtdForPhase(
    phase: SimSetup["phases"][number],
    phaseIdx: number,
    state: LiveWindowState,
    simNowMs: number,
    preCancelForNextPhase = false,
  ): void {
    if (!this.restingGtd) return;
    const restingSide = this.restingGtd.side;
    const endingThisPhase = this.restingGtd.phaseIdx === phaseIdx && preCancelForNextPhase;
    if (
      this.restingGtd.phaseIdx !== phaseIdx ||
      phase.buyOptimize ||
      !phase.buyEnabled ||
      !gapAllowsBuy(restingSide, phase, state.assetGap) ||
      endingThisPhase
    ) {
      this.cancelRestingGtd(
        endingThisPhase
          ? "phase ending"
          : this.restingGtd.phaseIdx !== phaseIdx
            ? "phase change"
            : phase.buyOptimize
              ? "optimize on"
              : !phase.buyEnabled
                ? "buy disabled"
                : describeGapFilterCancelReason(restingSide, phase, state.assetGap),
        simNowMs,
      );
    }
  }

  private tickRestingGtd(
    quote: DepthQuote,
    nowSec: number,
    state: LiveWindowState,
    phase: SimSetup["phases"][number],
    phaseIdx: number,
    simNowMs: number,
  ): void {
    const resting = this.restingGtd;
    if (!resting) return;
    // Safety: never fill a resting order that belongs to a previous phase.
    if (resting.phaseIdx !== phaseIdx) {
      this.cancelRestingGtd("phase change", simNowMs);
      return;
    }

    const fill = fillMakerLimitBuyAvailable(
      asksForSide(quote, resting.side),
      resting.shares,
      resting.limitPrice,
    );
    if (!fill || fill.shares <= 0) return;

    this.applyBuyFill(resting.side, fill, nowSec, state, resting.phaseIdx, "maker");
    resting.shares -= fill.shares;
    if (resting.shares <= 1e-9) {
      this.restingGtd = null;
    }
  }

  private tryStartBuyWatch(
    phase: SimSetup["phases"][number],
    quote: DepthQuote,
    nowSec: number,
    state: LiveWindowState,
    _setup: SimSetup,
    _simNowMs: number,
  ): void {
    if (this.externalBuyPaused || !phase.buyOptimize || !phase.buyEnabled) return;
    const phaseIdx = phaseIndexForFrac(elapsedFrac(state, nowSec), _setup);
    if (this.isPhaseBuyAborted(phaseIdx)) return;
    if (this.position || this.buyWatch || this.restingGtd || this.pendingBuy) return;

    const shares = Math.max(1, phase.buyShares || 1);
    const triggerCents = phase.buyTrigger;
    const assetGap = state.assetGap;

    for (const side of SIDES_ORDER) {
      const ask = bestAskForSide(quote, side);
      if (ask == null || !Number.isFinite(ask)) continue;
      const askCents = priceToCents(ask);

      // Optimize: must first touch trigger exactly, then hunt ≤.
      if (askCents !== triggerCents) continue;
      if (!gapAllowsBuy(side, phase, assetGap)) continue;

      this.buyWatch = {
        side,
        phaseIdx,
        shares,
        triggerCents,
        optimize: true,
        armed: true,
        gapChecked: true,
        stallCents: null,
        stallTicks: 0,
        prevAskCents: askCents,
        lastBookSampleCount: state.bookTickSequence ?? 0,
      };
      logService.info(
        "sim",
        `Buy optimize armed: ${side} touched ${triggerCents}¢ (gap passed)`,
      );
      return;
    }
  }

  private tickBuyWatch(
    quote: DepthQuote,
    nowSec: number,
    state: LiveWindowState,
    setup: SimSetup,
    simNowMs: number,
  ): void {
    if (!this.buyWatch?.optimize) return;
    const w = this.buyWatch;
    const ask = bestAskForSide(quote, w.side);
    if (ask == null || !Number.isFinite(ask)) return;
    const askCents = priceToCents(ask);
    const phaseIdx = phaseIndexForFrac(elapsedFrac(state, nowSec), setup);
    const phase = setup.phases[phaseIdx];
    // Phase-boundary cancelBuysAtPhaseEnd already drops watches; never carry
    // a prior phase's trigger into the current phase.
    if (w.phaseIdx !== phaseIdx) {
      this.buyWatch = null;
      return;
    }
    if (this.isPhaseBuyAborted(phaseIdx)) {
      this.buyWatch = null;
      return;
    }
    if (!phase.buyEnabled) {
      this.buyWatch = null;
      return;
    }

    const bookSampleCount = state.bookTickSequence ?? 0;
    if (bookSampleCount <= w.lastBookSampleCount) return;
    w.lastBookSampleCount = bookSampleCount;

    if (askCents > w.triggerCents) {
      // Pause until trigger is touched again.
      w.armed = false;
      w.stallCents = null;
      w.stallTicks = 0;
      w.prevAskCents = askCents;
      return;
    }

    if (!w.armed) {
      if (askCents !== w.triggerCents) {
        w.prevAskCents = askCents;
        return;
      }
      // Re-touch — gap was already validated at first arm.
      w.armed = true;
      w.stallCents = null;
      w.stallTicks = 0;
      w.prevAskCents = askCents;
      logService.info("sim", `Buy optimize re-armed: ${w.side} @ ${w.triggerCents}¢`);
      return;
    }

    // FAK: any available size is enough (partial OK).
    if (totalLevelSize(asksForSide(quote, w.side)) <= 0) return;

    // Hunting at ≤ trigger.
    if (askCents <= w.triggerCents) {
      if (w.prevAskCents != null && askCents > w.prevAskCents) {
        // Reverse while still ≤ trigger → buy.
        this.fireFakBuy(w.side, w.shares, w.triggerCents, nowSec, state, setup, simNowMs, quote);
        return;
      }

      if (w.stallCents === askCents) {
        w.stallTicks += 1;
      } else {
        w.stallCents = askCents;
        w.stallTicks = 1;
      }
      if (w.stallTicks >= 3) {
        this.fireFakBuy(w.side, w.shares, w.triggerCents, nowSec, state, setup, simNowMs, quote);
        return;
      }
    }

    w.prevAskCents = askCents;
  }

  private tickSellWatch(
    quote: DepthQuote,
    nowSec: number,
    state: LiveWindowState,
    setup: SimSetup,
    simNowMs: number,
  ): void {
    if (!this.position || !this.sellWatch) return;
    const bid = bestBidForSide(quote, this.position.side);
    if (bid == null || !Number.isFinite(bid)) return;
    if (bid < this.sellWatch.target) return;
    // Maker sell fills have no simulated latency.
    this.executeSell(quote, nowSec, state, setup);
  }

  tick(state: LiveWindowState, setup: SimSetup, nowMs?: number): void {
    if (!state.windowStart || !state.windowEnd) return;

    this.rollWindowIfNeeded(state);

    const simNowMs = nowMs ?? state.lastTickMs ?? Date.now();
    const nowSec = Math.floor(simNowMs / 1000);
    if (nowSec < state.windowStart || nowSec >= state.windowEnd) return;

    this.captureWindowSnapshot(state);

    const frac = elapsedFrac(state, nowSec);
    const phaseIdx = phaseIndexForFrac(frac, setup);
    const phase = setup.phases[phaseIdx];
    const quote = depthFromState(state);
    const preCancelForNextPhase = shouldPreCancelGtdForNextPhase(
      state,
      setup.phaseSplit,
      phaseIdx,
      nowSec,
    );

    // Hard boundary: kill prior-phase FAK/GTD before any fill can land.
    if (this.lastGtdPhaseIdx !== phaseIdx) {
      if (this.lastGtdPhaseIdx >= 0) {
        this.cancelBuysAtPhaseEnd(simNowMs);
      }
      this.lastGtdPhaseIdx = phaseIdx;
      this.gtdRepressUntilMs = 0;
    }

    this.syncPhaseCrossingAbort(phase, phaseIdx, state, setup, simNowMs);
    this.processPendingFills(state, setup, quote, nowSec, simNowMs);
    this.processPendingPhaseAbort(simNowMs);

    // GTD resting: cancel on optimize/gap/phase-ending, fill from book, place when active.
    this.syncRestingGtdForPhase(phase, phaseIdx, state, simNowMs, preCancelForNextPhase);
    this.tickRestingGtd(quote, nowSec, state, phase, phaseIdx, simNowMs);
    if (!this.position || this.restingGtd) {
      this.tryPlaceRestingGtd(phase, phaseIdx, state, simNowMs, preCancelForNextPhase);
      this.tickRestingGtd(quote, nowSec, state, phase, phaseIdx, simNowMs);
    }

    if (!this.position && !this.pendingBuy && !this.restingGtd) {
      this.tryStartBuyWatch(phase, quote, nowSec, state, setup, simNowMs);
      this.tickBuyWatch(quote, nowSec, state, setup, simNowMs);
    } else if (this.position && !this.sellsSuppressed) {
      // Sell follows the clock phase's settings, not the phase that bought.
      this.syncSellWatchForPhase(phase);
      if (this.sellWatch) {
        this.tickSellWatch(quote, nowSec, state, setup, simNowMs);
      }
    }
  }
}
