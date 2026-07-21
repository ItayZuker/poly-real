import {
  findActiveScheduleContext,
  getUtcScheduleClock,
  isScheduleContextActive,
  isSchedulePlacementElapsed,
  schedulePlacementSortKey,
  type ActiveScheduleContext,
} from "./schedule-active.js";
import { listSchedulePlacements } from "./db/schedule-placement-repository.js";
import {
  cancelOpenOrder,
  fetchOpenOrder,
  placeLimitGtdBuy,
  placeLimitGtdSell,
  placeMarketOrder,
  type MarketOrderType,
} from "./order-service.js";
import { fetchCurrentUpDownMarket } from "./market-pair.js";
import { getTradingClient, initTradingClient, refreshCollateralBalance } from "./trading-client.js";
import { SimulatorEngine } from "./simulator-engine.js";
import { simulatorService, phaseSetupToSimSetup } from "./simulator-service.js";
import { logService } from "./log-service.js";
import {
  fetchClosedPositions,
  fetchUserPositions,
  fetchUserTrades,
  findClosedPosition,
  findPosition,
  findResolvedPosition,
  findTrade,
  pollUntil,
  isValidSharePrice,
  isValidShareSize,
  type PolymarketClosedPosition,
  type PolymarketPosition,
} from "./polymarket-portfolio.js";
import {
  DEFAULT_CRYPTO_TAKER_FEE_PARAMS,
  estimateTakerFeeUsd,
  resolveTakerFeeParams,
} from "./taker-fee.js";
import {
  addActivatedPlacementId,
  ensureLiveCollectionStartedAt,
  getLiveCollectionStartedAt,
  getLiveResetAt,
  listActivatedPlacementIds,
  listTradingStatEvents,
  markLiveReset,
  setActivatedPlacementIds,
  upsertTradingStatEvent,
  type TradingStatEvent,
} from "./db/trading-session-memory-repository.js";
import {
  getUserById,
  listUsersForLiveTrading,
  resolveUserTradingForSeries,
  updateUserTrading,
} from "./db/user-repository.js";
import { DEFAULT_MARKET_SERIES } from "./collections.js";
import { isTradingExecutor } from "./trading-executor.js";
import { seriesMarketHub } from "./series-market-hub.js";
import {
  centsToPrice,
  gapAllowsBuy,
  gtdExpirationUnix,
  phaseIndexForState,
  priceToCents,
  sellEnabledForPhase,
  SIDES_ORDER,
  stabilizeAllowsBuyForSide,
} from "./phase-config.js";
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
  /** Schedule card that owned this order when it was placed. */
  placementId?: string;
}

/** Live optimize (FAK) arm/hunt state — independent of SimulatorEngine. */
interface LiveFakBuyWatch {
  side: "up" | "down";
  phaseIdx: number;
  shares: number;
  triggerCents: number;
  armed: boolean;
  stallCents: number | null;
  stallTicks: number;
  prevAskCents: number | null;
  lastBookSampleCount: number;
}

/** Phase/GTD buy cancel still settling on the CLOB (avoid orphan fills in the next phase). */
interface PendingBuyCancel {
  resting: {
    orderId: string;
    side: "up" | "down";
    sessionKey: string;
    shares: number;
    limitPrice: number;
    sizeMatched: number;
    phaseIdx?: number;
    tokenId?: string;
    conditionId?: string;
    slug?: string;
    cardId?: string;
    placementId?: string;
  };
  reason: string;
  attempts: number;
  nextAttemptMs: number;
  kind: "phase" | "override";
}

interface RestingSellOrder {
  orderId: string;
  side: "up" | "down";
  sessionKey: string;
  shares: number;
  limitPrice: number;
  sizeMatched: number;
  phaseIdx: number;
  tokenId?: string;
  conditionId?: string;
  slug?: string;
  cardId?: string;
}

/** Highest-priority resting buy that holds to settlement on any fill. */
interface OverrideRestingBuy {
  orderId: string;
  side: "up" | "down";
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
  /** Phase index where the position was bought (sell profit source). */
  buyPhaseIdx?: number;
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
  let status = card.status;
  if (card.status === "sold") {
    if (pl > 0) green = 1;
    else red = 1;
  } else if (card.status === "win" || card.status === "loss") {
    // Never trust a stale status that disagrees with settled P/L.
    if (pl > 1e-9) {
      blue = 1;
      status = "win";
    } else {
      red = 1;
      status = "loss";
    }
  } else {
    return null;
  }
  return { green, red, blue, pnl: pl, status };
}

/**
 * Resolve held-to-settlement win/loss.
 * Polymarket `outcome` on a position is the token held, not the market winner —
 * derive market outcome from our side + whether that token paid out.
 */
function resolveHeldSettlement(
  card: TradingPositionCard,
  opts: { curPrice?: number | null; grossPl?: number | null },
): { won: boolean; pl: number; outcome: "up" | "down"; status: "win" | "loss" } {
  const cur =
    opts.curPrice != null && Number.isFinite(Number(opts.curPrice))
      ? Number(opts.curPrice)
      : null;
  const gross =
    opts.grossPl != null && Number.isFinite(Number(opts.grossPl)) ? Number(opts.grossPl) : null;

  let won: boolean;
  if (cur != null) {
    won = cur >= 0.5;
  } else if (gross != null) {
    won = gross >= 0;
  } else {
    won = false;
  }

  // Prefer local held P/L when token price clearly resolved — avoids mismatched
  // closed-position realizedPnl being applied to the wrong / duplicate card.
  let pl =
    cur != null
      ? feeAwarePlHeld(card, won)
      : gross != null
        ? feeAwarePlFromGross(gross, card)
        : feeAwarePlHeld(card, won);

  if (gross != null && cur != null) {
    const plFromGross = feeAwarePlFromGross(gross, card);
    if ((plFromGross >= 0) === won) pl = plFromGross;
  }

  // Final consistency: P/L sign owns the outcome color.
  if (pl > 1e-9) won = true;
  else if (pl < -1e-9) won = false;

  return {
    won,
    pl,
    outcome: won ? card.side : card.side === "up" ? "down" : "up",
    status: won ? "win" : "loss",
  };
}

function eventStatContribution(event: TradingStatEvent): SettledStatContribution | null {
  if (!isConfirmedStatEvent(event)) return null;
  const pl = Number(event.pnl);
  if (!Number.isFinite(pl)) return null;

  let green = 0;
  let red = 0;
  let blue = 0;
  let status = event.status;
  if (event.status === "sold") {
    if (pl > 0) green = 1;
    else red = 1;
  } else if (event.status === "win" || event.status === "loss") {
    if (pl > 1e-9) {
      blue = 1;
      status = "win";
    } else {
      red = 1;
      status = "loss";
    }
  } else {
    return null;
  }
  return { green, red, blue, pnl: pl, status };
}

function confirmedContributionFromCard(
  card: TradingPositionCard,
): SettledStatContribution | null {
  if (card.confirmed !== true) return null;
  return contributionFromCard(card);
}

function isConfirmedStatEvent(event: TradingStatEvent): boolean {
  // Older events may predate card snapshots. Only reject events explicitly saved as provisional.
  return event.card?.confirmed !== false;
}

function cardStatIdentity(
  card: Pick<
    TradingPositionCard,
    "conditionId" | "asset" | "buyAt"
  >,
): string | null {
  if (!card.conditionId || !card.asset || !Number.isFinite(card.buyAt)) return null;
  return `${card.conditionId}|${card.asset}|${card.buyAt}`;
}

function eventStatIdentity(event: TradingStatEvent): string | null {
  return event.card ? cardStatIdentity(event.card) : null;
}

/** Parse market window key to unix seconds (`1784536500` or `btc-5m:1784536500`). */
function windowKeyUnixSec(windowKey: string | undefined | null): number {
  if (windowKey == null || windowKey === "") return NaN;
  const raw = String(windowKey).trim();
  const colon = raw.lastIndexOf(":");
  const tail = colon >= 0 ? raw.slice(colon + 1) : raw;
  const n = Number(tail);
  if (Number.isFinite(n) && n > 0) {
    // ms timestamps are >> 1e12
    return n > 1e12 ? n / 1000 : n;
  }
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms / 1000 : NaN;
}

/** UTC ISO week key (YYYY-Www) — groups one weekly “run” of a schedule card. */
function utcIsoWeekKey(unixSec: number): string {
  const date = new Date(unixSec * 1000);
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((target.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${target.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
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

function eventSettledMs(event: TradingStatEvent): number {
  const at = Date.parse(event.settledAt);
  return Number.isFinite(at) ? at : NaN;
}

/** Prefer root placementId; fall back to card snapshot (older Mongo rows). */
function eventPlacementId(event: TradingStatEvent): string | undefined {
  return event.placementId || event.card?.placementId || undefined;
}

/** Best clock for attributing a settled trade to a schedule slot (buy time, not settle). */
function eventAttributionMs(event: TradingStatEvent): number {
  const buyAt = event.card?.buyAt;
  if (buyAt != null && Number.isFinite(buyAt)) {
    return buyAt > 1e12 ? buyAt : buyAt * 1000;
  }
  return eventSettledMs(event);
}

function cardSettledMs(card: TradingPositionCard): number {
  const sec = card.soldAt ?? card.buyAt;
  if (sec == null || !Number.isFinite(sec)) return NaN;
  return sec * 1000;
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

/** Quiet period after gap/stabilize cancel before placing another resting GTD buy. */
const GTD_FILTER_REPRESS_MS = 2500;
/** Quiet period after sell balance/allowance reject (tokens not credited yet). */
const GTD_SELL_BALANCE_REPRESS_MS = 2500;
/** Max position cards kept in RAM and sent to the UI scroll. */
const MAX_POSITION_CARDS = 50;

function isRoutineGtdCancelReason(reason: string): boolean {
  return reason === "gap filter" || reason === "stabilize filter";
}

function isBalanceAllowanceError(err: string): boolean {
  return /not enough balance|allowance/i.test(err);
}

function newCardId(): string {
  return `pos-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function defaultTradingConfig(): TradingConfig {
  return {
    autoTrade: false,
    useSchedule: false,
    startTrading: false,
    manualShares: 10,
    manualOrderUnit: "shares",
    buyOverrideEnabled: false,
    buyOverridePriceCents: 0,
    buyOverrideShares: 0,
    buyOverrideDirection: "with",
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
  const priceRaw = Number(raw.buyOverridePriceCents);
  const sharesRaw = Number(raw.buyOverrideShares);
  const next: TradingConfig = {
    autoTrade: Boolean(raw.autoTrade),
    useSchedule: Boolean(raw.useSchedule),
    startTrading: Boolean(raw.startTrading),
    manualShares: amount,
    manualOrderUnit: unit,
    buyOverrideEnabled: Boolean(raw.buyOverrideEnabled),
    buyOverridePriceCents: Number.isFinite(priceRaw)
      ? Math.max(0, Math.min(99, Math.floor(priceRaw)))
      : 0,
    buyOverrideShares: Number.isFinite(sharesRaw)
      ? Math.max(0, Math.min(100000, Math.floor(sharesRaw)))
      : 0,
    buyOverrideDirection: raw.buyOverrideDirection === "opposite" ? "opposite" : "with",
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
   * Settled contributions for schedule card stats + Live header (filtered by liveResetAtMs).
   * Keyed by cardId — survives restart and header Live reset; cleared per placement on remove.
   */
  private liveStatLedger = new Map<string, TradingStatEvent>();
  /** Last written fingerprints — skip identical Mongo upserts. */
  private lastPersistedStatFingerprint = new Map<string, string>();
  /** True after the first successful Mongo ledger hydrate for this process. */
  private statsHydrated = false;
  /** Header "Live" range cut — events at/before this ms are excluded from session totals only. */
  private liveResetAtMs: number | null = null;
  /** Schedule live collection arm time — slots before this stay pre-run (dashes). */
  private liveCollectionStartedAtMs: number | null = null;
  private sessionKey: string | null = null;
  private mirroredMarkerCount = 0;
  private orderInFlight = false;
  /** True across the complete manual BUY attempt. */
  private manualBuyPending = false;
  /** Successful manual BUY suppresses all phase buys until this window rolls. */
  private manualBuyOverrideWindowKey: string | null = null;
  /**
   * Ambiguous / unverified buy response — block further buys for this window
   * until we adopt an on-chain position or the window rolls.
   */
  private buyBlockedWindowKey: string | null = null;
  /** Resting GTD limit buy for the active non-optimize phase. */
  private restingBuy: RestingBuyOrder | null = null;
  /** After gap/stabilize cancel, delay before placing another resting GTD buy. */
  private gtdBuyRepressUntilMs = 0;
  /** Last phase index for clearing buy repress across phase boundaries. */
  private lastGtdBuyPhaseIdx = -1;
  /** After a rejected phase GTD buy (e.g. expiration), skip further places this window. */
  private gtdBuyBlockedWindowKey: string | null = null;
  /** Live FAK optimize watch (only while live-armed; sim is not ticked). */
  private liveFakWatch: LiveFakBuyWatch | null = null;
  /** Resting phase GTD buys awaiting confirmed CLOB cancel (and possible race fill). */
  private pendingBuyCancels: PendingBuyCancel[] = [];
  /** PTB-crossing abort state for live (replaces sim abort while armed). */
  private liveAbortedBuyPhases = new Set<number>();
  private livePendingPhaseAborts = new Map<number, number>();
  private liveCompletedPhaseAbortCancellations = new Set<number>();
  private liveTrackedPhaseIdx = -1;
  private livePhaseCrossingBaseline = 0;
  private liveLastPtbCrossings = 0;
  /** Resting GTD maker sell for the open auto/manual-managed position. */
  private restingSell: RestingSellOrder | null = null;
  /** After a rejected GTD sell (e.g. expiration), skip further sell places this window. */
  private gtdSellBlockedWindowKey: string | null = null;
  /** After balance/allowance reject, delay before retrying GTD sell. */
  private gtdSellRepressUntilMs = 0;
  /** Highest-priority resting buy override (competes with phase buys). */
  private overrideRestingBuy: OverrideRestingBuy | null = null;
  /** After a rejected buy-override GTD (e.g. expiration), skip further places this window. */
  private overrideGtdBlockedWindowKey: string | null = null;
  /** Window key where override fill owns the position (hold to settlement, no sell). */
  private overrideHoldWindowKey: string | null = null;
  /** Serialize CLOB + Chainlink tick handlers for this user. */
  private tickQueue: Promise<void> = Promise.resolve();
  /** Do not hit Polymarket positions API before this time (rate-limit / throttle). */
  private onChainCheckNotBeforeMs = 0;
  /** Exponential backoff after Data API 429s (ms). */
  private onChainBackoffMs = 0;
  private scheduleContext: ActiveScheduleContext | null = null;
  private scheduleContextFetchedAt = 0;
  private activePhaseSetup: TradingPhaseSetup | null = null;
  private readonly autoEngine = new SimulatorEngine();
  private readonly listeners = new Set<UpdateListener>();
  private confirmLoopTimer: ReturnType<typeof setInterval> | null = null;
  private confirmInFlight = false;
  /** Market this engine's config/schedule/resting orders are bound to. */
  private boundSeries: string = DEFAULT_MARKET_SERIES;

  constructor(private readonly userId: string) {}

  getBoundSeries(): string {
    return this.boundSeries;
  }

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

  async loadPersistedConfig(options?: {
    hydrateStats?: boolean;
    series?: string;
  }): Promise<TradingConfig> {
    const series =
      String(options?.series ?? this.boundSeries ?? DEFAULT_MARKET_SERIES).trim() ||
      DEFAULT_MARKET_SERIES;
    this.boundSeries = series;
    try {
      const user = await getUserById(this.userId);
      if (!user) {
        throw new Error(`User not found: ${this.userId}`);
      }
      this.config = resolveUserTradingForSeries(user, series);
    } catch (err) {
      logService.warn("trading", `Failed to load trading config: ${String(err)}`);
      this.config = defaultTradingConfig();
    }
    // Always hydrate once so schedule cards aren't empty after deploy; later polls can skip.
    const skipHydrate = options?.hydrateStats === false && this.statsHydrated;
    if (!skipHydrate) {
      await this.hydrateLiveStatsFromMongo();
    }
    return this.getConfig();
  }

  /** Reload settled events from Mongo (after boot). Card stats keep full history; Live header uses liveResetAt. */
  async hydrateLiveStatsFromMongo(): Promise<void> {
    try {
      const resetAt = await getLiveResetAt(this.userId);
      const resetMs = resetAt ? Date.parse(resetAt) : NaN;
      this.liveResetAtMs = Number.isFinite(resetMs) ? resetMs : null;

      const collectionStartedAt = await getLiveCollectionStartedAt(this.userId);
      const collectionMs = collectionStartedAt ? Date.parse(collectionStartedAt) : NaN;
      this.liveCollectionStartedAtMs = Number.isFinite(collectionMs) ? collectionMs : null;

      const events = await listTradingStatEvents(this.userId, {});
      if (this.liveCollectionStartedAtMs == null && events.length > 0) {
        let earliest = Infinity;
        for (const event of events) {
          const at = eventSettledMs(event);
          if (Number.isFinite(at) && at < earliest) earliest = at;
        }
        if (Number.isFinite(earliest)) {
          this.liveCollectionStartedAtMs = earliest;
          await ensureLiveCollectionStartedAt(this.userId, new Date(earliest).toISOString());
        }
      }

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
        // Older rows may only store placementId on the card snapshot.
        const pid = eventPlacementId(event);
        if (pid && !event.placementId) event.placementId = pid;
        if (pid && event.card && !event.card.placementId) {
          event.card = { ...event.card, placementId: pid };
        }
        this.liveStatLedger.set(event.cardId, event);
        this.lastPersistedStatFingerprint.set(event.cardId, eventFingerprint(event));
        if (pid) this.knownPlacementIds.add(pid);
        const card = positionCardFromEvent(event);
        if (card) {
          restored.push(card);
          if (card.placementId) this.knownPlacementIds.add(card.placementId);
        }
      }

      restored.sort((a, b) => (b.buyAt ?? 0) - (a.buyAt ?? 0));
      this.positionCards = [...openCards, ...restored].slice(0, MAX_POSITION_CARDS);
      this.statsHydrated = true;

      const backfilled = await this.backfillOrphanPlacementIds();
      logService.info(
        "trading",
        `Hydrated ${events.length} live stat event(s) from Mongo (${restored.length} position card(s), ${this.knownPlacementIds.size} placement(s)${
          backfilled > 0 ? `, backfilled ${backfilled} placementId(s)` : ""
        })`,
      );
      await this.syncActivatedSchedulePlacements();
      this.ensureConfirmLoop();
    } catch (err) {
      logService.warn("trading", `Failed to hydrate live stats from Mongo: ${String(err)}`);
    }
  }

  /**
   * Map settled trades that never got a placementId (late GTD fills, wiped upserts)
   * onto the schedule slot that was live at buy time so card stats match Live totals.
   */
  private async backfillOrphanPlacementIds(): Promise<number> {
    let placements: Awaited<ReturnType<typeof listSchedulePlacements>>;
    try {
      placements = await listSchedulePlacements(this.userId, this.boundSeries);
    } catch {
      return 0;
    }
    if (placements.length === 0) return 0;

    const findPlacementAt = (atMs: number): string | undefined => {
      if (!Number.isFinite(atMs)) return undefined;
      const clock = getUtcScheduleClock(new Date(atMs));
      const match = placements.find(
        (p) =>
          p.day === clock.day &&
          clock.hour >= p.startHour &&
          clock.hour < p.startHour + p.durationHours,
      );
      return match?._id;
    };

    let fixed = 0;
    for (const event of this.liveStatLedger.values()) {
      if (eventPlacementId(event)) continue;
      const placementId = findPlacementAt(eventAttributionMs(event));
      if (!placementId) continue;

      event.placementId = placementId;
      if (event.card) {
        event.card = { ...event.card, placementId };
      }
      this.knownPlacementIds.add(placementId);

      const ramCard = this.findCard(event.cardId);
      if (ramCard && !ramCard.placementId) ramCard.placementId = placementId;

      this.lastPersistedStatFingerprint.set(event.cardId, eventFingerprint(event));
      const snapshot: TradingStatEvent = {
        cardId: event.cardId,
        placementId: event.placementId,
        status: event.status,
        green: event.green,
        red: event.red,
        blue: event.blue,
        pnl: event.pnl,
        settledAt: event.settledAt,
        updatedAt: event.updatedAt,
        card: event.card,
      };
      this.statsPersistChain = this.statsPersistChain
        .then(() =>
          upsertTradingStatEvent(this.userId, {
            cardId: snapshot.cardId,
            placementId: snapshot.placementId,
            status: snapshot.status,
            green: snapshot.green,
            red: snapshot.red,
            blue: snapshot.blue,
            pnl: snapshot.pnl,
            settledAt: snapshot.settledAt,
            card: snapshot.card,
          }).then(() => undefined),
        )
        .catch((err) => {
          this.lastPersistedStatFingerprint.delete(snapshot.cardId);
          logService.warn(
            "trading",
            `Failed to persist backfilled placementId for ${snapshot.cardId}: ${String(err)}`,
          );
        });
      fixed += 1;
    }
    return fixed;
  }

  /** Mark a schedule placement as live this session so cards show 0/0/0 until the first fill. */
  private rememberActivatedPlacement(
    placementId: string | undefined,
    opts?: { quiet?: boolean },
  ): void {
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
    if (!opts?.quiet) this.notify();
  }

  /**
   * Zero-trade slots that ran after live collection started (or sit between slots with
   * live fills) show gray +$0.00. Slots before collection start stay pre-run (dashes).
   */
  private async syncActivatedSchedulePlacements(): Promise<void> {
    if (!this.config.autoTrade || !this.config.useSchedule) return;

    let placements: Awaited<ReturnType<typeof listSchedulePlacements>>;
    try {
      placements = await listSchedulePlacements(this.userId, this.boundSeries);
    } catch {
      return;
    }
    if (placements.length === 0) return;

    if (this.config.startTrading) {
      await this.ensureCollectionStarted();
    }

    const floorKey = this.collectionFloorKey();
    const keyed = placements
      .map((p) => ({ p, key: schedulePlacementSortKey(p) }))
      .sort((a, b) => a.key - b.key);

    // Drop pre-run activations that fully ended before recording/collection start.
    // Use end time (not start): a slot that was already running when collection began
    // must stay activated — otherwise remember/prune thrash and the live card flickers.
    if (floorKey != null) {
      const keep: string[] = [];
      let pruned = false;
      for (const { p, key } of keyed) {
        if (!this.knownPlacementIds.has(p._id)) continue;
        // Never prune the slot that is live right now.
        if (isScheduleContextActive(p)) {
          keep.push(p._id);
          continue;
        }
        const endKey = key + p.durationHours;
        if (endKey <= floorKey + 1e-9) {
          // Keep cards that already have live outcomes — they stay locked on the board.
          if (this.placementHasRecordedStats(p._id)) {
            keep.push(p._id);
            continue;
          }
          this.knownPlacementIds.delete(p._id);
          pruned = true;
        } else {
          keep.push(p._id);
        }
      }
      // Keep ids not on this week's board (shouldn't happen) — only persist board survivors + events.
      for (const id of this.knownPlacementIds) {
        if (!keyed.some(({ p }) => p._id === id)) keep.push(id);
      }
      if (this.scheduleContext?.placementId) {
        keep.push(this.scheduleContext.placementId);
      }
      if (pruned) {
        const unique = [...new Set(keep)];
        this.knownPlacementIds = new Set(unique);
        this.statsPersistChain = this.statsPersistChain
          .then(() => setActivatedPlacementIds(this.userId, unique))
          .catch((err) => {
            logService.warn("trading", `Failed to prune activated placements: ${String(err)}`);
          });
      }
    }

    let changed = false;
    const remember = (id: string): void => {
      if (this.knownPlacementIds.has(id)) return;
      this.rememberActivatedPlacement(id, { quiet: true });
      changed = true;
    };

    // While live: every elapsed slot that overlaps/after collection start is a real zero result.
    if (this.config.startTrading && floorKey != null) {
      for (const { p, key } of keyed) {
        const endKey = key + p.durationHours;
        if (endKey <= floorKey + 1e-9) continue;
        if (isSchedulePlacementElapsed(p)) remember(p._id);
      }
    }

    // Fill gaps between slots that actually have fills (still not before floor).
    const eventPlacementIds = new Set<string>();
    for (const event of this.liveStatLedger.values()) {
      const pid = eventPlacementId(event);
      if (pid) eventPlacementIds.add(pid);
    }
    const seedKeys = keyed
      .filter(({ p, key }) => {
        if (!eventPlacementIds.has(p._id)) return false;
        const endKey = key + p.durationHours;
        if (floorKey != null && endKey <= floorKey + 1e-9) return false;
        return true;
      })
      .map(({ key }) => key);
    if (seedKeys.length >= 1) {
      const minK = Math.min(...seedKeys);
      const maxK = Math.max(...seedKeys);
      for (const { p, key } of keyed) {
        const endKey = key + p.durationHours;
        if (floorKey != null && endKey <= floorKey + 1e-9) continue;
        if (key >= minK && key <= maxK) remember(p._id);
      }
    }

    if (changed) this.notify();
  }

  private collectionFloorKey(): number | null {
    if (this.liveCollectionStartedAtMs == null) return null;
    const { day, hour } = getUtcScheduleClock(new Date(this.liveCollectionStartedAtMs));
    return schedulePlacementSortKey({ day, startHour: hour });
  }

  private async ensureCollectionStarted(at = new Date()): Promise<void> {
    if (this.liveCollectionStartedAtMs != null) return;
    const iso = at.toISOString();
    this.liveCollectionStartedAtMs = at.getTime();
    try {
      const stored = await ensureLiveCollectionStartedAt(this.userId, iso);
      const ms = Date.parse(stored);
      if (Number.isFinite(ms)) this.liveCollectionStartedAtMs = ms;
    } catch (err) {
      logService.warn("trading", `Failed to persist live collection start: ${String(err)}`);
    }
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
    const series = this.boundSeries;
    this.persistChain = this.persistChain
      .then(() => updateUserTrading(this.userId, snapshot, series).then(() => undefined))
      .catch((err) => {
        logService.warn("trading", `Failed to save trading config: ${String(err)}`);
      });
  }

  setConfig(patch: Partial<TradingConfig>): TradingConfig {
    const wasLive =
      this.config.autoTrade && this.config.useSchedule && this.config.startTrading;
    const wasOverrideActive = this.isBuyOverrideConfigActive();
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
    if (patch.buyOverrideEnabled != null) {
      this.config.buyOverrideEnabled = Boolean(patch.buyOverrideEnabled);
    }
    if (patch.buyOverridePriceCents != null) {
      const price = Number(patch.buyOverridePriceCents);
      this.config.buyOverridePriceCents = Number.isFinite(price)
        ? Math.max(0, Math.min(99, Math.floor(price)))
        : 0;
    }
    if (patch.buyOverrideShares != null) {
      const shares = Number(patch.buyOverrideShares);
      this.config.buyOverrideShares = Number.isFinite(shares)
        ? Math.max(0, Math.min(100000, Math.floor(shares)))
        : 0;
    }
    if (patch.buyOverrideDirection === "with" || patch.buyOverrideDirection === "opposite") {
      this.config.buyOverrideDirection = patch.buyOverrideDirection;
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
      // Arm collection + current live slot only. Do NOT run full
      // syncActivatedSchedulePlacements here — that retroactively zeros every
      // elapsed card and looks like an Allow-trade "reset".
      void this.ensureCollectionStarted()
        .then(() => this.refreshScheduleContext(true))
        .then(() => {
          const liveId = this.scheduleContext?.placementId;
          if (liveId) this.rememberActivatedPlacement(liveId);
        });
    }
    if (wasOverrideActive && !this.isBuyOverrideConfigActive() && this.overrideRestingBuy) {
      void this.cancelOverrideRestingBuy("override disabled");
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
      positionCards: this.positionCards
        .filter((card) => this.cardMatchesBoundSeries(card))
        .map((card) => ({ ...card })),
      placementStats: this.getPlacementStatsFromCards(),
      sessionTotals: {
        green: live.green,
        red: live.red,
        blue: live.blue,
        pnl: live.pnl,
        hasData: live.hasBalance,
      },
      demoLastWindow:
        this.config.autoTrade && !this.isLiveArmed()
          ? this.autoEngine.getLastWindow()
          : null,
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

  private cardMatchesBoundSeries(card: Pick<TradingPositionCard, "series">): boolean {
    return !card.series || card.series === this.boundSeries;
  }

  private eventMatchesBoundSeries(event: TradingStatEvent): boolean {
    const series = event.card?.series;
    return !series || series === this.boundSeries;
  }

  /** Aggregate real-trade outcomes for schedule placement cards (last weekly run only). */
  getPlacementStats(placementIds: string[]): PlacementLiveStats[] {
    return placementIds.map((id) => this.statsForPlacement(id));
  }

  /** True once the card has started at least one window — stays locked until removed. */
  isPlacementLocked(placementId: string): boolean {
    if (!placementId) return false;
    if (this.knownPlacementIds.has(placementId)) return true;
    if (this.scheduleContext?.placementId === placementId) return true;
    // Any recorded live outcome for this card locks it (incl. after activation prune).
    if (this.placementHasRecordedStats(placementId)) return true;
    return false;
  }

  private placementHasRecordedStats(placementId: string): boolean {
    for (const event of this.liveStatLedger.values()) {
      if (eventPlacementId(event) !== placementId) continue;
      if (!this.eventMatchesBoundSeries(event)) continue;
      return true;
    }
    for (const card of this.positionCards) {
      if (card.placementId !== placementId) continue;
      if (!this.cardMatchesBoundSeries(card)) continue;
      if (card.status === "open") continue;
      return true;
    }
    return false;
  }

  private getPlacementStatsFromCards(): PlacementLiveStats[] {
    const ids = new Set(this.knownPlacementIds);
    for (const event of this.liveStatLedger.values()) {
      const pid = eventPlacementId(event);
      if (pid) ids.add(pid);
    }
    for (const card of this.positionCards) {
      if (card.placementId) ids.add(card.placementId);
    }
    // Always include the in-progress schedule slot so the live card stays stable.
    if (this.scheduleContext?.placementId) {
      ids.add(this.scheduleContext.placementId);
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
      locked: this.isPlacementLocked(placementId),
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
      locked: true,
    };
  }

  private statsForPlacement(placementId: string): PlacementLiveStats {
    type RunHit = {
      weekKey: string;
      windowSec: number;
      identity: string | null;
      contrib: { green: number; red: number; blue: number; pnl: number };
    };
    const hits: RunHit[] = [];
    const cardIdsFromRam = new Set<string>();
    const tradeIdentities = new Set<string>();

    const pushHit = (
      windowKey: string | undefined,
      identity: string | null,
      contrib: { green: number; red: number; blue: number; pnl: number },
      fallbackUnixSec?: number,
    ): void => {
      let windowSec = windowKeyUnixSec(windowKey);
      if (!Number.isFinite(windowSec) && fallbackUnixSec != null && Number.isFinite(fallbackUnixSec)) {
        windowSec = fallbackUnixSec > 1e12 ? fallbackUnixSec / 1000 : fallbackUnixSec;
      }
      if (!Number.isFinite(windowSec)) return;
      if (identity) {
        if (tradeIdentities.has(identity)) return;
        tradeIdentities.add(identity);
      }
      hits.push({
        weekKey: utcIsoWeekKey(windowSec),
        windowSec,
        identity,
        contrib,
      });
    };

    for (const card of this.positionCards) {
      if (card.placementId !== placementId) continue;
      if (!this.cardMatchesBoundSeries(card)) continue;
      if (card.status === "open") continue;
      const contrib = confirmedContributionFromCard(card);
      if (!contrib) continue;
      cardIdsFromRam.add(card.id);
      pushHit(card.windowKey, cardStatIdentity(card), contrib, card.soldAt ?? card.buyAt);
    }

    for (const event of this.liveStatLedger.values()) {
      if (eventPlacementId(event) !== placementId) continue;
      if (!this.eventMatchesBoundSeries(event)) continue;
      if (cardIdsFromRam.has(event.cardId)) continue;
      const contrib = eventStatContribution(event);
      if (!contrib) continue;
      const settledSec = eventSettledMs(event);
      pushHit(
        event.card?.windowKey,
        eventStatIdentity(event),
        contrib,
        Number.isFinite(settledSec) ? settledSec / 1000 : undefined,
      );
    }

    if (hits.length === 0) {
      const liveArmedSlot =
        this.config.startTrading && this.scheduleContext?.placementId === placementId;
      if (this.knownPlacementIds.has(placementId) || liveArmedSlot) {
        return this.zeroPlacementStats(placementId);
      }
      return this.emptyPlacementStats(placementId);
    }

    // Any card with recorded outcomes is locked until removed.
    this.rememberActivatedPlacement(placementId, { quiet: true });

    let latest = hits[0]!;
    for (const hit of hits) {
      if (hit.windowSec > latest.windowSec) latest = hit;
    }
    const lastWeek = latest.weekKey;

    let green = 0;
    let red = 0;
    let blue = 0;
    let pnl = 0;
    for (const hit of hits) {
      if (hit.weekKey !== lastWeek) continue;
      green += hit.contrib.green;
      red += hit.contrib.red;
      blue += hit.contrib.blue;
      pnl += hit.contrib.pnl;
    }

    return { placementId, hasData: true, green, red, blue, pnl, locked: true };
  }

  /** Clears trades tied to a removed schedule placement (stats drop with them). */
  forgetPlacement(placementId: string): void {
    this.knownPlacementIds.delete(placementId);
    const before = this.positionCards.length;
    this.positionCards = this.positionCards.filter((card) => card.placementId !== placementId);
    for (const [cardId, event] of this.liveStatLedger) {
      if (eventPlacementId(event) === placementId) {
        this.liveStatLedger.delete(cardId);
        this.lastPersistedStatFingerprint.delete(cardId);
      }
    }
    if (this.positionCards.length !== before) {
      this.stopConfirmLoopIfIdle();
    }
    this.notify();
  }

  /** Snapshot of settled live counters (Live range: RAM + hydrated Mongo since header reset). */
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
    const tradeIdentities = new Set<string>();
    let earliestBuyAt: number | null = null;

    for (const card of this.positionCards) {
      if (card.status === "open") continue;
      if (!this.cardMatchesBoundSeries(card)) continue;
      if (!this.countsTowardLiveHeader(cardSettledMs(card))) continue;
      const contrib = confirmedContributionFromCard(card);
      if (!contrib) continue;
      const identity = cardStatIdentity(card);
      if (identity && tradeIdentities.has(identity)) continue;
      if (identity) tradeIdentities.add(identity);
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
      if (!this.eventMatchesBoundSeries(event)) continue;
      if (!this.countsTowardLiveHeader(eventSettledMs(event))) continue;
      const contrib = eventStatContribution(event);
      if (!contrib) continue;
      const identity = eventStatIdentity(event);
      if (identity && tradeIdentities.has(identity)) continue;
      if (identity) tradeIdentities.add(identity);
      green += contrib.green;
      red += contrib.red;
      blue += contrib.blue;
      pnl += contrib.pnl;
      const settled = eventSettledMs(event);
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

  private countsTowardLiveHeader(settledAtMs: number): boolean {
    if (!Number.isFinite(settledAtMs)) return false;
    if (this.liveResetAtMs == null) return true;
    return settledAtMs > this.liveResetAtMs;
  }

  /**
   * Reset header "Live" counters only. Schedule placement cards keep collecting;
   * Week / All keep Mongo events. Does not clear activated placements or card ledgers.
   */
  clearPositionCards(): void {
    const at = new Date().toISOString();
    const ms = Date.parse(at);
    this.liveResetAtMs = Number.isFinite(ms) ? ms : Date.now();
    this.statsPersistChain = this.statsPersistChain
      .then(() => markLiveReset(this.userId, at))
      .catch((err) => {
        logService.warn("trading", `Failed to mark live stats reset: ${String(err)}`);
      });
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

  /**
   * Apply Polymarket closed-position data onto a held card. Returns true when confirmed.
   * Losses often never appear here — use redeemable open positions instead.
   */
  private async applyClosedHeldSettlement(
    card: TradingPositionCard,
    closed: PolymarketClosedPosition,
  ): Promise<boolean> {
    const grossPl = Number(closed.realizedPnl);
    if (!Number.isFinite(grossPl)) return false;
    if (closed.avgPrice != null && isValidSharePrice(closed.avgPrice)) {
      card.buyPrice = Number(closed.avgPrice);
    }
    if (closed.totalBought != null && isValidShareSize(closed.totalBought)) {
      card.shares = Number(closed.totalBought);
      card.buyCost = card.shares * card.buyPrice;
    }
    card.asset = card.asset ?? closed.asset;
    card.conditionId = card.conditionId ?? closed.conditionId;
    card.slug = card.slug ?? closed.slug;
    card.buyFees = await estimateLiveTakerFee(this.userId, card.asset, card.shares, card.buyPrice);
    const settled = resolveHeldSettlement(card, {
      curPrice: closed.curPrice,
      grossPl,
    });
    card.status = settled.status;
    card.outcome = settled.outcome;
    card.pl = settled.pl;
    if (!isValidSharePrice(card.buyPrice) || !isValidShareSize(card.shares)) return false;
    card.confirmed = true;
    return true;
  }

  /** Apply redeemable / near-settled open position (typical path for held losses). */
  private async applyRedeemableHeldSettlement(
    card: TradingPositionCard,
    openPos: PolymarketPosition,
  ): Promise<boolean> {
    const grossPl = Number(openPos.cashPnl ?? openPos.realizedPnl ?? 0);
    if (openPos.avgPrice != null && isValidSharePrice(openPos.avgPrice)) {
      card.buyPrice = Number(openPos.avgPrice);
    }
    if (openPos.size != null && isValidShareSize(openPos.size)) {
      card.shares = Number(openPos.size);
      card.buyCost = Number(openPos.initialValue ?? card.shares * card.buyPrice);
    }
    card.asset = card.asset ?? openPos.asset;
    card.conditionId = card.conditionId ?? openPos.conditionId;
    card.slug = card.slug ?? openPos.slug;
    card.buyFees = await estimateLiveTakerFee(this.userId, card.asset, card.shares, card.buyPrice);
    const settled = resolveHeldSettlement(card, {
      curPrice: openPos.curPrice,
      grossPl: Number.isFinite(grossPl) ? grossPl : null,
    });
    card.status = settled.status;
    card.outcome = settled.outcome;
    card.pl = settled.pl;
    if (!isValidSharePrice(card.buyPrice) || !isValidShareSize(card.shares)) return false;
    card.confirmed = true;
    return true;
  }

  /** Fetch a resolved open position; broaden beyond market filter when needed. */
  private async fetchResolvedHeldPosition(
    card: TradingPositionCard,
  ): Promise<PolymarketPosition | null> {
    if (!card.asset && !card.conditionId) return null;

    const rows = await fetchUserPositions(this.userId, {
      conditionId: card.conditionId,
      sizeThreshold: 0,
    });
    let match = findResolvedPosition(rows, {
      asset: card.asset,
      conditionId: card.conditionId,
    });
    if (match) return match;

    // Market filter can miss rows; scan recent open positions by asset/conditionId.
    if (card.asset || card.conditionId) {
      const broad = await fetchUserPositions(this.userId, {
        sizeThreshold: 0,
        limit: 200,
      });
      match = findResolvedPosition(broad, {
        asset: card.asset,
        conditionId: card.conditionId,
      });
      if (match) return match;
    }
    return null;
  }

  /** One Polymarket settlement attempt for a held (open or provisional win/loss) card. */
  private async trySettleHeldCardFromPolymarket(card: TradingPositionCard): Promise<boolean> {
    if (!card.asset && !card.conditionId) return false;

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
      if (closed) {
        return await this.applyClosedHeldSettlement(card, closed);
      }

      const openPos = await this.fetchResolvedHeldPosition(card);
      if (openPos) {
        return await this.applyRedeemableHeldSettlement(card, openPos);
      }
    } catch {
      // confirm loop retries
    }
    return false;
  }

  private async settleOpenCardsForWindow(windowKey: string): Promise<boolean> {
    const openCards = this.positionCards.filter(
      (card) => card.windowKey === windowKey && card.status === "open",
    );
    if (openCards.length === 0) return false;

    let settledCount = 0;
    for (const card of openCards) {
      // Keep status open until Polymarket confirms — no Chainlink provisional win/loss.
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

      if (closed && (await this.applyClosedHeldSettlement(card, closed))) {
        settledCount += 1;
        continue;
      }

      const openPos = await pollUntil(
        async () => this.fetchResolvedHeldPosition(card),
        { attempts: 5, delayMs: 900 },
      );

      if (openPos && (await this.applyRedeemableHeldSettlement(card, openPos))) {
        settledCount += 1;
        continue;
      }

      // Still unresolved — leave open + unconfirmed; confirm loop keeps polling.
      card.confirmed = false;
    }

    logService.info(
      "trading",
      `Settled ${settledCount}/${openCards.length} held position(s) for prior window` +
        (settledCount < openCards.length
          ? ` (${openCards.length - settledCount} waiting on Polymarket)`
          : ""),
    );
    for (const card of openCards) {
      this.persistCardStat(card);
    }
    this.notify();
    this.ensureConfirmLoop();
    return settledCount > 0 || openCards.length > 0;
  }

  private resetWindow(state: LiveWindowState): void {
    const prevKey = this.sessionKey;
    const prevResting = this.restingBuy;
    const prevRestingSell = this.restingSell;
    const prevOverride = this.overrideRestingBuy;
    this.restingBuy = null;
    this.restingSell = null;
    this.overrideRestingBuy = null;
    this.overrideHoldWindowKey = null;
    this.overrideGtdBlockedWindowKey = null;
    this.gtdBuyRepressUntilMs = 0;
    this.lastGtdBuyPhaseIdx = -1;
    this.gtdBuyBlockedWindowKey = null;
    this.liveFakWatch = null;
    // Keep pendingBuyCancels — old GTDs may still fill after window roll.
    this.liveAbortedBuyPhases.clear();
    this.livePendingPhaseAborts.clear();
    this.liveCompletedPhaseAbortCancellations.clear();
    this.liveTrackedPhaseIdx = -1;
    this.livePhaseCrossingBaseline = 0;
    this.liveLastPtbCrossings = 0;
    this.gtdSellBlockedWindowKey = null;
    this.gtdSellRepressUntilMs = 0;
    if (isTradingExecutor()) {
      if (prevResting?.orderId) {
        void this.finishBuyCancel(prevResting, "window roll", state, "phase");
      }
      if (prevOverride?.orderId) {
        void this.finishBuyCancel(prevOverride, "window roll", state, "override");
      }
      if (prevRestingSell?.orderId) void cancelOpenOrder(this.userId, prevRestingSell.orderId);
    }
    this.positions = { up: null, down: null };
    this.quoteLocks = emptyQuoteLocks();
    this.markers = [];
    this.mirroredMarkerCount = 0;
    this.manualBuyPending = false;
    this.manualBuyOverrideWindowKey = null;
    this.buyBlockedWindowKey = null;
    this.onChainCheckNotBeforeMs = 0;
    this.onChainBackoffMs = 0;
    this.sessionKey = sessionKey(state);
    if (prevKey) {
      void this.settleOpenCardsForWindow(prevKey).then((hadHits) => {
        if (hadHits) {
          // Stats already written via persistCardStat; wait for Mongo flush then refresh placement aggregates.
          void this.statsPersistChain.then(() => this.syncActivatedSchedulePlacements());
        }
      });
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

  /** Clear a quote latch (e.g. resting sell cancelled without a fill). */
  private unlockQuote(side: "up" | "down", leg: "buy" | "sell"): void {
    const key = leg === "buy" ? (`${side}Buy` as const) : (`${side}Sell` as const);
    this.quoteLocks[key] = null;
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

  private isBuyBlocked(state: LiveWindowState): boolean {
    const key = sessionKey(state);
    if (this.positions.up || this.positions.down) return true;
    if (this.manualBuyPending) return true;
    if (this.manualBuyOverrideWindowKey === key) return true;
    if (this.buyBlockedWindowKey === key) return true;
    // Block while a prior GTD cancel may still race-fill on the CLOB.
    if (this.pendingBuyCancels.length > 0) return true;
    return false;
  }

  private blockFurtherBuys(state: LiveWindowState, reason: string): void {
    this.buyBlockedWindowKey = sessionKey(state);
    this.liveFakWatch = null;
    if (!this.isLiveArmed()) this.autoEngine.suppressBuysForWindow();
    logService.warn("trading", `Further buys blocked for window (${reason})`);
  }

  /**
   * If Polymarket already holds UP/DOWN shares for this market, adopt them locally
   * and suppress more buys. Prevents duplicate FOK/FAK submissions after a fill
   * that the app failed to record.
   */
  private async adoptOnChainPositionIfAny(
    state: LiveWindowState,
    options?: { force?: boolean },
  ): Promise<boolean> {
    if (this.positions.up || this.positions.down) return true;
    if (!isTradingExecutor()) return false;
    const nowMs = Date.now();
    if (!options?.force && nowMs < this.onChainCheckNotBeforeMs) return false;
    // Throttle routine empty checks even when the API is healthy.
    if (!options?.force) {
      this.onChainCheckNotBeforeMs = nowMs + Math.max(5_000, this.onChainBackoffMs);
    }
    try {
      const pair = await fetchCurrentUpDownMarket(state.series);
      const rows = await fetchUserPositions(this.userId, {
        conditionId: pair.conditionId,
        sizeThreshold: 0,
      });
      this.onChainBackoffMs = 0;
      for (const side of SIDES_ORDER) {
        const tokenId = side === "up" ? pair.yesTokenId : pair.noTokenId;
        const match = findPosition(rows, {
          asset: tokenId,
          conditionId: pair.conditionId,
        });
        if (!match) continue;
        const shares = Number(match.size);
        const price = Number(match.avgPrice);
        if (!isValidShareSize(shares) || !isValidSharePrice(price)) continue;
        const cost = Number(match.initialValue ?? shares * price);
        logService.warn(
          "trading",
          `Adopting on-chain ${side.toUpperCase()} position: ${shares} sh @ ${(price * 100).toFixed(1)}¢ — blocking duplicate buys`,
        );
        await this.recordBuyFill(
          state,
          side,
          shares,
          price,
          cost,
          tokenId,
          pair.conditionId,
          match.slug ?? pair.slug,
          "auto",
        );
        const nowSec = Math.floor(Date.now() / 1000);
        const setup = this.resolveAutoSimSetup(state);
        const phaseIdx = setup
          ? phaseIndexForState(state, setup.phaseSplit, nowSec)
          : 0;
        this.blockFurtherBuys(state, "on-chain position detected");
        if (!this.isLiveArmed()) {
          this.autoEngine.adoptExternalBuy(state, side, shares, price, phaseIdx, nowSec);
          this.autoEngine.suppressBuysForWindow();
        }
        this.liveFakWatch = null;
        return true;
      }
    } catch (err) {
      const message = String(err);
      const isRateLimited = /\b429\b/.test(message) || /rate.?limit/i.test(message);
      if (isRateLimited) {
        this.onChainBackoffMs = Math.min(120_000, Math.max(15_000, this.onChainBackoffMs * 2 || 15_000));
        this.onChainCheckNotBeforeMs = Date.now() + this.onChainBackoffMs;
        logService.warn(
          "trading",
          `On-chain position check rate-limited; backing off ${Math.round(this.onChainBackoffMs / 1000)}s`,
        );
      } else {
        logService.warn("trading", `On-chain position check failed: ${message}`);
      }
    }
    return false;
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
        const next = await findActiveScheduleContext(this.userId, this.boundSeries);
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
    // Do not run syncActivatedSchedulePlacements on this 5s cadence — pruning/gap-fill
    // + notify was flipping active-card stats (zeros ↔ dashes) every refresh.
    // Activation sync runs on hydrate, live arming, and settlement instead.
    if (
      this.config.startTrading &&
      this.config.autoTrade &&
      this.config.useSchedule &&
      nextPlacementId
    ) {
      this.rememberActivatedPlacement(nextPlacementId, { quiet: true });
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
    // Defer tickUnlocked until the previous tick fully finishes — do not start it eagerly.
    const queued = this.tickQueue.then(
      () => this.tickUnlocked(state, nowMs),
      () => this.tickUnlocked(state, nowMs),
    );
    this.tickQueue = queued.then(
      () => undefined,
      () => undefined,
    );
    await queued;
  }

  /**
   * Bind this engine to a market series: load that market's trading config + schedule.
   * Cancels resting orders when switching away from a previously armed market.
   */
  async ensureBoundToSeries(seriesInput: string): Promise<void> {
    const series = String(seriesInput || DEFAULT_MARKET_SERIES).trim() || DEFAULT_MARKET_SERIES;
    if (series === this.boundSeries) return;

    if (this.restingBuy) await this.cancelRestingBuy("market switch");
    if (this.restingSell) await this.cancelRestingSell("market switch");
    if (this.overrideRestingBuy) await this.cancelOverrideRestingBuy("market switch");

    this.boundSeries = series;
    this.scheduleContext = null;
    this.activePhaseSetup = null;
    await this.loadPersistedConfig({ hydrateStats: false, series });
    await this.refreshScheduleContext(true);
    this.notify();
  }

  private async tickUnlocked(state: LiveWindowState, nowMs?: number): Promise<void> {
    // Never rebind from a shared display/feed series — each engine stays on its
    // own boundSeries (set via ensureBoundToSeries from that user's API).
    const feedSeries =
      String(state.series || "").trim() || this.boundSeries || DEFAULT_MARKET_SERIES;
    if (feedSeries !== this.boundSeries) return;

    const prevSessionKey = this.sessionKey;
    this.ensureWindow(state);
    const windowRolled = prevSessionKey != null && prevSessionKey !== this.sessionKey;
    await this.refreshScheduleContext(windowRolled);

    if (!this.config.autoTrade) {
      if (this.overrideRestingBuy) await this.cancelOverrideRestingBuy("autoTrade off");
      return;
    }

    const autoSetup = this.resolveAutoSimSetup(state);
    if (!autoSetup) {
      // Still commit the prior window's demo result when leaving a schedule slot.
      if (!this.isLiveArmed()) this.autoEngine.rollWindowIfNeeded(state);
      if (this.overrideRestingBuy) await this.cancelOverrideRestingBuy("no active setup");
      return;
    }

    // Live-armed: do not tick or log via SimulatorEngine — live owns FAK/GTD/abort.
    if (this.isLiveArmed()) {
      await this.sweepPendingBuyCancels(state, nowMs);
      await this.manageBuyOverride(state, nowMs);
      if (this.isOverrideHoldActive(state)) {
        this.liveFakWatch = null;
        if (this.restingBuy) await this.cancelRestingBuy("buy override hold", nowMs, state);
        if (this.restingSell) await this.cancelRestingSell("buy override hold");
        return;
      }
      await this.syncLivePhaseCrossingAbort(state, autoSetup, nowMs);
      await this.manageLiveOptimizeBuys(state, autoSetup, nowMs);
      await this.manageRestingGtdBuys(state, autoSetup, nowMs);
      if (!this.isOverrideHoldActive(state)) {
        await this.manageRestingGtdSells(state, autoSetup, nowMs);
      }
      return;
    }

    // Preview / demo: simulator drives markers and logs.
    this.autoEngine.tick(state, autoSetup, nowMs);
    this.mirroredMarkerCount = this.autoEngine
      .getMarkers()
      .filter((m) => m.windowKey === sessionKey(state)).length;
    if (this.restingBuy && !this.config.startTrading) {
      await this.cancelRestingBuy("startTrading off");
    }
    if (this.restingSell && !this.config.startTrading) {
      await this.cancelRestingSell("startTrading off");
    }
    if (this.overrideRestingBuy) {
      await this.cancelOverrideRestingBuy("startTrading off");
    }
  }

  private liveAskCents(state: LiveWindowState, side: "up" | "down"): number | null {
    const ask = side === "up" ? state.yesAsk : state.noAsk;
    if (ask == null || !Number.isFinite(ask)) return null;
    return priceToCents(ask);
  }

  private isLivePhaseBuyAborted(phaseIdx: number): boolean {
    return this.liveAbortedBuyPhases.has(phaseIdx);
  }

  private isLivePhaseAbortCancellationDue(phaseIdx: number): boolean {
    return this.liveCompletedPhaseAbortCancellations.has(phaseIdx);
  }

  private async syncLivePhaseCrossingAbort(
    state: LiveWindowState,
    setup: SimSetup,
    nowMs?: number,
  ): Promise<void> {
    const now = nowMs ?? state.lastTickMs ?? Date.now();
    const nowSec = Math.floor(now / 1000);
    const phaseIdx = phaseIndexForState(state, setup.phaseSplit, nowSec);
    const phase = setup.phases[phaseIdx] ?? setup.phases[0];
    const crossings = Math.max(0, Math.floor(state.ptbCrossings ?? 0));

    if (this.liveTrackedPhaseIdx !== phaseIdx) {
      const firstObservedPhase = this.liveTrackedPhaseIdx < 0;
      this.liveTrackedPhaseIdx = phaseIdx;
      this.livePhaseCrossingBaseline = firstObservedPhase
        ? crossings
        : this.liveLastPtbCrossings;
      this.liveFakWatch = null;
    }
    this.liveLastPtbCrossings = crossings;

    for (const [idx, executeAtMs] of this.livePendingPhaseAborts) {
      if (now < executeAtMs) continue;
      this.livePendingPhaseAborts.delete(idx);
      this.liveCompletedPhaseAbortCancellations.add(idx);
      if (this.liveFakWatch?.phaseIdx === idx) this.liveFakWatch = null;
      if (this.restingBuy?.phaseIdx === idx) {
        await this.cancelRestingBuy("PTB crossing abort", now, state);
      }
      logService.info("trading", `Phase ${idx + 1} PTB-crossing cancellation executed`);
    }

    const threshold = Math.max(0, Math.min(1000, Math.floor(phase.buyAbortOnCrossing || 0)));
    if (
      threshold <= 0 ||
      this.liveAbortedBuyPhases.has(phaseIdx) ||
      this.livePendingPhaseAborts.has(phaseIdx) ||
      crossings - this.livePhaseCrossingBaseline < threshold
    ) {
      return;
    }

    this.liveAbortedBuyPhases.add(phaseIdx);
    if (this.liveFakWatch?.phaseIdx === phaseIdx) this.liveFakWatch = null;
    logService.info(
      "trading",
      `Phase ${phaseIdx + 1} buys aborted after PTB crossing threshold`,
    );

    const latency = Math.max(0, setup.latencyMs ?? state.feedLatencyMs ?? 0);
    if (latency <= 0) {
      this.liveCompletedPhaseAbortCancellations.add(phaseIdx);
      if (this.restingBuy?.phaseIdx === phaseIdx) {
        await this.cancelRestingBuy("PTB crossing abort", now, state);
      }
      logService.info("trading", `Phase ${phaseIdx + 1} PTB-crossing cancellation executed`);
      return;
    }
    this.livePendingPhaseAborts.set(phaseIdx, now + latency);
    logService.info(
      "trading",
      `Phase ${phaseIdx + 1} buy abort scheduled, latency ${latency} ms`,
    );
  }

  /** Live optimize/FAK buys — same arm/hunt rules as sim, without running SimulatorEngine. */
  private async manageLiveOptimizeBuys(
    state: LiveWindowState,
    setup: SimSetup,
    nowMs?: number,
  ): Promise<void> {
    if (this.orderInFlight || this.positions.up || this.positions.down) {
      this.liveFakWatch = null;
      return;
    }
    if (this.isBuyBlocked(state) || this.manualBuyPending) {
      this.liveFakWatch = null;
      return;
    }
    if (this.restingBuy) {
      this.liveFakWatch = null;
      return;
    }

    const nowSec = Math.floor((nowMs ?? state.lastTickMs ?? Date.now()) / 1000);
    const phaseIdx = phaseIndexForState(state, setup.phaseSplit, nowSec);
    const phase = setup.phases[phaseIdx] ?? setup.phases[0];

    if (this.liveFakWatch && this.liveFakWatch.phaseIdx !== phaseIdx) {
      this.liveFakWatch = null;
    }

    if (
      !phase.buyOptimize ||
      !phase.buyEnabled ||
      this.isLivePhaseBuyAborted(phaseIdx)
    ) {
      this.liveFakWatch = null;
      return;
    }

    if (!this.liveFakWatch) {
      const shares = Math.max(1, phase.buyShares || 1);
      const triggerCents = phase.buyTrigger;
      for (const side of SIDES_ORDER) {
        const askCents = this.liveAskCents(state, side);
        if (askCents == null || askCents !== triggerCents) continue;
        if (!gapAllowsBuy(side, phase, state.assetGap)) continue;
        if (!stabilizeAllowsBuyForSide(phase, state, side)) continue;
        this.liveFakWatch = {
          side,
          phaseIdx,
          shares,
          triggerCents,
          armed: true,
          stallCents: null,
          stallTicks: 0,
          prevAskCents: askCents,
          lastBookSampleCount: state.bookTickSequence ?? 0,
        };
        logService.info(
          "trading",
          `FAK optimize armed: ${side} touched ${triggerCents}¢`,
        );
        return;
      }
      return;
    }

    const w = this.liveFakWatch;
    const askCents = this.liveAskCents(state, w.side);
    if (askCents == null) return;

    const bookSampleCount = state.bookTickSequence ?? 0;
    if (bookSampleCount <= w.lastBookSampleCount) return;
    w.lastBookSampleCount = bookSampleCount;

    if (askCents > w.triggerCents) {
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
      if (!stabilizeAllowsBuyForSide(phase, state, w.side)) {
        w.prevAskCents = askCents;
        return;
      }
      w.armed = true;
      w.stallCents = null;
      w.stallTicks = 0;
      w.prevAskCents = askCents;
      logService.info("trading", `FAK optimize re-armed: ${w.side} @ ${w.triggerCents}¢`);
      return;
    }

    if (!stabilizeAllowsBuyForSide(phase, state, w.side)) return;

    let shouldFire = false;
    if (askCents <= w.triggerCents) {
      if (w.prevAskCents != null && askCents > w.prevAskCents) {
        shouldFire = true;
      } else if (w.stallCents === askCents) {
        w.stallTicks += 1;
        if (w.stallTicks >= 3) shouldFire = true;
      } else {
        w.stallCents = askCents;
        w.stallTicks = 1;
      }
    }
    w.prevAskCents = askCents;
    if (!shouldFire) return;

    if (await this.adoptOnChainPositionIfAny(state, { force: true })) {
      this.liveFakWatch = null;
      return;
    }

    logService.info(
      "trading",
      `FAK buy firing: ${w.side} up to ${w.shares} sh @ ≤${w.triggerCents}¢`,
    );
    const result = await this.executeOrder(
      state,
      w.side,
      "buy",
      w.shares,
      "auto",
      "shares",
      "FAK",
      centsToPrice(w.triggerCents),
      phaseIdx,
    );
    // Keep the watch only for clearly-unfilled retries; block/adopt clears via isBuyBlocked.
    if (result.ok || this.isBuyBlocked(state) || this.positions.up || this.positions.down) {
      this.liveFakWatch = null;
    }
  }

  private async cancelRestingBuy(
    reason: string,
    nowMs?: number,
    state?: LiveWindowState,
  ): Promise<void> {
    const resting = this.restingBuy;
    if (!resting) return;
    // Drop local tracking immediately so we never re-manage / leave it as "active"
    // in the next phase — but keep working the CLOB cancel until confirmed.
    this.restingBuy = null;
    if (isRoutineGtdCancelReason(reason)) {
      this.gtdBuyRepressUntilMs = (nowMs ?? Date.now()) + GTD_FILTER_REPRESS_MS;
    }
    logService.info(
      "trading",
      `Cancel resting GTD (${reason}) ${resting.side.toUpperCase()} ${resting.shares} sh @ ${(resting.limitPrice * 100).toFixed(0)}¢ phase ${((resting.phaseIdx ?? 0) + 1)}`,
    );
    if (!this.positions.up && !this.positions.down) {
      this.autoEngine.setExternalBuyPaused(false);
    }
    if (!isTradingExecutor()) return;
    await this.finishBuyCancel(resting, reason, state, "phase", nowMs);
  }

  private async cancelRestingSell(reason: string): Promise<void> {
    const resting = this.restingSell;
    if (!resting) return;
    this.restingSell = null;
    // Resting sell placement must not look like a fill — clear any stale sell latch.
    this.unlockQuote(resting.side, "sell");
    logService.info("trading", `Cancel resting GTD sell (${reason})`);
    if (!isTradingExecutor()) return;
    await cancelOpenOrder(this.userId, resting.orderId);
  }

  private async cancelOverrideRestingBuy(
    reason: string,
    state?: LiveWindowState,
  ): Promise<void> {
    const resting = this.overrideRestingBuy;
    if (!resting) return;
    this.overrideRestingBuy = null;
    logService.info(
      "trading",
      `Cancel buy override GTD (${reason}) ${resting.side.toUpperCase()} ${resting.shares} sh @ ${(resting.limitPrice * 100).toFixed(0)}¢`,
    );
    if (!isTradingExecutor()) return;
    await this.finishBuyCancel(resting, reason, state, "override");
  }

  /**
   * Cancel on the CLOB, then re-check for a race fill. If the order is still live,
   * queue retries so a phase-1 5¢ GTD cannot silently fill in phase 2.
   */
  private async finishBuyCancel(
    resting: PendingBuyCancel["resting"],
    reason: string,
    state: LiveWindowState | undefined,
    kind: "phase" | "override",
    nowMs?: number,
  ): Promise<void> {
    const now = nowMs ?? Date.now();
    if (state && (await this.harvestBuyCancelFill(resting, state, kind))) {
      return;
    }

    // Reason already logged by cancelRestingBuy / cancelOverrideRestingBuy.
    const result = await cancelOpenOrder(this.userId, resting.orderId, { quiet: true });

    if (state && (await this.harvestBuyCancelFill(resting, state, kind))) {
      return;
    }

    const snap = await fetchOpenOrder(this.userId, resting.orderId);
    const status = snap?.status?.toLowerCase() ?? "";
    const stillOpen = status === "live" || status === "delayed";
    if (!result.ok || stillOpen) {
      this.enqueueBuyCancel(resting, reason, kind, now + 400);
      if (!result.ok) {
        logService.warn(
          "trading",
          `GTD buy cancel queued for retry (${kind}, ${reason}): ${result.error ?? "still open"}`,
        );
      }
    }
  }

  private enqueueBuyCancel(
    resting: PendingBuyCancel["resting"],
    reason: string,
    kind: "phase" | "override",
    nextAttemptMs: number,
    attempts = 1,
  ): void {
    if (this.pendingBuyCancels.some((p) => p.resting.orderId === resting.orderId)) return;
    this.pendingBuyCancels.push({
      resting: { ...resting },
      reason,
      attempts,
      nextAttemptMs,
      kind,
    });
  }

  /** If the order filled (fully or partially) while cancelling, record it. */
  private async harvestBuyCancelFill(
    resting: PendingBuyCancel["resting"],
    state: LiveWindowState,
    kind: "phase" | "override",
  ): Promise<boolean> {
    const snap = await fetchOpenOrder(this.userId, resting.orderId);
    if (!snap) return false;

    const matched = Math.max(0, snap.sizeMatched);
    if (matched > resting.sizeMatched + 1e-9) {
      const delta = matched - resting.sizeMatched;
      const fillPrice = snap.price > 0 ? snap.price : resting.limitPrice;
      resting.sizeMatched = matched;
      resting.tokenId = resting.tokenId ?? snap.assetId;
      resting.conditionId = resting.conditionId ?? snap.market;

      if (kind === "override") {
        const overrideResting: OverrideRestingBuy = {
          orderId: resting.orderId,
          side: resting.side,
          sessionKey: resting.sessionKey,
          shares: resting.shares,
          limitPrice: resting.limitPrice,
          sizeMatched: matched,
          tokenId: resting.tokenId,
          conditionId: resting.conditionId,
          slug: resting.slug,
          cardId: resting.cardId,
        };
        await this.onBuyOverrideFill(
          state,
          overrideResting,
          delta,
          fillPrice,
          resting.tokenId,
          resting.conditionId,
        );
        return true;
      }

      logService.warn(
        "trading",
        `GTD buy filled during cancel (${resting.side} ${delta} sh @ ~${(fillPrice * 100).toFixed(1)}¢) — recording race fill`,
      );
      await this.recordBuyFill(
        state,
        resting.side,
        delta,
        fillPrice,
        delta * fillPrice,
        resting.tokenId,
        resting.conditionId,
        resting.slug,
        "auto",
        resting.cardId,
        resting.phaseIdx,
        { placementId: resting.placementId },
      );
      // Fully matched → nothing left to cancel.
      const status = snap.status.toLowerCase();
      if (status !== "live" && status !== "delayed") return true;
      if (matched + 1e-9 >= resting.shares) return true;
    }

    const status = snap.status.toLowerCase();
    return status !== "live" && status !== "delayed";
  }

  private async sweepPendingBuyCancels(
    state: LiveWindowState,
    nowMs?: number,
  ): Promise<void> {
    if (!isTradingExecutor() || this.pendingBuyCancels.length === 0) return;
    const now = nowMs ?? Date.now();
    const due = this.pendingBuyCancels.filter((p) => now >= p.nextAttemptMs);
    if (due.length === 0) return;

    const remaining: PendingBuyCancel[] = this.pendingBuyCancels.filter(
      (p) => now < p.nextAttemptMs,
    );
    this.pendingBuyCancels = remaining;

    for (const item of due) {
      if (await this.harvestBuyCancelFill(item.resting, state, item.kind)) {
        continue;
      }
      if (item.attempts >= 8) {
        logService.warn(
          "trading",
          `Giving up GTD buy cancel after ${item.attempts} tries (${item.kind} ${item.resting.orderId.slice(0, 10)}…)`,
        );
        // Last-ditch cancel; fill may still be adopted via on-chain check.
        void cancelOpenOrder(this.userId, item.resting.orderId, { quiet: true });
        if (!this.positions.up && !this.positions.down) {
          const adopted = await this.adoptOnChainPositionIfAny(state, { force: true });
          if (!adopted) {
            this.blockFurtherBuys(state, "GTD cancel abandoned — possible orphan fill");
          }
        }
        continue;
      }
      const result = await cancelOpenOrder(this.userId, item.resting.orderId, { quiet: true });
      if (await this.harvestBuyCancelFill(item.resting, state, item.kind)) {
        continue;
      }
      const snap = await fetchOpenOrder(this.userId, item.resting.orderId);
      const status = snap?.status?.toLowerCase() ?? "";
      if (status === "live" || status === "delayed" || !result.ok) {
        if (item.attempts === 1 || item.attempts % 3 === 0) {
          logService.warn(
            "trading",
            `GTD buy cancel retry ${item.attempts} (${item.kind} ${item.resting.orderId.slice(0, 10)}… still ${status || "unknown"})`,
          );
        }
        this.enqueueBuyCancel(
          item.resting,
          item.reason,
          item.kind,
          now + Math.min(5_000, 400 * item.attempts),
          item.attempts + 1,
        );
      }
    }
  }

  private isBuyOverrideConfigActive(): boolean {
    return (
      this.config.buyOverrideEnabled &&
      this.config.buyOverridePriceCents >= 1 &&
      this.config.buyOverridePriceCents <= 99 &&
      this.config.buyOverrideShares >= 1
    );
  }

  private isOverrideHoldActive(state: LiveWindowState): boolean {
    return this.overrideHoldWindowKey === sessionKey(state);
  }

  private resolveBuyOverrideSide(state: LiveWindowState): "up" | "down" | null {
    const gap = state.assetGap;
    if (gap == null || !Number.isFinite(gap)) return null;
    const withPtb = this.config.buyOverrideDirection !== "opposite";
    for (const side of SIDES_ORDER) {
      const wantAbovePtb = side === "up" ? withPtb : !withPtb;
      if (wantAbovePtb ? gap >= 0 : gap <= 0) return side;
    }
    return null;
  }

  private async onBuyOverrideFill(
    state: LiveWindowState,
    resting: OverrideRestingBuy,
    fillShares: number,
    fillPrice: number,
    tokenId: string | undefined,
    conditionId: string | undefined,
  ): Promise<void> {
    logService.info(
      "trading",
      `Buy override filled ${fillShares} ${resting.side.toUpperCase()} @ ${(fillPrice * 100).toFixed(1)}¢ — holding to settlement`,
    );
    this.overrideHoldWindowKey = sessionKey(state);
    this.overrideRestingBuy = null;
    this.liveFakWatch = null;
    if (!this.isLiveArmed()) {
      this.autoEngine.suppressBuysForWindow();
      this.autoEngine.suppressSellsForWindow();
    }
    this.blockFurtherBuys(state, "buy override fill");
    if (isTradingExecutor()) {
      await cancelOpenOrder(this.userId, resting.orderId);
    }
    await this.cancelRestingBuy("buy override fill");
    await this.cancelRestingSell("buy override fill");
    await this.recordBuyFill(
      state,
      resting.side,
      fillShares,
      fillPrice,
      fillShares * fillPrice,
      tokenId ?? resting.tokenId,
      conditionId ?? resting.conditionId,
      resting.slug,
      "auto",
      resting.cardId,
      undefined,
      { holdToSettlement: true },
    );
  }

  private async pollOverrideRestingBuy(state: LiveWindowState): Promise<void> {
    const resting = this.overrideRestingBuy;
    if (!resting) return;

    const snap = await fetchOpenOrder(this.userId, resting.orderId);
    if (!snap) return;

    const matched = Math.max(0, snap.sizeMatched);
    if (matched > resting.sizeMatched + 1e-9) {
      const delta = matched - resting.sizeMatched;
      const fillPrice = snap.price > 0 ? snap.price : resting.limitPrice;
      await this.onBuyOverrideFill(
        state,
        resting,
        delta,
        fillPrice,
        resting.tokenId ?? snap.assetId,
        resting.conditionId ?? snap.market,
      );
      return;
    }

    const status = snap.status.toLowerCase();
    if (status === "live" || status === "delayed") return;

    this.overrideRestingBuy = null;
    this.notify();
  }

  private async manageBuyOverride(state: LiveWindowState, nowMs?: number): Promise<void> {
    if (this.orderInFlight) return;

    if (!this.isBuyOverrideConfigActive()) {
      if (this.overrideRestingBuy) await this.cancelOverrideRestingBuy("override inactive", state);
      return;
    }

    if (this.isOverrideHoldActive(state)) return;

    if (
      this.positions.up ||
      this.positions.down ||
      this.isBuyBlocked(state) ||
      this.manualBuyPending
    ) {
      if (this.overrideRestingBuy) await this.cancelOverrideRestingBuy("position exists", state);
      return;
    }

    const key = sessionKey(state);
    const side = this.resolveBuyOverrideSide(state);
    const limitPrice = centsToPrice(this.config.buyOverridePriceCents);
    const shares = Math.max(1, Math.floor(this.config.buyOverrideShares));
    const nowSec = Math.floor((nowMs ?? state.lastTickMs ?? Date.now()) / 1000);

    if (this.overrideRestingBuy) {
      const resting = this.overrideRestingBuy;
      const stale =
        !side ||
        resting.sessionKey !== key ||
        resting.side !== side ||
        Math.abs(resting.limitPrice - limitPrice) > 1e-9 ||
        resting.shares !== shares;
      if (stale) {
        await this.cancelOverrideRestingBuy(
          !side
            ? "no PTB side"
            : resting.side !== side
              ? "PTB side change"
              : resting.sessionKey !== key
                ? "window roll"
                : "override params change",
          state,
        );
      } else {
        await this.pollOverrideRestingBuy(state);
        if (this.overrideRestingBuy || this.isOverrideHoldActive(state)) return;
      }
    }

    if (this.positions.up || this.positions.down || this.isBuyBlocked(state)) return;
    if (!side) return;
    if (this.overrideRestingBuy) return;
    if (this.overrideGtdBlockedWindowKey === key) return;
    if (this.pendingBuyCancels.some((p) => p.kind === "override")) return;
    const windowEnd = state.windowEnd ?? nowSec + 300;

    this.orderInFlight = true;
    try {
      const result = await placeLimitGtdBuy(this.userId, {
        series: state.series,
        side,
        size: shares,
        price: limitPrice,
        expirationSec: gtdExpirationUnix(windowEnd, nowSec),
        state,
        logTag: "override",
      });
      if (!result.success || !result.orderId) {
        const err = result.error ?? "";
        if (/expiration/i.test(err)) {
          this.overrideGtdBlockedWindowKey = key;
          logService.warn("trading", `Buy override GTD skipped for rest of window (${err})`);
        } else if (err) {
          logService.warn("trading", `Buy override GTD place failed: ${err}`);
        }
        return;
      }

      if (result.fillShares != null && result.fillPrice != null && result.fillShares > 0) {
        const resting: OverrideRestingBuy = {
          orderId: result.orderId,
          side,
          sessionKey: key,
          shares,
          limitPrice,
          sizeMatched: 0,
          tokenId: result.tokenId,
          conditionId: result.conditionId,
          slug: result.slug,
        };
        await this.onBuyOverrideFill(
          state,
          resting,
          result.fillShares,
          result.fillPrice,
          result.tokenId,
          result.conditionId,
        );
        return;
      }

      this.overrideRestingBuy = {
        orderId: result.orderId,
        side,
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

  private async manageRestingGtdBuys(
    state: LiveWindowState,
    setup: SimSetup,
    nowMs?: number,
  ): Promise<void> {
    if (this.manualBuyPending || this.manualBuyOverrideWindowKey === sessionKey(state)) return;
    if (this.buyBlockedWindowKey === sessionKey(state)) {
      if (this.restingBuy) await this.cancelRestingBuy("buy blocked", nowMs, state);
      return;
    }

    const now = nowMs ?? state.lastTickMs ?? Date.now();
    const nowSec = Math.floor(now / 1000);
    const phaseIdx = phaseIndexForState(state, setup.phaseSplit, nowSec);
    const phase = setup.phases[phaseIdx] ?? setup.phases[0];
    const key = sessionKey(state);
    const crossingAborted = this.isLivePhaseBuyAborted(phaseIdx);

    // Phase boundary must not inherit gap/stabilize repress from the prior phase.
    if (this.lastGtdBuyPhaseIdx !== phaseIdx) {
      this.lastGtdBuyPhaseIdx = phaseIdx;
      this.gtdBuyRepressUntilMs = 0;
    }

    // Always cancel stale resting buys even while another order is in flight —
    // skipping this left phase-1 limits live into phase 2/3.
    if (this.restingBuy) {
      const r = this.restingBuy;
      const restingStabilizeOk = stabilizeAllowsBuyForSide(phase, state, r.side);
      const restingGapOk = gapAllowsBuy(r.side, phase, state.assetGap);
      if (
        r.sessionKey !== key ||
        r.phaseIdx !== phaseIdx ||
        phase.buyOptimize ||
        !phase.buyEnabled ||
        !restingGapOk ||
        !restingStabilizeOk
      ) {
        await this.cancelRestingBuy(
          r.phaseIdx !== phaseIdx
            ? "phase change"
            : phase.buyOptimize
              ? "optimize on"
              : !phase.buyEnabled
                ? "buy disabled"
                : !restingGapOk
                  ? "gap filter"
                  : "stabilize filter",
          now,
          state,
        );
      }
    }

    // Poll open resting order for fills.
    if (this.restingBuy) {
      await this.pollRestingBuy(state, setup, nowMs);
      if (this.restingBuy) return; // still open — don't place another
    }

    if (this.orderInFlight) return;
    if (crossingAborted) return;

    if (await this.adoptOnChainPositionIfAny(state, { force: true })) return;

    // Place GTD when optimize is off and phase allows buys.
    if (phase.buyOptimize || !phase.buyEnabled) return;
    if (this.positions.up || this.positions.down) return;
    if (this.isBuyBlocked(state)) return;
    if (this.restingBuy) return;
    if (this.gtdBuyBlockedWindowKey === key) return;
    if (now < this.gtdBuyRepressUntilMs) return;

    let chosenSide: "up" | "down" | null = null;
    for (const side of SIDES_ORDER) {
      if (gapAllowsBuy(side, phase, state.assetGap)) {
        chosenSide = side;
        break;
      }
    }
    if (!chosenSide) return;
    if (!stabilizeAllowsBuyForSide(phase, state, chosenSide)) return;

    const windowEnd = state.windowEnd ?? nowSec + 300;
    const limitPrice = centsToPrice(phase.buyTrigger);
    const shares = Math.max(1, phase.buyShares || 1);

    this.orderInFlight = true;
    try {
      this.autoEngine.setExternalBuyPaused(true);
      const result = await placeLimitGtdBuy(this.userId, {
        series: state.series,
        side: chosenSide,
        size: shares,
        price: limitPrice,
        expirationSec: gtdExpirationUnix(windowEnd, nowSec),
        state,
        logTag: `phase ${phaseIdx + 1}`,
      });
      if (!result.success || !result.orderId) {
        this.autoEngine.setExternalBuyPaused(false);
        const err = result.error ?? "";
        if (/expiration/i.test(err)) {
          this.gtdBuyBlockedWindowKey = key;
          logService.warn("trading", `GTD buy skipped for rest of window (${err})`);
        } else if (err) {
          logService.warn("trading", `GTD place failed: ${err}`);
        }
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
          undefined,
          phaseIdx,
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
        placementId: this.scheduleContext?.placementId,
      };
      this.notify();
    } finally {
      this.orderInFlight = false;
    }
  }

  private async pollRestingBuy(
    state: LiveWindowState,
    setup: SimSetup,
    nowMs?: number,
  ): Promise<void> {
    const resting = this.restingBuy;
    if (!resting) return;

    const nowSec = Math.floor((nowMs ?? state.lastTickMs ?? Date.now()) / 1000);
    const phaseIdx = phaseIndexForState(state, setup.phaseSplit, nowSec);
    const phase = setup.phases[phaseIdx] ?? setup.phases[0];
    const crossingCancellationDue = this.isLivePhaseAbortCancellationDue(phaseIdx);
    if (!crossingCancellationDue && !gapAllowsBuy(resting.side, phase, state.assetGap)) {
      await this.cancelRestingBuy("gap filter", nowMs ?? nowSec * 1000, state);
      return;
    }
    if (!crossingCancellationDue && !stabilizeAllowsBuyForSide(phase, state, resting.side)) {
      await this.cancelRestingBuy("stabilize filter", nowMs ?? nowSec * 1000, state);
      return;
    }

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
        resting.phaseIdx,
        { placementId: resting.placementId },
      );
      const pos = this.positions[resting.side];
      resting.cardId = pos?.cardId ?? resting.cardId;
      resting.sizeMatched = matched;
      resting.tokenId = resting.tokenId ?? snap.assetId;
      resting.conditionId = resting.conditionId ?? snap.market;
    }

    const status = snap.status.toLowerCase();
    if (crossingCancellationDue) {
      if (matched > 0) {
        logService.warn(
          "trading",
          `PTB crossing abort lost race to ${matched} GTD fill shares; cancelling remainder`,
        );
      }
      if (status === "live" || status === "delayed") {
        await this.cancelRestingBuy("PTB crossing abort", nowMs, state);
      } else {
        this.restingBuy = null;
        this.notify();
      }
      return;
    }

    // Still working — leave resting open.
    if (status === "live" || status === "delayed") return;

    // Matched, cancelled, expired, unmatched, etc.
    this.restingBuy = null;
    if (!this.positions.up && !this.positions.down) {
      this.autoEngine.setExternalBuyPaused(false);
    }
    this.notify();
  }

  private async manageRestingGtdSells(
    state: LiveWindowState,
    setup: SimSetup,
    nowMs?: number,
  ): Promise<void> {
    if (this.isOverrideHoldActive(state)) {
      if (this.restingSell) await this.cancelRestingSell("buy override hold");
      return;
    }
    const side = this.positions.up ? "up" : this.positions.down ? "down" : null;
    if (!side) {
      if (this.restingSell) await this.cancelRestingSell("no position");
      return;
    }
    const nowSec = Math.floor((nowMs ?? state.lastTickMs ?? Date.now()) / 1000);
    // Sell follows the clock phase, not the phase that bought.
    const phaseIdx = phaseIndexForState(state, setup.phaseSplit, nowSec);
    const phase = setup.phases[phaseIdx] ?? setup.phases[0];
    if (!sellEnabledForPhase(phase)) {
      if (this.restingSell) await this.cancelRestingSell("sell disabled");
      return;
    }
    if (this.restingSell) {
      const wantLimit = Math.min(
        0.99,
        Math.max(0.01, this.positions[side]!.avgPrice + centsToPrice(phase.sellProfitCents)),
      );
      const stalePhase =
        this.restingSell.phaseIdx !== phaseIdx ||
        Math.abs(this.restingSell.limitPrice - wantLimit) > 1e-9;
      if (stalePhase) {
        await this.cancelRestingSell("phase sell settings change");
      } else {
        if (this.orderInFlight) return;
        await this.pollRestingSell(state);
        if (this.restingSell) return;
      }
    }
    if (this.orderInFlight) return;
    if (!this.positions[side]) return;
    await this.ensureRestingGtdSell(state, setup, side, nowMs);
  }

  private async ensureRestingGtdSell(
    state: LiveWindowState,
    setup: SimSetup,
    side: "up" | "down",
    nowMs?: number,
  ): Promise<void> {
    if (!this.isLiveArmed()) return;
    if (this.isOverrideHoldActive(state)) return;
    const pos = this.positions[side];
    if (!pos || pos.shares <= 0) return;

    const nowSec = Math.floor((nowMs ?? state.lastTickMs ?? Date.now()) / 1000);
    const phaseIdx = phaseIndexForState(state, setup.phaseSplit, nowSec);
    const phase = setup.phases[phaseIdx] ?? setup.phases[0];
    if (!sellEnabledForPhase(phase)) return;
    const limitPrice = Math.min(0.99, Math.max(0.01, pos.avgPrice + centsToPrice(phase.sellProfitCents)));
    const shares = Math.max(1, Math.floor(pos.shares));
    const key = sessionKey(state);
    if (this.gtdSellBlockedWindowKey === key) return;
    const now = nowMs ?? Date.now();
    if (now < this.gtdSellRepressUntilMs) return;

    if (
      this.restingSell &&
      this.restingSell.side === side &&
      this.restingSell.sessionKey === key &&
      this.restingSell.phaseIdx === phaseIdx &&
      Math.abs(this.restingSell.limitPrice - limitPrice) < 1e-9 &&
      this.restingSell.shares === shares
    ) {
      return;
    }

    if (this.restingSell) {
      await this.cancelRestingSell("resize sell");
    }

    const windowEnd = state.windowEnd ?? nowSec + 300;

    const wasInFlight = this.orderInFlight;
    this.orderInFlight = true;
    try {
      const result = await placeLimitGtdSell(this.userId, {
        series: state.series,
        side,
        size: shares,
        price: limitPrice,
        expirationSec: gtdExpirationUnix(windowEnd, nowSec),
        state,
      });
      if (!result.success || !result.orderId) {
        const err = result.error ?? "";
        if (/expiration/i.test(err)) {
          this.gtdSellBlockedWindowKey = key;
          logService.warn(
            "trading",
            `GTD sell skipped for rest of window (${err})`,
          );
        } else if (isBalanceAllowanceError(err)) {
          // Tokens often lag the buy fill; backoff instead of spamming every tick.
          // order-service already logged the CLOB error — don't duplicate here.
          this.gtdSellRepressUntilMs = now + GTD_SELL_BALANCE_REPRESS_MS;
        } else if (err) {
          logService.warn("trading", `GTD sell place failed: ${err}`);
        }
        return;
      }

      this.gtdSellRepressUntilMs = 0;

      if (result.fillShares != null && result.fillPrice != null && result.fillShares > 0) {
        await this.recordSellFill(
          state,
          side,
          result.fillShares,
          result.fillPrice,
          result.usdcAmount,
          result.tokenId,
          result.conditionId,
          result.slug,
        );
        return;
      }

      this.restingSell = {
        orderId: result.orderId,
        side,
        sessionKey: key,
        shares,
        limitPrice,
        sizeMatched: 0,
        phaseIdx,
        tokenId: result.tokenId ?? pos.asset,
        conditionId: result.conditionId ?? pos.conditionId,
        cardId: pos.cardId,
      };
      // Do not latch the sell quote here — only real fills should highlight it.
      this.notify();
    } finally {
      this.orderInFlight = wasInFlight;
    }
  }

  private async pollRestingSell(state: LiveWindowState): Promise<void> {
    const resting = this.restingSell;
    if (!resting) return;

    const snap = await fetchOpenOrder(this.userId, resting.orderId);
    if (!snap) return;

    const matched = Math.max(0, snap.sizeMatched);
    if (matched > resting.sizeMatched + 1e-9) {
      const delta = matched - resting.sizeMatched;
      const fillPrice = snap.price > 0 ? snap.price : resting.limitPrice;
      await this.recordSellFill(
        state,
        resting.side,
        delta,
        fillPrice,
        delta * fillPrice,
        resting.tokenId ?? snap.assetId,
        resting.conditionId ?? snap.market,
        resting.slug,
      );
      resting.sizeMatched = matched;
    }

    const status = snap.status.toLowerCase();
    if (status === "live" || status === "delayed") return;

    this.restingSell = null;
    this.notify();
  }

  private async recordSellFill(
    state: LiveWindowState,
    side: "up" | "down",
    fillShares: number,
    fillPrice: number,
    usdcAmount: number | undefined,
    tokenId: string | undefined,
    conditionId: string | undefined,
    slug: string | undefined,
  ): Promise<void> {
    const pos = this.positions[side];
    if (!pos) return;

    const nowSec = Math.floor(Date.now() / 1000);
    const proceeds = usdcAmount ?? fillShares * fillPrice;
    const sellFees = await estimateLiveTakerFee(
      this.userId,
      tokenId ?? pos.asset,
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
      card.asset = card.asset ?? tokenId ?? pos.asset;
      card.conditionId = card.conditionId ?? conditionId ?? pos.conditionId;
      card.slug = card.slug ?? slug;
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
    if (!this.isLiveArmed()) this.autoEngine.clearExternalPosition(side);
    this.restingSell = null;
    void refreshCollateralBalance(this.userId);
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
    buyPhaseIdx?: number,
    opts?: { holdToSettlement?: boolean; placementId?: string },
  ): Promise<void> {
    const holdToSettlement = Boolean(opts?.holdToSettlement);
    const resolvedPlacementId =
      source === "auto" && this.config.useSchedule
        ? opts?.placementId ?? this.scheduleContext?.placementId
        : undefined;
    const nowSec = Math.floor(Date.now() / 1000);
    const cost = usdcAmount ?? fillShares * fillPrice;
    const buyFees = await estimateLiveTakerFee(this.userId, tokenId, fillShares, fillPrice);
    const windowKey = sessionKey(state);
    const setup = this.resolveAutoSimSetup(state);
    const phaseIdx =
      buyPhaseIdx ??
      (setup ? phaseIndexForState(state, setup.phaseSplit, nowSec) : 0);

    const existing =
      (existingCardId ? this.findCard(existingCardId) : undefined) ??
      this.positionCards.find(
        (card) => card.status === "open" && card.windowKey === windowKey && card.side === side,
      );

    if (existing && existing.status === "open") {
      if (!existing.placementId && resolvedPlacementId) {
        existing.placementId = resolvedPlacementId;
      }
      if (!this.positions[side]) {
        this.positions[side] = {
          shares: existing.shares,
          avgPrice: existing.buyPrice,
          cost: existing.buyCost,
          buyFees: existing.buyFees ?? 0,
          cardId: existing.id,
          asset: existing.asset,
          conditionId: existing.conditionId,
          buyPhaseIdx: phaseIdx,
        };
      }
      const livePos = this.positions[side]!;
      const totalShares = livePos.shares + fillShares;
      const totalCost = livePos.cost + cost;
      const totalFees = (livePos.buyFees ?? 0) + buyFees;
      livePos.shares = totalShares;
      livePos.avgPrice = totalShares > 0 ? totalCost / totalShares : fillPrice;
      livePos.cost = totalCost;
      livePos.buyFees = totalFees;
      livePos.asset = livePos.asset ?? tokenId;
      livePos.conditionId = livePos.conditionId ?? conditionId;
      livePos.buyPhaseIdx = livePos.buyPhaseIdx ?? phaseIdx;
      existing.shares = totalShares;
      existing.buyPrice = livePos.avgPrice;
      existing.buyCost = totalCost;
      existing.buyFees = totalFees;
      existing.asset = existing.asset ?? tokenId;
      existing.conditionId = existing.conditionId ?? conditionId;
      existing.slug = existing.slug ?? slug;
    } else {
      // Hard stop: never open a second card for the same window/side/market.
      const dup = this.positionCards.find(
        (card) =>
          card.windowKey === windowKey &&
          card.side === side &&
          ((tokenId && card.asset === tokenId) ||
            (conditionId && card.conditionId === conditionId)),
      );
      if (dup) {
        logService.warn(
          "trading",
          `Skipped duplicate buy card for ${windowKey} ${side} (existing ${dup.id})`,
        );
        return;
      }

      const cardId = newCardId();
      this.positions[side] = {
        shares: fillShares,
        avgPrice: fillPrice,
        cost,
        buyFees,
        cardId,
        asset: tokenId,
        conditionId,
        buyPhaseIdx: phaseIdx,
      };
      this.lockQuote(side, "buy", fillPrice);
      this.positionCards.unshift({
        id: cardId,
        windowKey,
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
        placementId: resolvedPlacementId,
      });
      if (resolvedPlacementId) {
        this.rememberActivatedPlacement(resolvedPlacementId);
      }
      if (this.positionCards.length > MAX_POSITION_CARDS) {
        this.positionCards.length = MAX_POSITION_CARDS;
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

    const pos = this.positions[side];
    if (pos) {
      // Keep sim in sync only while previewing — live must not drive SimulatorEngine.
      if (!this.isLiveArmed()) {
        this.autoEngine.adoptExternalBuy(state, side, pos.shares, pos.avgPrice, phaseIdx, nowSec);
        if (holdToSettlement) {
          this.autoEngine.suppressBuysForWindow();
          this.autoEngine.suppressSellsForWindow();
        } else {
          this.autoEngine.setExternalBuyPaused(false);
        }
      }
      if (holdToSettlement) {
        this.liveFakWatch = null;
      } else {
        // Phase/manual fill won the window — cancel any competing override rest.
        if (this.overrideRestingBuy) {
          await this.cancelOverrideRestingBuy("phase/manual fill first");
        }
        if (source === "auto" && this.isLiveArmed() && setup && !this.isOverrideHoldActive(state)) {
          await this.ensureRestingGtdSell(state, setup, side);
        }
      }
    }

    void refreshCollateralBalance(this.userId);
    this.notify();
  }

  canManualTrade(side: "up" | "down", leg: "buy" | "sell"): boolean {
    if (leg === "buy") return !this.positions.up && !this.positions.down;
    return Boolean(this.positions[side]);
  }

  async manualOrder(
    state: LiveWindowState,
    side: "up" | "down",
    leg: "buy" | "sell",
  ): Promise<{ ok: boolean; error?: string; fillShares?: number; fillPrice?: number }> {
    this.ensureWindow(state);
    if (!this.canExecuteOrders()) {
      return { ok: false, error: "Allow trade to place orders" };
    }
    if (leg === "buy") {
      if (await this.adoptOnChainPositionIfAny(state)) {
        return { ok: false, error: "Already holding position" };
      }
      if (this.isBuyBlocked(state)) {
        return { ok: false, error: "Buy blocked until window rolls (prior order unresolved)" };
      }
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
    if (leg === "buy") {
      this.manualBuyPending = true;
      this.liveFakWatch = null;
      if (!this.isLiveArmed()) this.autoEngine.setExternalBuyPaused(true);
      await this.cancelRestingBuy("manual buy override");
      await this.cancelOverrideRestingBuy("manual buy override");
    } else {
      await this.cancelRestingSell("manual sell override");
    }

    try {
      const result = await this.executeOrder(state, side, leg, size, "manual", sizeUnit);
      if (result.ok) {
        if (leg === "buy") {
          if (!this.isLiveArmed()) {
            const nowSec = Math.floor(Date.now() / 1000);
            const setup = this.resolveAutoSimSetup(state);
            const phaseIdx = setup
              ? phaseIndexForState(state, setup.phaseSplit, nowSec)
              : 0;
            if (result.fillShares != null && result.fillPrice != null) {
              this.autoEngine.adoptExternalBuy(
                state,
                side,
                result.fillShares,
                result.fillPrice,
                phaseIdx,
                nowSec,
              );
            }
            this.autoEngine.suppressBuysForWindow();
          }
          this.manualBuyOverrideWindowKey = sessionKey(state);
        } else if (!this.isLiveArmed()) {
          this.autoEngine.clearExternalPosition(side);
        }
        return result;
      }
      logService.error(
        "trading",
        `${leg.toUpperCase()} ${side.toUpperCase()} failed (single attempt)`,
      );
      return result;
    } finally {
      if (leg === "buy") {
        this.manualBuyPending = false;
        if (
          !this.isLiveArmed() &&
          this.manualBuyOverrideWindowKey !== sessionKey(state)
        ) {
          this.autoEngine.setExternalBuyPaused(false);
        }
      }
    }
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
    const currentKey = this.sessionKey;
    return this.positionCards.some((card) => {
      if (this.isCorruptConfirmedCard(card)) return true;
      if (!card.confirmed) return true;
      // Prior-window holds need Polymarket settlement even if the buy was confirmed.
      if (card.status === "open" && currentKey && card.windowKey !== currentKey) return true;
      return false;
    });
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
    const currentKey = this.sessionKey;
    const pending = this.positionCards.filter((card) => {
      if (this.isCorruptConfirmedCard(card)) return true;
      if (!card.confirmed) return true;
      if (card.status === "open" && currentKey && card.windowKey !== currentKey) return true;
      return false;
    });
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
    if (card.status === "sold") {
      if (card.confirmed) return;
      await this.tryConfirmSoldCard(card);
      return;
    }
    if (card.status === "win" || card.status === "loss") {
      if (card.confirmed) return;
      await this.tryConfirmSettledCard(card);
      return;
    }
    if (card.status === "open") {
      const priorWindow =
        Boolean(this.sessionKey) && Boolean(card.windowKey) && card.windowKey !== this.sessionKey;
      if (priorWindow) {
        // Held past window end — only Polymarket may mark win/loss.
        const settled = await this.trySettleHeldCardFromPolymarket(card);
        if (!settled) card.confirmed = false;
        return;
      }
      if (!card.confirmed) {
        await this.tryConfirmOpenCard(card);
      }
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
    await this.trySettleHeldCardFromPolymarket(card);
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
    maxPrice?: number,
    buyPhaseIdx?: number,
  ): Promise<{ ok: boolean; error?: string; fillShares?: number; fillPrice?: number }> {
    if (!isTradingExecutor()) {
      logNonExecutorSkipOnce();
      return { ok: false, error: "Trading executor not enabled in this process" };
    }
    if (this.orderInFlight) return { ok: false, error: "Order already in progress" };
    if (leg === "buy") {
      if (this.isBuyBlocked(state) && source === "auto") {
        return { ok: false, error: "Buy blocked for this window" };
      }
      if (await this.adoptOnChainPositionIfAny(state)) {
        const pos = this.positions.up ?? this.positions.down;
        if (pos) {
          return { ok: true, fillShares: pos.shares, fillPrice: pos.avgPrice };
        }
        return { ok: false, error: "Already holding on-chain position" };
      }
    }
    this.orderInFlight = true;
    try {
      const result = await placeMarketOrder(this.userId, {
        series: state.series,
        side,
        leg,
        size,
        sizeUnit: leg === "sell" ? "shares" : sizeUnit,
        orderType: leg === "buy" ? orderType : "FOK",
        maxPrice: leg === "buy" ? maxPrice : undefined,
        state,
      });
      if (!result.success || result.fillPrice == null || result.fillShares == null) {
        if (leg === "buy") {
          const adopted = await this.adoptOnChainPositionIfAny(state, { force: true });
          if (adopted) {
            const pos = this.positions[side] ?? this.positions.up ?? this.positions.down;
            if (pos) {
              return { ok: true, fillShares: pos.shares, fillPrice: pos.avgPrice };
            }
          }
          if (result.orderId || result.ambiguous) {
            const reason = result.ambiguous
              ? (result.error ?? "ambiguous buy response")
              : `unverified buy (order ${result.orderId!.slice(0, 10)}…)`;
            this.blockFurtherBuys(state, reason);
          }
        }
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
          undefined,
          buyPhaseIdx,
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

      return { ok: true, fillShares, fillPrice };
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
    // Hydrate stats once; later ensureLoaded calls only refresh config.
    await engine.loadPersistedConfig({ hydrateStats: false });
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
    const displaySeries =
      String(state.series || "").trim() || DEFAULT_MARKET_SERIES;
    const matching = engines.filter((e) => e.getBoundSeries() === displaySeries);
    const otherSeries = [
      ...new Set(
        engines
          .map((e) => e.getBoundSeries())
          .filter((s) => s && s !== displaySeries),
      ),
    ];

    await Promise.all(matching.map((e) => e.tick(state, nowMs).catch(() => {})));

    if (otherSeries.length === 0) {
      seriesMarketHub.setActiveSeries([]);
      return;
    }
    await seriesMarketHub.ensureSeries(otherSeries);
    await Promise.all(
      otherSeries.map(async (series) => {
        const feed = seriesMarketHub.getState(series);
        if (!feed) return;
        await Promise.all(
          engines
            .filter((e) => e.getBoundSeries() === series)
            .map((e) => e.tick(feed, nowMs).catch(() => {})),
        );
      }),
    );
  }

  drop(userId: string): void {
    this.engines.delete(userId);
  }

  async syncFromMongo(): Promise<void> {
    const users = await listUsersForLiveTrading();
    for (const user of users) {
      const id = String(user._id);
      const engine = this.get(id);
      // Config refresh; first call still hydrates stats once (see loadPersistedConfig).
      await engine.loadPersistedConfig({ hydrateStats: false });
      if (isTradingExecutor() && user.wallet?.privateKeyEnc && user.wallet?.funderAddress) {
        try {
          await initTradingClient(id, { reason: "poll" });
        } catch {
          /* logged in client */
        }
      }
    }
  }

  /** Discover live users + refresh config. Default 60s (was 5s full hydrate). */
  startPolling(intervalMs = 60_000): void {
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