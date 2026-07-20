import { createPublicClient, getClobHost, getChainId } from "./clob-service.js";
import { clobMarketFeed } from "./clob-market-feed.js";
import { getPolymarketWindowAssetPricesForPair } from "./asset-price-service.js";
import {
  fetchCurrentUpDownMarket,
  fetchCurrentUpDownMarketWithRetry,
} from "./market-pair.js";
import { parseMarketSeries } from "./market-pair.js";
import { takeLevels } from "./book-depth.js";
import { pickDisplayPrice } from "./quote-price.js";
import { recordAskSamples } from "./phase-config.js";
import { getPtbSide, type PtbSide } from "./window-dynamics.js";
import { resolveTakerFeeParams } from "./taker-fee.js";
import { logService } from "./log-service.js";
import type { LiveWindowState } from "./types.js";

/**
 * Background market feeds for series that live-trading engines are bound to
 * but that are not the UI display series. Prevents one viewer's market select
 * from being the only tick source for all users.
 */
class SeriesFeed {
  private yesTokenId: string | null = null;
  private noTokenId: string | null = null;
  private sampleInFlight = false;
  private lastPtbSide: PtbSide | null = null;
  private state: LiveWindowState;

  constructor(private readonly series: string) {
    const now = Math.floor(Date.now() / 1000);
    this.state = {
      series,
      windowStart: now,
      windowEnd: now + 300,
      priceHistory: [],
      ptbCrossings: 0,
      bookTickSequence: 0,
      upAskCentsSamples: [],
      downAskCentsSamples: [],
    };
  }

  getState(): LiveWindowState {
    return {
      ...this.state,
      priceHistory: [...this.state.priceHistory],
      upAskCentsSamples: [...(this.state.upAskCentsSamples ?? [])],
      downAskCentsSamples: [...(this.state.downAskCentsSamples ?? [])],
    };
  }

  private ownerKey(): string {
    return `hub:${this.series}`;
  }

  private syncClobSubscriptions(): void {
    const ids = [this.yesTokenId, this.noTokenId].filter((id): id is string => Boolean(id));
    clobMarketFeed.setOwnerSubscriptions(this.ownerKey(), ids);
  }

  dispose(): void {
    clobMarketFeed.clearOwnerSubscriptions(this.ownerKey());
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
    recordAskSamples(this.state);
  }

  private applyPolymarketAssetPrices(prices: {
    assetPrice?: number;
    prevCloseAsset?: number;
    assetGap?: number;
    priceToBeatSource?: LiveWindowState["priceToBeatSource"];
  }): void {
    if (prices.prevCloseAsset != null) {
      this.state.prevCloseAsset = prices.prevCloseAsset;
      this.state.priceToBeatSource = prices.priceToBeatSource ?? "polymarket-openPrice";
    }
    if (prices.assetPrice != null) {
      this.state.assetPrice = prices.assetPrice;
      const tickMs = Date.now();
      this.state.lastTickMs = tickMs;
      const tickSec = tickMs / 1000;
      if (tickSec >= this.state.windowStart && tickSec < this.state.windowEnd) {
        const history = this.state.priceHistory;
        const last = history[history.length - 1];
        if (!last || last.price !== prices.assetPrice || tickSec - last.t >= 0.4) {
          history.push({ t: tickSec, price: prices.assetPrice });
          if (history.length > 2000) {
            history.splice(0, history.length - 2000);
          }
        }
      }
    }
    if (this.state.assetPrice != null && this.state.prevCloseAsset != null) {
      this.state.assetGap = this.state.assetPrice - this.state.prevCloseAsset;
      const ptbSide = getPtbSide(this.state.assetPrice, this.state.prevCloseAsset);
      if (ptbSide != null) {
        if (this.lastPtbSide != null && this.lastPtbSide !== ptbSide) {
          this.state.ptbCrossings = (this.state.ptbCrossings ?? 0) + 1;
        }
        this.lastPtbSide = ptbSide;
      }
    } else if (prices.assetGap != null) {
      this.state.assetGap = prices.assetGap;
    }
  }

  async sample(): Promise<void> {
    if (this.sampleInFlight) return;
    this.sampleInFlight = true;
    try {
      let pair;
      try {
        pair = await fetchCurrentUpDownMarket(this.series);
      } catch {
        pair = await fetchCurrentUpDownMarketWithRetry(this.series, { maxWaitMs: 5000 });
      }
      if (!pair.windowStart || !pair.windowEnd) return;

      if (this.state.windowStart !== pair.windowStart) {
        this.state.priceHistory = [];
        this.state.ptbCrossings = 0;
        this.state.bookTickSequence = 0;
        this.lastPtbSide = null;
        this.state.upAskCentsSamples = [];
        this.state.downAskCentsSamples = [];
        // Keep prevCloseAsset / priceToBeatSource until Polymarket open arrives.
      }

      this.state.series = this.series;
      this.state.windowStart = pair.windowStart;
      this.state.windowEnd = pair.windowEnd;
      this.state.slug = pair.slug;
      this.state.question = pair.question;
      this.yesTokenId = pair.yesTokenId;
      this.noTokenId = pair.noTokenId;
      this.syncClobSubscriptions();

      void createPublicClient(getClobHost(), getChainId())
        .then((client) => resolveTakerFeeParams(client, pair.yesTokenId))
        .catch(() => {});

      const { asset, timeframe } = parseMarketSeries(this.series);
      try {
        const prices = await getPolymarketWindowAssetPricesForPair(asset, timeframe, pair);
        this.applyPolymarketAssetPrices(prices);
      } catch {
        // Keep last Polymarket print; do not fall back to Chainlink.
      }

      this.updateQuotesFromCache();
    } catch (err) {
      logService.warn("series-hub", `Sample error (${this.series}): ${String(err)}`);
    } finally {
      this.sampleInFlight = false;
    }
  }
}

class SeriesMarketHub {
  private readonly feeds = new Map<string, SeriesFeed>();
  private interval: ReturnType<typeof setInterval> | null = null;
  private activeSeries = new Set<string>();

  async ensureSeries(seriesList: string[]): Promise<void> {
    this.setActiveSeries(seriesList);
    await Promise.all(
      seriesList
        .map((s) => this.feeds.get(String(s || "").trim()))
        .filter((f): f is SeriesFeed => Boolean(f))
        .map((f) => f.sample()),
    );
  }

  setActiveSeries(seriesList: string[]): void {
    const next = new Set(
      seriesList.map((s) => String(s || "").trim()).filter(Boolean),
    );
    this.activeSeries = next;

    for (const [series, feed] of this.feeds) {
      if (!next.has(series)) {
        feed.dispose();
        this.feeds.delete(series);
      }
    }
    for (const series of next) {
      if (!this.feeds.has(series)) {
        this.feeds.set(series, new SeriesFeed(series));
      }
    }

    if (next.size > 0) this.start();
    else this.stop();
  }

  getState(series: string): LiveWindowState | null {
    return this.feeds.get(series)?.getState() ?? null;
  }

  private start(): void {
    if (this.interval) return;
    void this.sampleAll();
    this.interval = setInterval(() => void this.sampleAll(), 500);
  }

  private stop(): void {
    if (!this.interval) return;
    clearInterval(this.interval);
    this.interval = null;
  }

  private async sampleAll(): Promise<void> {
    await Promise.all([...this.feeds.values()].map((f) => f.sample()));
  }
}

export const seriesMarketHub = new SeriesMarketHub();
