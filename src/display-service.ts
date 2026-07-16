import { createPublicClient, getClobHost, getChainId } from "./clob-service.js";
import { clobMarketFeed } from "./clob-market-feed.js";
import { chainlinkPriceFeed } from "./chainlink-price-feed.js";
import {
  getPolymarketWindowAssetPricesForPair,
  applyRtdsLivePrice,
} from "./asset-price-service.js";
import {
  fetchCurrentUpDownMarket,
  fetchCurrentUpDownMarketWithRetry,
  fetchUpDownMarketAtWindow,
  parseMarketSeries,
} from "./market-pair.js";
import { takeLevels } from "./book-depth.js";
import { pickDisplayPrice } from "./quote-price.js";
import { simulatorService } from "./simulator-service.js";
import { liveTradingRegistry } from "./live-trading-service.js";
import { resolveTakerFeeParams } from "./taker-fee.js";
import { logService } from "./log-service.js";
import type { LiveWindowState } from "./types.js";

type UpdateListener = (state: LiveWindowState) => void;

const NEXT_WINDOW_PREFETCH_SEC = 30;

/** Display-only observer for the UI-selected market (no persistence). */
export class DisplayService {
  private series = "btc-5m";
  private interval: ReturnType<typeof setInterval> | null = null;
  private clobUnsub: (() => void) | null = null;
  private chainlinkUnsub: (() => void) | null = null;
  private listeners = new Set<UpdateListener>();
  private state: LiveWindowState = this.emptyState("btc-5m");
  private yesTokenId: string | null = null;
  private noTokenId: string | null = null;
  private sampleInFlight = false;
  private prefetchedNextWindowStart: number | null = null;
  private nextWindowPrefetchInFlight = false;

  private emptyState(series: string): LiveWindowState {
    const now = Math.floor(Date.now() / 1000);
    return {
      series,
      windowStart: now,
      windowEnd: now + 300,
      priceHistory: [],
    };
  }

  start(): void {
    if (this.interval) return;

    void this.collectSample();
    this.interval = setInterval(() => void this.collectSample(), 500);

    this.clobUnsub = clobMarketFeed.onUpdate((tokenIds) => {
      if (!this.yesTokenId || !this.noTokenId) return;
      if (!tokenIds.includes(this.yesTokenId) && !tokenIds.includes(this.noTokenId)) return;
      this.updateQuotesFromCache();
    });

    this.chainlinkUnsub = chainlinkPriceFeed.onUpdate((asset) => {
      const { asset: seriesAsset } = parseMarketSeries(this.series);
      if (asset !== seriesAsset) return;
      this.updateAssetFromChainlink();
    });
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.clobUnsub) {
      this.clobUnsub();
      this.clobUnsub = null;
    }
    if (this.chainlinkUnsub) {
      this.chainlinkUnsub();
      this.chainlinkUnsub = null;
    }
  }

  setSeries(series: string): void {
    if (this.series === series) return;
    this.series = series;
    this.state = this.emptyState(series);
    this.yesTokenId = null;
    this.noTokenId = null;
    this.prefetchedNextWindowStart = null;
    void this.collectSample();
  }

  getState(): LiveWindowState {
    return { ...this.state, priceHistory: [...this.state.priceHistory] };
  }

  onUpdate(listener: UpdateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    const snapshot = this.getState();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  private updateQuotesFromCache(): void {
    if (!this.yesTokenId || !this.noTokenId) return;
    const yesInfo = clobMarketFeed.getCachedMarketInfo(this.yesTokenId);
    const noInfo = clobMarketFeed.getCachedMarketInfo(this.noTokenId);
    if (yesInfo) {
      this.state.yesBid = yesInfo.bestBid;
      this.state.yesAsk = yesInfo.bestAsk;
      this.state.yesBidSize = yesInfo.bestBidSize;
      this.state.yesAskSize = yesInfo.bestAskSize;
      this.state.yesBids = takeLevels(yesInfo.bids);
      this.state.yesAsks = takeLevels(yesInfo.asks);
      this.state.yesDisplay = pickDisplayPrice(yesInfo).price;
    }
    if (noInfo) {
      this.state.noBid = noInfo.bestBid;
      this.state.noAsk = noInfo.bestAsk;
      this.state.noBidSize = noInfo.bestBidSize;
      this.state.noAskSize = noInfo.bestAskSize;
      this.state.noBids = takeLevels(noInfo.bids);
      this.state.noAsks = takeLevels(noInfo.asks);
      this.state.noDisplay = pickDisplayPrice(noInfo).price;
    }
    const tickMs = Date.now();
    this.state.lastTickMs = tickMs;
    const feedLatency = clobMarketFeed.getFeedLatencyMs();
    if (feedLatency != null) {
      this.state.feedLatencyMs = feedLatency;
    }
    void (async () => {
      await liveTradingRegistry.tickAll(this.state, tickMs);
      this.notify();
    })();
  }

  private updateAssetFromChainlink(): void {
    const { asset } = parseMarketSeries(this.series);
    const live = chainlinkPriceFeed.getLivePrice(asset);
    if (!live) return;

    this.state.assetPrice = live.value;
    if (this.state.prevCloseAsset != null) {
      this.state.assetGap = live.value - this.state.prevCloseAsset;
    }
    const tickMs = live.timestampMs;
    this.state.lastTickMs = tickMs;

    const nowSec = Math.floor(Date.now() / 1000);
    if (nowSec >= this.state.windowStart && nowSec < this.state.windowEnd) {
      this.state.priceHistory.push({ t: nowSec, price: live.value });
      if (this.state.priceHistory.length > 2000) {
        this.state.priceHistory.splice(0, this.state.priceHistory.length - 2000);
      }
    }

    void (async () => {
      await liveTradingRegistry.tickAll(this.state, tickMs);
      this.notify();
    })();
  }

  private async prefetchNextWindowTokens(): Promise<void> {
    if (this.nextWindowPrefetchInFlight) return;

    const nowSec = Math.floor(Date.now() / 1000);
    const { windowEnd } = this.state;
    if (!windowEnd || nowSec < windowEnd - NEXT_WINDOW_PREFETCH_SEC) return;

    const nextStart = windowEnd;
    if (this.prefetchedNextWindowStart === nextStart) return;

    this.nextWindowPrefetchInFlight = true;
    try {
      const pair = await fetchUpDownMarketAtWindow(this.series, nextStart);
      clobMarketFeed.ensureSubscribed([pair.yesTokenId, pair.noTokenId]);
      this.prefetchedNextWindowStart = nextStart;
    } catch {
      // next market may not be listed yet
    } finally {
      this.nextWindowPrefetchInFlight = false;
    }
  }

  private async collectSample(): Promise<void> {
    if (this.sampleInFlight) return;
    this.sampleInFlight = true;
    try {
      void this.prefetchNextWindowTokens();

      let pair;
      try {
        pair = await fetchCurrentUpDownMarket(this.series);
      } catch {
        pair = await fetchCurrentUpDownMarketWithRetry(this.series, { maxWaitMs: 5000 });
      }

      if (!pair.windowStart || !pair.windowEnd) return;

      if (this.state.windowStart !== pair.windowStart) {
        this.state.priceHistory = [];
      }

      this.state.series = this.series;
      this.state.windowStart = pair.windowStart;
      this.state.windowEnd = pair.windowEnd;
      this.state.slug = pair.slug;
      this.state.question = pair.question;

      clobMarketFeed.ensureSubscribed([pair.yesTokenId, pair.noTokenId]);
      this.yesTokenId = pair.yesTokenId;
      this.noTokenId = pair.noTokenId;

      // Fee schedule is metadata (not book prices) — REST ok.
      void createPublicClient(getClobHost(), getChainId())
        .then((client) => resolveTakerFeeParams(client, pair.yesTokenId))
        .then((feeParams) => simulatorService.setFeeParams(feeParams))
        .catch(() => {});

      const { asset, timeframe } = parseMarketSeries(this.series);
      try {
        const prices = await getPolymarketWindowAssetPricesForPair(asset, timeframe, pair);
        const live = applyRtdsLivePrice(asset, prices);
        this.state.prevCloseAsset = live.prevCloseAsset;
        this.state.assetPrice = live.assetPrice;
        this.state.assetGap = live.assetGap;
      } catch {
        const live = chainlinkPriceFeed.getLivePrice(asset);
        if (live) {
          this.state.assetPrice = live.value;
          if (this.state.prevCloseAsset != null) {
            this.state.assetGap = live.value - this.state.prevCloseAsset;
          }
        }
      }

      this.updateQuotesFromCache();
    } catch (err) {
      logService.error("display", `Sample error (${this.series}): ${String(err)}`);
    } finally {
      this.sampleInFlight = false;
    }
  }
}

export const displayService = new DisplayService();
