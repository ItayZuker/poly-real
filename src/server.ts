import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { initStorageAndSeed, ensureAllMarketIndexes, listMarkets, updateMarket, getMarket } from "./db/market-repository.js";
import { listReplayTicks } from "./db/replay-tick-repository.js";
import {
  listChainlinkTicks,
  listClobBookTicks,
  listClobRawTicks,
} from "./db/tick-repository.js";
import { clobMarketFeed } from "./clob-market-feed.js";
import { chainlinkPriceFeed } from "./chainlink-price-feed.js";
import { displayService } from "./display-service.js";
import { recordingManager } from "./recording-manager.js";
import { startArchiveScheduler, stopArchiveScheduler } from "./archive-service.js";
import { simulatorService } from "./simulator-service.js";
import { logService } from "./log-service.js";
import {
  deleteSchedulePlacement,
  deletePlacementsBySetupId,
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
} from "./db/trading-setup-repository.js";
import { closeMongoClient } from "./db/mongo-client.js";
import {
  getHeatmapState,
  loadAllHeatmapWindows,
  setHeatmapUpdateListener,
} from "./heatmap-service.js";
import { getWindowRangeFromPtb } from "./window-dynamics.js";
import { backtestSchedulePlacements } from "./schedule-backtest-service.js";
import type { EnrichedLiveWindowState, ReplayTickDocument, SimSetup } from "./types.js";
import { createPublicClient, getClobHost, getChainId } from "./clob-service.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3847;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));

type SseClient = { id: number; res: express.Response };
let sseClients: SseClient[] = [];
let sseId = 0;

function broadcast(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
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

function enrichWindowState(state: ReturnType<typeof displayService.getState>): EnrichedLiveWindowState {
  const recorderWindow = recordingManager.getActiveWindow(state.series);
  const traderStats = recordingManager.getTraderStats(state.series);
  const range = recorderWindow
    ? getWindowRangeFromPtb(recorderWindow, state.prevCloseAsset)
    : null;
  return {
    ...state,
    recording: recorderWindow || traderStats
      ? {
          ptbCrossings: recorderWindow?.ptbCrossings,
          rangeTop: range?.rangeTop,
          rangeBottom: range?.rangeBottom,
          uniqueTraders: traderStats?.uniqueTraders,
          newWallets: traderStats?.newWallets,
          knownWallets: traderStats?.knownWallets,
        }
      : null,
    sim: simulatorService.getPublicState(),
  };
}

function pushWindowState(): void {
  broadcast("window", enrichWindowState(displayService.getState()));
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

app.get("/api/markets", async (_req, res) => {
  try {
    const markets = await listMarkets();
    res.json(markets);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.patch("/api/markets/:series", async (req, res) => {
  try {
    const series = req.params.series;
    const patch: { recordingEnabled?: boolean } = {};
    if (typeof req.body.recordingEnabled === "boolean") {
      patch.recordingEnabled = req.body.recordingEnabled;
    }
    const updated = await updateMarket(series, patch);
    if (!updated) {
      res.status(404).json({ error: "Market not found" });
      return;
    }
    await recordingManager.refreshMarket(updated);
    broadcast("markets", await listMarkets());
    logService.info(
      "recording",
      `Recording ${updated.recordingEnabled ? "enabled" : "disabled"} for ${updated._id}`,
    );
    res.json(updated);
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
    res.json(enrichWindowState(displayService.getState()));
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

    const saved = await insertTradingSetup({
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

app.get("/api/trading-setups", async (_req, res) => {
  try {
    const setups = await listTradingSetups();
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
    const setup = await getTradingSetupById(req.params.id);
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
    const descriptionRaw = req.body?.description;
    const updated = await updateTradingSetup(req.params.id, {
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
      await updatePlacementTitlesBySetupId(req.params.id, updated.title);
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
    const existing = await getTradingSetupById(req.params.id);
    if (!existing) {
      res.status(404).json({ error: "Setup not found" });
      return;
    }
    await deletePlacementsBySetupId(req.params.id);
    const ok = await deleteTradingSetup(req.params.id);
    if (!ok) {
      res.status(404).json({ error: "Setup not found" });
      return;
    }
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

app.get("/api/schedule-placements", async (_req, res) => {
  try {
    const placements = await listSchedulePlacements();
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
    const saved = await insertSchedulePlacement({
      setupId: String(req.body?.setupId ?? ""),
      title: String(req.body?.title ?? ""),
      day: String(req.body?.day ?? ""),
      startHour: Number(req.body?.startHour),
      durationHours: Number(req.body?.durationHours),
    });
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
    const setupId = String(req.body?.setupId ?? "");
    const title = String(req.body?.title ?? "");
    const setup = await getTradingSetupById(setupId);
    if (!setup) {
      res.status(404).json({ error: "Trading setup not found" });
      return;
    }
    const placements = await replaceAllPlacementsSetup(setupId, title || setup.title);
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
    const updated = await updateSchedulePlacement(req.params.id, {
      day: req.body?.day != null ? String(req.body.day) : undefined,
      startHour: req.body?.startHour != null ? Number(req.body.startHour) : undefined,
      durationHours: req.body?.durationHours != null ? Number(req.body.durationHours) : undefined,
    });
    if (!updated) {
      res.status(404).json({ error: "Placement not found" });
      return;
    }
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
    const ok = await deleteSchedulePlacement(req.params.id);
    if (!ok) {
      res.status(404).json({ error: "Placement not found" });
      return;
    }
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
    const series = getDisplaySeries(req);
    const market = await getMarket(series);
    if (!market) {
      res.status(404).json({ error: "Market not found" });
      return;
    }
    const allPlacements = await listSchedulePlacements();
    const placementIds = parsePlacementIdsQuery(req);
    const placements = filterSchedulePlacements(allPlacements, placementIds);
    const latencyMs = simulatorService.getSetup().latencyMs;
    const setupId = typeof req.query.setupId === "string" ? req.query.setupId : undefined;
    const stats = await backtestSchedulePlacements(market, placements, latencyMs, {
      recomputeSetupId: setupId,
    });
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

  writeEvent("progress", { completed: 0, total: 0, indeterminate: true });

  try {
    const series = getDisplaySeries(req);
    const market = await getMarket(series);
    if (!market) {
      writeEvent("failure", { error: "Market not found" });
      res.end();
      return;
    }
    const allPlacements = await listSchedulePlacements();
    const placementIds = parsePlacementIdsQuery(req);
    const placements = filterSchedulePlacements(allPlacements, placementIds);
    const latencyMs = simulatorService.getSetup().latencyMs;
    const setupId = typeof req.query.setupId === "string" ? req.query.setupId : undefined;
    const stats = await backtestSchedulePlacements(market, placements, latencyMs, {
      recomputeSetupId: setupId,
      onProgress: (progress) => writeEvent("progress", progress),
      shouldAbort: () => closed,
    });
    if (!closed) {
      writeEvent("done", stats);
      res.end();
    }
  } catch (err) {
    const message = String(err);
    if (!closed) {
      writeEvent("failure", { error: message.includes("MONGODB_URI") ? message : message });
      res.end();
    }
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

  const client: SseClient = { id: ++sseId, res };
  sseClients.push(client);

  void (async () => {
    try {
      const markets = await listMarkets();
      res.write(`event: markets\ndata: ${JSON.stringify(markets)}\n\n`);
      res.write(`event: window\ndata: ${JSON.stringify(enrichWindowState(displayService.getState()))}\n\n`);
      res.write(`event: log-history\ndata: ${JSON.stringify(logService.getRecent())}\n\n`);
      res.write(`event: heatmap\ndata: ${JSON.stringify(getHeatmapState())}\n\n`);
      const placements = await listSchedulePlacements();
      res.write(`event: schedule-placements\ndata: ${JSON.stringify(placements)}\n\n`);
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

  logService.onEntry((entry) => {
    broadcastLog(entry);
  });

  setHeatmapUpdateListener((state) => {
    broadcast("heatmap", state);
  });
  await loadAllHeatmapWindows();

  chainlinkPriceFeed.start();
  clobMarketFeed.start();
  displayService.start();

  recordingManager.setOnChange(() => {
    pushWindowState();
  });
  await recordingManager.sync();
  startArchiveScheduler();

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
    stopArchiveScheduler();
    recordingManager.stopAll();
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
