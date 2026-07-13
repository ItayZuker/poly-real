import { SEED_MARKETS } from "../collections.js";
import type { MarketDocument } from "../types.js";
import {
  ensureMarketDirs,
  getDataDir,
  initStorage,
  marketsFilePath,
} from "./data-dir.js";
import { readJsonFile, writeJsonFile } from "./file-store.js";

const SEED_SERIES_IDS = SEED_MARKETS.map((m) => m.series);

type MarketsFile = Record<string, MarketDocument>;

async function readMarketsFile(): Promise<MarketsFile> {
  return (await readJsonFile<MarketsFile>(marketsFilePath())) ?? {};
}

async function writeMarketsFile(markets: MarketsFile): Promise<void> {
  await writeJsonFile(marketsFilePath(), markets);
}

export async function initStorageAndSeed(): Promise<void> {
  await initStorage();
  await seedMarkets();
  await ensureAllMarketDirs();
}

export async function seedMarkets(): Promise<void> {
  const markets = await readMarketsFile();
  const now = new Date().toISOString();

  for (const seed of SEED_MARKETS) {
    const existing = markets[seed.series];
    markets[seed.series] = {
      _id: seed.series,
      label: seed.label,
      timeframeMinutes: seed.timeframeMinutes,
      recordingEnabled: existing?.recordingEnabled ?? false,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
  }

  await writeMarketsFile(markets);
}

export async function ensureAllMarketDirs(): Promise<void> {
  await Promise.all(SEED_SERIES_IDS.map((series) => ensureMarketDirs(series)));
}

/** @deprecated Indexes are not used with file storage. */
export async function ensureAllMarketIndexes(): Promise<void> {
  await ensureAllMarketDirs();
}

export async function listMarkets(): Promise<MarketDocument[]> {
  const markets = await readMarketsFile();
  return SEED_SERIES_IDS.map((series) => markets[series]).filter(
    (market): market is MarketDocument => market != null,
  );
}

export async function getMarket(series: string): Promise<MarketDocument | null> {
  const markets = await readMarketsFile();
  return markets[series] ?? null;
}

export async function updateMarket(
  series: string,
  patch: Partial<Pick<MarketDocument, "recordingEnabled">>,
): Promise<MarketDocument | null> {
  const markets = await readMarketsFile();
  const existing = markets[series];
  if (!existing) return null;

  const updated: MarketDocument = {
    ...existing,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  markets[series] = updated;
  await writeMarketsFile(markets);
  return updated;
}

export { getDataDir };
