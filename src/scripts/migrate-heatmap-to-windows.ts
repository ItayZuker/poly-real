/**
 * One-time migration: merge heatmap/*.json stats into windows/*.json, then stop using heatmap/.
 *
 * Usage:
 *   npm run migrate:heatmap-to-windows
 *   npm run migrate:heatmap-to-windows -- btc-5m
 */
import "dotenv/config";
import path from "path";
import { getMarket, listMarkets } from "../db/market-repository.js";
import { initStorage, marketHeatmapDir } from "../db/data-dir.js";
import { listWindowFiles, readJsonFile } from "../db/file-store.js";
import {
  getRecordedWindow,
  saveRecordedWindow,
} from "../db/recorded-window-repository.js";
import { fromStoredHeatmapWindow, type StoredHeatmapDocument } from "../heatmap-compact.js";
import { mergeHeatmapIntoRecordedWindow } from "../window-merge.js";
import type { MarketDocument } from "../types.js";

async function migrateMarket(market: MarketDocument): Promise<void> {
  const heatmapDir = marketHeatmapDir(market._id);
  let heatmapFiles: string[];
  try {
    heatmapFiles = await listWindowFiles(heatmapDir);
  } catch {
    heatmapFiles = [];
  }

  if (heatmapFiles.length === 0) {
    console.log(`[migrate] ${market._id}: no heatmap files`);
    return;
  }

  let merged = 0;
  let created = 0;
  let unchanged = 0;

  for (const filename of heatmapFiles) {
    const heatmapPath = path.join(heatmapDir, filename);
    const raw = await readJsonFile<StoredHeatmapDocument>(heatmapPath);
    if (!raw) continue;

    const heatmap = fromStoredHeatmapWindow(raw);
    const recorded = await getRecordedWindow(market, heatmap.windowStart);
    const next = mergeHeatmapIntoRecordedWindow(recorded, heatmap);

    const same =
      recorded != null &&
      recorded.windowOutcome === next.windowOutcome &&
      recorded.ptbCrossings === next.ptbCrossings &&
      recorded.minAssetPrice === next.minAssetPrice &&
      recorded.maxAssetPrice === next.maxAssetPrice &&
      recorded.rangeTop === next.rangeTop &&
      recorded.rangeBottom === next.rangeBottom &&
      recorded.uniqueTraders === next.uniqueTraders &&
      recorded.newWallets === next.newWallets &&
      recorded.knownWallets === next.knownWallets;

    if (same) {
      unchanged += 1;
      continue;
    }

    await saveRecordedWindow(market, next);
    if (recorded) merged += 1;
    else created += 1;
  }

  console.log(
    `[migrate] ${market._id}: heatmap=${heatmapFiles.length} merged=${merged}` +
      ` created=${created} unchanged=${unchanged}`,
  );
}

async function main(): Promise<void> {
  await initStorage();
  const seriesArg = process.argv[2]?.trim();
  const markets = seriesArg
    ? [await getMarket(seriesArg)].filter((m): m is MarketDocument => m != null)
    : await listMarkets();

  if (markets.length === 0) {
    console.error(seriesArg ? `Market not found: ${seriesArg}` : "No markets found");
    process.exitCode = 1;
    return;
  }

  for (const market of markets) {
    await migrateMarket(market);
  }

  console.log("[migrate] Done. You can delete data/*/heatmap/ folders after verifying the app.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
