import type { MarketDocument } from "./types.js";
import { listMarkets } from "./db/market-repository.js";
import { MarketRecorder } from "./market-recorder.js";
import { chainlinkPriceFeed } from "./chainlink-price-feed.js";
import { parseMarketSeries } from "./market-pair.js";
import { logService } from "./log-service.js";

export class RecordingManager {
  private recorders = new Map<string, MarketRecorder>();
  private onChange: ((series: string) => void) | null = null;
  private stallUnsub: (() => void) | null = null;

  setOnChange(listener: (series: string) => void): void {
    this.onChange = listener;
  }

  private ensureStallHandler(): void {
    if (this.stallUnsub) return;
    this.stallUnsub = chainlinkPriceFeed.onAssetStall((asset) => {
      logService.warn("chainlink", `${asset.toUpperCase()} price stalled — reconnecting RTDS`);
      this.discardWindowsForAsset(asset);
    });
  }

  private discardWindowsForAsset(asset: string): void {
    const target = asset.toLowerCase();
    for (const [series, recorder] of this.recorders) {
      try {
        const { asset: seriesAsset } = parseMarketSeries(series);
        if (seriesAsset !== target) continue;
        recorder.discardActiveWindow(`chainlink ${target} stall`);
      } catch {
        // ignore unknown series ids
      }
    }
  }

  async sync(): Promise<void> {
    this.ensureStallHandler();
    const markets = await listMarkets();
    const enabled = new Set(
      markets.filter((m) => m.recordingEnabled).map((m) => m._id),
    );

    for (const [series, recorder] of this.recorders) {
      if (!enabled.has(series)) {
        recorder.stop();
        this.recorders.delete(series);
      }
    }

    for (const market of markets) {
      if (!market.recordingEnabled) continue;
      const existing = this.recorders.get(market._id);
      if (existing) continue;
      const recorder = new MarketRecorder(market, (s) => this.onChange?.(s));
      recorder.start();
      this.recorders.set(market._id, recorder);
    }
  }

  async refreshMarket(market: MarketDocument): Promise<void> {
    this.ensureStallHandler();
    const existing = this.recorders.get(market._id);
    if (market.recordingEnabled) {
      if (existing) {
        existing.stop();
        this.recorders.delete(market._id);
      }
      const recorder = new MarketRecorder(market, (s) => this.onChange?.(s));
      recorder.start();
      this.recorders.set(market._id, recorder);
    } else if (existing) {
      existing.stop();
      this.recorders.delete(market._id);
    }
  }

  getRecorder(series: string): MarketRecorder | undefined {
    return this.recorders.get(series);
  }

  getActiveWindow(series: string) {
    return this.recorders.get(series)?.getActiveWindow() ?? null;
  }

  getTraderStats(series: string) {
    return this.recorders.get(series)?.getTraderStats() ?? null;
  }

  stopAll(): void {
    if (this.stallUnsub) {
      this.stallUnsub();
      this.stallUnsub = null;
    }
    for (const recorder of this.recorders.values()) {
      recorder.stop();
    }
    this.recorders.clear();
  }
}

export const recordingManager = new RecordingManager();
