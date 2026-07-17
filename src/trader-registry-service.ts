import { SEED_MARKETS } from "./collections.js";
import { enrichWindowWithUniqueTraders } from "./market-participants.js";
import {
  buildUpDownSlug,
  getUpDownDuration,
  parseMarketSeries,
} from "./market-pair.js";
import { displayService } from "./display-service.js";
import { logService } from "./log-service.js";

/** How often to check for rolled windows across all seed markets. */
const POLL_MS = 30_000;

/**
 * After a window ends, wait briefly so Polymarket Data API trades can settle
 * (enrichWindowWithUniqueTraders also waits POST_WINDOW_SETTLE_MS).
 */
const POST_ROLL_DELAY_MS = 3_000;

type TrackedWindow = {
  windowStart: number;
  windowEnd: number;
  slug: string;
};

/**
 * Watches all seed market series; when a window rolls, fetches unique traders
 * from Polymarket and upserts them into Mongo `trader_wallets`.
 */
class TraderRegistryService {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Last observed live windowStart per series. */
  private lastWindowStart = new Map<string, number>();
  /** Windows currently being registered (or already done this process). */
  private handled = new Set<string>();
  private inFlight = 0;

  start(): void {
    if (this.timer) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), POLL_MS);
    this.timer.unref?.();
    logService.info("traders", "Trader registry watcher started");
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private handleKey(series: string, windowStart: number): string {
    return `${series}:${windowStart}`;
  }

  private currentWindow(series: string, nowSec = Math.floor(Date.now() / 1000)): TrackedWindow {
    const { asset, timeframe } = parseMarketSeries(series);
    const duration = getUpDownDuration(timeframe);
    const windowStart = Math.floor(nowSec / duration) * duration;
    return {
      windowStart,
      windowEnd: windowStart + duration,
      slug: buildUpDownSlug(asset, timeframe, windowStart),
    };
  }

  private previousWindows(
    series: string,
    fromStart: number,
    toStartExclusive: number,
  ): TrackedWindow[] {
    const { asset, timeframe } = parseMarketSeries(series);
    const duration = getUpDownDuration(timeframe);
    const out: TrackedWindow[] = [];
    for (let start = fromStart; start < toStartExclusive; start += duration) {
      out.push({
        windowStart: start,
        windowEnd: start + duration,
        slug: buildUpDownSlug(asset, timeframe, start),
      });
    }
    return out;
  }

  private isSelectedSeries(series: string): boolean {
    return displayService.getState().series === series;
  }

  private logSelected(
    level: "info" | "warn",
    series: string,
    message: string,
  ): void {
    if (!this.isSelectedSeries(series)) return;
    if (level === "warn") logService.warn("traders", message);
    else logService.info("traders", message);
  }

  private async poll(): Promise<void> {
    const nowSec = Math.floor(Date.now() / 1000);

    for (const { series } of SEED_MARKETS) {
      try {
        const current = this.currentWindow(series, nowSec);
        const last = this.lastWindowStart.get(series);

        if (last == null) {
          // First sighting: track live window, and register the just-ended one once.
          this.lastWindowStart.set(series, current.windowStart);
          const { timeframe } = parseMarketSeries(series);
          const duration = getUpDownDuration(timeframe);
          const prevStart = current.windowStart - duration;
          if (prevStart > 0) {
            void this.registerWindow(series, {
              windowStart: prevStart,
              windowEnd: current.windowStart,
              slug: buildUpDownSlug(parseMarketSeries(series).asset, timeframe, prevStart),
            });
          }
          continue;
        }

        if (current.windowStart > last) {
          const rolled = this.previousWindows(series, last, current.windowStart);
          this.lastWindowStart.set(series, current.windowStart);
          for (const window of rolled) {
            void this.registerWindow(series, window);
          }
        }
      } catch (err) {
        this.logSelected("warn", series, `Poll failed for ${series}: ${String(err)}`);
      }
    }
  }

  private async registerWindow(series: string, window: TrackedWindow): Promise<void> {
    const key = this.handleKey(series, window.windowStart);
    if (this.handled.has(key)) return;
    this.handled.add(key);

    // Bound memory of handled keys (keep recent ~2 days of 5m slots across 6 series ≈ plenty).
    if (this.handled.size > 4_000) {
      const drop = [...this.handled].slice(0, 1_000);
      for (const k of drop) this.handled.delete(k);
    }

    this.inFlight += 1;
    try {
      await sleep(POST_ROLL_DELAY_MS);
      const input: {
        windowStart: number;
        windowEnd: number;
        slug: string;
        uniqueTraders?: number;
        newWallets?: number;
        knownWallets?: number;
      } = {
        windowStart: window.windowStart,
        windowEnd: window.windowEnd,
        slug: window.slug,
      };
      const enriched = await enrichWindowWithUniqueTraders(input, series, {
        force: true,
        waitForSettle: true,
      });

      const traders = enriched.uniqueTraders ?? 0;
      const neu = enriched.newWallets ?? 0;
      const known = enriched.knownWallets ?? 0;
      this.logSelected(
        "info",
        series,
        `${series} window ${window.windowStart}: ${traders} traders (${neu} new, ${known} known)`,
      );
    } catch (err) {
      // Allow retry on next process / later poll if we remove from handled.
      this.handled.delete(key);
      this.logSelected(
        "warn",
        series,
        `Failed to register traders for ${series} @ ${window.windowStart}: ${String(err)}`,
      );
    } finally {
      this.inFlight -= 1;
    }
  }
}
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const traderRegistryService = new TraderRegistryService();
