import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { initStorageAndSeed, ensureAllMarketIndexes, listMarkets, getMarket } from "./db/market-repository.js";
import { listReplayTicks } from "./db/replay-tick-repository.js";
import {
  listChainlinkTicks,
  listClobBookTicks,
  listClobRawTicks,
} from "./db/tick-repository.js";
import { clobMarketFeed } from "./clob-market-feed.js";
import { chainlinkPriceFeed } from "./chainlink-price-feed.js";
import { displayService } from "./display-service.js";
import { simulatorService } from "./simulator-service.js";
import { logService } from "./log-service.js";
import {
  deleteSchedulePlacement,
  deletePlacementsByDay,
  deletePlacementsBySetupId,
  deleteAllSchedulePlacementsForUser,
  ensureSchedulePlacementsUserId,
  getSchedulePlacementById,
  insertSchedulePlacement,
  listSchedulePlacements,
  replaceAllPlacementsSetup,
  replaceDayWithSetup,
  updatePlacementTitlesBySetupId,
  updateSchedulePlacement,
} from "./db/schedule-placement-repository.js";
import type { SchedulePlacementListItem } from "./db/schedule-placement-repository.js";
import {
  insertTradingSetup,
  listTradingSetups,
  getTradingSetupById,
  updateTradingSetup,
  deleteTradingSetup,
  deleteAllTradingSetupsForUser,
  reorderTradingSetups,
  normalizePhaseSetup,
  ensureTradingSetupsUserId,
} from "./db/trading-setup-repository.js";
import {
  reconcileLiveScheduleInUseFlags,
  syncLiveScheduleInUseForSetup,
} from "./db/live-schedule-setup-usage.js";
import {
  parseScheduleWorkspaceMode,
  type ScheduleWorkspaceMode,
} from "./schedule-workspace-mode.js";
import {
  deleteAllTradingSessionDataForUser,
  ensureTradingSessionMemoryUserId,
  sumTradingSessionMemory,
  sumTradingStatEventsForSeries,
} from "./db/trading-session-memory-repository.js";
import { closeMongoClient } from "./db/mongo-client.js";
import {
  getHeatmapState,
  loadAllHeatmapWindows,
  setHeatmapUpdateListener,
} from "./heatmap-service.js";
import type { EnrichedLiveWindowState, SimSetup } from "./types.js";
import {
  dropTradingClient,
  getTradingAccountStatus,
  isTradingConfigured,
  onBalanceRefresh,
  reconnectTradingClient,
  refreshCollateralBalance,
} from "./trading-client.js";
import { liveTradingRegistry } from "./live-trading-service.js";
import { isTradingExecutor } from "./trading-executor.js";
import { ensureWalletRegistryReady } from "./wallet-registry.js";
import { traderRegistryService } from "./trader-registry-service.js";
import {
  authenticateUser,
  deleteUserById,
  ensureDefaultUser,
  ensureUserIndexes,
  getBootstrapUserId,
  getUserPublicById,
  maybeBootstrapDefaultPassword,
  registerUser,
  updateUserProfile,
  updateUserWallet,
  type UserPublic,
} from "./db/user-repository.js";
import {
  buildClearSessionCookie,
  buildSessionCookie,
  createSession,
  destroySession,
  destroySessionsForUser,
  ensureSessionIndexes,
  getSessionTokenFromRequest,
  isSecureRequest,
  resolveSessionUserId,
} from "./auth/session.js";
import { ObjectId } from "mongodb";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3848;
/** Sparse Mongo → RAM heatmap refresh (sim upserts windows elsewhere). */
const HEATMAP_REFRESH_MS = 10 * 60 * 1000;
const publicDir = path.join(__dirname, "../public");

const app = express();
app.use(express.json());

function sendIndexHtml(_req: express.Request, res: express.Response): void {
  res.sendFile(path.join(publicDir, "index.html"));
}

// Exact SPA pages (before static so /docs is the app, not the docs/ folder).
app.get(["/docs", "/version"], sendIndexHtml);

app.use(
  express.static(publicDir, {
    setHeaders(res, filePath) {
      if (/\.(?:js|css|html)$/i.test(filePath)) {
        res.setHeader("Cache-Control", "no-cache");
      }
    },
  }),
);

type AuthedRequest = express.Request & { authUser?: UserPublic };

function requireUserId(req: express.Request): string {
  const user = (req as AuthedRequest).authUser;
  if (!user?.id) throw new Error("Unauthorized");
  return user.id;
}

function tradingFor(req: express.Request) {
  return liveTradingRegistry.get(requireUserId(req));
}

type SseClient = { id: number; res: express.Response; userId?: string };
let sseClients: SseClient[] = [];
let sseId = 0;

async function loadAuthUser(req: express.Request): Promise<UserPublic | null> {
  const token = getSessionTokenFromRequest(req.headers.cookie);
  const userId = await resolveSessionUserId(token);
  if (!userId) return null;
  return getUserPublicById(userId);
}

function isPublicAuthPath(req: express.Request): boolean {
  if (req.method === "POST" && req.path === "/api/auth/login") return true;
  if (req.method === "POST" && req.path === "/api/auth/register") return true;
  if (req.method === "GET" && req.path === "/api/auth/me") return true;
  return false;
}

async function requireAuth(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): Promise<void> {
  if (!req.path.startsWith("/api/")) {
    next();
    return;
  }
  if (isPublicAuthPath(req)) {
    next();
    return;
  }
  try {
    const user = await loadAuthUser(req);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    (req as AuthedRequest).authUser = user;
    next();
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}

app.use(requireAuth);

app.post("/api/auth/login", async (req, res) => {
  try {
    const body = (req.body ?? {}) as { email?: string; password?: string };
    const user = await authenticateUser(body.email ?? "", body.password ?? "");
    if (!user) {
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }
    const { token, expiresAt } = await createSession(new ObjectId(user.id));
    res.setHeader("Set-Cookie", buildSessionCookie(token, expiresAt, isSecureRequest(req)));
    res.json({ user });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/auth/register", async (req, res) => {
  try {
    const body = (req.body ?? {}) as {
      email?: string;
      password?: string;
      name?: string;
    };
    const user = await registerUser({
      email: body.email ?? "",
      password: body.password ?? "",
      name: body.name,
    });
    const { token, expiresAt } = await createSession(new ObjectId(user.id));
    res.setHeader("Set-Cookie", buildSessionCookie(token, expiresAt, isSecureRequest(req)));
    res.status(201).json({ user });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/api/auth/me", async (req, res) => {
  try {
    const user = await loadAuthUser(req);
    res.json({ user });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/api/auth/logout", async (req, res) => {
  try {
    const token = getSessionTokenFromRequest(req.headers.cookie);
    await destroySession(token);
    res.setHeader("Set-Cookie", buildClearSessionCookie(isSecureRequest(req)));
    // Live trading continues from server-side config — do not stop it on logout.
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.delete("/api/auth/account", async (req, res) => {
  try {
    const userId = requireUserId(req);
    const oid = new ObjectId(userId);

    await destroySessionsForUser(oid);

    // Cascade user-owned trading data before dropping the user doc.
    await Promise.all([
      deleteAllTradingSetupsForUser(userId, "live"),
      deleteAllTradingSetupsForUser(userId, "replay"),
      deleteAllSchedulePlacementsForUser(userId, "live"),
      deleteAllSchedulePlacementsForUser(userId, "replay"),
      deleteAllTradingSessionDataForUser(userId),
    ]);

    const deleted = await deleteUserById(oid);
    if (!deleted) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    dropTradingClient(userId);
    liveTradingRegistry.drop(userId);

    // Keep a bootstrap default user if the DB is empty after delete.
    try {
      await ensureDefaultUser();
    } catch {
      // ignore
    }

    res.setHeader("Set-Cookie", buildClearSessionCookie(isSecureRequest(req)));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

function broadcast(event: string, data: unknown, userId?: string): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    if (userId != null && client.userId !== userId) continue;
    client.res.write(payload);
  }
}

function broadcastLog(entry: ReturnType<typeof logService.getRecent>[number]): void {
  broadcast("log", entry);
}

function windowDurationSec(state: { windowStart?: number; windowEnd?: number }): number {
  if (state.windowStart && state.windowEnd) return state.windowEnd - state.windowStart;
  return 300;
}

/** Full window snapshots (history + trading) — paced so book ticks don't re-stringify huge payloads. */
const FULL_WINDOW_SSE_MS = 200;
let fullWindowTimer: ReturnType<typeof setTimeout> | null = null;
let fullWindowDirty = false;
let lastQuotesPayload = "";

function enrichWindowStateForUser(
  userId: string | undefined,
  state: ReturnType<typeof displayService.getState>,
): EnrichedLiveWindowState {
  const trading = userId
    ? liveTradingRegistry.get(userId).getPublicState()
    : undefined;
  return {
    ...state,
    sim: simulatorService.getPublicState(),
    trading: trading ?? null,
  };
}

function quotesPayloadFromState(state: ReturnType<typeof displayService.getState>) {
  return {
    series: state.series,
    windowStart: state.windowStart,
    windowEnd: state.windowEnd,
    assetPrice: state.assetPrice,
    assetGap: state.assetGap,
    prevCloseAsset: state.prevCloseAsset,
    priceToBeatSource: state.priceToBeatSource,
    yesBid: state.yesBid,
    yesAsk: state.yesAsk,
    noBid: state.noBid,
    noAsk: state.noAsk,
    yesBidSize: state.yesBidSize,
    yesAskSize: state.yesAskSize,
    noBidSize: state.noBidSize,
    noAskSize: state.noAskSize,
    yesDisplay: state.yesDisplay,
    noDisplay: state.noDisplay,
    feedLatencyMs: state.feedLatencyMs,
    lastTickMs: state.lastTickMs,
  };
}

/** Tick-live quotes for clickable up/down buttons — small payload, every price change. */
function pushQuotesLive(): void {
  const state = displayService.getState();
  const quotes = quotesPayloadFromState(state);
  const payload = JSON.stringify(quotes);
  if (payload === lastQuotesPayload) return;
  lastQuotesPayload = payload;
  const message = `event: quotes\ndata: ${payload}\n\n`;
  for (const client of sseClients) {
    client.res.write(message);
  }
}

function pushWindowState(): void {
  const state = displayService.getState();
  for (const client of sseClients) {
    const payload = `event: window\ndata: ${JSON.stringify(enrichWindowStateForUser(client.userId, state))}\n\n`;
    client.res.write(payload);
  }
}

/** Immediate full snapshot (config/trading changes, HTTP handlers). */
function pushWindowStateImmediate(): void {
  fullWindowDirty = false;
  if (fullWindowTimer) {
    clearTimeout(fullWindowTimer);
    fullWindowTimer = null;
  }
  pushWindowState();
}

/** Coalesce chart/history/trading blob after display ticks. */
function scheduleFullWindowPush(): void {
  fullWindowDirty = true;
  if (fullWindowTimer) return;
  fullWindowTimer = setTimeout(() => {
    fullWindowTimer = null;
    if (!fullWindowDirty) return;
    fullWindowDirty = false;
    pushWindowState();
  }, FULL_WINDOW_SSE_MS);
}

async function broadcastSchedulePlacements(
  userId: string,
  series?: string | null,
  mode: ScheduleWorkspaceMode = "live",
): Promise<void> {
  const placements = await listSchedulePlacements(userId, series ?? undefined, mode);
  broadcast("schedule-placements", { mode, placements }, userId);
}

function getDisplaySeries(req: express.Request): string {
  const series = String(req.query.series ?? displayService.getState().series);
  return series;
}

function parseSeriesParam(req: express.Request, bodySeries?: unknown): string {
  const fromQuery = typeof req.query.series === "string" ? req.query.series.trim() : "";
  const fromBody = typeof bodySeries === "string" ? bodySeries.trim() : "";
  return fromQuery || fromBody || displayService.getState().series || "btc-5m";
}

function parseWorkspaceMode(req: express.Request): ScheduleWorkspaceMode {
  const fromQuery = req.query.mode;
  const fromBody = req.body?.mode;
  return parseScheduleWorkspaceMode(fromQuery ?? fromBody);
}

function parsePlacementIdsQuery(req: express.Request): string[] | undefined {
  const raw = req.query.placementIds;
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const ids = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return ids.length > 0 ? ids : undefined;
}

function filterSchedulePlacements(
  all: SchedulePlacementListItem[],
  placementIds: string[] | undefined,
): SchedulePlacementListItem[] {
  if (!placementIds?.length) return all;
  const idSet = new Set(placementIds);
  return all.filter((p) => idSet.has(p._id));
}

/** Empty until an external replay worker URL is configured. */
const SCHEDULE_REPLAY_SERVICE_URL = String(process.env.SCHEDULE_REPLAY_SERVICE_URL ?? "").trim();

function writeSseEvent(
  res: express.Response,
  closed: { value: boolean },
  event: string,
  data: unknown,
): void {
  if (closed.value) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const flush = (res as express.Response & { flush?: () => void }).flush;
  if (typeof flush === "function") flush.call(res);
}

app.get("/api/account", async (req, res) => {
  try {
    const userId = requireUserId(req);
    const authUser = (req as AuthedRequest).authUser!;
    const status = await refreshCollateralBalance(userId);
    const user = (await getUserPublicById(userId)) ?? authUser;
    res.json({
      ...status,
      hasPrivateKey: user.wallet.hasPrivateKey || Boolean(status.hasPrivateKey),
      funderAddress: status.funderAddress ?? user.wallet.funderAddress,
      signerAddress: status.signerAddress ?? user.wallet.signerAddress,
      privateKeyHint: user.wallet.privateKeyHint,
    });
  } catch {
    try {
      const userId = requireUserId(req);
      const authUser = (req as AuthedRequest).authUser!;
      const user = (await getUserPublicById(userId)) ?? authUser;
      const status = getTradingAccountStatus(userId);
      res.json({
        ...status,
        hasPrivateKey: user.wallet.hasPrivateKey,
        funderAddress: status.funderAddress ?? user.wallet.funderAddress,
        signerAddress: status.signerAddress ?? user.wallet.signerAddress,
        privateKeyHint: user.wallet.privateKeyHint,
      });
    } catch {
      try {
        res.json(getTradingAccountStatus(requireUserId(req)));
      } catch {
        res.json({ connected: false });
      }
    }
  }
});

app.get("/api/user", async (req, res) => {
  try {
    const authUser = (req as AuthedRequest).authUser;
    if (!authUser) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const user = await getUserPublicById(authUser.id);
    res.json(user ?? authUser);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.patch("/api/user", async (req, res) => {
  try {
    const authUser = (req as AuthedRequest).authUser;
    if (!authUser) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const body = (req.body ?? {}) as { name?: string; email?: string };
    if (!("name" in body) && !("email" in body)) {
      res.status(400).json({ error: "Provide name and/or email" });
      return;
    }
    const user = await updateUserProfile(authUser.id, {
      name: body.name,
      email: body.email,
    });
    res.json(user);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.patch("/api/account/wallet", async (req, res) => {
  try {
    const userId = requireUserId(req);
    const body = (req.body ?? {}) as {
      funderAddress?: string;
      privateKey?: string;
      signatureType?: number;
    };
    if (
      body.funderAddress == null &&
      body.privateKey == null &&
      body.signatureType == null
    ) {
      res.status(400).json({ error: "Provide funderAddress and/or privateKey" });
      return;
    }

    const user = await updateUserWallet(userId, {
      funderAddress: body.funderAddress,
      privateKey: body.privateKey,
      signatureType: body.signatureType,
    });

    let status = getTradingAccountStatus(userId);
    try {
      status = await reconnectTradingClient(userId);
      await liveTradingRegistry.ensureLoaded(userId);
    } catch (err) {
      status = getTradingAccountStatus(userId);
      res.status(400).json({
        error: err instanceof Error ? err.message : String(err),
        wallet: user.wallet,
        account: {
          ...status,
          hasPrivateKey: user.wallet.hasPrivateKey,
          funderAddress: status.funderAddress ?? user.wallet.funderAddress,
          signerAddress: status.signerAddress ?? user.wallet.signerAddress,
          privateKeyHint: user.wallet.privateKeyHint,
        },
      });
      return;
    }

    broadcast(
      "account",
      {
        ...status,
        hasPrivateKey: user.wallet.hasPrivateKey,
        privateKeyHint: user.wallet.privateKeyHint,
      },
      userId,
    );

    res.json({
      ok: true,
      user,
      wallet: user.wallet,
      account: {
        ...status,
        hasPrivateKey: user.wallet.hasPrivateKey,
        funderAddress: status.funderAddress ?? user.wallet.funderAddress,
        signerAddress: status.signerAddress ?? user.wallet.signerAddress,
        privateKeyHint: user.wallet.privateKeyHint,
      },
    });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/api/trading/config", async (req, res) => {
  try {
    const series = parseSeriesParam(req);
    const engine = tradingFor(req);
    await engine.ensureBoundToSeries(series);
    res.json(engine.getConfig());
  } catch (err) {
    res.status(401).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.put("/api/trading/config", async (req, res) => {
  try {
    const series = parseSeriesParam(req, req.body?.series);
    const engine = tradingFor(req);
    await engine.ensureBoundToSeries(series);
    const body = req.body as Partial<import("./types.js").TradingConfig>;
    const config = engine.setConfig(body);
    void engine.refreshScheduleContext(true);
    pushWindowStateImmediate();
    res.json(config);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post("/api/trading/order", async (req, res) => {
  try {
    const userId = requireUserId(req);
    if (!isTradingConfigured(userId)) {
      res.status(400).json({ error: "Trading account not configured" });
      return;
    }
    const side = req.body?.side;
    const leg = req.body?.leg;
    if (side !== "up" && side !== "down") {
      res.status(400).json({ error: "side must be up or down" });
      return;
    }
    if (leg !== "buy" && leg !== "sell") {
      res.status(400).json({ error: "leg must be buy or sell" });
      return;
    }
    const state = displayService.getState();
    const result = await tradingFor(req).manualOrder(state, side, leg);
    pushWindowStateImmediate();
    if (!result.ok) {
      res.status(400).json({ error: result.error ?? "Order failed" });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post("/api/trading/positions/clear", async (req, res) => {
  try {
    // Reset Live header counters only — Market / Week keep full history in Mongo.
    // Schedule placement card stats keep collecting until cards are removed.
    tradingFor(req).clearPositionCards();
    pushWindowStateImmediate();
    res.json({ ok: true, archived: false });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

/** Reload schedule-card / Live stats from Mongo into RAM (e.g. after restore script). */
app.post("/api/trading/stats/rehydrate", async (req, res) => {
  try {
    await tradingFor(req).hydrateLiveStatsFromMongo();
    pushWindowStateImmediate();
    const live = tradingFor(req).getLiveSessionTotals();
    res.json({
      ok: true,
      green: live.green,
      red: live.red,
      blue: live.blue,
      pnl: live.pnl,
      placementStats: live.placementStats,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/api/trading/session-memory", async (req, res) => {
  try {
    const userId = requireUserId(req);
    const mode = String(req.query.mode ?? "live").toLowerCase();
    const live = tradingFor(req).getLiveSessionTotals();
    const liveTotals = {
      green: live.green,
      red: live.red,
      blue: live.blue,
      pnl: live.pnl,
      hasData: live.hasBalance,
      sessionCount: live.hasBalance ? 1 : 0,
    };

    if (mode === "live") {
      res.json({ mode, ...liveTotals, live: liveTotals });
      return;
    }

    if (mode === "market") {
      const { DEFAULT_MARKET_SERIES } = await import("./collections.js");
      const series = String(req.query.series ?? DEFAULT_MARKET_SERIES).trim() || DEFAULT_MARKET_SERIES;
      const archived = await sumTradingStatEventsForSeries(userId, series);
      res.json({
        mode: "market",
        series,
        green: archived.green,
        red: archived.red,
        blue: archived.blue,
        pnl: archived.pnl,
        sessionCount: archived.sessionCount,
        hasData: archived.hasData,
        archived,
        live: liveTotals,
      });
      return;
    }

    let fromMs: number | undefined;
    let toMs: number | undefined;
    const now = Date.now();

    if (mode === "week") {
      fromMs = now - 7 * 24 * 60 * 60 * 1000;
      toMs = now;
    } else if (mode === "all" || mode === "alltime" || mode === "all-time") {
      fromMs = undefined;
      toMs = undefined;
    } else {
      res.status(400).json({ error: "mode must be live, market, week, or all" });
      return;
    }

    // Events are written on each settled-stat update — do not add live again (would double-count).
    const archived = await sumTradingSessionMemory(userId, { fromMs, toMs });

    res.json({
      mode: mode === "alltime" || mode === "all-time" ? "all" : mode,
      green: archived.green,
      red: archived.red,
      blue: archived.blue,
      pnl: archived.pnl,
      sessionCount: archived.sessionCount,
      hasData: archived.hasData,
      archived,
      live: liveTotals,
      includeLive: false,
    });
  } catch (err) {
    const message = String(err);
    if (message.includes("MONGODB_URI")) {
      res.status(503).json({ error: message });
      return;
    }
    res.status(500).json({ error: message });
  }
});

app.get("/api/markets", async (_req, res) => {
  try {
    const markets = await listMarkets();
    res.json(markets);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/api/quotes", async (req, res) => {
  try {
    const series = getDisplaySeries(req);
    displayService.setSeries(series);
    const state = displayService.getState();
    res.json({
      series,
      yesBid: state.yesBid,
      yesAsk: state.yesAsk,
      noBid: state.noBid,
      noAsk: state.noAsk,
      yesDisplay: state.yesDisplay,
      noDisplay: state.noDisplay,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/api/book", async (req, res) => {
  try {
    const series = getDisplaySeries(req);
    displayService.setSeries(series);
    const state = displayService.getState();

    const pair = await import("./market-pair.js").then((m) =>
      m.fetchCurrentUpDownMarket(series),
    );
    clobMarketFeed.ensureSubscribed([pair.yesTokenId, pair.noTokenId]);

    const yesBook = clobMarketFeed.getCachedBookDepth(pair.yesTokenId);
    const noBook = clobMarketFeed.getCachedBookDepth(pair.noTokenId);

    res.json({
      series,
      windowStart: state.windowStart,
      windowEnd: state.windowEnd,
      up: yesBook ?? { bids: [], asks: [] },
      down: noBook ?? { bids: [], asks: [] },
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/api/window", async (req, res) => {
  try {
    const series = getDisplaySeries(req);
    displayService.setSeries(series);
    const userId = (req as AuthedRequest).authUser?.id;
    if (userId) {
      void tradingFor(req).ensureBoundToSeries(series);
    }
    res.json(enrichWindowStateForUser(userId, displayService.getState()));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/api/sim/setup", (_req, res) => {
  res.json(simulatorService.getSetup());
});

app.put("/api/sim/setup", (req, res) => {
  try {
    const body = req.body as SimSetup;
    if (!body?.phaseSplit || !body?.phases || body.phases.length !== 3) {
      res.status(400).json({ error: "phaseSplit and 3 phases required" });
      return;
    }
    const setup = simulatorService.setSetup(body, windowDurationSec(displayService.getState()));
    logService.info("sim", `Setup updated (latency ${setup.latencyMs} ms)`);
    pushWindowStateImmediate();
    res.json(setup);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post("/api/trading-setups", async (req, res) => {
  try {
    const userId = requireUserId(req);
    const mode = parseWorkspaceMode(req);
    const title = String(req.body?.title ?? "").trim();
    if (!title) {
      res.status(400).json({ error: "title is required" });
      return;
    }
    const descriptionRaw = req.body?.description;
    const description =
      descriptionRaw == null || String(descriptionRaw).trim() === ""
        ? undefined
        : String(descriptionRaw).trim();

    let phaseSetup = simulatorService.getPhaseSetup();
    if (req.body?.setup != null) {
      const parsed = normalizePhaseSetup(req.body.setup);
      if (!parsed) {
        res.status(400).json({ error: "Invalid setup phases" });
        return;
      }
      phaseSetup = parsed;
    }

    const saved = await insertTradingSetup(
      userId,
      {
        title,
        description,
        setup: phaseSetup,
      },
      mode,
    );
    logService.success("sim", `Trading setup saved (${mode}): "${title}"`);
    res.status(201).json(saved);
  } catch (err) {
    const message = String(err);
    if (message.includes("MONGODB_URI")) {
      res.status(503).json({ error: message });
      return;
    }
    res.status(500).json({ error: message });
  }
});

app.get("/api/trading-setups", async (req, res) => {
  try {
    const setups = await listTradingSetups(requireUserId(req), parseWorkspaceMode(req));
    res.json(setups);
  } catch (err) {
    const message = String(err);
    if (message.includes("MONGODB_URI")) {
      res.status(503).json({ error: message });
      return;
    }
    res.status(500).json({ error: message });
  }
});

app.put("/api/trading-setups/reorder", async (req, res) => {
  try {
    const mode = parseWorkspaceMode(req);
    const orderedIds = Array.isArray(req.body?.orderedIds)
      ? req.body.orderedIds.map((id: unknown) => String(id))
      : null;
    if (!orderedIds) {
      res.status(400).json({ error: "orderedIds is required" });
      return;
    }
    const setups = await reorderTradingSetups(requireUserId(req), orderedIds, mode);
    res.json(setups);
  } catch (err) {
    const message = String(err);
    if (message.includes("MONGODB_URI")) {
      res.status(503).json({ error: message });
      return;
    }
    if (
      message.includes("required") ||
      message.includes("unique") ||
      message.includes("every setup") ||
      message.includes("Unknown setup") ||
      message.includes("Invalid setup")
    ) {
      res.status(400).json({ error: message });
      return;
    }
    res.status(500).json({ error: message });
  }
});

app.get("/api/trading-setups/:id", async (req, res) => {
  try {
    const setup = await getTradingSetupById(
      requireUserId(req),
      req.params.id,
      parseWorkspaceMode(req),
    );
    if (!setup) {
      res.status(404).json({ error: "Setup not found" });
      return;
    }
    res.json(setup);
  } catch (err) {
    const message = String(err);
    if (message.includes("MONGODB_URI")) {
      res.status(503).json({ error: message });
      return;
    }
    res.status(500).json({ error: message });
  }
});

app.patch("/api/trading-setups/:id", async (req, res) => {
  try {
    const userId = requireUserId(req);
    const mode = parseWorkspaceMode(req);
    const descriptionRaw = req.body?.description;
    const updated = await updateTradingSetup(
      userId,
      req.params.id,
      {
        title: req.body?.title != null ? String(req.body.title) : undefined,
        description:
          descriptionRaw === undefined
            ? undefined
            : descriptionRaw == null || String(descriptionRaw).trim() === ""
              ? null
              : String(descriptionRaw).trim(),
        color: req.body?.color != null ? String(req.body.color) : undefined,
        setup: req.body?.setup,
      },
      mode,
    );
    if (!updated) {
      res.status(404).json({ error: "Setup not found" });
      return;
    }
    if (req.body?.title != null) {
      await updatePlacementTitlesBySetupId(userId, req.params.id, updated.title, mode);
      await broadcastSchedulePlacements(userId, undefined, mode);
    }
    if (req.body?.setup != null && mode === "live") {
      await tradingFor(req).refreshScheduleContext(true);
      pushWindowStateImmediate();
    }
    logService.success("sim", `Trading setup updated (${mode}): "${updated.title}"`);
    res.json(updated);
  } catch (err) {
    const message = String(err);
    if (message.includes("MONGODB_URI")) {
      res.status(503).json({ error: message });
      return;
    }
    if (message.includes("required") || message.includes("Invalid")) {
      res.status(400).json({ error: message });
      return;
    }
    res.status(500).json({ error: message });
  }
});

app.delete("/api/trading-setups/:id", async (req, res) => {
  try {
    const userId = requireUserId(req);
    const mode = parseWorkspaceMode(req);
    const existing = await getTradingSetupById(userId, req.params.id, mode);
    if (!existing) {
      res.status(404).json({ error: "Setup not found" });
      return;
    }
    const setupId = String(req.params.id);
    const linked = (await listSchedulePlacements(userId, undefined, mode)).filter(
      (p) => p.setupId === setupId,
    );
    await deletePlacementsBySetupId(userId, setupId, mode);
    if (mode === "live") {
      for (const placement of linked) {
        tradingFor(req).forgetPlacement(placement._id);
      }
    }
    const ok = await deleteTradingSetup(userId, setupId, mode);
    if (!ok) {
      res.status(404).json({ error: "Setup not found" });
      return;
    }
    await broadcastSchedulePlacements(userId, undefined, mode);
    if (mode === "live") pushWindowStateImmediate();
    logService.success("sim", `Trading setup deleted (${mode}): "${existing.title}"`);
    res.status(204).send();
  } catch (err) {
    const message = String(err);
    if (message.includes("MONGODB_URI")) {
      res.status(503).json({ error: message });
      return;
    }
    res.status(500).json({ error: message });
  }
});

app.get("/api/heatmap", (req, res) => {
  try {
    const series = parseSeriesParam(req);
    res.json(getHeatmapState(series));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/api/schedule-placements", async (req, res) => {
  try {
    const series = parseSeriesParam(req);
    const mode = parseWorkspaceMode(req);
    const placements = await listSchedulePlacements(requireUserId(req), series, mode);
    res.json(placements);
  } catch (err) {
    const message = String(err);
    if (message.includes("MONGODB_URI")) {
      res.status(503).json({ error: message });
      return;
    }
    res.status(500).json({ error: message });
  }
});

app.post("/api/schedule-placements", async (req, res) => {
  try {
    const userId = requireUserId(req);
    const mode = parseWorkspaceMode(req);
    const series = parseSeriesParam(req, req.body?.series);
    const saved = await insertSchedulePlacement(
      userId,
      {
        series,
        setupId: String(req.body?.setupId ?? ""),
        title: String(req.body?.title ?? ""),
        day: String(req.body?.day ?? ""),
        startHour: Number(req.body?.startHour),
        durationHours: Number(req.body?.durationHours),
      },
      mode,
    );
    if (mode === "live") {
      await syncLiveScheduleInUseForSetup(userId, saved.setupId);
    }
    await broadcastSchedulePlacements(userId, series, mode);
    res.status(201).json(saved);
  } catch (err) {
    const message = String(err);
    if (message.includes("MONGODB_URI")) {
      res.status(503).json({ error: message });
      return;
    }
    if (message.includes("overlap") || message.includes("Invalid") || message.includes("exceeds")) {
      res.status(400).json({ error: message });
      return;
    }
    res.status(500).json({ error: message });
  }
});

app.delete("/api/schedule-placements/day/:day", async (req, res) => {
  try {
    const userId = requireUserId(req);
    const mode = parseWorkspaceMode(req);
    const series = parseSeriesParam(req);
    const before = await listSchedulePlacements(userId, series, mode);
    const removed = before.filter((placement) => placement.day === req.params.day);
    await deletePlacementsByDay(userId, req.params.day, series, mode);
    if (mode === "live") {
      for (const placement of removed) tradingFor(req).forgetPlacement(placement._id);
      await reconcileLiveScheduleInUseFlags(userId);
      await tradingFor(req).refreshScheduleContext(true);
      pushWindowStateImmediate();
    }
    const placements = await listSchedulePlacements(userId, series, mode);
    await broadcastSchedulePlacements(userId, series, mode);
    res.json(placements);
  } catch (err) {
    res.status(400).json({ error: String(err) });
  }
});

app.post("/api/schedule-placements/replace-day", async (req, res) => {
  try {
    const userId = requireUserId(req);
    const mode = parseWorkspaceMode(req);
    const series = parseSeriesParam(req, req.body?.series);
    const setupId = String(req.body?.setupId ?? "");
    const setup = await getTradingSetupById(userId, setupId, mode);
    if (!setup) {
      res.status(404).json({ error: "Trading setup not found" });
      return;
    }
    const before = await listSchedulePlacements(userId, series, mode);
    const day = String(req.body?.day ?? "");
    const removed = before.filter((placement) => placement.day === day);
    const placements = await replaceDayWithSetup(
      userId,
      day,
      setupId,
      setup.title,
      series,
      mode,
    );
    if (mode === "live") {
      for (const placement of removed) tradingFor(req).forgetPlacement(placement._id);
      await reconcileLiveScheduleInUseFlags(userId);
      await tradingFor(req).refreshScheduleContext(true);
      pushWindowStateImmediate();
    }
    await broadcastSchedulePlacements(userId, series, mode);
    res.json(placements);
  } catch (err) {
    res.status(400).json({ error: String(err) });
  }
});

app.post("/api/schedule-placements/apply-setup", async (req, res) => {
  try {
    const userId = requireUserId(req);
    const mode = parseWorkspaceMode(req);
    const series = parseSeriesParam(req, req.body?.series);
    const setupId = String(req.body?.setupId ?? "");
    const title = String(req.body?.title ?? "");
    const setup = await getTradingSetupById(userId, setupId, mode);
    if (!setup) {
      res.status(404).json({ error: "Trading setup not found" });
      return;
    }
    const placements = await replaceAllPlacementsSetup(
      userId,
      setupId,
      title || setup.title,
      series,
      mode,
    );
    if (mode === "live") {
      await reconcileLiveScheduleInUseFlags(userId);
    }
    await broadcastSchedulePlacements(userId, series, mode);
    res.json(placements);
  } catch (err) {
    const message = String(err);
    if (message.includes("MONGODB_URI")) {
      res.status(503).json({ error: message });
      return;
    }
    if (message.includes("Invalid")) {
      res.status(400).json({ error: message });
      return;
    }
    res.status(500).json({ error: message });
  }
});

app.patch("/api/schedule-placements/:id", async (req, res) => {
  try {
    const userId = requireUserId(req);
    const mode = parseWorkspaceMode(req);
    const placementId = String(req.params.id);
    if (mode === "live" && tradingFor(req).isPlacementLocked(placementId)) {
      res.status(409).json({ error: "Placement is locked after its first window started" });
      return;
    }
    const updated = await updateSchedulePlacement(
      userId,
      placementId,
      {
        day: req.body?.day != null ? String(req.body.day) : undefined,
        startHour: req.body?.startHour != null ? Number(req.body.startHour) : undefined,
        durationHours: req.body?.durationHours != null ? Number(req.body.durationHours) : undefined,
      },
      mode,
    );
    if (!updated) {
      res.status(404).json({ error: "Placement not found" });
      return;
    }
    await broadcastSchedulePlacements(userId, updated.series, mode);
    res.json(updated);
  } catch (err) {
    const message = String(err);
    if (message.includes("MONGODB_URI")) {
      res.status(503).json({ error: message });
      return;
    }
    if (message.includes("overlap") || message.includes("Invalid") || message.includes("exceeds")) {
      res.status(400).json({ error: message });
      return;
    }
    res.status(500).json({ error: message });
  }
});

app.delete("/api/schedule-placements/:id", async (req, res) => {
  try {
    const userId = requireUserId(req);
    const mode = parseWorkspaceMode(req);
    const id = String(req.params.id);
    const existing = await getSchedulePlacementById(userId, id, mode);
    const ok = await deleteSchedulePlacement(userId, id, mode);
    if (!ok) {
      res.status(404).json({ error: "Placement not found" });
      return;
    }
    if (mode === "live") {
      if (existing?.setupId) {
        await syncLiveScheduleInUseForSetup(userId, existing.setupId);
      }
      tradingFor(req).forgetPlacement(id);
      pushWindowStateImmediate();
    }
    await broadcastSchedulePlacements(userId, existing?.series, mode);
    res.status(204).send();
  } catch (err) {
    const message = String(err);
    if (message.includes("MONGODB_URI")) {
      res.status(503).json({ error: message });
      return;
    }
    res.status(500).json({ error: message });
  }
});

/**
 * Replay the current Replay-mode schedule over historical windows.
 * Streams per-placement stats (event: placement) then event: done.
 * External worker URL is empty until SCHEDULE_REPLAY_SERVICE_URL is set.
 */
app.post("/api/schedule-replay", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const closed = { value: false };
  req.on("close", () => {
    closed.value = true;
  });

  try {
    const userId = requireUserId(req);
    const series = parseSeriesParam(req, req.body?.series);
    const placements = Array.isArray(req.body?.placements)
      ? req.body.placements
      : await listSchedulePlacements(userId, series, "replay");
    const setupIds: string[] = [
      ...new Set(
        (placements as Array<{ setupId?: string }>)
          .map((p) => String(p?.setupId ?? "").trim())
          .filter(Boolean),
      ),
    ];
    const setups =
      Array.isArray(req.body?.setups) && req.body.setups.length > 0
        ? req.body.setups
        : (
            await Promise.all(setupIds.map((id: string) => getTradingSetupById(userId, id, "replay")))
          ).filter(Boolean);

    writeSseEvent(res, closed, "progress", {
      completed: 0,
      total: Math.max(1, placements.length),
      indeterminate: !SCHEDULE_REPLAY_SERVICE_URL,
    });

    if (!SCHEDULE_REPLAY_SERVICE_URL) {
      writeSseEvent(res, closed, "failure", {
        error: "Replay service is not configured (SCHEDULE_REPLAY_SERVICE_URL is empty)",
        configured: false,
      });
      res.end();
      return;
    }

    const remoteRes = await fetch(SCHEDULE_REPLAY_SERVICE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({
        userId,
        series,
        placements,
        setups,
      }),
    });
    if (!remoteRes.ok || !remoteRes.body) {
      const remoteText = await remoteRes.text().catch(() => "");
      writeSseEvent(res, closed, "failure", {
        error: remoteText || `Replay service returned ${remoteRes.status}`,
      });
      res.end();
      return;
    }

    const reader = remoteRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (!closed.value) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes("\n\n")) {
        res.write(buffer);
        buffer = "";
        const flush = (res as express.Response & { flush?: () => void }).flush;
        if (typeof flush === "function") flush.call(res);
      }
    }
    if (buffer && !closed.value) res.write(buffer);
    if (!closed.value) res.end();
  } catch (err) {
    writeSseEvent(res, closed, "failure", { error: String(err) });
    res.end();
  }
});

app.get("/api/schedule-placement-stats", async (req, res) => {
  try {
    const userId = requireUserId(req);
    const mode = parseWorkspaceMode(req);
    if (mode === "replay") {
      res.json([]);
      return;
    }
    const series = parseSeriesParam(req);
    const engine = await liveTradingRegistry.ensureLoaded(userId);
    await engine.ensureBoundToSeries(series);
    const allPlacements = await listSchedulePlacements(userId, series, "live");
    const placementIds = parsePlacementIdsQuery(req);
    const placements = filterSchedulePlacements(allPlacements, placementIds);
    const stats = engine.getPlacementStats(placements.map((p) => p._id));
    res.json(stats);
  } catch (err) {
    const message = String(err);
    if (message.includes("MONGODB_URI")) {
      res.status(503).json({ error: message });
      return;
    }
    res.status(500).json({ error: message });
  }
});

app.get("/api/schedule-placement-stats/stream", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  let closed = false;
  req.on("close", () => {
    closed = true;
  });

  const writeEvent = (event: string, data: unknown) => {
    if (closed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const flush = (res as express.Response & { flush?: () => void }).flush;
    if (typeof flush === "function") flush.call(res);
  };

  try {
    const userId = requireUserId(req);
    const mode = parseWorkspaceMode(req);
    if (mode === "replay") {
      writeEvent("progress", { completed: 1, total: 1 });
      writeEvent("done", []);
      res.end();
      return;
    }
    const series = parseSeriesParam(req);
    writeEvent("progress", { completed: 1, total: 1 });
    const engine = await liveTradingRegistry.ensureLoaded(userId);
    await engine.ensureBoundToSeries(series);
    const allPlacements = await listSchedulePlacements(userId, series, "live");
    const placementIds = parsePlacementIdsQuery(req);
    const placements = filterSchedulePlacements(allPlacements, placementIds);
    const stats = engine.getPlacementStats(placements.map((p) => p._id));
    if (!closed) {
      writeEvent("done", stats);
      res.end();
    }
  } catch (err) {
    writeEvent("failure", { error: String(err) });
    res.end();
  }
});

app.get("/api/ticks", async (req, res) => {
  try {
    const series = getDisplaySeries(req);
    const windowStart = Number(req.query.windowStart);
    if (!Number.isFinite(windowStart)) {
      res.status(400).json({ error: "windowStart query param required" });
      return;
    }
    const market = await getMarket(series);
    if (!market) {
      res.status(404).json({ error: "Market not found" });
      return;
    }
    const limit = Math.min(Number(req.query.limit) || 5000, 50_000);
    const stream = String(req.query.stream || "merged");
    let ticks: unknown[];
    if (stream === "raw") {
      ticks = await listClobRawTicks(market, windowStart, limit);
    } else if (stream === "book") {
      ticks = await listClobBookTicks(market, windowStart, limit);
    } else if (stream === "chainlink") {
      ticks = await listChainlinkTicks(market, windowStart, limit);
    } else {
      ticks = await listReplayTicks(market, windowStart, limit);
    }
    res.json({ series, windowStart, stream, count: ticks.length, ticks });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/api/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const userId = (req as AuthedRequest).authUser?.id;
  const client: SseClient = { id: ++sseId, res, userId };
  sseClients.push(client);

  void (async () => {
    try {
      const markets = await listMarkets();
      res.write(`event: markets\ndata: ${JSON.stringify(markets)}\n\n`);
      res.write(
        `event: window\ndata: ${JSON.stringify(enrichWindowStateForUser(userId, displayService.getState()))}\n\n`,
      );
      res.write(`event: log-history\ndata: ${JSON.stringify(logService.getRecent())}\n\n`);
      const series = displayService.getState().series || "btc-5m";
      res.write(`event: heatmap\ndata: ${JSON.stringify(getHeatmapState(series))}\n\n`);
      if (userId) {
        const placements = await listSchedulePlacements(userId, series, "live");
        res.write(`event: schedule-placements\ndata: ${JSON.stringify({ mode: "live", placements })}\n\n`);
      }
    } catch {
      // ignore
    }
  })();

  req.on("close", () => {
    sseClients = sseClients.filter((c) => c.id !== client.id);
  });
});

async function main(): Promise<void> {
  await initStorageAndSeed();
  await ensureAllMarketIndexes();
  try {
    await ensureUserIndexes();
    await ensureSessionIndexes();
    await ensureDefaultUser();
    await ensureWalletRegistryReady();
    await maybeBootstrapDefaultPassword();
    const bootstrapId = await getBootstrapUserId();
    await ensureTradingSetupsUserId(bootstrapId);
    await ensureSchedulePlacementsUserId(bootstrapId);
    await ensureTradingSessionMemoryUserId(bootstrapId);
    await reconcileLiveScheduleInUseFlags(bootstrapId);
  } catch (err) {
    logService.warn("server", `Failed to ensure default user / auth indexes: ${String(err)}`);
  }

  liveTradingRegistry.startPolling(60_000);
  liveTradingRegistry.onUpdate(() => {
    // Positions/markers changed — send full snapshot now (not only throttled).
    pushWindowStateImmediate();
  });
  traderRegistryService.start();

  if (isTradingExecutor()) {
    logService.info("server", "TRADING_EXECUTOR enabled — this process may place orders");
  } else {
    logService.info("server", "TRADING_EXECUTOR off — settings only, no order placement");
  }

  logService.onEntry((entry) => {
    broadcastLog(entry);
  });

  onBalanceRefresh((userId, status) => {
    broadcast("account", status, userId);
  });

  setHeatmapUpdateListener((state) => {
    broadcast("heatmap", state);
  });
  await loadAllHeatmapWindows();
  const heatmapRefreshTimer = setInterval(() => {
    void loadAllHeatmapWindows().catch((err) => {
      logService.warn("heatmap", `Periodic recorded_windows refresh failed: ${String(err)}`);
    });
  }, HEATMAP_REFRESH_MS);
  heatmapRefreshTimer.unref?.();

  chainlinkPriceFeed.start();
  clobMarketFeed.start();
  displayService.start();

  // Send each Chainlink point as a tiny incremental event. Full window
  // snapshots remain the recovery path for initial load and reconnects.
  const chainlinkTickUnsub = chainlinkPriceFeed.onUpdate((asset, timestampMs) => {
    const live = chainlinkPriceFeed.getLivePrice(asset);
    if (!live || live.timestampMs !== timestampMs) return;
    broadcast("chainlink-tick", {
      asset,
      price: live.value,
      timestampMs,
    });
  });

  // Quotes: every tick (small). Full window (history + trading): coalesced ~200ms.
  displayService.onUpdate(() => {
    pushQuotesLive();
    scheduleFullWindowPush();
  });

  app.listen(PORT, () => {
    logService.info("server", `Listening on http://localhost:${PORT}`);
  });

  const shutdown = async () => {
    clearInterval(heatmapRefreshTimer);
    traderRegistryService.stop();
    liveTradingRegistry.stopPolling();
    displayService.stop();
    chainlinkTickUnsub();
    clobMarketFeed.stop();
    chainlinkPriceFeed.stop();
    await closeMongoClient().catch(() => {});
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
