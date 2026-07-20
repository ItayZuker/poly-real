import {
  parseBookSide,
  mergeBestLevelsIntoDepth,
  type BookLevel,
  type MarketInfo,
} from "./clob-service.js";
import { logService } from "./log-service.js";

const CLOB_MARKET_WS = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const PING_INTERVAL_MS = 10_000;
const RECONNECT_DELAY_MS = 2_000;

type UpdateListener = (tokenIds: string[]) => void;

export interface ClobRawMessageEvent {
  tMs: number;
  payload: unknown;
  tokenIds: string[];
}

type RawMessageListener = (event: ClobRawMessageEvent) => void;

interface TokenBookState {
  tokenId: string;
  tickSize: string;
  negRisk: boolean;
  midpoint?: number;
  bestBid?: number;
  bestAsk?: number;
  bestBidSize?: number;
  bestAskSize?: number;
  lastTradePrice?: number;
  bids: BookLevel[];
  asks: BookLevel[];
  updatedAtMs: number;
}

export interface BookDepth {
  bids: BookLevel[];
  asks: BookLevel[];
  bestBid?: number;
  bestAsk?: number;
  bestBidSize?: number;
  bestAskSize?: number;
}

function booksEqual(a: BookLevel[], b: BookLevel[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].price !== b[i].price || a[i].size !== b[i].size) return false;
  }
  return true;
}

function parsePrice(value: unknown): number | undefined {
  if (value == null) return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function syncMidpoint(state: TokenBookState): void {
  if (state.bestBid != null && state.bestAsk != null) {
    state.midpoint = (state.bestBid + state.bestAsk) / 2;
  }
}

/** True when the socket cache has any usable top-of-book for this token. */
export function hasSocketBook(info: MarketInfo | undefined): boolean {
  if (!info) return false;
  return (
    (info.bids?.length ?? 0) > 0 ||
    (info.asks?.length ?? 0) > 0 ||
    info.bestBid != null ||
    info.bestAsk != null
  );
}

/**
 * Live CLOB market feed — book state is driven only by the market WebSocket.
 * Token discovery (Gamma/slug) is separate; REST order books are not applied.
 */
export class ClobMarketFeed {
  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastPingSentMs: number | null = null;
  private feedLatencyMs: number | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private connecting = false;
  private tokens = new Map<string, TokenBookState>();
  private subscribedIds = new Set<string>();
  private listeners = new Set<UpdateListener>();
  private rawListeners = new Set<RawMessageListener>();

  start(): void {
    if (this.started) return;
    this.started = true;
    this.connect();
  }

  stop(): void {
    this.started = false;
    this.clearPingTimer();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  onUpdate(listener: UpdateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onRawMessage(listener: RawMessageListener): () => void {
    this.rawListeners.add(listener);
    return () => this.rawListeners.delete(listener);
  }

  private notifyRawMessage(event: ClobRawMessageEvent): void {
    for (const listener of this.rawListeners) {
      listener(event);
    }
  }

  private notifyUpdate(tokenIds: string[]): void {
    if (tokenIds.length === 0) return;
    for (const listener of this.listeners) {
      listener(tokenIds);
    }
  }

  getCachedMarketInfo(tokenId: string): MarketInfo | undefined {
    const state = this.tokens.get(tokenId);
    if (!state) return undefined;
    return {
      tokenId: state.tokenId,
      tickSize: state.tickSize,
      negRisk: state.negRisk,
      midpoint: state.midpoint,
      bestBid: state.bestBid,
      bestAsk: state.bestAsk,
      bestBidSize: state.bestBidSize,
      bestAskSize: state.bestAskSize,
      lastTradePrice: state.lastTradePrice,
      bids: state.bids,
      asks: state.asks,
    };
  }

  getFeedLatencyMs(): number | undefined {
    return this.feedLatencyMs ?? undefined;
  }

  getCachedBookDepth(tokenId: string): BookDepth | undefined {
    const state = this.tokens.get(tokenId);
    if (!state) return undefined;
    return mergeBestLevelsIntoDepth({
      bids: state.bids,
      asks: state.asks,
      bestBid: state.bestBid,
      bestAsk: state.bestAsk,
      bestBidSize: state.bestBidSize,
      bestAskSize: state.bestAskSize,
    });
  }

  /** Subscribe tokens on the market WS without REST book seeding. */
  ensureSubscribed(tokenIds: string[]): void {
    const unique = [...new Set(tokenIds.filter(Boolean))];
    if (unique.length === 0) return;

    const toSubscribe = unique.filter((id) => !this.subscribedIds.has(id));
    for (const id of unique) {
      this.subscribedIds.add(id);
      if (!this.tokens.has(id)) {
        this.tokens.set(id, {
          tokenId: id,
          tickSize: "0.01",
          negRisk: false,
          bids: [],
          asks: [],
          updatedAtMs: Date.now(),
        });
      }
    }

    if (toSubscribe.length === 0) return;

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.sendSubscribe(toSubscribe);
      return;
    }

    this.connect();
  }

  /**
   * Keep only these token subscriptions (current window + optional prefetch).
   * Unsubscribes and drops book state for everything else.
   * Prefer setOwnerSubscriptions when multiple feeds share the socket.
   */
  setDesiredSubscriptions(tokenIds: string[]): void {
    this.setOwnerSubscriptions("default", tokenIds);
  }

  private readonly ownerSubscriptions = new Map<string, string[]>();

  /**
   * Merge token subscriptions across named owners (display UI + background
   * trading feeds). Reconciles the socket to the union of all owners.
   */
  setOwnerSubscriptions(owner: string, tokenIds: string[]): void {
    const key = String(owner || "default").trim() || "default";
    const desired = [...new Set(tokenIds.filter(Boolean))];
    if (desired.length === 0) {
      this.ownerSubscriptions.delete(key);
    } else {
      this.ownerSubscriptions.set(key, desired);
    }
    this.reconcileOwnerSubscriptions();
  }

  clearOwnerSubscriptions(owner: string): void {
    const key = String(owner || "default").trim() || "default";
    if (!this.ownerSubscriptions.has(key)) return;
    this.ownerSubscriptions.delete(key);
    this.reconcileOwnerSubscriptions();
  }

  private reconcileOwnerSubscriptions(): void {
    const desired = [...new Set([...this.ownerSubscriptions.values()].flat())];
    const desiredSet = new Set(desired);

    const toRemove = [...this.subscribedIds].filter((id) => !desiredSet.has(id));
    if (toRemove.length > 0) {
      this.unsubscribe(toRemove);
    }

    this.ensureSubscribed(desired);
  }

  unsubscribe(tokenIds: string[]): void {
    const unique = [...new Set(tokenIds.filter(Boolean))];
    const toDrop = unique.filter((id) => this.subscribedIds.has(id));
    if (toDrop.length === 0) return;

    for (const id of toDrop) {
      this.subscribedIds.delete(id);
      this.tokens.delete(id);
    }

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          assets_ids: toDrop,
          operation: "unsubscribe",
        }),
      );
    }
  }

  private sendSubscribe(tokenIds: string[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || tokenIds.length === 0) {
      return;
    }

    this.ws.send(
      JSON.stringify({
        assets_ids: tokenIds,
        operation: "subscribe",
      }),
    );
  }

  private sendInitialSubscribe(): void {
    const ids = [...this.subscribedIds];
    if (ids.length === 0 || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      JSON.stringify({
        assets_ids: ids,
        type: "market",
        custom_feature_enabled: true,
      }),
    );
  }

  private connect(): void {
    if (!this.started || this.connecting || this.ws) return;
    this.connecting = true;

    try {
      const ws = new WebSocket(CLOB_MARKET_WS);
      this.ws = ws;

      ws.addEventListener("open", () => {
        this.connecting = false;
        logService.success("clob", "WebSocket connected");
        this.sendInitialSubscribe();
        this.clearPingTimer();
        this.pingTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            this.lastPingSentMs = Date.now();
            ws.send("PING");
          }
        }, PING_INTERVAL_MS);
      });

      ws.addEventListener("message", (event: MessageEvent) => {
        const raw = typeof event.data === "string" ? event.data : String(event.data);
        if (!raw) return;
        if (raw === "PONG") {
          if (this.lastPingSentMs != null) {
            this.feedLatencyMs = Math.max(0, Date.now() - this.lastPingSentMs);
            this.lastPingSentMs = null;
          }
          return;
        }
        if (raw === "PING") return;
        this.handleMessage(raw);
      });

      ws.addEventListener("close", () => {
        this.ws = null;
        this.connecting = false;
        this.clearPingTimer();
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

  private scheduleReconnect(): void {
    if (!this.started || this.reconnectTimer) return;
    logService.warn("clob", `Reconnecting in ${RECONNECT_DELAY_MS} ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, RECONNECT_DELAY_MS);
  }

  private clearPingTimer(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private handleMessage(raw: string): void {
    const tMs = Date.now();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    const messages = Array.isArray(parsed) ? parsed : [parsed];
    const updated = new Set<string>();

    for (const message of messages) {
      const tokenId = this.applyMarketEvent(message as Record<string, unknown>);
      if (tokenId) updated.add(tokenId);
    }

    if (updated.size > 0) {
      const tokenIds = [...updated];
      this.notifyRawMessage({ tMs, payload: parsed, tokenIds });
      this.notifyUpdate(tokenIds);
    }
  }

  private applyMarketEvent(message: Record<string, unknown>): string | undefined {
    const eventType = typeof message.event_type === "string" ? message.event_type : "";
    const assetId =
      typeof message.asset_id === "string"
        ? message.asset_id
        : undefined;

    if (eventType === "book" && assetId) {
      return this.applyBookEvent(assetId, message);
    }

    if (eventType === "best_bid_ask" && assetId) {
      return this.applyBestBidAsk(assetId, message.best_bid, message.best_ask);
    }

    if (eventType === "last_trade_price" && assetId) {
      return this.applyLastTrade(assetId, message.price);
    }

    if (eventType === "price_change" && Array.isArray(message.price_changes)) {
      let lastUpdated: string | undefined;
      for (const change of message.price_changes as Record<string, unknown>[]) {
        const changeAssetId =
          typeof change.asset_id === "string" ? change.asset_id : undefined;
        if (!changeAssetId) continue;
        const updated = this.applyBestBidAsk(
          changeAssetId,
          change.best_bid,
          change.best_ask,
        );
        if (updated) lastUpdated = updated;
      }
      return lastUpdated;
    }

    return undefined;
  }

  private getOrCreateState(tokenId: string): TokenBookState | undefined {
    const existing = this.tokens.get(tokenId);
    if (existing) return existing;
    if (!this.subscribedIds.has(tokenId)) return undefined;
    const created: TokenBookState = {
      tokenId,
      tickSize: "0.01",
      negRisk: false,
      bids: [],
      asks: [],
      updatedAtMs: Date.now(),
    };
    this.tokens.set(tokenId, created);
    return created;
  }

  private applyBookEvent(
    tokenId: string,
    message: Record<string, unknown>,
  ): string | undefined {
    const state = this.getOrCreateState(tokenId);
    if (!state) return undefined;

    const bids = message.bids as Array<{ price?: unknown; size?: unknown }> | undefined;
    const asks = message.asks as Array<{ price?: unknown; size?: unknown }> | undefined;

    if (bids) {
      const parsedBids = parseBookSide(bids, "bid");
      if (parsedBids.length > 0) {
        state.bids = parsedBids;
        const bidLevel = state.bids[0];
        state.bestBid = bidLevel.price;
        state.bestBidSize = bidLevel.size;
      }
    }
    if (asks) {
      const parsedAsks = parseBookSide(asks, "ask");
      if (parsedAsks.length > 0) {
        state.asks = parsedAsks;
        const askLevel = state.asks[0];
        state.bestAsk = askLevel.price;
        state.bestAskSize = askLevel.size;
      }
    }
    syncMidpoint(state);
    state.updatedAtMs = Date.now();
    return tokenId;
  }

  private applyBestBidAsk(
    tokenId: string,
    bestBidRaw: unknown,
    bestAskRaw: unknown,
  ): string | undefined {
    const state = this.getOrCreateState(tokenId);
    if (!state) return undefined;

    const bestBid = parsePrice(bestBidRaw);
    const bestAsk = parsePrice(bestAskRaw);
    const before = {
      bestBid: state.bestBid,
      bestAsk: state.bestAsk,
      bids: state.bids,
      asks: state.asks,
    };

    if (bestBid != null) {
      state.bestBid = bestBid;
    }
    if (bestAsk != null) {
      state.bestAsk = bestAsk;
    }

    const merged = mergeBestLevelsIntoDepth({
      bids: state.bids,
      asks: state.asks,
      bestBid: state.bestBid,
      bestAsk: state.bestAsk,
      bestBidSize: state.bestBidSize,
      bestAskSize: state.bestAskSize,
    });
    state.bids = merged.bids;
    state.asks = merged.asks;

    if (
      before.bestBid === state.bestBid &&
      before.bestAsk === state.bestAsk &&
      booksEqual(before.bids, state.bids) &&
      booksEqual(before.asks, state.asks)
    ) {
      return undefined;
    }

    syncMidpoint(state);
    state.updatedAtMs = Date.now();
    return tokenId;
  }

  private applyLastTrade(tokenId: string, priceRaw: unknown): string | undefined {
    const state = this.getOrCreateState(tokenId);
    if (!state) return undefined;

    const price = parsePrice(priceRaw);
    if (price == null || state.lastTradePrice === price) return undefined;

    state.lastTradePrice = price;
    state.updatedAtMs = Date.now();
    return tokenId;
  }
}

export const clobMarketFeed = new ClobMarketFeed();
