import {
  findActiveScheduleContext,
  isScheduleContextActive,
  type ActiveScheduleContext,
} from "./schedule-active.js";
import {
  cancelOpenOrder,
  fetchOpenOrder,
  placeLimitGtdBuy,
  placeMarketOrder,
  type MarketOrderType,
} from "./order-service.js";
import { getTradingClient, initTradingClient, refreshCollateralBalance } from "./trading-client.js";
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
import {
  DEFAULT_CRYPTO_TAKER_FEE_PARAMS,
  estimateTakerFeeUsd,
  resolveTakerFeeParams,
} from "./taker-fee.js";
import {
  addActivatedPlacementId,
  listActivatedPlacementIds,
  listTradingStatEvents,
  markLiveReset,
  upsertTradingStatEvent,
  type TradingStatEvent,
} from "./db/trading-session-memory-repository.js";
import {
  getUserPublicById,
  listUsersForLiveTrading,
  updateUserTrading,
} from "./db/user-repository.js";
import { isTradingExecutor } from "./trading-executor.js";
import {
  assetPricesFromState,
  centsToPrice,
  gapAllowsBuy,
  gtdExpirationUnix,
  phaseIndexForState,
  SIDES_ORDER,
  stabilizeAllowsBuy,
} from "./phase-config.js";
import type {
  LiveWindowState,
  SimMarker,
  SimPhaseConfig,
  SimQuoteLocks,
  SimSetup,
  TradingConfig,
  TradingPhaseSetup,
  TradingPositionCard,
  TradingPublicState,
  PlacementLiveStats,
} from "./types.js";

interface RestingBuyOrder {
  orderId: string;
  side: "up" | "down";
  phaseIdx: number;
  sessionKey: string;
  shares: number;
  limitPrice: number;
  sizeMatched: number;
  tokenId?: string;
  conditionId?: string;
  slug?: string;
  cardId?: string;
}

type SettledStatContribution = {
  green: number;
  red: number;
  blue: number;
  pnl: number;
  status: Exclude<TradingPositionCard["status"], "open">;
};

interface SidePosition {
  shares: number;
  avgPrice: number;
  cost: number;
  buyFees: number;
  cardId: string;
  asset?: string;
  conditionId?: string;
}

type UpdateListener = () => void;

function sessionKey(state: LiveWindowState): string {
  return `${state.series || ""}:${state.windowStart || ""}`;
}

function contributionFromCard(card: TradingPositionCard): SettledStatContribution | null {
  if (card.status === "open") return null;
  const pl = Number(card.pl);
  if (!Number.isFinite(pl)) return null;

  let green = 0;
  let red = 0;
  let blue = 0;
  if (card.status === "sold") {
    if (pl > 0) green = 1;
    else red = 1;
  } else if (card.status === "win") {
    blue = 1;
  } else if (card.status === "loss") {
    red = 1;
  } else {
    return null;
  }
  return { green, red, blue, pnl: pl, status: card.status };
}

function totalTradeFees(card: Pick<TradingPositionCard, "buyFees" | "sellFees">): number {
  return (card.buyFees ?? 0) + (card.sellFees ?? 0);
}

/** Gross Polymarket position P/L minus estimated taker fees (wallet-closer). */
function feeAwarePlFromGross(
  grossPl: number,
  card: Pick<TradingPositionCard, "buyFees" | "sellFees">,
): number {
  return grossPl - totalTradeFees(card);
}

function feeAwarePlHeld(card: TradingPositionCard, won: boolean): number {
  const payout = won ? card.shares : 0;
  return payout - card.buyCost - (card.buyFees ?? 0);
}

function feeAwarePlSold(card: TradingPositionCard): number {
  const proceeds = Number(card.sellProceeds ?? 0);
  return proceeds - (card.sellFees ?? 0) - card.buyCost - (card.buyFees ?? 0);
}

async function estimateLiveTakerFee(
  userId: string,
  tokenId: string | undefined,
  shares: number,
  price: number,
): Promise<number> {
  if (!Number.isFinite(shares) || shares <= 0 || !Number.isFinite(price) || price <= 0 || price >= 1) {
    return 0;
  }
  const client = getTradingClient(userId);
  const params =
    tokenId && client
      ? await resolveTakerFeeParams(client, tokenId)
      : DEFAULT_CRYPTO_TAKER_FEE_PARAMS;
  return estimateTakerFeeUsd(shares, price, params);
}

let loggedNonExecutorSkip = false;
function logNonExecutorSkipOnce(): void {
  if (loggedNonExecutorSkip) return;
  loggedNonExecutorSkip = true;
  logService.warn(
    "trading",
    "TRADING_EXECUTOR is not set — live order placement disabled in this process",
  );
}

function eventFingerprint(
  event: Pick<TradingStatEvent, "status" | "green" | "red" | "blue" | "pnl" | "placementId" | "card">,
): string {
  const card = event.card;
  return [
    event.status,
    event.green,
    event.red,
    event.blue,
    event.pnl,
    event.placementId ?? "",
    card?.shares ?? "",
    card?.buyPrice ?? "",
    card?.pl ?? "",
    card?.buyFees ?? "",
    card?.sellFees ?? "",
    card?.confirmed ? 1 : 0,
  ].join("|");
}

function cardSnapshotFromPosition(card: TradingPositionCard): TradingStatEvent["card"] {
  if (card.status === "open") return undefined;
  const snap: NonNullable<TradingStatEvent["card"]> = {
    windowKey: card.windowKey,
    series: card.series,
    side: card.side,
    shares: card.shares,
    buyPrice: card.buyPrice,
    buyCost: card.buyCost,
    buyAt: card.buyAt,
    status: card.status,
    confirmed: card.confirmed === true,
  };
  if (card.pl != null) snap.pl = card.pl;
  if (card.outcome) snap.outcome = card.outcome;
  if (card.asset) snap.asset = card.asset;
  if (card.conditionId) snap.conditionId = card.conditionId;
  if (card.slug) snap.slug = card.slug;
  if (card.placementId) snap.placementId = card.placementId;
  if (card.buyFees != null) snap.buyFees = card.buyFees;
  if (card.sellPrice != null) snap.sellPrice = card.sellPrice;
  if (card.sellProceeds != null) snap.sellProceeds = card.sellProceeds;
  if (card.sellFees != null) snap.sellFees = card.sellFees;
  if (card.soldAt != null) snap.soldAt = card.soldAt;
  return snap;
}

function positionCardFromEvent(event: TradingStatEvent): TradingPositionCard | null {
  const snap = event.card;
  if (!snap) return null;
  if (snap.status === "open") return null;
  const card: TradingPositionCard = {
    id: event.cardId,
    windowKey: snap.windowKey,
    series: snap.series,
    side: snap.side,
    shares: snap.shares,
    buyPrice: snap.buyPrice,
    buyCost: snap.buyCost,
    buyAt: snap.buyAt,
    status: snap.status,
    confirmed: snap.confirmed === true,
  };
  if (snap.pl != null) card.pl = snap.pl;
  else card.pl = event.pnl;
  if (snap.outcome) card.outcome = snap.outcome;
  if (snap.asset) card.asset = snap.asset;
  if (snap.conditionId) card.conditionId = snap.conditionId;
  if (snap.slug) card.slug = snap.slug;
  if (snap.buyFees != null) card.buyFees = snap.buyFees;
  if (snap.placementId || event.placementId) {
    card.placementId = snap.placementId ?? event.placementId;
  }
  if (snap.sellPrice != null) card.sellPrice = snap.sellPrice;
  if (snap.sellProceeds != null) card.sellProceeds = snap.sellProceeds;
  if (snap.sellFees != null) card.sellFees = snap.sellFees;
  if (snap.soldAt != null) card.soldAt = snap.soldAt;
  return card;
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
  private statsPersistChain: Promise<void> = Promise.resolve();

  private positions: { up: SidePosition | null; down: SidePosition | null } = {
    up: null,
    down: null,
  };

  private quoteLocks: SimQuoteLocks = emptyQuoteLocks();
  private markers: SimMarker[] = [];
  private positionCards: TradingPositionCard[] = [];
  /** Placement ids that have had schedule auto-trades this session (for live card stats). */
  private knownPlacementIds = new Set<string>();
  /**
   * Settled contributions for Live range (RAM cards + Mongo hydrate after restart).
   * Keyed by cardId — survives restart until Live reset.
   */
  private liveStatLedger = new Map<string, TradingStatEvent>();
  /** Last written fingerprints — skip identical Mongo upserts. */
  private lastPersistedStatFingerprint = new Map<string, string>();
  private sessionKey: string | null = null;
  private mirroredMarkerCount = 0;
  private orderInFlight = false;
  /** Resting GTD limit buy for the active non-optimize phase. */
  private restingBuy: RestingBuyOrder | null = null;
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

  constructor(private readonly userId: string) {}

  getUserId(): string {
    return this.userId;
  }

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
      const user = await getUserPublicById(this.userId);
      if (!user) {
        throw new Error(`User not found: ${this.userId}`);
      }
      this.config = normalizeTradingConfig(user.trading);
    } catch (err) {
      logService.warn("trading", `Failed to load trading config: ${String(err)}`);
      this.config = defaultTradingConfig();
    }
    await this.hydrateLiveStatsFromMongo();
    return this.getConfig();
  }

  /** Reload Live-range settled events from Mongo (after boot / reset). */
  async hydrateLiveStatsFromMongo(): Promise<void> {
    try {
      const events = await listTradingStatEvents(this.userId, { afterLiveReset: true });
      const activated = await listActivatedPlacementIds(this.userId);
      this.liveStatLedger.clear();
      this.lastPersistedStatFingerprint.clear();
      this.knownPlacementIds.clear();

      const openCards = this.positionCards.filter((c) => c.status === "open");
      const restored: TradingPositionCard[] = [];

      for (const id of activated) {
        this.knownPlacementIds.add(id);
      }

      for (const event of events) {
        this.liveStatLedger.set(event.cardId, event);
        this.lastPersistedStatFingerprint.set(event.cardId, eventFingerprint(event));
        if (event.placementId) this.knownPlacementIds.add(event.placementId);
        const card = positionCardFromEvent(event);
        if (card) {
          restored.push(card);
          if (card.placementId) this.knownPlacementIds.add(card.placementId);
        }
      }

      restored.sort((a, b) => (b.buyAt ?? 0) - (a.buyAt ?? 0));
      this.positionCards = [...openCards, ...restored].slice(0, 100);
      logService.info(
        "trading",
        `Hydrated ${events.length} live stat event(s) from Mongo (${restored.length} position card(s), ${this.knownPlacementIds.size} placement(s))`,
      );
    } catch (err) {
      logService.warn("trading", `Failed to hydrate live stats from Mongo: ${String(err)}`);
    }
  }

  /** Mark a schedule placement as live this session so cards show 0/0/0 until the first fill. */
  private rememberActivatedPlacement(placementId: string | undefined): void {
    if (!placementId || this.knownPlacementIds.has(placementId)) return;
    this.knownPlacementIds.add(placementId);
    this.statsPersistChain = this.statsPersistChain
      .then(() => addActivatedPlacementId(this.userId, placementId))
      .catch((err) => {
        logService.warn(
          "trading",
          `Failed to persist activated placement ${placementId}: ${String(err)}`,
        );
      });
    this.notify();
  }

  private persistCardStat(card: TradingPositionCard): void {
    const contrib = contributionFromCard(card);
    if (!contrib) return;

    const event: TradingStatEvent = {
      cardId: card.id,
      status: contrib.status,
      green: contrib.green,
      red: contrib.red,
      blue: contrib.blue,
      pnl: contrib.pnl,
      settledAt: new Date(
        (card.soldAt ?? card.buyAt ?? Math.floor(Date.now() / 1000)) * 1000,
      ).toISOString(),
      updatedAt: new Date().toISOString(),
    };
    if (card.placementId) event.placementId = card.placementId;
    const snap = cardSnapshotFromPosition(card);
    if (snap) event.card = snap;

    const fingerprint = eventFingerprint(event);
    if (this.lastPersistedStatFingerprint.get(card.id) === fingerprint) return;

    this.liveStatLedger.set(card.id, event);
    this.lastPersistedStatFingerprint.set(card.id, fingerprint);
    if (card.placementId) this.knownPlacementIds.add(card.placementId);

    this.statsPersistChain = this.statsPersistChain
      .then(async () => {
        await upsertTradingStatEvent(this.userId, {
          cardId: event.cardId,
          placementId: event.placementId,
          status: event.status,
          green: event.green,
          red: event.red,
          blue: event.blue,
          pnl: event.pnl,
          settledAt: event.settledAt,
          card: event.card,
        });
      })
      .catch((err) => {
        // Allow retry on next change
        this.lastPersistedStatFingerprint.delete(card.id);
        logService.warn("trading", `Failed to persist stat event ${card.id}: ${String(err)}`);
      });
  }

  private persistConfig(): void {
    const snapshot = this.getConfig();
    this.persistChain = this.persistChain
      .then(() => updateUserTrading(this.userId, snapshot).then(() => undefined))
      .catch((err) => {
        logService.warn("trading", `Failed to save trading config: ${String(err)}`);
      });
  }

  setConfig(patch: Partial<TradingConfig>): TradingConfig {
    const wasLive =
      this.config.autoTrade && this.config.useSchedule && this.config.startTrading;
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
    const isLive =
      this.config.autoTrade && this.config.useSchedule && this.config.startTrading;
    if (isLive && (!wasLive || patch.startTrading === true || patch.useSchedule === true)) {
      void this.refreshScheduleContext(true);
    }
    return this.getConfig();
  }

  private isPreviewMode(): boolean {
    // startTrading alone is not enough — non-executor processes stay in preview.
    return this.config.autoTrade && !(this.config.startTrading && isTradingExecutor());
  }

  private canExecuteOrders(): boolean {
    if (!isTradingExecutor()) return false;
    if (!this.config.autoTrade) return true;
    return this.config.startTrading;
  }

  /** True when this process may place/cancel live orders for the current config. */
  private isLiveArmed(): boolean {
    return this.config.startTrading && isTradingExecutor();
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
    const live = this.getLiveSessionTotals();
    return {
      config: this.getConfig(),
      positions: {
        up: this.positions.up ? { ...this.positions.up } : null,
        down: this.positions.down ? { ...this.positions.down } : null,
      },
      positionCards: this.positionCards.map((card) => ({ ...card })),
      placementStats: this.getPlacementStatsFromCards(),
      sessionTotals: {
        green: live.green,
        red: live.red,
        blue: live.blue,
        pnl: live.pnl,
        hasData: live.hasBalance,
      },
      demoLastWindow: this.config.autoTrade ? this.autoEngine.getLastWindow() : null,
      quoteLocks: previewMode ? this.autoEngine.getQuoteLocks() : { ...this.quoteLocks },
      markers: this.getDisplayMarkers(),
      phaseSetup: phasesVisible ? this.getDisplayPhaseSetup() : null,
      phasesVisible,
      // Schedule mode: bars follow the active card only (view/click, no drag-edit).
      phasesEditable: phasesVisible && this.config.autoTrade && !this.config.useSchedule,
      scheduleTitle: this.config.useSchedule && this.scheduleContext ? this.scheduleContext.title : null,
      scheduleSetupId:
        this.config.useSchedule && this.scheduleContext ? this.scheduleContext.setupId : null,
      quotesEnabled: this.canExecuteOrders(),
      previewMode,
    };
  }

  /** Aggregate real-trade outcomes for schedule placement cards. */
  getPlacementStats(placementIds: string[]): PlacementLiveStats[] {
    return placementIds.map((id) => this.statsForPlacement(id));
  }

  private getPlacementStatsFromCards(): PlacementLiveStats[] {
    const ids = new Set(this.knownPlacementIds);
    for (const event of this.liveStatLedger.values()) {
      if (event.placementId) ids.add(event.placementId);
    }
    for (const card of this.positionCards) {
      if (card.placementId) ids.add(card.placementId);
    }
    return this.getPlacementStats([...ids]);
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

  /** Live-armed placement with no fills yet — match demo “0 cards” zeros, not dashes. */
  private zeroPlacementStats(placementId: string): PlacementLiveStats {
    return {
      placementId,
      hasData: true,
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
    const cardIdsFromRam = new Set<string>();

    for (const card of this.positionCards) {
      if (card.placementId !== placementId) continue;
      if (card.status === "open") continue;
      const contrib = contributionFromCard(card);
      if (!contrib) continue;
      cardIdsFromRam.add(card.id);
      hasData = true;
      green += contrib.green;
      red += contrib.red;
      blue += contrib.blue;
      pnl += contrib.pnl;
    }

    for (const event of this.liveStatLedger.values()) {
      if (event.placementId !== placementId) continue;
      if (cardIdsFromRam.has(event.cardId)) continue;
      hasData = true;
      green += event.green ?? 0;
      red += event.red ?? 0;
      blue += event.blue ?? 0;
      pnl += event.pnl ?? 0;
    }

    if (!hasData) {
      return this.knownPlacementIds.has(placementId)
        ? this.zeroPlacementStats(placementId)
        : this.emptyPlacementStats(placementId);
    }
    return { placementId, hasData: true, green, red, blue, pnl };
  }

  /** Clears trades tied to a removed schedule placement (stats drop with them). */
  forgetPlacement(placementId: string): void {
    this.knownPlacementIds.delete(placementId);
    const before = this.positionCards.length;
    this.positionCards = this.positionCards.filter((card) => card.placementId !== placementId);
    for (const [cardId, event] of this.liveStatLedger) {
      if (event.placementId === placementId) {
        this.liveStatLedger.delete(cardId);
        this.lastPersistedStatFingerprint.delete(cardId);
      }
    }
    if (this.positionCards.length !== before) {
      this.stopConfirmLoopIfIdle();
    }
    this.notify();
  }

  /** Snapshot of settled live counters (Live range: RAM + hydrated Mongo since reset). */
  getLiveSessionTotals(): {
    green: number;
    red: number;
    blue: number;
    pnl: number;
    hasBalance: boolean;
    placementStats: PlacementLiveStats[];
    startedAt?: string;
  } {
    const placementStats = this.getPlacementStatsFromCards();
    let green = 0;
    let red = 0;
    let blue = 0;
    let pnl = 0;
    const seen = new Set<string>();
    let earliestBuyAt: number | null = null;

    for (const card of this.positionCards) {
      if (card.status === "open") continue;
      const contrib = contributionFromCard(card);
      if (!contrib) continue;
      seen.add(card.id);
      green += contrib.green;
      red += contrib.red;
      blue += contrib.blue;
      pnl += contrib.pnl;
      if (card.buyAt != null && Number.isFinite(card.buyAt)) {
        if (earliestBuyAt == null || card.buyAt < earliestBuyAt) earliestBuyAt = card.buyAt;
      }
    }

    for (const event of this.liveStatLedger.values()) {
      if (seen.has(event.cardId)) continue;
      green += event.green ?? 0;
      red += event.red ?? 0;
      blue += event.blue ?? 0;
      pnl += event.pnl ?? 0;
      const settled = Date.parse(event.settledAt);
      if (Number.isFinite(settled)) {
        const buyAtSec = Math.floor(settled / 1000);
        if (earliestBuyAt == null || buyAtSec < earliestBuyAt) earliestBuyAt = buyAtSec;
      }
    }

    const hasData = green + red + blue > 0 || pnl !== 0;
    const hasBalance = hasData;
    const out: {
      green: number;
      red: number;
      blue: number;
      pnl: number;
      hasBalance: boolean;
      placementStats: PlacementLiveStats[];
      startedAt?: string;
    } = {
      green,
      red,
      blue,
      pnl,
      hasBalance,
      placementStats,
    };
    if (earliestBuyAt != null) out.startedAt = new Date(earliestBuyAt * 1000).toISOString();
    return out;
  }

  /** Clears settled/sold history for Live; Week/All keep Mongo events. */
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
    this.liveStatLedger.clear();
    this.lastPersistedStatFingerprint.clear();
    this.statsPersistChain = this.statsPersistChain
      .then(() => markLiveReset(this.userId))
      .catch((err) => {
        logService.warn("trading", `Failed to mark live stats reset: ${String(err)}`);
      });
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
          const rows = await fetchClosedPositions(this.userId, {
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
        const grossPl = Number(closed.realizedPnl);
        card.confirmed = true;
        if (closed.avgPrice != null && Number.isFinite(Number(closed.avgPrice))) {
          card.buyPrice = Number(closed.avgPrice);
        }
        if (closed.totalBought != null && Number.isFinite(Number(closed.totalBought))) {
          card.shares = Number(closed.totalBought);
          card.buyCost = card.shares * card.buyPrice;
        }
        card.buyFees = await estimateLiveTakerFee(this.userId, card.asset, card.shares, card.buyPrice);
        const marketOutcome = outcomeFromIndex(closed.outcomeIndex, closed.outcome);
        // Position outcome token that won if curPrice ~ 1
        const won = closed.curPrice != null ? Number(closed.curPrice) >= 0.5 : grossPl >= 0;
        card.status = won ? "win" : "loss";
        card.outcome = marketOutcome ?? (won ? card.side : card.side === "up" ? "down" : "up");
        card.pl = Number.isFinite(grossPl)
          ? feeAwarePlFromGross(grossPl, card)
          : feeAwarePlHeld(card, won);
        continue;
      }

      const openPos = await pollUntil(
        async () => {
          const rows = await fetchUserPositions(this.userId, {
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
        const grossPl = Number(openPos.cashPnl ?? openPos.realizedPnl ?? 0);
        card.confirmed = true;
        if (openPos.avgPrice != null) card.buyPrice = Number(openPos.avgPrice);
        if (openPos.size != null) {
          card.shares = Number(openPos.size);
          card.buyCost = Number(openPos.initialValue ?? card.shares * card.buyPrice);
        }
        card.buyFees = await estimateLiveTakerFee(this.userId, card.asset, card.shares, card.buyPrice);
        const won = openPos.curPrice != null ? Number(openPos.curPrice) >= 0.5 : grossPl >= 0;
        card.status = won ? "win" : "loss";
        card.outcome =
          outcomeFromIndex(openPos.outcomeIndex, openPos.outcome) ??
          (won ? card.side : card.side === "up" ? "down" : "up");
        card.pl = Number.isFinite(grossPl)
          ? feeAwarePlFromGross(grossPl, card)
          : feeAwarePlHeld(card, won);
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
      card.status = won ? "win" : "loss";
      card.outcome = outcome;
      if (card.buyFees == null) {
        card.buyFees = await estimateLiveTakerFee(this.userId, card.asset, card.shares, card.buyPrice);
      }
      card.pl = feeAwarePlHeld(card, won);
      card.confirmed = false;
    }

    logService.info("trading", `Settled ${openCards.length} open position(s) for prior window`);
    for (const card of openCards) {
      this.persistCardStat(card);
    }
    this.notify();
    this.ensureConfirmLoop();
  }

  private resetWindow(state: LiveWindowState): void {
    const prevKey = this.sessionKey;
    const prevResting = this.restingBuy;
    this.restingBuy = null;
    if (prevResting?.orderId && isTradingExecutor()) {
      void cancelOpenOrder(this.userId, prevResting.orderId);
    }
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
        const next = await findActiveScheduleContext(this.userId);
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
    if (
      this.config.startTrading &&
      this.config.autoTrade &&
      this.config.useSchedule &&
      nextPlacementId
    ) {
      this.rememberActivatedPlacement(nextPlacementId);
    }
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
    if (!autoSetup) {
      // Still commit the prior window's demo result when leaving a schedule slot.
      this.autoEngine.rollWindowIfNeeded(state);
      return;
    }

    const key = sessionKey(state);
    const prevMarkerCount = this.autoEngine.getMarkers().filter((m) => m.windowKey === key).length;

    this.autoEngine.tick(state, autoSetup, nowMs);

    const currentCount = this.autoEngine.getMarkers().filter((m) => m.windowKey === key).length;

    if (this.isLiveArmed()) {
      await this.mirrorNewSimMarkers(state, autoSetup, prevMarkerCount);
      await this.manageRestingGtdBuys(state, autoSetup, nowMs);
    } else {
      this.mirroredMarkerCount = currentCount;
      if (this.restingBuy && !this.config.startTrading) {
        await this.cancelRestingBuy("startTrading off");
      }
    }
  }

  private phaseAtTime(setup: SimSetup, state: LiveWindowState, tSec: number): SimPhaseConfig {
    const idx = phaseIndexForState(state, setup.phaseSplit, tSec);
    return setup.phases[idx] ?? setup.phases[0];
  }

  private async mirrorNewSimMarkers(
    state: LiveWindowState,
    setup: SimSetup,
    prevCount: number,
  ): Promise<void> {
    if (this.orderInFlight) return;
    const key = sessionKey(state);
    const simMarkers = this.autoEngine.getMarkers().filter((m) => m.windowKey === key);
    if (simMarkers.length <= prevCount) return;

    const newMarkers = simMarkers.slice(prevCount);
    for (const marker of newMarkers) {
      if (marker.type === "buy") {
        // Optimize-off buys are resting GTD limits — do not mirror sim market fires.
        const phase = this.phaseAtTime(setup, state, marker.t);
        if (!phase.buyOptimize) continue;
        if (!stabilizeAllowsBuy(phase, assetPricesFromState(state))) continue;
        if (this.positions[marker.side]) continue;
        await this.executeOrder(state, marker.side, "buy", marker.shares, "auto", "shares", "FAK");
      } else if (marker.type === "sell") {
        if (!this.positions[marker.side]) continue;
        await this.executeOrder(state, marker.side, "sell", this.positions[marker.side]!.shares, "auto");
      }
    }
    this.mirroredMarkerCount = simMarkers.length;
  }

  private async cancelRestingBuy(reason: string): Promise<void> {
    const resting = this.restingBuy;
    if (!resting) return;
    this.restingBuy = null;
    logService.info("trading", `Cancel resting GTD (${reason})`);
    if (!isTradingExecutor()) return;
    await cancelOpenOrder(this.userId, resting.orderId);
  }

  private async manageRestingGtdBuys(
    state: LiveWindowState,
    setup: SimSetup,
    nowMs?: number,
  ): Promise<void> {
    if (this.orderInFlight) return;

    const nowSec = Math.floor((nowMs ?? state.lastTickMs ?? Date.now()) / 1000);
    const phaseIdx = phaseIndexForState(state, setup.phaseSplit, nowSec);
    const phase = setup.phases[phaseIdx] ?? setup.phases[0];
    const key = sessionKey(state);
    const stabilizeOk = stabilizeAllowsBuy(phase, assetPricesFromState(state));

    // Phase changed or optimize/disabled/stabilize — cancel prior resting buy.
    if (this.restingBuy) {
      const r = this.restingBuy;
      if (
        r.sessionKey !== key ||
        r.phaseIdx !== phaseIdx ||
        phase.buyOptimize ||
        !phase.buyEnabled ||
        !stabilizeOk
      ) {
        await this.cancelRestingBuy(
          r.phaseIdx !== phaseIdx
            ? "phase change"
            : phase.buyOptimize
              ? "optimize on"
              : !phase.buyEnabled
                ? "buy disabled"
                : "stabilize filter",
        );
      }
    }

    // Poll open resting order for fills.
    if (this.restingBuy) {
      await this.pollRestingBuy(state);
      if (this.restingBuy) return; // still open — don't place another
    }

    // Place GTD when optimize is off and phase allows buys.
    if (phase.buyOptimize || !phase.buyEnabled) return;
    if (!stabilizeOk) return;
    if (this.positions.up || this.positions.down) return;
    if (this.restingBuy) return;

    let chosenSide: "up" | "down" | null = null;
    for (const side of SIDES_ORDER) {
      if (gapAllowsBuy(side, phase, state.assetGap)) {
        chosenSide = side;
        break;
      }
    }
    if (!chosenSide) return;

    const windowEnd = state.windowEnd ?? nowSec + 300;
    const limitPrice = centsToPrice(phase.buyTrigger);
    const shares = Math.max(1, phase.buyShares || 1);

    this.orderInFlight = true;
    try {
      const result = await placeLimitGtdBuy(this.userId, {
        series: state.series,
        side: chosenSide,
        size: shares,
        price: limitPrice,
        expirationSec: gtdExpirationUnix(windowEnd, nowSec),
        state,
      });
      if (!result.success || !result.orderId) {
        if (result.error) logService.warn("trading", `GTD place failed: ${result.error}`);
        return;
      }

      if (result.fillShares != null && result.fillPrice != null && result.fillShares > 0) {
        await this.recordBuyFill(
          state,
          chosenSide,
          result.fillShares,
          result.fillPrice,
          result.usdcAmount,
          result.tokenId,
          result.conditionId,
          result.slug,
          "auto",
        );
        return;
      }

      this.restingBuy = {
        orderId: result.orderId,
        side: chosenSide,
        phaseIdx,
        sessionKey: key,
        shares,
        limitPrice,
        sizeMatched: 0,
        tokenId: result.tokenId,
        conditionId: result.conditionId,
        slug: result.slug,
      };
      this.notify();
    } finally {
      this.orderInFlight = false;
    }
  }

  private async pollRestingBuy(state: LiveWindowState): Promise<void> {
    const resting = this.restingBuy;
    if (!resting) return;

    const snap = await fetchOpenOrder(this.userId, resting.orderId);
    // Transient fetch failures — keep tracking so we don't double-place.
    if (!snap) return;

    const matched = Math.max(0, snap.sizeMatched);
    if (matched > resting.sizeMatched + 1e-9) {
      const delta = matched - resting.sizeMatched;
      const fillPrice = snap.price > 0 ? snap.price : resting.limitPrice;
      await this.recordBuyFill(
        state,
        resting.side,
        delta,
        fillPrice,
        delta * fillPrice,
        resting.tokenId ?? snap.assetId,
        resting.conditionId ?? snap.market,
        resting.slug,
        "auto",
        resting.cardId,
      );
      const pos = this.positions[resting.side];
      resting.cardId = pos?.cardId ?? resting.cardId;
      resting.sizeMatched = matched;
      resting.tokenId = resting.tokenId ?? snap.assetId;
      resting.conditionId = resting.conditionId ?? snap.market;
    }

    const status = snap.status.toLowerCase();
    // Still working — leave resting open.
    if (status === "live" || status === "delayed") return;

    // Matched, cancelled, expired, unmatched, etc.
    this.restingBuy = null;
    this.notify();
  }

  private async recordBuyFill(
    state: LiveWindowState,
    side: "up" | "down",
    fillShares: number,
    fillPrice: number,
    usdcAmount: number | undefined,
    tokenId: string | undefined,
    conditionId: string | undefined,
    slug: string | undefined,
    source: "manual" | "auto",
    existingCardId?: string,
  ): Promise<void> {
    const nowSec = Math.floor(Date.now() / 1000);
    const cost = usdcAmount ?? fillShares * fillPrice;
    const buyFees = await estimateLiveTakerFee(this.userId, tokenId, fillShares, fillPrice);

    const existing = existingCardId ? this.findCard(existingCardId) : undefined;
    const pos = this.positions[side];

    if (existing && existing.status === "open" && pos) {
      const totalShares = pos.shares + fillShares;
      const totalCost = pos.cost + cost;
      const totalFees = (pos.buyFees ?? 0) + buyFees;
      pos.shares = totalShares;
      pos.avgPrice = totalShares > 0 ? totalCost / totalShares : fillPrice;
      pos.cost = totalCost;
      pos.buyFees = totalFees;
      pos.asset = pos.asset ?? tokenId;
      pos.conditionId = pos.conditionId ?? conditionId;
      existing.shares = totalShares;
      existing.buyPrice = pos.avgPrice;
      existing.buyCost = totalCost;
      existing.buyFees = totalFees;
      existing.asset = existing.asset ?? tokenId;
      existing.conditionId = existing.conditionId ?? conditionId;
      existing.slug = existing.slug ?? slug;
    } else {
      const cardId = newCardId();
      this.positions[side] = {
        shares: fillShares,
        avgPrice: fillPrice,
        cost,
        buyFees,
        cardId,
        asset: tokenId,
        conditionId,
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
        buyFees,
        buyAt: nowSec,
        status: "open",
        asset: tokenId,
        conditionId,
        slug,
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
        this.rememberActivatedPlacement(this.scheduleContext.placementId);
      }
      if (this.positionCards.length > 100) {
        this.positionCards.length = 100;
      }
      void this.enrichCardFromPolymarketBuy(cardId);
    }

    this.addMarker(state, {
      type: "buy",
      side,
      t: nowSec,
      y: state.assetPrice ?? null,
      shares: fillShares,
      price: fillPrice,
      cost,
      fees: buyFees,
      total: cost + buyFees,
    });
    void refreshCollateralBalance(this.userId);
    this.notify();
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
      return { ok: false, error: "Allow trade to place orders" };
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
          this.persistCardStat(card);
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
      const trades = await fetchUserTrades(this.userId, {
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
        card.buyFees = await estimateLiveTakerFee(this.userId, card.asset ?? trade.asset, size, price);
        card.asset = card.asset ?? trade.asset;
        card.conditionId = card.conditionId ?? trade.conditionId;
        card.slug = card.slug ?? trade.slug;
        if (trade.timestamp != null) card.buyAt = Number(trade.timestamp);
        card.confirmed = true;
      } else {
        const rows = await fetchUserPositions(this.userId, {
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
          card.buyFees = await estimateLiveTakerFee(
            this.userId,
            card.asset ?? pos.asset,
            card.shares,
            card.buyPrice,
          );
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
      sidePos.buyFees = card.buyFees ?? 0;
      sidePos.asset = card.asset;
      sidePos.conditionId = card.conditionId;
    }
    if (card.confirmed) this.syncBuyMarkerFromCard(card);
  }

  private syncBuyMarkerFromCard(card: TradingPositionCard): void {
    for (let i = this.markers.length - 1; i >= 0; i -= 1) {
      const marker = this.markers[i];
      if (
        marker.type === "buy" &&
        marker.windowKey === card.windowKey &&
        marker.side === card.side
      ) {
        marker.shares = card.shares;
        marker.price = card.buyPrice;
        marker.cost = card.buyCost;
        marker.fees = card.buyFees ?? 0;
        marker.total = card.buyCost + (card.buyFees ?? 0);
        break;
      }
    }
  }

  private async tryConfirmSoldCard(card: TradingPositionCard): Promise<void> {
    if (!card.asset && !card.conditionId) return;

    try {
      const soldAt = card.soldAt ?? card.buyAt;
      const trades = await fetchUserTrades(this.userId, {
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
        card.buyFees = await estimateLiveTakerFee(this.userId, card.asset, card.shares, card.buyPrice);
        card.sellFees = await estimateLiveTakerFee(this.userId, card.asset ?? trade.asset, size, price);
        card.asset = card.asset ?? trade.asset;
        card.conditionId = card.conditionId ?? trade.conditionId;
        card.slug = card.slug ?? trade.slug;
        if (trade.timestamp != null) card.soldAt = Number(trade.timestamp);
        card.pl = feeAwarePlSold(card);
        if (isValidSharePrice(card.buyPrice)) {
          card.confirmed = true;
        }
      }

      const rows = await fetchClosedPositions(this.userId, {
        conditionId: card.conditionId,
        limit: 30,
      });
      const closed = findClosedPosition(rows, {
        asset: card.asset,
        conditionId: card.conditionId,
        afterTs: card.buyAt - 30,
      });

      if (closed?.realizedPnl != null && Number.isFinite(Number(closed.realizedPnl))) {
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
        card.buyFees = await estimateLiveTakerFee(this.userId, card.asset, card.shares, card.buyPrice);
        if (card.sellPrice != null) {
          card.sellFees = await estimateLiveTakerFee(this.userId, card.asset, card.shares, card.sellPrice);
        }
        card.asset = card.asset ?? closed.asset;
        card.conditionId = card.conditionId ?? closed.conditionId;
        card.slug = card.slug ?? closed.slug;
        card.pl = feeAwarePlFromGross(Number(closed.realizedPnl), card);
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
      const closedRows = await fetchClosedPositions(this.userId, {
        conditionId: card.conditionId,
        limit: 30,
      });
      const closed = findClosedPosition(closedRows, {
        asset: card.asset,
        conditionId: card.conditionId,
        afterTs: card.buyAt - 30,
      });
      if (closed?.realizedPnl != null && Number.isFinite(Number(closed.realizedPnl))) {
        const grossPl = Number(closed.realizedPnl);
        if (closed.avgPrice != null && isValidSharePrice(closed.avgPrice)) {
          card.buyPrice = Number(closed.avgPrice);
        }
        if (closed.totalBought != null && isValidShareSize(closed.totalBought)) {
          card.shares = Number(closed.totalBought);
          card.buyCost = card.shares * card.buyPrice;
        }
        card.buyFees = await estimateLiveTakerFee(this.userId, card.asset, card.shares, card.buyPrice);
        const won = closed.curPrice != null ? Number(closed.curPrice) >= 0.5 : grossPl >= 0;
        card.status = won ? "win" : "loss";
        card.outcome =
          outcomeFromIndex(closed.outcomeIndex, closed.outcome) ??
          (won ? card.side : card.side === "up" ? "down" : "up");
        card.pl = feeAwarePlFromGross(grossPl, card);
        if (isValidSharePrice(card.buyPrice) && isValidShareSize(card.shares)) {
          card.confirmed = true;
        }
        return;
      }

      const openRows = await fetchUserPositions(this.userId, {
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
        const grossPl = Number(openPos.cashPnl ?? openPos.realizedPnl ?? 0);
        card.buyPrice = Number(openPos.avgPrice);
        card.shares = Number(openPos.size);
        card.buyCost = Number(openPos.initialValue ?? card.shares * card.buyPrice);
        card.buyFees = await estimateLiveTakerFee(this.userId, card.asset, card.shares, card.buyPrice);
        const won = openPos.curPrice != null ? Number(openPos.curPrice) >= 0.5 : grossPl >= 0;
        card.status = won ? "win" : "loss";
        card.outcome =
          outcomeFromIndex(openPos.outcomeIndex, openPos.outcome) ??
          (won ? card.side : card.side === "up" ? "down" : "up");
        card.pl = Number.isFinite(grossPl)
          ? feeAwarePlFromGross(grossPl, card)
          : feeAwarePlHeld(card, won);
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
    this.persistCardStat(card);
    this.notify();
    this.ensureConfirmLoop();
  }

  private async enrichCardFromPolymarketSell(cardId: string, _soldAt: number): Promise<void> {
    const card = this.findCard(cardId);
    if (!card) return;
    await this.tryConfirmCard(card);
    this.persistCardStat(card);
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
    orderType: MarketOrderType = "FOK",
  ): Promise<{ ok: boolean; error?: string }> {
    if (!isTradingExecutor()) {
      logNonExecutorSkipOnce();
      return { ok: false, error: "Trading executor not enabled in this process" };
    }
    if (this.orderInFlight) return { ok: false, error: "Order already in progress" };
    this.orderInFlight = true;
    try {
      const result = await placeMarketOrder(this.userId, {
        series: state.series,
        side,
        leg,
        size,
        sizeUnit: leg === "sell" ? "shares" : sizeUnit,
        orderType: leg === "buy" ? orderType : "FOK",
        state,
      });
      if (!result.success || result.fillPrice == null || result.fillShares == null) {
        return { ok: false, error: result.error ?? "Order failed" };
      }

      const nowSec = Math.floor(Date.now() / 1000);
      const fillShares = result.fillShares;
      const fillPrice = result.fillPrice;

      if (leg === "buy") {
        await this.recordBuyFill(
          state,
          side,
          fillShares,
          fillPrice,
          result.usdcAmount,
          result.tokenId,
          result.conditionId,
          result.slug,
          source,
        );
      } else {
        const pos = this.positions[side]!;
        const proceeds = result.usdcAmount ?? fillShares * fillPrice;
        const sellFees = await estimateLiveTakerFee(
          this.userId,
          result.tokenId ?? pos.asset,
          fillShares,
          fillPrice,
        );
        const buyFees = pos.buyFees ?? 0;
        const profit = proceeds - sellFees - (pos.cost + buyFees);
        this.lockQuote(side, "sell", fillPrice);
        const card = this.findCard(pos.cardId);
        if (card && card.status === "open") {
          card.status = "sold";
          card.sellPrice = fillPrice;
          card.sellProceeds = proceeds;
          card.sellFees = sellFees;
          card.buyFees = card.buyFees ?? buyFees;
          card.soldAt = nowSec;
          card.pl = profit;
          card.shares = fillShares;
          card.asset = card.asset ?? result.tokenId ?? pos.asset;
          card.conditionId = card.conditionId ?? result.conditionId ?? pos.conditionId;
          card.slug = card.slug ?? result.slug;
          card.confirmed = false;
          this.persistCardStat(card);
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
          fees: sellFees,
          profit,
          total: proceeds,
        });
        this.positions[side] = null;
        void refreshCollateralBalance(this.userId);
        this.notify();
      }

      logService.info("trading", `${source} ${leg} ${side} filled`);
      return { ok: true };
    } finally {
      this.orderInFlight = false;
    }
  }
}

class LiveTradingRegistry {
  private engines = new Map<string, LiveTradingService>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private readonly listeners = new Set<UpdateListener>();
  private readonly fanOut = (): void => {
    for (const listener of this.listeners) listener();
  };

  get(userId: string): LiveTradingService {
    let engine = this.engines.get(userId);
    if (!engine) {
      engine = new LiveTradingService(userId);
      engine.onUpdate(this.fanOut);
      this.engines.set(userId, engine);
    }
    return engine;
  }

  async ensureLoaded(userId: string): Promise<LiveTradingService> {
    const engine = this.get(userId);
    await engine.loadPersistedConfig();
    if (isTradingExecutor()) {
      try {
        await initTradingClient(userId);
      } catch {
        /* logged in client */
      }
    }
    return engine;
  }

  async tickAll(state: LiveWindowState, nowMs?: number): Promise<void> {
    const engines = [...this.engines.values()];
    await Promise.all(engines.map((e) => e.tick(state, nowMs).catch(() => {})));
  }

  async syncFromMongo(): Promise<void> {
    const users = await listUsersForLiveTrading();
    for (const user of users) {
      const id = String(user._id);
      const engine = this.get(id);
      await engine.loadPersistedConfig();
      if (isTradingExecutor() && user.wallet?.privateKeyEnc && user.wallet?.funderAddress) {
        try {
          await initTradingClient(id);
        } catch {
          /* logged in client */
        }
      }
    }
  }

  startPolling(intervalMs = 5000): void {
    if (this.pollTimer) return;
    void this.syncFromMongo();
    this.pollTimer = setInterval(() => {
      void this.syncFromMongo();
    }, intervalMs);
  }

  stopPolling(): void {
    if (!this.pollTimer) return;
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  /** Forward engine updates — same contract as LiveTradingService.onUpdate. */
  onUpdate(listener: UpdateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  listEngines(): LiveTradingService[] {
    return [...this.engines.values()];
  }
}

export const liveTradingRegistry = new LiveTradingRegistry();