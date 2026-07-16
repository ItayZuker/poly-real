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
  deletePlacementsBySetupId,
  ensureSchedulePlacementsUserId,
  getSchedulePlacementById,
  insertSchedulePlacement,
  listSchedulePlacements,
  replaceAllPlacementsSetup,
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
  normalizePhaseSetup,
  ensureTradingSetupsUserId,
} from "./db/trading-setup-repository.js";
import {
  reconcileLiveScheduleInUseFlags,
  syncLiveScheduleInUseForSetup,
} from "./db/live-schedule-setup-usage.js";
import {
  ensureTradingSessionMemoryUserId,
  sumTradingSessionMemory,
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
import {
  authenticateUser,
  deleteUserById,
  ensureDefaultUser,
  ensureUserIndexes,
  getBootstrapUserId,
  getUserPublicById,
  maybeBootstrapDefaultPassword,
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

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));

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
    const deleted = await deleteUserById(oid);
    if (!deleted) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    dropTradingClient(userId);

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

function pushWindowState(): void {
  const state = displayService.getState();
  for (const client of sseClients) {
    const payload = `event: window\ndata: ${JSON.stringify(enrichWindowStateForUser(client.userId, state))}\n\n`;
    client.res.write(payload);
  }
}

async function broadcastSchedulePlacements(userId: string): Promise<void> {
  const placements = await listSchedulePlacements(userId);
  broadcast("schedule-placements", placements, userId);
}

function getDisplaySeries(req: express.Request): string {
  const series = String(req.query.series ?? displayService.getState().series);
  return series;
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

app.get("/api/trading/config", (req, res) => {
  try {
    res.json(tradingFor(req).getConfig());
  } catch (err) {
    res.status(401).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.put("/api/trading/config", (req, res) => {
  try {
    const engine = tradingFor(req);
    const body = req.body as Partial<import("./types.js").TradingConfig>;
    const config = engine.setConfig(body);
    void engine.refreshScheduleContext(true);
    pushWindowState();
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
    pushWindowState();
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
    // Reset Live header counters only — history stays in Mongo for Week / All time.
    // Schedule placement card stats keep collecting until cards are removed.
    tradingFor(req).clearPositionCards();
    pushWindowState();
    res.json({ ok: true, archived: false });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

/** Reload schedule-card / Live stats from Mongo into RAM (e.g. after restore script). */
app.post("/api/trading/stats/rehydrate", async (req, res) => {
  try {
    await tradingFor(req).hydrateLiveStatsFromMongo();
    pushWindowState();
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
      res.status(400).json({ error: "mode must be live, week, or all" });
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
    pushWindowState();
    res.json(setup);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post("/api/trading-setups", async (req, res) => {
  try {
    const userId = requireUserId(req);
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

    const saved = await insertTradingSetup(userId, {
      title,
      description,
      setup: phaseSetup,
    });
    logService.success("sim", `Trading setup saved: "${title}"`);
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
    const setups = await listTradingSetups(requireUserId(req));
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

app.get("/api/trading-setups/:id", async (req, res) => {
  try {
    const setup = await getTradingSetupById(requireUserId(req), req.params.id);
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
    const descriptionRaw = req.body?.description;
    const updated = await updateTradingSetup(userId, req.params.id, {
      title: req.body?.title != null ? String(req.body.title) : undefined,
      description:
        descriptionRaw === undefined
          ? undefined
          : descriptionRaw == null || String(descriptionRaw).trim() === ""
            ? null
            : String(descriptionRaw).trim(),
      color: req.body?.color != null ? String(req.body.color) : undefined,
      setup: req.body?.setup,
    });
    if (!updated) {
      res.status(404).json({ error: "Setup not found" });
      return;
    }
    if (req.body?.title != null) {
      await updatePlacementTitlesBySetupId(userId, req.params.id, updated.title);
      await broadcastSchedulePlacements(userId);
    }
    if (req.body?.setup != null) {
      await tradingFor(req).refreshScheduleContext(true);
      pushWindowState();
    }
    logService.success("sim", `Trading setup updated: "${updated.title}"`);
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
    const existing = await getTradingSetupById(userId, req.params.id);
    if (!existing) {
      res.status(404).json({ error: "Setup not found" });
      return;
    }
    const setupId = String(req.params.id);
    const linked = (await listSchedulePlacements(userId)).filter((p) => p.setupId === setupId);
    await deletePlacementsBySetupId(userId, setupId);
    for (const placement of linked) {
      tradingFor(req).forgetPlacement(placement._id);
    }
    const ok = await deleteTradingSetup(userId, setupId);
    if (!ok) {
      res.status(404).json({ error: "Setup not found" });
      return;
    }
    await broadcastSchedulePlacements(userId);
    pushWindowState();
    logService.success("sim", `Trading setup deleted: "${existing.title}"`);
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

app.get("/api/heatmap", (_req, res) => {
  try {
    res.json(getHeatmapState());
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/api/schedule-placements", async (req, res) => {
  try {
    const placements = await listSchedulePlacements(requireUserId(req));
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
    const saved = await insertSchedulePlacement(userId, {
      setupId: String(req.body?.setupId ?? ""),
      title: String(req.body?.title ?? ""),
      day: String(req.body?.day ?? ""),
      startHour: Number(req.body?.startHour),
      durationHours: Number(req.body?.durationHours),
    });
    await syncLiveScheduleInUseForSetup(userId, saved.setupId);
    await broadcastSchedulePlacements(userId);
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

app.post("/api/schedule-placements/apply-setup", async (req, res) => {
  try {
    const userId = requireUserId(req);
    const setupId = String(req.body?.setupId ?? "");
    const title = String(req.body?.title ?? "");
    const setup = await getTradingSetupById(userId, setupId);
    if (!setup) {
      res.status(404).json({ error: "Trading setup not found" });
      return;
    }
    const placements = await replaceAllPlacementsSetup(userId, setupId, title || setup.title);
    await reconcileLiveScheduleInUseFlags(userId);
    await broadcastSchedulePlacements(userId);
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
    const updated = await updateSchedulePlacement(userId, req.params.id, {
      day: req.body?.day != null ? String(req.body.day) : undefined,
      startHour: req.body?.startHour != null ? Number(req.body.startHour) : undefined,
      durationHours: req.body?.durationHours != null ? Number(req.body.durationHours) : undefined,
    });
    if (!updated) {
      res.status(404).json({ error: "Placement not found" });
      return;
    }
    await broadcastSchedulePlacements(userId);
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
    const id = String(req.params.id);
    const existing = await getSchedulePlacementById(userId, id);
    const ok = await deleteSchedulePlacement(userId, id);
    if (!ok) {
      res.status(404).json({ error: "Placement not found" });
      return;
    }
    if (existing?.setupId) {
      await syncLiveScheduleInUseForSetup(userId, existing.setupId);
    }
    tradingFor(req).forgetPlacement(id);
    await broadcastSchedulePlacements(userId);
    pushWindowState();
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

app.get("/api/schedule-placement-stats", async (req, res) => {
  try {
    const userId = requireUserId(req);
    const allPlacements = await listSchedulePlacements(userId);
    const placementIds = parsePlacementIdsQuery(req);
    const placements = filterSchedulePlacements(allPlacements, placementIds);
    const stats = tradingFor(req).getPlacementStats(placements.map((p) => p._id));
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
    writeEvent("progress", { completed: 1, total: 1 });
    const allPlacements = await listSchedulePlacements(userId);
    const placementIds = parsePlacementIdsQuery(req);
    const placements = filterSchedulePlacements(allPlacements, placementIds);
    const stats = tradingFor(req).getPlacementStats(placements.map((p) => p._id));
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
      res.write(`event: heatmap\ndata: ${JSON.stringify(getHeatmapState())}\n\n`);
      if (userId) {
        const placements = await listSchedulePlacements(userId);
        res.write(`event: schedule-placements\ndata: ${JSON.stringify(placements)}\n\n`);
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
    await maybeBootstrapDefaultPassword();
    const bootstrapId = await getBootstrapUserId();
    await ensureTradingSetupsUserId(bootstrapId);
    await ensureSchedulePlacementsUserId(bootstrapId);
    await ensureTradingSessionMemoryUserId(bootstrapId);
    await reconcileLiveScheduleInUseFlags(bootstrapId);
  } catch (err) {
    logService.warn("server", `Failed to ensure default user / auth indexes: ${String(err)}`);
  }

  liveTradingRegistry.startPolling(5000);
  liveTradingRegistry.onUpdate(() => {
    pushWindowState();
  });

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

  displayService.onUpdate(() => {
    pushWindowState();
  });

  chainlinkPriceFeed.onUpdate(() => {
    pushWindowState();
  });

  clobMarketFeed.onUpdate(() => {
    broadcast("book", { series: displayService.getState().series });
    pushWindowState();
  });

  app.listen(PORT, () => {
    logService.info("server", `Listening on http://localhost:${PORT}`);
  });

  const shutdown = async () => {
    clearInterval(heatmapRefreshTimer);
    liveTradingRegistry.stopPolling();
    displayService.stop();
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
