import type { BookLevel } from "./clob-service.js";

export type WindowOutcome = "up" | "down";
export type TickSource = "clob-book" | "chainlink-tick";

export const BOOK_DEPTH_LEVELS = 5;

export interface MarketDocument {
  _id: string;
  label: string;
  timeframeMinutes: number;
  createdAt: string;
  updatedAt: string;
}

export interface RecordedWindowDocument {
  _id: string;
  windowStart: number;
  windowEnd: number;
  savedAt: string;
  updatedAt: string;
  slug?: string;
  question?: string;
  conditionId?: string;
  assetPrice?: number;
  prevCloseAsset?: number;
  assetGap?: number;
  windowOutcome?: WindowOutcome;
  yesPrice?: number;
  noPrice?: number;
  ptbCrossings?: number;
  minAssetPrice?: number;
  maxAssetPrice?: number;
  assetRange?: number;
  rangeTop?: number;
  rangeBottom?: number;
  uniqueTraders?: number;
  newWallets?: number;
  knownWallets?: number;
  tickCount: number;
  clobRawCount?: number;
  clobBookCount?: number;
  chainlinkCount?: number;
}

export interface WalletRegistryEntry {
  address: string;
  firstSeenAt: number;
  lastSeenAt: number;
  markets: Record<string, number>;
  totalSightings: number;
}

export type WalletRegistry = Record<string, WalletRegistryEntry>;

/** Raw CLOB websocket payload for audit replay. */
export interface ClobRawTickDocument {
  _id: string;
  windowStart: number;
  windowEnd: number;
  tMs: number;
  payload: unknown;
}

/** Parsed top-of-book depth snapshot after each raw WS message. */
export interface ClobBookTickDocument {
  _id: string;
  windowStart: number;
  windowEnd: number;
  tMs: number;
  yesPrice?: number;
  noPrice?: number;
  yesBids: BookLevel[];
  yesAsks: BookLevel[];
  noBids: BookLevel[];
  noAsks: BookLevel[];
}

/** @deprecated Use ClobBookTickDocument */
export type BookTickDocument = ClobBookTickDocument;

/** Chainlink asset price and per-window dynamics. */
export interface ChainlinkTickDocument {
  _id: string;
  windowStart: number;
  windowEnd: number;
  tMs: number;
  assetPrice?: number;
  prevCloseAsset?: number;
  assetGap?: number;
  ptbCrossings?: number;
  minAssetPrice?: number;
  maxAssetPrice?: number;
  assetRange?: number;
  rangeTop?: number;
  rangeBottom?: number;
}

/** Merged book + chainlink state for replay APIs. */
export interface ReplayTickDocument {
  tMs: number;
  t: number;
  elapsedSec: number;
  source: TickSource;
  yesPrice?: number;
  noPrice?: number;
  yesBid?: number;
  noBid?: number;
  yesAsk?: number;
  noAsk?: number;
  yesBidSize?: number;
  noBidSize?: number;
  yesAskSize?: number;
  noAskSize?: number;
  yesBids?: BookLevel[];
  yesAsks?: BookLevel[];
  noBids?: BookLevel[];
  noAsks?: BookLevel[];
  assetPrice?: number;
  prevCloseAsset?: number;
  assetGap?: number;
  ptbCrossings?: number;
  minAssetPrice?: number;
  maxAssetPrice?: number;
  assetRange?: number;
  rangeTop?: number;
  rangeBottom?: number;
}

/** @deprecated Use BookTickDocument */
export type TickDocument = BookTickDocument;

export interface HeatmapWindowDocument {
  _id: string;
  windowStart: number;
  windowEnd: number;
  savedAt: string;
  ptbCrossings?: number;
  assetRange?: number;
  minAssetPrice?: number;
  maxAssetPrice?: number;
  rangeTop?: number;
  rangeBottom?: number;
  uniqueTraders?: number;
  newWallets?: number;
  knownWallets?: number;
  windowOutcome?: WindowOutcome;
}

export interface WindowHitRecord {
  windowStart: number;
  windowEnd: number;
  slug?: string;
  question?: string;
  conditionId?: string;
  assetPrice?: number;
  prevCloseAsset?: number;
  assetGap?: number;
  windowOutcome?: WindowOutcome;
  yesPrice?: number;
  noPrice?: number;
  ptbCrossings?: number;
  minAssetPrice?: number;
  maxAssetPrice?: number;
  assetRange?: number;
  rangeTop?: number;
  rangeBottom?: number;
  uniqueTraders?: number;
  newWallets?: number;
  knownWallets?: number;
  savedAt?: string;
}

export interface LiveWindowState {
  series: string;
  windowStart: number;
  windowEnd: number;
  slug?: string;
  question?: string;
  prevCloseAsset?: number;
  assetPrice?: number;
  assetGap?: number;
  yesBid?: number;
  yesAsk?: number;
  noBid?: number;
  noAsk?: number;
  yesBidSize?: number;
  yesAskSize?: number;
  noBidSize?: number;
  noAskSize?: number;
  yesBids?: BookLevel[];
  yesAsks?: BookLevel[];
  noBids?: BookLevel[];
  noAsks?: BookLevel[];
  yesDisplay?: number;
  noDisplay?: number;
  ptbCrossings?: number;
  minAssetPrice?: number;
  maxAssetPrice?: number;
  assetRange?: number;
  uniqueTraders?: number;
  lastTickMs?: number;
  /** Measured CLOB WebSocket round-trip latency (ms). */
  feedLatencyMs?: number;
  priceHistory: Array<{ t: number; price: number }>;
}

export type GapVsPtb = "with" | "opposite";

export interface SimPhaseConfig {
  buyEnabled: boolean;
  buyShares: number;
  /** Ask touch / limit price in cents (1–99). */
  buyTrigger: number;
  /** After touching trigger, hunt a better (≤) fill. */
  buyOptimize: boolean;
  /** Min |asset−PTB| in $; 0 = ignore. */
  minGap: number;
  /** Max |asset−PTB| in $; 0 = ignore. */
  maxGap: number;
  /** Gap direction relative to the side being bought. */
  gapVsPtb: GapVsPtb;
  /** Sell limit = buy + this many cents. */
  sellProfitCents: number;
}


export interface SimTakerFeeParams {
  feeRate: number;
  feeExponent: number;
}

export interface SimSetup {
  phaseSplit: [number, number];
  phases: [SimPhaseConfig, SimPhaseConfig, SimPhaseConfig];
  /** Simulated order latency before fill re-check (ms). */
  latencyMs: number;
  /** Polymarket taker fee params (crypto default; override from CLOB when available). */
  feeParams?: SimTakerFeeParams;
}

/** Phase trading config persisted for replay (no latency or market). */
export interface TradingPhaseSetup {
  phaseSplit: [number, number];
  phases: [SimPhaseConfig, SimPhaseConfig, SimPhaseConfig];
}

export interface TradingSetupRecord {
  title: string;
  description?: string;
  color?: string;
  setup: TradingPhaseSetup;
  createdAt: Date;
  /**
   * True while at least one card using this setup is on the live schedule
   * (`schedual_setups_real`). Sim apps should refuse to delete when set.
   */
  liveScheduleInUse?: boolean;
  /**
   * True while at least one card using this setup is on the sim schedule
   * (`schedual_setups_sim`). Real app disables delete when set.
   */
  simScheduleInUse?: boolean;
}

export type ScheduleDayId = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

export interface SchedulePlacementRecord {
  setupId: string;
  title: string;
  day: ScheduleDayId;
  startHour: number;
  durationHours: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface SimMarker {
  type: "buy" | "sell";
  side: "up" | "down";
  t: number;
  y: number | null;
  shares: number;
  price: number;
  cost?: number;
  fees?: number;
  proceeds?: number;
  profit?: number;
  /** Total position cost (buy: cost+fees) or total sale (sell: proceeds). */
  total?: number;
  windowKey: string;
}

export interface SimLastWindow {
  windowKey: string;
  windowStart: number;
  windowEnd?: number;
  outcome?: "up" | "down";
  prevCloseAsset?: number;
  assetPrice?: number;
  assetGap?: number;
  side?: "up" | "down";
  shares?: number;
  buyPrice?: number;
  buyCost?: number;
  buyFees?: number;
  positionCost?: number;
  sold: boolean;
  sellPrice?: number;
  sellProceeds?: number;
  positionWon?: boolean | null;
  pl: number;
  plLabel: "Trade" | "Settlement" | "No trade";
}

export interface SimQuoteLocks {
  upBuy: number | null;
  upSell: number | null;
  downBuy: number | null;
  downSell: number | null;
}

export interface SimPublicState {
  setup: SimSetup;
  markers: SimMarker[];
  quoteLocks: SimQuoteLocks;
  lastWindow: SimLastWindow | null;
}

export interface TradingConfig {
  autoTrade: boolean;
  useSchedule: boolean;
  startTrading: boolean;
  /** Manual buy size (share count or USDC, depending on manualOrderUnit). */
  manualShares: number;
  manualOrderUnit: "shares" | "usdc";
}

export interface LiveSidePosition {
  shares: number;
  avgPrice: number;
  cost: number;
  cardId?: string;
}

export type TradingPositionCardStatus = "open" | "sold" | "win" | "loss";

export interface TradingPositionCard {
  id: string;
  windowKey: string;
  series: string;
  side: "up" | "down";
  shares: number;
  buyPrice: number;
  buyCost: number;
  buyAt: number;
  status: TradingPositionCardStatus;
  sellPrice?: number;
  sellProceeds?: number;
  soldAt?: number;
  pl?: number;
  outcome?: "up" | "down";
  /** Polymarket outcome token id */
  asset?: string;
  conditionId?: string;
  slug?: string;
  /** Whether buy/sell/P/L numbers were confirmed from Polymarket Data API */
  confirmed?: boolean;
  /** Schedule placement that auto-triggered this trade (real schedule only). */
  placementId?: string;
}

/** Live real-trade aggregates for a schedule placement card. */
export interface PlacementLiveStats {
  placementId: string;
  hasData: boolean;
  green: number;
  red: number;
  blue: number;
  pnl: number;
}

export interface TradingPublicState {
  config: TradingConfig;
  positions: { up: LiveSidePosition | null; down: LiveSidePosition | null };
  positionCards: TradingPositionCard[];
  placementStats: PlacementLiveStats[];
  quoteLocks: SimQuoteLocks;
  markers: SimMarker[];
  phaseSetup: TradingPhaseSetup | null;
  phasesVisible: boolean;
  phasesEditable: boolean;
  scheduleTitle: string | null;
  quotesEnabled: boolean;
  previewMode: boolean;
}

export interface EnrichedLiveWindowState extends LiveWindowState {
  sim: SimPublicState;
  trading: TradingPublicState;
}
