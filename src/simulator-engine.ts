import type { BookLevel } from "./clob-service.js";
import {
  bestPrice,
  canFillAsks,
  fillMakerLimitBuy,
  fillMakerLimitSell,
  takeLevels,
  walkAsks,
  walkBids,
} from "./book-depth.js";
import { DEFAULT_CRYPTO_TAKER_FEE_PARAMS, type TakerFeeParams } from "./taker-fee.js";
import type { LiveWindowState, SimMarker, SimQuoteLocks, SimSetup, SimLastWindow } from "./types.js";
import { gapAllowsBuy, priceToCents, SIDES_ORDER } from "./phase-config.js";
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
}

interface SellWatch {
  target: number;
}

interface PendingBuy {
  side: Side;
  shares: number;
  executeAtMs: number;
  /** Limit price for maker; null = take asks. */
  limitPrice: number | null;
}

interface PendingSell {
  executeAtMs: number;
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

function hasBuyLiquidity(quote: DepthQuote, side: Side, shares: number): boolean {
  if (!shares || shares <= 0) return false;
  const ask = bestAskForSide(quote, side);
  if (ask == null || !Number.isFinite(ask)) return false;
  return canFillAsks(asksForSide(quote, side), shares);
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
  private sellWatch: SellWatch | null = null;
  private pendingBuy: PendingBuy | null = null;
  private pendingSell: PendingSell | null = null;
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
    this.sellWatch = null;
    this.pendingBuy = null;
    this.pendingSell = null;
    this.markers = [];
    this.boughtThisWindow = false;
    this.windowTrade = null;
    this.windowEndSnapshot = null;
    this.resetQuoteLocks();
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

  private scheduleBuy(
    side: Side,
    shares: number,
    nowSec: number,
    state: LiveWindowState,
    setup: SimSetup,
    simNowMs: number,
    quote: DepthQuote,
    limitPrice: number | null,
  ): void {
    const latency = this.latencyMs(setup);
    if (latency <= 0) {
      this.executeBuy(side, shares, nowSec, state, setup, quote, limitPrice);
      return;
    }
    if (this.pendingBuy) return;
    this.pendingBuy = { side, shares, executeAtMs: simNowMs + latency, limitPrice };
    logService.info(
      "sim",
      `Buy scheduled: ${side} ${shares} sh, latency ${latency} ms (ask ${fmtCents(bestAskForSide(quote, side) ?? 0)})`,
    );
  }

  private scheduleSell(
    quote: DepthQuote,
    nowSec: number,
    state: LiveWindowState,
    setup: SimSetup,
    simNowMs: number,
  ): void {
    const latency = this.latencyMs(setup);
    if (latency <= 0) {
      this.executeSell(quote, nowSec, state, setup);
      return;
    }
    if (this.pendingSell) return;
    this.pendingSell = { executeAtMs: simNowMs + latency };
    const side = this.position?.side ?? "up";
    logService.info(
      "sim",
      `Sell scheduled: ${side}, latency ${latency} ms (bid ${fmtCents(bestBidForSide(quote, side) ?? 0)})`,
    );
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
      if (!this.boughtThisWindow && !this.position) {
        const phaseIdx = phaseIndexForFrac(elapsedFrac(state, nowSec), setup);
        const phase = setup.phases[phaseIdx];
        if (phase.buyEnabled) {
          const trigger = centsToPrice(phase.buyTrigger);
          const ask = bestAskForSide(quote, pending.side);
          const askOk =
            ask != null &&
            Number.isFinite(ask) &&
            ask <= trigger &&
            hasBuyLiquidity(quote, pending.side, pending.shares);
          if (askOk) {
            this.executeBuy(
              pending.side,
              pending.shares,
              nowSec,
              state,
              setup,
              quote,
              pending.limitPrice,
            );
          } else {
            logService.error("sim", `Buy skipped after latency (conditions no longer met)`);
          }
        }
      }
    }

    if (this.pendingSell && simNowMs >= this.pendingSell.executeAtMs) {
      this.pendingSell = null;
      if (this.position && this.sellWatch) {
        const bid = bestBidForSide(quote, this.position.side);
        if (bid != null && Number.isFinite(bid) && bid >= this.sellWatch.target) {
          this.executeSell(quote, nowSec, state, setup);
        } else {
          logService.error("sim", `Sell skipped after latency (bid below target)`);
        }
      }
    }
  }

  private executeBuy(
    side: Side,
    shares: number,
    nowSec: number,
    state: LiveWindowState,
    setup: SimSetup,
    quote: DepthQuote,
    limitPrice: number | null,
  ): void {
    if (!hasBuyLiquidity(quote, side, shares)) return;
    if (this.boughtThisWindow || this.position) return;

    const phaseIdx = phaseIndexForFrac(elapsedFrac(state, nowSec), setup);
    const phase = setup.phases[phaseIdx];
    const feeParams = this.feeParams(setup);
    const makerLimit = limitPrice ?? centsToPrice(phase.buyTrigger);
    const isTaker = limitPrice == null;
    const fill = isTaker
      ? walkAsks(asksForSide(quote, side), shares, true, feeParams)
      : fillMakerLimitBuy(asksForSide(quote, side), shares, makerLimit);
    if (!fill) return;

    this.boughtThisWindow = true;
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
    this.buyWatch = null;
    this.sellWatch = null;
    this.markers.push({
      type: "buy",
      side,
      t: nowSec,
      y: state.assetPrice ?? null,
      shares,
      price: fill.avgPrice,
      cost: fill.cost,
      fees: fill.fees,
      total: fill.cost + fill.fees,
      windowKey: sessionKeyFor(state),
    });
    this.lockQuoteBox(side, "buy", fill.avgPrice);
    logService.success(
      "sim",
      `Buy filled: ${side} ${shares} sh @ ${fmtCents(fill.avgPrice)}, cost $${fill.cost.toFixed(2)}${fill.fees > 0 ? `, fees $${fill.fees.toFixed(5)}` : ""} (${isTaker ? "taker" : "maker"})`,
    );
  }

  private startSellWatch(phase: SimSetup["phases"][number]): void {
    if (!this.position || this.sellWatch) return;
    const target = this.position.buyPrice + centsToPrice(phase.sellProfitCents);
    this.sellWatch = { target };
    logService.info("sim", `Sell watch started, limit ${fmtCents(target)}`);
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

  private fireBuy(
    side: Side,
    shares: number,
    nowSec: number,
    state: LiveWindowState,
    setup: SimSetup,
    simNowMs: number,
    quote: DepthQuote,
    optimize: boolean,
  ): void {
    const limitPrice = optimize ? null : centsToPrice(setup.phases[
      phaseIndexForFrac(elapsedFrac(state, nowSec), setup)
    ].buyTrigger);
    this.buyWatch = null;
    this.scheduleBuy(side, shares, nowSec, state, setup, simNowMs, quote, limitPrice);
  }

  private tryStartBuyWatch(
    phase: SimSetup["phases"][number],
    quote: DepthQuote,
    nowSec: number,
    state: LiveWindowState,
    setup: SimSetup,
    simNowMs: number,
  ): void {
    if (!phase.buyEnabled || this.position || this.buyWatch || this.boughtThisWindow) return;

    const shares = Math.max(1, phase.buyShares || 1);
    const triggerCents = phase.buyTrigger;
    const assetGap = state.assetGap;

    for (const side of SIDES_ORDER) {
      if (!hasBuyLiquidity(quote, side, shares)) continue;
      const ask = bestAskForSide(quote, side);
      if (ask == null || !Number.isFinite(ask)) continue;
      const askCents = priceToCents(ask);

      if (!phase.buyOptimize) {
        // Limit: fire when ask is at or below trigger; gap checked at arm/fire.
        if (askCents > triggerCents) continue;
        if (!gapAllowsBuy(side, phase, assetGap)) continue;
        this.fireBuy(side, shares, nowSec, state, setup, simNowMs, quote, false);
        return;
      }

      // Optimize: must first touch trigger exactly, then hunt ≤.
      if (askCents !== triggerCents) continue;
      if (!gapAllowsBuy(side, phase, assetGap)) continue;

      this.buyWatch = {
        side,
        shares,
        triggerCents,
        optimize: true,
        armed: true,
        gapChecked: true,
        stallCents: null,
        stallTicks: 0,
        prevAskCents: askCents,
      };
      logService.info(
        "sim",
        `Buy optimize armed: ${side} touched ${triggerCents}¢ (gap filter passed)`,
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
      // Re-touch — gap already validated at first arm.
      w.armed = true;
      w.stallCents = null;
      w.stallTicks = 0;
      w.prevAskCents = askCents;
      logService.info("sim", `Buy optimize re-armed: ${w.side} @ ${w.triggerCents}¢`);
      return;
    }

    if (!hasBuyLiquidity(quote, w.side, w.shares)) return;

    // Hunting at ≤ trigger.
    if (askCents <= w.triggerCents) {
      if (w.prevAskCents != null && askCents > w.prevAskCents) {
        // Reverse while still ≤ trigger → buy.
        this.fireBuy(w.side, w.shares, nowSec, state, setup, simNowMs, quote, true);
        return;
      }

      if (w.stallCents === askCents) {
        w.stallTicks += 1;
      } else {
        w.stallCents = askCents;
        w.stallTicks = 1;
      }
      if (w.stallTicks >= 3) {
        this.fireBuy(w.side, w.shares, nowSec, state, setup, simNowMs, quote, true);
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
    this.scheduleSell(quote, nowSec, state, setup, simNowMs);
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

    this.processPendingFills(state, setup, quote, nowSec, simNowMs);

    if (!this.position && !this.pendingBuy) {
      this.tryStartBuyWatch(phase, quote, nowSec, state, setup, simNowMs);
      this.tickBuyWatch(quote, nowSec, state, setup, simNowMs);
    } else if (this.position && !this.pendingSell) {
      const sellPhase = setup.phases[this.position.phaseIndex];
      if (!this.sellWatch) this.startSellWatch(sellPhase);
      this.tickSellWatch(quote, nowSec, state, setup, simNowMs);
    }
  }
}
