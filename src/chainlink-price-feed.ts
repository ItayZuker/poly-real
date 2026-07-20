const RTDS_URL = "wss://ws-live-data.polymarket.com";
const PING_INTERVAL_MS = 5_000;
/** Whole-socket silence (no crypto_prices messages at all). */
const CONNECTION_STALL_TIMEOUT_MS = 45_000;
/** Per-asset silence — BTC can freeze while ETH/SOL still keep the socket alive. */
const ASSET_STALL_TIMEOUT_MS = 20_000;
const STALL_CHECK_INTERVAL_MS = 2_000;
const RECONNECT_DELAY_MS = 2_000;
const MAX_TICKS_PER_ASSET = 1_200;
const BOUNDARY_CAPTURE_MS = 2_500;
const BOUNDARY_TIMER_OFFSET_MS = 80;
const WINDOW_DURATIONS_SEC = [300, 900] as const;
const TRACKED_ASSETS = ["btc", "eth", "sol"] as const;

const CHAINLINK_SYMBOL_BY_ASSET: Record<string, string> = {
  btc: "btc/usd",
  eth: "eth/usd",
  sol: "sol/usd",
};

const ASSET_BY_CHAINLINK_SYMBOL = Object.fromEntries(
  Object.entries(CHAINLINK_SYMBOL_BY_ASSET).map(([asset, symbol]) => [symbol, asset]),
);

interface PriceEntry {
  value: number;
  timestampMs: number;
  receivedAtMs: number;
}

interface PriceTick {
  value: number;
  timestampMs: number;
}

export class ChainlinkPriceFeed {
  private ws: WebSocket | null = null;
  private prices = new Map<string, PriceEntry>();
  private tickHistory = new Map<string, PriceTick[]>();
  private windowOpens = new Map<string, number>();
  private windowCloses = new Map<string, number>();
  private boundaryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private boundaryCaptureDeltaMs = new Map<string, number>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private stallTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastMessageAtMs = 0;
  private started = false;
  private connecting = false;
  private tearingDown = false;
  private listeners = new Set<(asset: string, timestampMs: number) => void>();
  private stallListeners = new Set<(asset: string) => void>();
  /** Assets currently in a stall episode (cleared when a fresh tick arrives). */
  private assetsInStall = new Set<string>();

  start(): void {
    if (this.started) return;
    this.started = true;
    this.connect();
    this.scheduleAllBoundaryCaptures();
  }

  stop(): void {
    this.started = false;
    this.clearBoundaryTimers();
    this.clearTimers();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  scheduleAllBoundaryCaptures(): void {
    for (const asset of TRACKED_ASSETS) {
      for (const durationSec of WINDOW_DURATIONS_SEC) {
        this.scheduleBoundaryCapture(asset, durationSec);
      }
    }
  }

  getLivePrice(asset: string, options?: { maxAgeMs?: number }): PriceEntry | undefined {
    const entry = this.prices.get(asset.toLowerCase());
    if (!entry) return undefined;
    if (
      options?.maxAgeMs != null &&
      Date.now() - entry.receivedAtMs > options.maxAgeMs
    ) {
      return undefined;
    }
    return entry;
  }

  /** True when we have a recent tick for this asset. */
  isAssetFresh(asset: string, maxAgeMs = ASSET_STALL_TIMEOUT_MS): boolean {
    return this.getLivePrice(asset, { maxAgeMs }) != null;
  }

  findClosestTick(
    asset: string,
    targetMs: number,
    maxDeltaMs = BOUNDARY_CAPTURE_MS,
  ): PriceTick | undefined {
    const ticks = this.tickHistory.get(asset.toLowerCase());
    if (!ticks?.length) {
      return undefined;
    }

    let best: PriceTick | undefined;
    let bestDelta = Infinity;
    let bestAfter: PriceTick | undefined;
    let bestAfterDelta = Infinity;

    for (const tick of ticks) {
      const delta = Math.abs(tick.timestampMs - targetMs);
      if (delta > maxDeltaMs) {
        continue;
      }
      if (tick.timestampMs >= targetMs && tick.timestampMs - targetMs < bestAfterDelta) {
        bestAfterDelta = tick.timestampMs - targetMs;
        bestAfter = tick;
      }
      if (delta < bestDelta) {
        bestDelta = delta;
        best = tick;
      }
    }

    return bestAfter ?? best;
  }

  getPriceAtWindowStart(asset: string, windowStartSec: number): number | undefined {
    const stored = this.getWindowOpen(asset, windowStartSec);
    const storedDelta = this.boundaryCaptureDeltaMs.get(this.windowKey(asset, windowStartSec));
    // Reject opens that were not captured near the boundary (e.g. old live fallback).
    if (stored != null && (storedDelta == null || storedDelta <= BOUNDARY_CAPTURE_MS)) {
      return stored;
    }

    const tick = this.findClosestTick(asset, windowStartSec * 1000);
    if (tick != null) {
      this.recordBoundaryCapture(asset, windowStartSec, tick.value, tick.timestampMs);
      return tick.value;
    }

    return undefined;
  }

  getWindowOpen(asset: string, windowStartSec: number): number | undefined {
    return this.windowOpens.get(this.windowKey(asset, windowStartSec));
  }

  getWindowClose(asset: string, windowStartSec: number): number | undefined {
    return this.windowCloses.get(this.windowKey(asset, windowStartSec));
  }

  setWindowOpen(asset: string, windowStartSec: number, price: number): void {
    this.windowOpens.set(this.windowKey(asset, windowStartSec), price);
  }

  setWindowClose(asset: string, windowStartSec: number, price: number): void {
    this.windowCloses.set(this.windowKey(asset, windowStartSec), price);
  }

  getPriceToBeat(
    asset: string,
    windowStartSec: number,
    prevWindowStartSec?: number,
  ): number | undefined {
    const atStart = this.getPriceAtWindowStart(asset, windowStartSec);
    if (atStart != null) {
      return atStart;
    }

    if (prevWindowStartSec != null) {
      const priorClose = this.getWindowClose(asset, prevWindowStartSec);
      if (priorClose != null) {
        this.setWindowOpen(asset, windowStartSec, priorClose);
        return priorClose;
      }
    }

    return undefined;
  }

  captureBoundary(
    asset: string,
    prevWindowStartSec: number,
    nextWindowStartSec: number,
    price: number,
    captureTimestampMs?: number,
  ): void {
    this.recordBoundaryCapture(
      asset,
      nextWindowStartSec,
      price,
      captureTimestampMs ?? nextWindowStartSec * 1000,
    );
    this.setWindowClose(asset, prevWindowStartSec, price);
  }

  tryCaptureEarlyWindowOpen(asset: string, windowStartSec: number): void {
    if (this.getWindowOpen(asset, windowStartSec) != null) {
      return;
    }

    const elapsedSec = Math.floor(Date.now() / 1000) - windowStartSec;
    if (elapsedSec < 0 || elapsedSec > 8) {
      return;
    }

    this.getPriceAtWindowStart(asset, windowStartSec);
  }

  private recordBoundaryCapture(
    asset: string,
    windowStartSec: number,
    price: number,
    captureTimestampMs: number,
  ): void {
    const key = this.windowKey(asset, windowStartSec);
    const targetMs = windowStartSec * 1000;
    const deltaMs = Math.abs(captureTimestampMs - targetMs);
    const existingDelta = this.boundaryCaptureDeltaMs.get(key);
    if (existingDelta != null && existingDelta <= deltaMs) {
      return;
    }

    this.boundaryCaptureDeltaMs.set(key, deltaMs);
    this.setWindowOpen(asset, windowStartSec, price);
  }

  private scheduleBoundaryCapture(asset: string, durationSec: number): void {
    const timerKey = `${asset}:${durationSec}`;
    const existing = this.boundaryTimers.get(timerKey);
    if (existing) {
      clearTimeout(existing);
    }

    const nowMs = Date.now();
    const nowSec = Math.floor(nowMs / 1000);
    const nextBoundarySec =
      (Math.floor(nowSec / durationSec) + 1) * durationSec;
    const delayMs = Math.max(
      0,
      nextBoundarySec * 1000 - nowMs + BOUNDARY_TIMER_OFFSET_MS,
    );

    const timer = setTimeout(() => {
      this.boundaryTimers.delete(timerKey);
      this.captureScheduledBoundary(asset, nextBoundarySec, durationSec);
      this.scheduleBoundaryCapture(asset, durationSec);
    }, delayMs);

    this.boundaryTimers.set(timerKey, timer);
  }

  private captureScheduledBoundary(
    asset: string,
    windowStartSec: number,
    durationSec: number,
  ): void {
    // Only accept a tick near the boundary. Never fall back to "live now" — if the
    // timer fires late that would lock a far-off price as PTB for the whole window.
    const tick = this.findClosestTick(asset, windowStartSec * 1000);
    if (!tick) {
      return;
    }

    this.captureBoundary(
      asset,
      windowStartSec - durationSec,
      windowStartSec,
      tick.value,
      tick.timestampMs,
    );
  }

  private tryCaptureFromTick(
    asset: string,
    timestampMs: number,
    value: number,
  ): void {
    for (const durationSec of WINDOW_DURATIONS_SEC) {
      const windowStartSec = Math.floor(timestampMs / 1000 / durationSec) * durationSec;
      const targetMs = windowStartSec * 1000;
      const deltaMs = Math.abs(timestampMs - targetMs);
      if (deltaMs > BOUNDARY_CAPTURE_MS) {
        continue;
      }

      const key = this.windowKey(asset, windowStartSec);
      const existingDelta = this.boundaryCaptureDeltaMs.get(key);
      if (existingDelta != null && existingDelta <= deltaMs) {
        continue;
      }

      this.captureBoundary(
        asset,
        windowStartSec - durationSec,
        windowStartSec,
        value,
        timestampMs,
      );
    }
  }

  private clearBoundaryTimers(): void {
    for (const timer of this.boundaryTimers.values()) {
      clearTimeout(timer);
    }
    this.boundaryTimers.clear();
  }

  private windowKey(asset: string, windowStartSec: number): string {
    return `${asset.toLowerCase()}:${windowStartSec}`;
  }

  private clearTimers(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.stallTimer) {
      clearInterval(this.stallTimer);
      this.stallTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (!this.started || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, RECONNECT_DELAY_MS);
  }

  private connect(): void {
    if (!this.started || this.connecting || this.ws) return;
    this.connecting = true;

    try {
      const ws = new WebSocket(RTDS_URL);
      this.ws = ws;

      ws.addEventListener("open", () => {
        this.connecting = false;
        this.lastMessageAtMs = Date.now();
        ws.send(
          JSON.stringify({
            action: "subscribe",
            subscriptions: [
              {
                topic: "crypto_prices_chainlink",
                type: "*",
                filters: "",
              },
            ],
          }),
        );
        this.clearTimers();
        this.pingTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send("PING");
          }
        }, PING_INTERVAL_MS);
        this.stallTimer = setInterval(() => {
          this.checkStalls();
        }, STALL_CHECK_INTERVAL_MS);
      });

      ws.addEventListener("message", (event: MessageEvent) => {
        const raw = typeof event.data === "string" ? event.data : String(event.data);
        if (!raw || raw === "PONG" || raw === "PING") return;
        this.lastMessageAtMs = Date.now();
        this.handleMessage(raw);
      });

      ws.addEventListener("close", () => {
        this.tearingDown = false;
        this.ws = null;
        this.connecting = false;
        this.clearTimers();
        this.scheduleReconnect();
      });

      ws.addEventListener("error", () => {
        // close handler runs cleanup
      });
    } catch {
      this.connecting = false;
      this.scheduleReconnect();
    }
  }

  private checkStalls(): void {
    const now = Date.now();
    const stalledAssets: string[] = [];

    const connectionStalled =
      this.lastMessageAtMs > 0 &&
      now - this.lastMessageAtMs > CONNECTION_STALL_TIMEOUT_MS;

    for (const asset of TRACKED_ASSETS) {
      const entry = this.prices.get(asset);
      if (!entry) continue;
      const assetStale = now - entry.receivedAtMs > ASSET_STALL_TIMEOUT_MS;
      if (!assetStale && !connectionStalled) continue;
      if (this.assetsInStall.has(asset)) continue;
      this.assetsInStall.add(asset);
      stalledAssets.push(asset);
    }

    if (stalledAssets.length === 0 && !connectionStalled) return;

    for (const asset of stalledAssets) {
      this.prices.delete(asset);
      this.notifyStall(asset);
    }

    this.forceReconnect();
  }

  private forceReconnect(): void {
    if (this.tearingDown) return;
    this.clearTimers();
    const ws = this.ws;
    if (!ws) {
      this.connecting = false;
      this.scheduleReconnect();
      return;
    }
    if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      this.ws = null;
      this.connecting = false;
      this.scheduleReconnect();
      return;
    }
    this.tearingDown = true;
    this.ws = null;
    this.connecting = false;
    try {
      ws.close();
    } catch {
      this.tearingDown = false;
      this.scheduleReconnect();
    }
  }

  private handleMessage(raw: string): void {
    let message: {
      topic?: string;
      type?: string;
      payload?: {
        symbol?: string;
        value?: number;
        timestamp?: number;
        data?: Array<{ timestamp?: number; value?: number }>;
      };
    };

    try {
      message = JSON.parse(raw) as typeof message;
    } catch {
      return;
    }

    if (message.topic !== "crypto_prices_chainlink") return;

    const payload = message.payload;
    if (!payload) return;

    if (Array.isArray(payload.data)) {
      for (const point of payload.data) {
        this.storePoint(payload.symbol, point.value, point.timestamp);
      }
      return;
    }

    this.storePoint(payload.symbol, payload.value, payload.timestamp);
  }

  private storePoint(symbol: string | undefined, value: unknown, timestampMs: unknown): void {
    if (!symbol) return;
    const asset = ASSET_BY_CHAINLINK_SYMBOL[symbol.toLowerCase()];
    if (!asset) return;

    const parsedValue = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsedValue)) return;

    const ts =
      typeof timestampMs === "number" && Number.isFinite(timestampMs)
        ? timestampMs
        : Date.now();

    this.prices.set(asset, {
      value: parsedValue,
      timestampMs: ts,
      receivedAtMs: Date.now(),
    });
    this.assetsInStall.delete(asset);

    const ticks = this.tickHistory.get(asset) ?? [];
    ticks.push({ value: parsedValue, timestampMs: ts });
    if (ticks.length > MAX_TICKS_PER_ASSET) {
      ticks.splice(0, ticks.length - MAX_TICKS_PER_ASSET);
    }
    this.tickHistory.set(asset, ticks);

    this.tryCaptureFromTick(asset, ts, parsedValue);
    this.notifyUpdate(asset, ts);
  }

  onUpdate(listener: (asset: string, timestampMs: number) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onAssetStall(listener: (asset: string) => void): () => void {
    this.stallListeners.add(listener);
    return () => this.stallListeners.delete(listener);
  }

  private notifyUpdate(asset: string, timestampMs: number): void {
    for (const listener of this.listeners) {
      listener(asset, timestampMs);
    }
  }

  private notifyStall(asset: string): void {
    for (const listener of this.stallListeners) {
      listener(asset);
    }
  }
}

export const chainlinkPriceFeed = new ChainlinkPriceFeed();
export { ASSET_STALL_TIMEOUT_MS };
