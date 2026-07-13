import { clobMarketFeed, hasSocketBook } from "./clob-market-feed.js";
import { chainlinkPriceFeed } from "./chainlink-price-feed.js";
import { getPolymarketWindowAssetPricesForPair } from "./asset-price-service.js";
import { waitForGammaWindowResolution } from "./gamma-window-resolution.js";
import {
  fetchCurrentUpDownMarket,
  fetchCurrentUpDownMarketWithRetry,
  fetchMarketPairFromSlug,
  fetchUpDownMarketAtWindow,
  parseMarketSeries,
} from "./market-pair.js";
import { pickDisplayPrice, pickTriggerPrice } from "./quote-price.js";
import { resolveWindowOutcome } from "./window-outcome.js";
import { takeLevels } from "./book-depth.js";
import { makeStoredTickId, roundTo4 } from "./tick-compact.js";
import { enrichWindowWithUniqueTraders, listUniqueTradersForWindow, resolveConditionIdForSlug } from "./market-participants.js";
import { classifyWindowTraders } from "./wallet-registry.js";
import {
  createWindowDynamicsTracker,
  finalizeWindowDynamics,
  updateWindowDynamics,
  type WindowDynamicsTracker,
} from "./window-dynamics.js";
import { logService } from "./log-service.js";
import type {
  ChainlinkTickDocument,
  ClobBookTickDocument,
  ClobRawTickDocument,
  MarketDocument,
  WindowHitRecord,
} from "./types.js";
import {
  ensureWindowTickDir,
  insertChainlinkTicks,
  insertClobBookTicks,
  insertClobRawTicks,
} from "./db/tick-repository.js";
import { saveRecordedWindow } from "./db/recorded-window-repository.js";
import { ingestRecordedWindow } from "./heatmap-service.js";
import { archiveColdMarketData } from "./db/tick-archive.js";
import {
  marketWindowsDir,
  windowTicksDir,
} from "./db/data-dir.js";
import fs from "fs/promises";
import path from "path";

const TICK_FLUSH_MS = 1_500;
const POLL_MS = 500;
const TRADERS_POLL_MS = 15_000;
/** Subscribe the next window's CLOB tokens this many seconds before current end. */
const NEXT_WINDOW_PREFETCH_SEC = 30;

type StateChangeListener = (series: string) => void;

export interface TraderStatsSnapshot {
  uniqueTraders?: number;
  newWallets?: number;
  knownWallets?: number;
}

/** Records CLOB book ticks and Chainlink asset ticks in separate collections. */
export class MarketRecorder {
  private readonly market: MarketDocument;
  private readonly onStateChange: StateChangeListener | null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private tradersPollTimer: ReturnType<typeof setInterval> | null = null;
  private tradersPollInFlight = false;
  private clobRawUnsub: (() => void) | null = null;
  private chainlinkUnsub: (() => void) | null = null;
  private sampleInFlight = false;
  private windowFetchPending = false;
  private fastRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private finalizedWindowStarts = new Set<number>();
  /** Windows abandoned after Chainlink stall — do not re-open or save. */
  private discardedWindowStarts = new Set<number>();
  private activeWindow: WindowHitRecord | null = null;
  private activeYesTokenId: string | null = null;
  private activeNoTokenId: string | null = null;
  private dynamicsTracker: WindowDynamicsTracker = createWindowDynamicsTracker();
  private clobRawBuffer: ClobRawTickDocument[] = [];
  private clobBookBuffer: ClobBookTickDocument[] = [];
  private chainlinkTickBuffer: ChainlinkTickDocument[] = [];
  private clobRawSeq = 0;
  private clobBookSeq = 0;
  private chainlinkSeq = 0;
  private windowTickCount = 0;
  private clobRawCount = 0;
  private clobBookCount = 0;
  private chainlinkCount = 0;
  private lastTraderStats: TraderStatsSnapshot | null = null;
  private assetPrices: { assetPrice?: number; prevCloseAsset?: number } = {};
  private prefetchedNextWindowStart: number | null = null;
  private nextWindowPrefetchInFlight = false;

  constructor(market: MarketDocument, onStateChange: StateChangeListener | null = null) {
    this.market = market;
    this.onStateChange = onStateChange;
  }

  getSeries(): string {
    return this.market._id;
  }

  getActiveWindow(): WindowHitRecord | null {
    return this.activeWindow ? { ...this.activeWindow } : null;
  }

  getTraderStats(): TraderStatsSnapshot | null {
    if (this.activeWindow) {
      return {
        uniqueTraders: this.activeWindow.uniqueTraders,
        newWallets: this.activeWindow.newWallets,
        knownWallets: this.activeWindow.knownWallets,
      };
    }
    return this.lastTraderStats;
  }

  isRunning(): boolean {
    return this.interval != null;
  }

  start(): void {
    if (this.interval) return;

    const { asset } = parseMarketSeries(this.market._id);

    void this.collectSample().catch((err) => {
      logService.error("recorder", `${this.market._id}: ${String(err)}`);
    });

    this.interval = setInterval(() => {
      void this.collectSample().catch((err) => {
        logService.error("recorder", `${this.market._id}: ${String(err)}`);
      });
    }, POLL_MS);

    this.flushTimer = setInterval(() => {
      void this.flushTicks();
    }, TICK_FLUSH_MS);

    this.clobRawUnsub = clobMarketFeed.onRawMessage((event) => {
      this.recordClobRawMessage(event);
    });

    this.chainlinkUnsub = chainlinkPriceFeed.onUpdate((updatedAsset) => {
      if (updatedAsset !== asset) return;
      this.recordChainlinkTick();
    });

    logService.success("recorder", `Recording started for ${this.market._id}`);
  }

  stop(): void {
    if (this.fastRetryTimer) {
      clearTimeout(this.fastRetryTimer);
      this.fastRetryTimer = null;
    }
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.stopTradersPoll();
    if (this.clobRawUnsub) {
      this.clobRawUnsub();
      this.clobRawUnsub = null;
    }
    if (this.chainlinkUnsub) {
      this.chainlinkUnsub();
      this.chainlinkUnsub = null;
    }
    void this.flushTicks();
    this.resetActiveWindow();
    this.finalizedWindowStarts.clear();
    this.discardedWindowStarts.clear();
    logService.info("recorder", `Recording stopped for ${this.market._id}`);
  }

  /**
   * Abandon the in-progress window without saving — used when Chainlink for this
   * asset stalled and the window's price stream is damaged.
   */
  discardActiveWindow(reason: string): void {
    if (!this.activeWindow) return;

    const windowStart = this.activeWindow.windowStart;
    const windowEnd = this.activeWindow.windowEnd;
    this.discardedWindowStarts.add(windowStart);

    this.clobRawBuffer = [];
    this.clobBookBuffer = [];
    this.chainlinkTickBuffer = [];
    this.resetActiveWindow();
    void this.purgeWindowArtifacts(windowStart);

    logService.warn(
      "recorder",
      `Discarded window ${new Date(windowStart * 1000).toLocaleTimeString()}–${new Date(windowEnd * 1000).toLocaleTimeString()} for ${this.market._id} (${reason})`,
    );
    this.onStateChange?.(this.market._id);
  }

  private async purgeWindowArtifacts(windowStart: number): Promise<void> {
    const series = this.market._id;
    const targets = [
      windowTicksDir(series, windowStart),
      path.join(marketWindowsDir(series), `${windowStart}.json`),
    ];
    await Promise.all(
      targets.map(async (target) => {
        try {
          await fs.rm(target, { recursive: true, force: true });
        } catch {
          // best effort
        }
      }),
    );
  }

  private resetActiveWindow(): void {
    this.stopTradersPoll();
    this.activeWindow = null;
    this.activeYesTokenId = null;
    this.activeNoTokenId = null;
    this.dynamicsTracker = createWindowDynamicsTracker();
    this.clobRawBuffer = [];
    this.clobBookBuffer = [];
    this.chainlinkTickBuffer = [];
    this.clobRawSeq = 0;
    this.clobBookSeq = 0;
    this.chainlinkSeq = 0;
    this.windowTickCount = 0;
    this.clobRawCount = 0;
    this.clobBookCount = 0;
    this.chainlinkCount = 0;
    this.lastTraderStats = null;
    this.assetPrices = {};
    this.prefetchedNextWindowStart = null;
    this.nextWindowPrefetchInFlight = false;
  }

  private isInWindow(tMs: number): boolean {
    if (!this.activeWindow) return false;
    const startMs = this.activeWindow.windowStart * 1000;
    const endMs = this.activeWindow.windowEnd * 1000;
    return tMs >= startMs && tMs < endMs;
  }

  private nextClobRawId(windowStart: number): string {
    this.clobRawSeq += 1;
    return makeStoredTickId(windowStart, this.clobRawSeq).replace(":", ":raw:");
  }

  private nextClobBookId(windowStart: number): string {
    this.clobBookSeq += 1;
    return makeStoredTickId(windowStart, this.clobBookSeq).replace(":", ":book:");
  }

  private nextChainlinkId(windowStart: number): string {
    this.chainlinkSeq += 1;
    return makeStoredTickId(windowStart, this.chainlinkSeq).replace(":", ":cl:");
  }

  private buildClobBookTick(tMs: number): ClobBookTickDocument | null {
    if (!this.activeWindow || !this.activeYesTokenId || !this.activeNoTokenId) return null;
    if (!this.isInWindow(tMs)) return null;

    const yesInfo = clobMarketFeed.getCachedMarketInfo(this.activeYesTokenId);
    const noInfo = clobMarketFeed.getCachedMarketInfo(this.activeNoTokenId);
    const elapsed = Math.max(0, Math.floor(tMs / 1000 - this.activeWindow.windowStart));

    const tick: ClobBookTickDocument = {
      _id: this.nextClobBookId(this.activeWindow.windowStart),
      windowStart: this.activeWindow.windowStart,
      windowEnd: this.activeWindow.windowEnd,
      tMs,
      yesBids: takeLevels(yesInfo?.bids),
      yesAsks: takeLevels(yesInfo?.asks),
      noBids: takeLevels(noInfo?.bids),
      noAsks: takeLevels(noInfo?.asks),
    };

    if (yesInfo) {
      const yesTrigger = pickTriggerPrice(yesInfo, elapsed);
      if (yesTrigger.price != null) tick.yesPrice = roundTo4(yesTrigger.price);
    }
    if (noInfo) {
      const noTrigger = pickTriggerPrice(noInfo, elapsed);
      if (noTrigger.price != null) tick.noPrice = roundTo4(noTrigger.price);
    }

    return tick;
  }

  private appendClobBookTick(tMs: number): void {
    const tick = this.buildClobBookTick(tMs);
    if (!tick) return;
    this.clobBookBuffer.push(tick);
    this.clobBookCount += 1;
    this.onStateChange?.(this.market._id);
  }

  private recordClobRawMessage(event: {
    tMs: number;
    payload: unknown;
    tokenIds: string[];
  }): void {
    if (!this.activeWindow || !this.activeYesTokenId || !this.activeNoTokenId) return;
    if (!this.isInWindow(event.tMs)) return;

    const relevant = event.tokenIds.some(
      (id) => id === this.activeYesTokenId || id === this.activeNoTokenId,
    );
    if (!relevant) return;

    this.clobRawBuffer.push({
      _id: this.nextClobRawId(this.activeWindow.windowStart),
      windowStart: this.activeWindow.windowStart,
      windowEnd: this.activeWindow.windowEnd,
      tMs: event.tMs,
      payload: event.payload,
    });
    this.clobRawCount += 1;
    this.appendClobBookTick(event.tMs);
  }

  private buildChainlinkTick(tMs: number): ChainlinkTickDocument | null {
    if (!this.activeWindow) return null;
    if (!this.isInWindow(tMs)) return null;

    const tick: ChainlinkTickDocument = {
      _id: this.nextChainlinkId(this.activeWindow.windowStart),
      windowStart: this.activeWindow.windowStart,
      windowEnd: this.activeWindow.windowEnd,
      tMs,
      ptbCrossings: this.activeWindow.ptbCrossings,
      minAssetPrice:
        this.activeWindow.minAssetPrice != null
          ? roundTo4(this.activeWindow.minAssetPrice)
          : undefined,
      maxAssetPrice:
        this.activeWindow.maxAssetPrice != null
          ? roundTo4(this.activeWindow.maxAssetPrice)
          : undefined,
    };

    if (this.assetPrices.assetPrice != null) {
      tick.assetPrice = roundTo4(this.assetPrices.assetPrice);
    }
    if (this.assetPrices.prevCloseAsset != null) {
      tick.prevCloseAsset = roundTo4(this.assetPrices.prevCloseAsset);
    }

    return tick;
  }

  private pushChainlinkTick(tMs: number): void {
    const tick = this.buildChainlinkTick(tMs);
    if (!tick) return;
    this.chainlinkTickBuffer.push(tick);
    this.chainlinkCount += 1;
    this.onStateChange?.(this.market._id);
  }

  private recordChainlinkTick(): void {
    const { asset } = parseMarketSeries(this.market._id);
    const live = chainlinkPriceFeed.getLivePrice(asset);
    if (!live || !this.activeWindow) return;

    this.applyAssetPrices(live.value, this.assetPrices.prevCloseAsset);
    const tMs = live.timestampMs || Date.now();
    this.pushChainlinkTick(tMs);
  }

  private applyAssetPrices(assetPrice?: number, prevCloseAsset?: number): void {
    if (!this.activeWindow) return;

    if (assetPrice != null && Number.isFinite(assetPrice)) {
      this.activeWindow.assetPrice = assetPrice;
      this.assetPrices.assetPrice = assetPrice;
    }
    if (prevCloseAsset != null && Number.isFinite(prevCloseAsset)) {
      this.activeWindow.prevCloseAsset = prevCloseAsset;
      this.assetPrices.prevCloseAsset = prevCloseAsset;
    }
    if (
      this.activeWindow.assetPrice != null &&
      this.activeWindow.prevCloseAsset != null
    ) {
      this.activeWindow.assetGap =
        this.activeWindow.assetPrice - this.activeWindow.prevCloseAsset;
    }

    updateWindowDynamics(
      this.activeWindow,
      this.dynamicsTracker,
      this.activeWindow.assetPrice,
      this.activeWindow.prevCloseAsset,
    );
  }

  private async flushTicks(): Promise<void> {
    const rawBatch = this.clobRawBuffer.splice(0, this.clobRawBuffer.length);
    const bookBatch = this.clobBookBuffer.splice(0, this.clobBookBuffer.length);
    const chainlinkBatch = this.chainlinkTickBuffer.splice(0, this.chainlinkTickBuffer.length);
    if (rawBatch.length === 0 && bookBatch.length === 0 && chainlinkBatch.length === 0) return;

    try {
      await Promise.all([
        insertClobRawTicks(this.market, rawBatch),
        insertClobBookTicks(this.market, bookBatch),
        insertChainlinkTicks(this.market, chainlinkBatch),
      ]);
    } catch (err) {
      logService.error("recorder", `Tick flush failed (${this.market._id}): ${String(err)}`);
      this.clobRawBuffer.unshift(...rawBatch);
      this.clobBookBuffer.unshift(...bookBatch);
      this.chainlinkTickBuffer.unshift(...chainlinkBatch);
    }
  }

  private beginWindow(
    windowStart: number,
    windowEnd: number,
    meta: { slug?: string; question?: string; conditionId?: string },
  ): void {
    this.activeWindow = {
      windowStart,
      windowEnd,
      slug: meta.slug,
      question: meta.question,
      conditionId: meta.conditionId,
    };
    this.dynamicsTracker = createWindowDynamicsTracker();
    this.clobRawSeq = 0;
    this.clobBookSeq = 0;
    this.chainlinkSeq = 0;
    this.windowTickCount = 0;
    this.clobRawCount = 0;
    this.clobBookCount = 0;
    this.chainlinkCount = 0;
    this.clobRawBuffer = [];
    this.clobBookBuffer = [];
    this.chainlinkTickBuffer = [];
    this.lastTraderStats = null;
    void ensureWindowTickDir(this.market._id, windowStart);
    this.startTradersPoll();
    logService.info(
      "recorder",
      `Window started ${new Date(windowStart * 1000).toLocaleTimeString()} for ${this.market._id}`,
    );
  }

  private stopTradersPoll(): void {
    if (this.tradersPollTimer) {
      clearInterval(this.tradersPollTimer);
      this.tradersPollTimer = null;
    }
  }

  private startTradersPoll(): void {
    this.stopTradersPoll();
    void this.refreshUniqueTraders();
    this.tradersPollTimer = setInterval(() => {
      void this.refreshUniqueTraders();
    }, TRADERS_POLL_MS);
  }

  private async refreshUniqueTraders(): Promise<void> {
    if (!this.activeWindow || this.tradersPollInFlight) return;

    const nowSec = Math.floor(Date.now() / 1000);
    if (nowSec >= this.activeWindow.windowEnd) return;

    const windowStart = this.activeWindow.windowStart;
    this.tradersPollInFlight = true;
    try {
      let conditionId = this.activeWindow.conditionId;
      if (!conditionId && this.activeWindow.slug) {
        conditionId = await resolveConditionIdForSlug(this.activeWindow.slug);
        if (conditionId && this.activeWindow?.windowStart === windowStart) {
          this.activeWindow.conditionId = conditionId;
        }
      }
      if (!conditionId || this.activeWindow?.windowStart !== windowStart) return;

      const wallets = await listUniqueTradersForWindow({
        conditionId,
        windowStart: this.activeWindow.windowStart,
        windowEnd: this.activeWindow.windowEnd,
        slug: this.activeWindow.slug,
        waitForSettle: false,
      });
      const { newWallets, knownWallets } = await classifyWindowTraders(wallets);

      if (this.activeWindow?.windowStart !== windowStart) return;

      const count = wallets.length;
      const changed =
        this.activeWindow.uniqueTraders !== count ||
        this.activeWindow.newWallets !== newWallets ||
        this.activeWindow.knownWallets !== knownWallets;

      if (changed) {
        this.activeWindow.uniqueTraders = count;
        this.activeWindow.newWallets = newWallets;
        this.activeWindow.knownWallets = knownWallets;
        this.onStateChange?.(this.market._id);
      }
    } catch (err) {
      logService.error("recorder", `Trader poll failed (${this.market._id}): ${String(err)}`);
    } finally {
      this.tradersPollInFlight = false;
    }
  }

  private async captureEndPrices(): Promise<void> {
    if (!this.activeWindow?.slug) return;

    try {
      const { asset, timeframe } = parseMarketSeries(this.market._id);
      const pair = await fetchMarketPairFromSlug(this.activeWindow.slug);
      const yesInfo = clobMarketFeed.getCachedMarketInfo(pair.yesTokenId);
      const noInfo = clobMarketFeed.getCachedMarketInfo(pair.noTokenId);
      const gamma = await waitForGammaWindowResolution(this.activeWindow.slug);

      if (yesInfo) this.activeWindow.yesPrice = pickDisplayPrice(yesInfo).price;
      if (noInfo) this.activeWindow.noPrice = pickDisplayPrice(noInfo).price;

      if (gamma) {
        this.applyAssetPrices(gamma.finalPrice, gamma.priceToBeat);
        this.activeWindow.windowOutcome = gamma.outcome;
        return;
      }

      // Fallback if Gamma has not resolved yet.
      const prices = await getPolymarketWindowAssetPricesForPair(asset, timeframe, pair);
      this.applyAssetPrices(prices.assetPrice, prices.prevCloseAsset);
      this.activeWindow.windowOutcome = resolveWindowOutcome(
        this.activeWindow.assetPrice,
        this.activeWindow.prevCloseAsset,
        this.activeWindow.assetGap,
      );
      logService.warn(
        "recorder",
        `Gamma resolution unavailable for ${this.activeWindow.slug}; used price fallback`,
      );
    } catch {
      // best effort
    }
  }

  /** Warm the next window's CLOB tokens on the socket ~30s before rollover. */
  private async prefetchNextWindowTokens(): Promise<void> {
    if (!this.activeWindow || this.nextWindowPrefetchInFlight) return;

    const nowSec = Math.floor(Date.now() / 1000);
    const { windowStart, windowEnd } = this.activeWindow;
    if (nowSec < windowEnd - NEXT_WINDOW_PREFETCH_SEC) return;

    const nextStart = windowEnd;
    if (this.prefetchedNextWindowStart === nextStart) return;

    this.nextWindowPrefetchInFlight = true;
    try {
      const pair = await fetchUpDownMarketAtWindow(this.market._id, nextStart);
      clobMarketFeed.ensureSubscribed([pair.yesTokenId, pair.noTokenId]);
      this.prefetchedNextWindowStart = nextStart;
      logService.info(
        "recorder",
        `Prefetched next window ${new Date(nextStart * 1000).toLocaleTimeString()} tokens for ${this.market._id}`,
      );
    } catch (err) {
      logService.warn(
        "recorder",
        `Next-window prefetch failed (${this.market._id}): ${String(err)}`,
      );
    } finally {
      this.nextWindowPrefetchInFlight = false;
    }
  }

  private writeOpeningSocketTicks(windowStart: number, yesTokenId: string, noTokenId: string): void {
    this.activeYesTokenId = yesTokenId;
    this.activeNoTokenId = noTokenId;
    const openMs = windowStart * 1000;
    const yesInfo = clobMarketFeed.getCachedMarketInfo(yesTokenId);
    const noInfo = clobMarketFeed.getCachedMarketInfo(noTokenId);
    if (hasSocketBook(yesInfo) || hasSocketBook(noInfo)) {
      this.appendClobBookTick(openMs);
    }
    this.pushChainlinkTick(openMs);
  }

  private async archiveOldData(): Promise<void> {
    await archiveColdMarketData(this.market);
  }

  private async finalizeWindow(): Promise<void> {
    if (!this.activeWindow) return;

    const nowSec = Math.floor(Date.now() / 1000);
    if (nowSec < this.activeWindow.windowEnd) return;

    const windowStart = this.activeWindow.windowStart;
    if (this.finalizedWindowStarts.has(windowStart)) {
      this.resetActiveWindow();
      return;
    }

    finalizeWindowDynamics(this.activeWindow);

    let record: WindowHitRecord = {
      windowStart: this.activeWindow.windowStart,
      windowEnd: this.activeWindow.windowEnd,
      slug: this.activeWindow.slug,
      question: this.activeWindow.question,
      conditionId: this.activeWindow.conditionId,
      assetPrice: this.activeWindow.assetPrice,
      prevCloseAsset: this.activeWindow.prevCloseAsset,
      assetGap: this.activeWindow.assetGap,
      ptbCrossings: this.activeWindow.ptbCrossings,
      minAssetPrice: this.activeWindow.minAssetPrice,
      maxAssetPrice: this.activeWindow.maxAssetPrice,
      assetRange: this.activeWindow.assetRange,
      rangeTop: this.activeWindow.rangeTop,
      rangeBottom: this.activeWindow.rangeBottom,
      windowOutcome: this.activeWindow.windowOutcome,
      yesPrice: this.activeWindow.yesPrice,
      noPrice: this.activeWindow.noPrice,
      savedAt: new Date().toISOString(),
    };

    try {
      await this.flushTicks();
      record = await enrichWindowWithUniqueTraders(record, this.market._id, { force: true });

      const savedAt = record.savedAt ?? new Date().toISOString();
      const recordedDoc = {
        windowStart: record.windowStart,
        windowEnd: record.windowEnd,
        savedAt,
        slug: record.slug,
        question: record.question,
        conditionId: record.conditionId,
        assetPrice: record.assetPrice,
        prevCloseAsset: record.prevCloseAsset,
        assetGap: record.assetGap,
        windowOutcome: record.windowOutcome,
        yesPrice: record.yesPrice,
        noPrice: record.noPrice,
        ptbCrossings: record.ptbCrossings,
        minAssetPrice: record.minAssetPrice,
        maxAssetPrice: record.maxAssetPrice,
        assetRange: record.assetRange,
        rangeTop: record.rangeTop,
        rangeBottom: record.rangeBottom,
        uniqueTraders: record.uniqueTraders,
        newWallets: record.newWallets,
        knownWallets: record.knownWallets,
        tickCount: this.clobRawCount + this.clobBookCount + this.chainlinkCount,
        clobRawCount: this.clobRawCount,
        clobBookCount: this.clobBookCount,
        chainlinkCount: this.chainlinkCount,
      };
      await saveRecordedWindow(this.market, recordedDoc);
      ingestRecordedWindow(this.market._id, {
        _id: String(record.windowStart),
        updatedAt: savedAt,
        ...recordedDoc,
      });
      await this.archiveOldData();

      this.lastTraderStats = {
        uniqueTraders: record.uniqueTraders,
        newWallets: record.newWallets,
        knownWallets: record.knownWallets,
      };

      this.finalizedWindowStarts.add(windowStart);
      const { timeframe } = parseMarketSeries(this.market._id);
      logService.success(
        "recorder",
        `Window saved ${new Date(windowStart * 1000).toLocaleTimeString()} (${this.clobRawCount} raw, ${this.clobBookCount} book, ${this.chainlinkCount} chainlink, ${record.newWallets ?? 0} new wallets)`,
      );
      this.onStateChange?.(this.market._id);
    } catch (err) {
      logService.error("recorder", `Failed to finalize window (${this.market._id}): ${String(err)}`);
    } finally {
      this.resetActiveWindow();
    }
  }

  private scheduleFastRetry(): void {
    if (this.fastRetryTimer || !this.interval) return;
    this.fastRetryTimer = setTimeout(() => {
      this.fastRetryTimer = null;
      void this.collectSample().catch((err) => {
        logService.error("recorder", `${this.market._id}: ${String(err)}`);
      });
    }, 1000);
  }

  private async fetchMarketPair(rolling = false) {
    if (rolling || this.windowFetchPending) {
      return fetchCurrentUpDownMarketWithRetry(this.market._id, {
        maxWaitMs: 30_000,
        intervalMs: 500,
      });
    }
    return fetchCurrentUpDownMarket(this.market._id);
  }

  private async collectSample(): Promise<void> {
    if (this.sampleInFlight) return;
    this.sampleInFlight = true;
    try {
      await this.runCollectSample();
    } finally {
      this.sampleInFlight = false;
    }
  }

  private async runCollectSample(): Promise<void> {
    const nowSec = Math.floor(Date.now() / 1000);
    let rolling = false;

    if (this.activeWindow && nowSec >= this.activeWindow.windowEnd) {
      await this.captureEndPrices();
      await this.finalizeWindow();
      rolling = true;
      this.windowFetchPending = true;
    } else if (this.activeWindow) {
      void this.prefetchNextWindowTokens();
    }

    let pair;
    try {
      pair = await this.fetchMarketPair(rolling);
      this.windowFetchPending = false;
      if (this.fastRetryTimer) {
        clearTimeout(this.fastRetryTimer);
        this.fastRetryTimer = null;
      }
    } catch (err) {
      if (rolling || this.windowFetchPending) {
        this.windowFetchPending = true;
        this.scheduleFastRetry();
      }
      throw err;
    }

    if (pair.windowEnd != null && Math.floor(Date.now() / 1000) >= pair.windowEnd) {
      this.windowFetchPending = true;
      try {
        pair = await fetchCurrentUpDownMarketWithRetry(this.market._id, {
          maxWaitMs: 30_000,
          intervalMs: 500,
        });
        this.windowFetchPending = false;
      } catch (err) {
        this.scheduleFastRetry();
        throw err;
      }
      const freshNow = Math.floor(Date.now() / 1000);
      if (pair.windowEnd != null && freshNow >= pair.windowEnd) {
        this.windowFetchPending = true;
        this.scheduleFastRetry();
        return;
      }
    }

    clobMarketFeed.ensureSubscribed([pair.yesTokenId, pair.noTokenId]);

    const { asset, timeframe } = parseMarketSeries(this.market._id);
    let assetPrice: number | undefined;
    let prevCloseAsset: number | undefined;
    try {
      if (pair.windowStart != null && pair.eventStartTimeIso && pair.eventEndTimeIso) {
        const prices = await getPolymarketWindowAssetPricesForPair(asset, timeframe, pair);
        assetPrice = prices.assetPrice;
        prevCloseAsset = prices.prevCloseAsset;
      }
    } catch {
      const live = chainlinkPriceFeed.getLivePrice(asset);
      if (live) assetPrice = live.value;
    }

    if (this.activeWindow && pair.windowStart === this.activeWindow.windowStart) {
      this.applyAssetPrices(assetPrice, prevCloseAsset);
      const yesInfo = clobMarketFeed.getCachedMarketInfo(pair.yesTokenId);
      const noInfo = clobMarketFeed.getCachedMarketInfo(pair.noTokenId);
      if (yesInfo) this.activeWindow.yesPrice = pickDisplayPrice(yesInfo).price;
      if (noInfo) this.activeWindow.noPrice = pickDisplayPrice(noInfo).price;
    }

    if (pair.windowStart != null && pair.windowEnd != null) {
      const windowStart = pair.windowStart;
      const windowEnd = pair.windowEnd;

      if (this.activeWindow && this.activeWindow.windowStart !== windowStart) {
        if (nowSec >= this.activeWindow.windowEnd) {
          await this.captureEndPrices();
          await this.finalizeWindow();
        } else if (this.activeWindow.slug) {
          try {
            pair = await fetchMarketPairFromSlug(this.activeWindow.slug);
          } catch {
            // keep current pair
          }
        }
      }

      if (!this.activeWindow) {
        if (
          this.discardedWindowStarts.has(windowStart) ||
          this.finalizedWindowStarts.has(windowStart)
        ) {
          // Stall-damaged or already finished — wait for the next window.
        } else {
          this.beginWindow(windowStart, windowEnd, {
            question: pair.question,
            slug: pair.slug,
            conditionId: pair.conditionId,
          });
          this.applyAssetPrices(assetPrice, prevCloseAsset);
          this.writeOpeningSocketTicks(windowStart, pair.yesTokenId, pair.noTokenId);
        }
      } else if (this.activeWindow.windowStart === windowStart && pair.conditionId) {
        this.activeWindow.conditionId = pair.conditionId;
      }

      if (this.activeWindow && this.activeWindow.windowStart === windowStart) {
        this.activeYesTokenId = pair.yesTokenId;
        this.activeNoTokenId = pair.noTokenId;
      }
    }

    this.onStateChange?.(this.market._id);
  }
}
