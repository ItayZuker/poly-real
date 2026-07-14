import {
  findActiveScheduleContext,
  isScheduleContextActive,
  type ActiveScheduleContext,
} from "./schedule-active.js";
import { placeMarketOrder } from "./order-service.js";
import { refreshCollateralBalance } from "./trading-client.js";
import { SimulatorEngine } from "./simulator-engine.js";
import { simulatorService, phaseSetupToSimSetup } from "./simulator-service.js";
import { logService } from "./log-service.js";
import { resolveWindowOutcome } from "./window-outcome.js";
import {
  fetchClosedPositions,
  fetchUserPositions,
  fetchUserTrades,
  findClosedPosition,
  findPosition,
  findTrade,
  pollUntil,
  isValidSharePrice,
  isValidShareSize,
} from "./polymarket-portfolio.js";
import { tradingConfigFilePath } from "./db/data-dir.js";
import { readJsonFile, writeJsonFile } from "./db/file-store.js";
import type {
  LiveWindowState,
  SimMarker,
  SimQuoteLocks,
  SimSetup,
  TradingConfig,
  TradingPhaseSetup,
  TradingPositionCard,
  TradingPublicState,
  PlacementLiveStats,
} from "./types.js";

interface SidePosition {
  shares: number;
  avgPrice: number;
  cost: number;
  cardId: string;
  asset?: string;
  conditionId?: string;
}

type UpdateListener = () => void;

function sessionKey(state: LiveWindowState): string {
  return `${state.series || ""}:${state.windowStart || ""}`;
}

function emptyQuoteLocks(): SimQuoteLocks {
  return { upBuy: null, upSell: null, downBuy: null, downSell: null };
}

function newCardId(): string {
  return `pos-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function outcomeFromIndex(index?: number, label?: string): "up" | "down" | undefined {
  if (index === 0 || /^up$/i.test(String(label || ""))) return "up";
  if (index === 1 || /^down$/i.test(String(label || ""))) return "down";
  return undefined;
}

function defaultTradingConfig(): TradingConfig {
  return {
    autoTrade: false,
    useSchedule: false,
    startTrading: false,
    manualShares: 10,
    manualOrderUnit: "shares",
  };
}

function normalizeTradingConfig(raw: Partial<TradingConfig> | null | undefined): TradingConfig {
  const base = defaultTradingConfig();
  if (!raw || typeof raw !== "object") return base;
  const unit = raw.manualOrderUnit === "usdc" ? "usdc" : "shares";
  const amountRaw = Number(raw.manualShares);
  const amount =
    unit === "usdc"
      ? Math.max(0.01, Math.min(100000, Math.round((Number.isFinite(amountRaw) ? amountRaw : 10) * 100) / 100))
      : Math.max(1, Math.min(100000, Math.floor(Number.isFinite(amountRaw) ? amountRaw : 10) || 10));
  const next: TradingConfig = {
    autoTrade: Boolean(raw.autoTrade),
    useSchedule: Boolean(raw.useSchedule),
    startTrading: Boolean(raw.startTrading),
    manualShares: amount,
    manualOrderUnit: unit,
  };
  if (!next.autoTrade) {
    next.useSchedule = false;
    next.startTrading = false;
  }
  return next;
}

/** Live trading — manual orders, phase auto-trade, schedule-driven setup. */
export class LiveTradingService {
  private config: TradingConfig = defaultTradingConfig();
  private persistChain: Promise<void> = Promise.resolve();

  private positions: { up: SidePosition | null; down: SidePosition | null } = {
    up: null,
    down: null,
  };

  private quoteLocks: SimQuoteLocks = emptyQuoteLocks();
  private markers: SimMarker[] = [];
  private positionCards: TradingPositionCard[] = [];
  /** Placement ids that have had schedule auto-trades this session (for live card stats). */
  private knownPlacementIds = new Set<string>();
  private sessionKey: string | null = null;
  private mirroredMarkerCount = 0;
  private orderInFlight = false;
  private scheduleContext: ActiveScheduleContext | null = null;
  private scheduleContextFetchedAt = 0;
  private activePhaseSetup: TradingPhaseSetup | null = null;
  private readonly autoEngine = new SimulatorEngine();
  private lastAssetPrice: number | undefined;
  private lastPrevCloseAsset: number | undefined;
  private lastAssetGap: number | undefined;
  private readonly listeners = new Set<UpdateListener>();
  private confirmLoopTimer: ReturnType<typeof setInterval> | null = null;
  private confirmInFlight = false;

  onUpdate(listener: UpdateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  getConfig(): TradingConfig {
    return { ...this.config };
  }

  async loadPersistedConfig(): Promise<TradingConfig> {
    try {
      const loaded = await readJsonFile<Partial<TradingConfig>>(tradingConfigFilePath());
      this.config = normalizeTradingConfig(loaded);
    } catch (err) {
      logService.warn("trading", `Failed to load trading config: ${String(err)}`);
      this.config = defaultTradingConfig();
    }
    return this.getConfig();
  }

  private persistConfig(): void {
    const snapshot = this.getConfig();
    this.persistChain = this.persistChain
      .then(() => writeJsonFile(tradingConfigFilePath(), snapshot))
      .catch((err) => {
        logService.warn("trading", `Failed to save trading config: ${String(err)}`);
      });
  }

  setConfig(patch: Partial<TradingConfig>): TradingConfig {
    if (patch.autoTrade != null) this.config.autoTrade = Boolean(patch.autoTrade);
    if (patch.useSchedule != null) this.config.useSchedule = Boolean(patch.useSchedule);
    if (patch.startTrading != null) this.config.startTrading = Boolean(patch.startTrading);
    if (patch.manualOrderUnit === "shares" || patch.manualOrderUnit === "usdc") {
      this.config.manualOrderUnit = patch.manualOrderUnit;
    }
    if (patch.manualShares != null) {
      const amount = Number(patch.manualShares);
      if (this.config.manualOrderUnit === "usdc") {
        this.config.manualShares = Math.max(
          0.01,
          Math.min(100000, Math.round((Number.isFinite(amount) ? amount : 10) * 100) / 100),
        );
      } else {
        this.config.manualShares = Math.max(
          1,
          Math.min(100000, Math.floor(Number.isFinite(amount) ? amount : 10) || 10),
        );
      }
    }
    // Re-normalize amount if unit changed after amount in the same patch
    if (patch.manualOrderUnit != null && patch.manualShares == null) {
      this.config = normalizeTradingConfig(this.config);
    }
    if (!this.config.autoTrade) {
      this.config.useSchedule = false;
      this.config.startTrading = false;
    }
    this.persistConfig();
    return this.getConfig();
  }

  private isPreviewMode(): boolean {
    return this.config.autoTrade && !this.config.startTrading;
  }

  private canExecuteOrders(): boolean {
    if (!this.config.autoTrade) return true;
    return this.config.startTrading;
  }

  private getDisplayMarkers(): SimMarker[] {
    const key = this.sessionKey;
    if (this.isPreviewMode() && key) {
      return this.autoEngine.getMarkers().filter((m) => m.windowKey === key);
    }
    return [...this.markers];
  }

  getPublicState(): TradingPublicState {
    const phasesVisible = this.shouldShowPhases();
    const previewMode = this.isPreviewMode();
    return {
      config: this.getConfig(),
      positions: {
        up: this.positions.up ? { ...this.positions.up } : null,
        down: this.positions.down ? { ...this.positions.down } : null,
      },
      positionCards: this.positionCards.map((card) => ({ ...card })),
      placementStats: this.getPlacementStatsFromCards(),
      quoteLocks: previewMode ? this.autoEngine.getQuoteLocks() : { ...this.quoteLocks },
      markers: this.getDisplayMarkers(),
      phaseSetup: phasesVisible ? this.getDisplayPhaseSetup() : null,
      phasesVisible,
      phasesEditable: phasesVisible && this.config.autoTrade && !this.config.useSchedule,
      scheduleTitle: this.config.useSchedule && this.scheduleContext ? this.scheduleContext.title : null,
      quotesEnabled: this.canExecuteOrders(),
      previewMode,
    };
  }

  /** Aggregate real-trade outcomes for schedule placement cards. */
  getPlacementStats(placementIds: string[]): PlacementLiveStats[] {
    return placementIds.map((id) => this.statsForPlacement(id));
  }

  private getPlacementStatsFromCards(): PlacementLiveStats[] {
    return this.getPlacementStats([...this.knownPlacementIds]);
  }

  private emptyPlacementStats(placementId: string): PlacementLiveStats {
    return {
      placementId,
      hasData: false,
      green: 0,
      red: 0,
      blue: 0,
      pnl: 0,
    };
  }

  private statsForPlacement(placementId: string): PlacementLiveStats {
    let green = 0;
    let red = 0;
    let blue = 0;
    let pnl = 0;
    let hasData = false;

    for (const card of this.positionCards) {
      if (card.placementId !== placementId) continue;
      if (card.status === "open") continue;
      hasData = true;
      const pl = Number(card.pl ?? 0);
      pnl += Number.isFinite(pl) ? pl : 0;
      if (card.status === "sold") {
        if (pl > 0) green += 1;
        else red += 1;
      } else if (card.status === "win") {
        blue += 1;
      } else if (card.status === "loss") {
        red += 1;
      }
    }

    if (!hasData) return this.emptyPlacementStats(placementId);
    return { placementId, hasData: true, green, red, blue, pnl };
  }

  /** Clears trades tied to a removed schedule placement (stats drop with them). */
  forgetPlacement(placementId: string): void {
    this.knownPlacementIds.delete(placementId);
    const before = this.positionCards.length;
    this.positionCards = this.positionCards.filter((card) => card.placementId !== placementId);
    if (this.positionCards.length !== before) {
      this.stopConfirmLoopIfIdle();
    }
    this.notify();
  }

  /** Clears settled/sold history; keeps open cards tied to active holdings. */
  clearPositionCards(): void {
    const keepIds = new Set(
      [this.positions.up?.cardId, this.positions.down?.cardId].filter(Boolean) as string[],
    );
    this.positionCards = this.positionCards.filter(
      (card) => card.status === "open" && keepIds.has(card.id),
    );
    this.knownPlacementIds = new Set(
      this.positionCards.map((c) => c.placementId).filter(Boolean) as string[],
    );
    this.stopConfirmLoopIfIdle();
    this.notify();
  }

  private shouldShowPhases(): boolean {
    if (!this.config.autoTrade) return false;
    if (this.config.useSchedule) return this.scheduleContext != null;
    return true;
  }

  private getDisplayPhaseSetup(): TradingPhaseSetup | null {
    if (!this.shouldShowPhases()) return null;
    if (this.config.useSchedule && this.scheduleContext) return this.scheduleContext.setup;
    return simulatorService.getPhaseSetup();
  }

  private rememberSettlementPrices(state: LiveWindowState): void {
    if (state.assetPrice != null && Number.isFinite(state.assetPrice)) {
      this.lastAssetPrice = state.assetPrice;
    }
    if (state.prevCloseAsset != null && Number.isFinite(state.prevCloseAsset)) {
      this.lastPrevCloseAsset = state.prevCloseAsset;
    }
    if (state.assetGap != null && Number.isFinite(state.assetGap)) {
      this.lastAssetGap = state.assetGap;
    }
  }

  private async settleOpenCardsForWindow(windowKey: string): Promise<void> {
    const openCards = this.positionCards.filter(
      (card) => card.windowKey === windowKey && card.status === "open",
    );
    if (openCards.length === 0) return;

    for (const card of openCards) {
      const closed = await pollUntil(
        async () => {
          const rows = await fetchClosedPositions({
            conditionId: card.conditionId,
            limit: 20,
          });
          return (
            findClosedPosition(rows, {
              asset: card.asset,
              conditionId: card.conditionId,
              afterTs: card.buyAt - 5,
            }) ?? null
          );
        },
        { attempts: 4, delayMs: 900 },
      );

      if (closed) {
        const pl = Number(closed.realizedPnl);
        card.pl = pl;
        card.confirmed = true;
        if (closed.avgPrice != null && Number.isFinite(Number(closed.avgPrice))) {
          card.buyPrice = Number(closed.avgPrice);
        }
        if (closed.totalBought != null && Number.isFinite(Number(closed.totalBought))) {
          card.shares = Number(closed.totalBought);
          card.buyCost = card.shares * card.buyPrice;
        }
        const marketOutcome = outcomeFromIndex(closed.outcomeIndex, closed.outcome);
        // Position outcome token that won if curPrice ~ 1
        const won = closed.curPrice != null ? Number(closed.curPrice) >= 0.5 : pl >= 0;
        card.status = won ? "win" : "loss";
        card.outcome = marketOutcome ?? (won ? card.side : card.side === "up" ? "down" : "up");
        continue;
      }

      const openPos = await pollUntil(
        async () => {
          const rows = await fetchUserPositions({
            conditionId: card.conditionId,
            sizeThreshold: 0,
          });
          const match = findPosition(rows, {
            asset: card.asset,
            conditionId: card.conditionId,
          });
          if (!match) return null;
          if (!isValidSharePrice(match.avgPrice) || !isValidShareSize(match.size)) return null;
          if (match.redeemable || (match.curPrice != null && (match.curPrice <= 0.02 || match.curPrice >= 0.98))) {
            return match;
          }
          return null;
        },
        { attempts: 3, delayMs: 900 },
      );

      if (openPos) {
        const pl = Number(openPos.cashPnl ?? openPos.realizedPnl ?? 0);
        card.pl = pl;
        card.confirmed = true;
        if (openPos.avgPrice != null) card.buyPrice = Number(openPos.avgPrice);
        if (openPos.size != null) {
          card.shares = Number(openPos.size);
          card.buyCost = Number(openPos.initialValue ?? card.shares * card.buyPrice);
        }
        const won = openPos.curPrice != null ? Number(openPos.curPrice) >= 0.5 : pl >= 0;
        card.status = won ? "win" : "loss";
        card.outcome =
          outcomeFromIndex(openPos.outcomeIndex, openPos.outcome) ??
          (won ? card.side : card.side === "up" ? "down" : "up");
        continue;
      }

      // Local fallback from last known window prices
      const outcome = resolveWindowOutcome(
        this.lastAssetPrice,
        this.lastPrevCloseAsset,
        this.lastAssetGap,
      );
      if (!outcome) continue;
      const won = card.side === outcome;
      const payout = won ? card.shares : 0;
      card.status = won ? "win" : "loss";
      card.outcome = outcome;
      card.pl = payout - card.buyCost;
      card.confirmed = false;
    }

    logService.info("trading", `Settled ${openCards.length} open position(s) for prior window`);
    this.notify();
    this.ensureConfirmLoop();
  }

  private resetWindow(state: LiveWindowState): void {
    const prevKey = this.sessionKey;
    this.positions = { up: null, down: null };
    this.quoteLocks = emptyQuoteLocks();
    this.markers = [];
    this.mirroredMarkerCount = 0;
    this.sessionKey = sessionKey(state);
    if (prevKey) {
      void this.settleOpenCardsForWindow(prevKey);
    }
    // Keep trying to confirm any pending cards from prior fills
    this.ensureConfirmLoop();
  }

  private ensureWindow(state: LiveWindowState): void {
    const key = sessionKey(state);
    if (this.sessionKey !== key) {
      this.resetWindow(state);
    }
  }

  private lockQuote(side: "up" | "down", leg: "buy" | "sell", price: number): void {
    const key = leg === "buy" ? (`${side}Buy` as const) : (`${side}Sell` as const);
    this.quoteLocks[key] = price;
  }

  private addMarker(
    state: LiveWindowState,
    marker: Omit<SimMarker, "windowKey">,
  ): void {
    this.markers.push({ ...marker, windowKey: sessionKey(state) });
  }

  private findCard(id: string): TradingPositionCard | undefined {
    return this.positionCards.find((card) => card.id === id);
  }

  async refreshScheduleContext(force = false): Promise<void> {
    const now = Date.now();
    if (!force && now - this.scheduleContextFetchedAt < 5000) return;
    this.scheduleContextFetchedAt = now;

    const prevPlacementId = this.scheduleContext?.placementId ?? null;
    const prevVisible = this.shouldShowPhases();

    if (!this.config.autoTrade || !this.config.useSchedule) {
      this.scheduleContext = null;
      this.activePhaseSetup = null;
    } else {
      try {
        const next = await findActiveScheduleContext();
        if (next) {
          this.scheduleContext = next;
          this.activePhaseSetup = next.setup;
        } else if (this.scheduleContext && isScheduleContextActive(this.scheduleContext)) {
          // Keep last known setup across transient empty lookups (DB flake, brief gaps).
        } else {
          this.scheduleContext = null;
          this.activePhaseSetup = null;
        }
      } catch {
        // Keep previous context on fetch errors so phases don't blink off mid-window.
      }
    }

    const nextPlacementId = this.scheduleContext?.placementId ?? null;
    if (prevVisible !== this.shouldShowPhases() || prevPlacementId !== nextPlacementId) {
      this.notify();
    }
  }

  private resolveAutoSimSetup(state: LiveWindowState): SimSetup | null {
    if (!this.config.autoTrade) return null;
    if (this.config.useSchedule) {
      if (!this.activePhaseSetup) return null;
      const latency = state.feedLatencyMs ?? simulatorService.getSetup().latencyMs;
      const duration =
        state.windowStart && state.windowEnd ? state.windowEnd - state.windowStart : 300;
      return phaseSetupToSimSetup(this.activePhaseSetup, latency, duration);
    }
    return simulatorService.getSetup();
  }

  async tick(state: LiveWindowState, nowMs?: number): Promise<void> {
    const prevSessionKey = this.sessionKey;
    this.ensureWindow(state);
    const windowRolled = prevSessionKey != null && prevSessionKey !== this.sessionKey;
    this.rememberSettlementPrices(state);
    await this.refreshScheduleContext(windowRolled);

    if (!this.config.autoTrade) return;

    const autoSetup = this.resolveAutoSimSetup(state);
    if (!autoSetup) return;

    const key = sessionKey(state);
    const prevMarkerCount = this.autoEngine.getMarkers().filter((m) => m.windowKey === key).length;

    this.autoEngine.tick(state, autoSetup, nowMs);

    const currentCount = this.autoEngine.getMarkers().filter((m) => m.windowKey === key).length;

    if (this.config.startTrading) {
      await this.mirrorNewSimMarkers(state, prevMarkerCount);
    } else {
      this.mirroredMarkerCount = currentCount;
    }
  }

  private async mirrorNewSimMarkers(state: LiveWindowState, prevCount: number): Promise<void> {
    if (this.orderInFlight) return;
    const key = sessionKey(state);
    const simMarkers = this.autoEngine.getMarkers().filter((m) => m.windowKey === key);
    if (simMarkers.length <= prevCount) return;

    const newMarkers = simMarkers.slice(prevCount);
    for (const marker of newMarkers) {
      if (marker.type === "buy") {
        if (this.positions[marker.side]) continue;
        await this.executeOrder(state, marker.side, "buy", marker.shares, "auto");
      } else if (marker.type === "sell") {
        if (!this.positions[marker.side]) continue;
        await this.executeOrder(state, marker.side, "sell", this.positions[marker.side]!.shares, "auto");
      }
    }
    this.mirroredMarkerCount = simMarkers.length;
  }

  canManualTrade(side: "up" | "down", leg: "buy" | "sell"): boolean {
    if (leg === "buy") return !this.positions[side];
    return Boolean(this.positions[side]);
  }

  async manualOrder(
    state: LiveWindowState,
    side: "up" | "down",
    leg: "buy" | "sell",
  ): Promise<{ ok: boolean; error?: string }> {
    this.ensureWindow(state);
    if (!this.canExecuteOrders()) {
      return { ok: false, error: "Start Trading to place orders" };
    }
    if (!this.canManualTrade(side, leg)) {
      return { ok: false, error: leg === "buy" ? "Already holding position" : "No position to sell" };
    }
    const size =
      leg === "sell" && this.positions[side]
        ? this.positions[side]!.shares
        : this.config.autoTrade
          ? (this.getPhaseBuyShares(state) ?? this.config.manualShares)
          : this.config.manualShares;
    const sizeUnit =
      leg === "sell" || this.config.autoTrade ? "shares" : this.config.manualOrderUnit;
    return this.executeOrder(state, side, leg, size, "manual", sizeUnit);
  }

  private getPhaseBuyShares(state: LiveWindowState): number | null {
    const setup = this.resolveAutoSimSetup(state);
    if (!setup) return null;
    const nowSec = Math.floor((state.lastTickMs ?? Date.now()) / 1000);
    const duration =
      state.windowStart && state.windowEnd ? state.windowEnd - state.windowStart : 300;
    const frac =
      duration > 0 && state.windowStart
        ? Math.min(1, Math.max(0, (nowSec - state.windowStart) / duration))
        : 0;
    let phaseIdx = 2;
    if (frac < setup.phaseSplit[0]) phaseIdx = 0;
    else if (frac < setup.phaseSplit[1]) phaseIdx = 1;
    return Math.max(1, setup.phases[phaseIdx]?.buyShares ?? this.config.manualShares);
  }

  private hasPendingCards(): boolean {
    return this.positionCards.some((card) => !card.confirmed || this.isCorruptConfirmedCard(card));
  }

  /** Confirmed cards that clearly used bad Polymarket data (e.g. 0¢) should be re-verified. */
  private isCorruptConfirmedCard(card: TradingPositionCard): boolean {
    if (!card.confirmed) return false;
    if (!isValidSharePrice(card.buyPrice)) return true;
    if (!isValidShareSize(card.shares)) return true;
    if (card.status === "sold" && card.sellPrice != null && !isValidSharePrice(card.sellPrice)) {
      return true;
    }
    return false;
  }

  private invalidateCorruptConfirmedCards(): void {
    for (const card of this.positionCards) {
      if (this.isCorruptConfirmedCard(card)) {
        card.confirmed = false;
      }
    }
  }

  private ensureConfirmLoop(): void {
    this.invalidateCorruptConfirmedCards();
    if (this.confirmLoopTimer || !this.hasPendingCards()) return;
    this.confirmLoopTimer = setInterval(() => {
      void this.reconfirmPendingCards();
    }, 3000);
    void this.reconfirmPendingCards();
  }

  private stopConfirmLoopIfIdle(): void {
    if (this.hasPendingCards() || !this.confirmLoopTimer) return;
    clearInterval(this.confirmLoopTimer);
    this.confirmLoopTimer = null;
  }

  private async reconfirmPendingCards(): Promise<void> {
    if (this.confirmInFlight) return;
    this.invalidateCorruptConfirmedCards();
    const pending = this.positionCards.filter(
      (card) => !card.confirmed || this.isCorruptConfirmedCard(card),
    );
    if (pending.length === 0) {
      this.stopConfirmLoopIfIdle();
      return;
    }

    this.confirmInFlight = true;
    let changed = false;
    try {
      for (const card of pending) {
        if (this.isCorruptConfirmedCard(card)) card.confirmed = false;
        const before = {
          confirmed: card.confirmed,
          buyPrice: card.buyPrice,
          shares: card.shares,
          sellPrice: card.sellPrice,
          pl: card.pl,
          status: card.status,
        };
        await this.tryConfirmCard(card);
        if (
          card.confirmed !== before.confirmed ||
          card.buyPrice !== before.buyPrice ||
          card.shares !== before.shares ||
          card.sellPrice !== before.sellPrice ||
          card.pl !== before.pl ||
          card.status !== before.status
        ) {
          changed = true;
        }
      }
      if (changed) this.notify();
    } finally {
      this.confirmInFlight = false;
      this.stopConfirmLoopIfIdle();
    }
  }

  /** One verification pass against Polymarket Data API. Does not poll long — the confirm loop retries. */
  private async tryConfirmCard(card: TradingPositionCard): Promise<void> {
    if (card.confirmed) return;

    if (card.status === "open") {
      await this.tryConfirmOpenCard(card);
      return;
    }
    if (card.status === "sold") {
      await this.tryConfirmSoldCard(card);
      return;
    }
    if (card.status === "win" || card.status === "loss") {
      await this.tryConfirmSettledCard(card);
    }
  }

  private async tryConfirmOpenCard(card: TradingPositionCard): Promise<void> {
    if (!card.asset && !card.conditionId) return;

    try {
      const trades = await fetchUserTrades({
        asset: card.asset,
        conditionId: card.conditionId,
        limit: 40,
      });
      const trade = findTrade(trades, {
        side: "BUY",
        asset: card.asset,
        conditionId: card.conditionId,
        afterTs: card.buyAt - 30,
      });

      if (trade && isValidShareSize(trade.size) && isValidSharePrice(trade.price)) {
        const size = Number(trade.size);
        const price = Number(trade.price);
        card.shares = size;
        card.buyPrice = price;
        card.buyCost = size * price;
        card.asset = card.asset ?? trade.asset;
        card.conditionId = card.conditionId ?? trade.conditionId;
        card.slug = card.slug ?? trade.slug;
        if (trade.timestamp != null) card.buyAt = Number(trade.timestamp);
        card.confirmed = true;
      } else {
        const rows = await fetchUserPositions({
          conditionId: card.conditionId,
          sizeThreshold: 0,
        });
        const pos = findPosition(rows, {
          asset: card.asset,
          conditionId: card.conditionId,
        });
        if (pos && isValidShareSize(pos.size) && isValidSharePrice(pos.avgPrice)) {
          card.shares = Number(pos.size);
          card.buyPrice = Number(pos.avgPrice);
          card.buyCost = Number(pos.initialValue ?? card.shares * card.buyPrice);
          card.asset = card.asset ?? pos.asset;
          card.conditionId = card.conditionId ?? pos.conditionId;
          card.slug = card.slug ?? pos.slug;
          card.confirmed = true;
        }
      }
    } catch {
      // keep pending; loop will retry
    }

    const sidePos = this.positions[card.side];
    if (sidePos?.cardId === card.id && card.confirmed) {
      sidePos.shares = card.shares;
      sidePos.avgPrice = card.buyPrice;
      sidePos.cost = card.buyCost;
      sidePos.asset = card.asset;
      sidePos.conditionId = card.conditionId;
    }
  }

  private async tryConfirmSoldCard(card: TradingPositionCard): Promise<void> {
    if (!card.asset && !card.conditionId) return;

    try {
      const soldAt = card.soldAt ?? card.buyAt;
      const trades = await fetchUserTrades({
        asset: card.asset,
        conditionId: card.conditionId,
        limit: 40,
      });
      const trade = findTrade(trades, {
        side: "SELL",
        asset: card.asset,
        conditionId: card.conditionId,
        afterTs: soldAt - 30,
      });

      if (trade && isValidShareSize(trade.size) && isValidSharePrice(trade.price)) {
        const size = Number(trade.size);
        const price = Number(trade.price);
        if (!isValidSharePrice(card.buyPrice)) {
          const buyTrade = findTrade(trades, {
            side: "BUY",
            asset: card.asset ?? trade.asset,
            conditionId: card.conditionId ?? trade.conditionId,
            afterTs: card.buyAt - 120,
          });
          if (buyTrade && isValidSharePrice(buyTrade.price)) {
            card.buyPrice = Number(buyTrade.price);
          }
        }
        card.shares = size;
        card.sellPrice = price;
        card.sellProceeds = size * price;
        card.buyCost = size * card.buyPrice;
        card.asset = card.asset ?? trade.asset;
        card.conditionId = card.conditionId ?? trade.conditionId;
        card.slug = card.slug ?? trade.slug;
        if (trade.timestamp != null) card.soldAt = Number(trade.timestamp);
        card.pl = card.sellProceeds - card.buyCost;
        if (isValidSharePrice(card.buyPrice)) {
          card.confirmed = true;
        }
      }

      const rows = await fetchClosedPositions({
        conditionId: card.conditionId,
        limit: 30,
      });
      const closed = findClosedPosition(rows, {
        asset: card.asset,
        conditionId: card.conditionId,
        afterTs: card.buyAt - 30,
      });

      if (closed?.realizedPnl != null && Number.isFinite(Number(closed.realizedPnl))) {
        card.pl = Number(closed.realizedPnl);
        if (closed.avgPrice != null && isValidSharePrice(closed.avgPrice)) {
          card.buyPrice = Number(closed.avgPrice);
        }
        if (closed.totalBought != null && isValidShareSize(closed.totalBought)) {
          const bought = Number(closed.totalBought);
          card.shares = bought;
          card.buyCost = bought * card.buyPrice;
          if (card.sellPrice != null && isValidSharePrice(card.sellPrice)) {
            card.sellProceeds = bought * card.sellPrice;
          }
        }
        card.asset = card.asset ?? closed.asset;
        card.conditionId = card.conditionId ?? closed.conditionId;
        card.slug = card.slug ?? closed.slug;
        if (isValidSharePrice(card.buyPrice) && isValidShareSize(card.shares)) {
          card.confirmed = true;
        }
      }
    } catch {
      // keep pending
    }
  }

  private async tryConfirmSettledCard(card: TradingPositionCard): Promise<void> {
    if (!card.asset && !card.conditionId) return;

    try {
      const closedRows = await fetchClosedPositions({
        conditionId: card.conditionId,
        limit: 30,
      });
      const closed = findClosedPosition(closedRows, {
        asset: card.asset,
        conditionId: card.conditionId,
        afterTs: card.buyAt - 30,
      });
      if (closed?.realizedPnl != null && Number.isFinite(Number(closed.realizedPnl))) {
        const pl = Number(closed.realizedPnl);
        card.pl = pl;
        if (closed.avgPrice != null && isValidSharePrice(closed.avgPrice)) {
          card.buyPrice = Number(closed.avgPrice);
        }
        if (closed.totalBought != null && isValidShareSize(closed.totalBought)) {
          card.shares = Number(closed.totalBought);
          card.buyCost = card.shares * card.buyPrice;
        }
        const won = closed.curPrice != null ? Number(closed.curPrice) >= 0.5 : pl >= 0;
        card.status = won ? "win" : "loss";
        card.outcome =
          outcomeFromIndex(closed.outcomeIndex, closed.outcome) ??
          (won ? card.side : card.side === "up" ? "down" : "up");
        if (isValidSharePrice(card.buyPrice) && isValidShareSize(card.shares)) {
          card.confirmed = true;
        }
        return;
      }

      const openRows = await fetchUserPositions({
        conditionId: card.conditionId,
        sizeThreshold: 0,
      });
      const openPos = findPosition(openRows, {
        asset: card.asset,
        conditionId: card.conditionId,
      });
      if (
        openPos &&
        isValidShareSize(openPos.size) &&
        isValidSharePrice(openPos.avgPrice) &&
        (openPos.redeemable ||
          (openPos.curPrice != null &&
            (Number(openPos.curPrice) <= 0.02 || Number(openPos.curPrice) >= 0.98)))
      ) {
        const pl = Number(openPos.cashPnl ?? openPos.realizedPnl ?? 0);
        card.pl = pl;
        card.buyPrice = Number(openPos.avgPrice);
        card.shares = Number(openPos.size);
        card.buyCost = Number(openPos.initialValue ?? card.shares * card.buyPrice);
        const won = openPos.curPrice != null ? Number(openPos.curPrice) >= 0.5 : pl >= 0;
        card.status = won ? "win" : "loss";
        card.outcome =
          outcomeFromIndex(openPos.outcomeIndex, openPos.outcome) ??
          (won ? card.side : card.side === "up" ? "down" : "up");
        card.confirmed = true;
      }
    } catch {
      // keep pending
    }
  }

  private async enrichCardFromPolymarketBuy(cardId: string): Promise<void> {
    const card = this.findCard(cardId);
    if (!card) return;
    await this.tryConfirmCard(card);
    this.notify();
    this.ensureConfirmLoop();
  }

  private async enrichCardFromPolymarketSell(cardId: string, _soldAt: number): Promise<void> {
    const card = this.findCard(cardId);
    if (!card) return;
    await this.tryConfirmCard(card);
    this.notify();
    this.ensureConfirmLoop();
  }

  private async executeOrder(
    state: LiveWindowState,
    side: "up" | "down",
    leg: "buy" | "sell",
    size: number,
    source: "manual" | "auto",
    sizeUnit: "shares" | "usdc" = "shares",
  ): Promise<{ ok: boolean; error?: string }> {
    if (this.orderInFlight) return { ok: false, error: "Order already in progress" };
    this.orderInFlight = true;
    try {
      const result = await placeMarketOrder({
        series: state.series,
        side,
        leg,
        size,
        sizeUnit: leg === "sell" ? "shares" : sizeUnit,
        state,
      });
      if (!result.success || result.fillPrice == null || result.fillShares == null) {
        return { ok: false, error: result.error ?? "Order failed" };
      }

      const nowSec = Math.floor(Date.now() / 1000);
      const fillShares = result.fillShares;
      const fillPrice = result.fillPrice;

      if (leg === "buy") {
        const cost = result.usdcAmount ?? fillShares * fillPrice;
        const cardId = newCardId();
        this.positions[side] = {
          shares: fillShares,
          avgPrice: fillPrice,
          cost,
          cardId,
          asset: result.tokenId,
          conditionId: result.conditionId,
        };
        this.lockQuote(side, "buy", fillPrice);
        this.positionCards.unshift({
          id: cardId,
          windowKey: sessionKey(state),
          series: state.series,
          side,
          shares: fillShares,
          buyPrice: fillPrice,
          buyCost: cost,
          buyAt: nowSec,
          status: "open",
          asset: result.tokenId,
          conditionId: result.conditionId,
          slug: result.slug,
          confirmed: false,
          placementId:
            source === "auto" && this.config.useSchedule
              ? this.scheduleContext?.placementId
              : undefined,
        });
        if (
          source === "auto" &&
          this.config.useSchedule &&
          this.scheduleContext?.placementId
        ) {
          this.knownPlacementIds.add(this.scheduleContext.placementId);
        }
        if (this.positionCards.length > 100) {
          this.positionCards.length = 100;
        }
        this.addMarker(state, {
          type: "buy",
          side,
          t: nowSec,
          y: state.assetPrice ?? null,
          shares: fillShares,
          price: fillPrice,
          cost,
          fees: 0,
          total: cost,
        });
        void this.enrichCardFromPolymarketBuy(cardId);
      } else {
        const pos = this.positions[side]!;
        const proceeds = result.usdcAmount ?? fillShares * fillPrice;
        const profit = proceeds - pos.cost;
        this.lockQuote(side, "sell", fillPrice);
        const card = this.findCard(pos.cardId);
        if (card && card.status === "open") {
          card.status = "sold";
          card.sellPrice = fillPrice;
          card.sellProceeds = proceeds;
          card.soldAt = nowSec;
          card.pl = profit;
          card.shares = fillShares;
          card.asset = card.asset ?? result.tokenId ?? pos.asset;
          card.conditionId = card.conditionId ?? result.conditionId ?? pos.conditionId;
          card.slug = card.slug ?? result.slug;
          card.confirmed = false;
          void this.enrichCardFromPolymarketSell(card.id, nowSec);
        }
        this.addMarker(state, {
          type: "sell",
          side,
          t: nowSec,
          y: state.assetPrice ?? null,
          shares: fillShares,
          price: fillPrice,
          proceeds,
          profit,
          total: proceeds,
        });
        this.positions[side] = null;
      }

      logService.info("trading", `${source} ${leg} ${side} filled`);
      void refreshCollateralBalance();
      this.notify();
      return { ok: true };
    } finally {
      this.orderInFlight = false;
    }
  }
}

export const liveTradingService = new LiveTradingService();
