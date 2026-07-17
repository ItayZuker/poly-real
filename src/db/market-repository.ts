import { SEED_MARKETS } from "../collections.js";
import type { MarketDocument } from "../types.js";
import {
  ensureMarketDirs,
  getDataDir,
  initStorage,
  marketsFilePath,
} from "./data-dir.js";
import { readJsonFile } from "./file-store.js";
import { getMongoClient, getMongoDbName } from "./mongo-client.js";

const COLLECTION = "markets";
const SEED_SERIES_IDS = SEED_MARKETS.map((m) => m.series);

type MarketsFile = Record<string, MarketDocument>;

async function collection() {
  const mongo = await getMongoClient();
  return mongo.db(getMongoDbName()).collection<MarketDocument>(COLLECTION);
}

export async function ensureMarketIndexes(): Promise<void> {
  const col = await collection();
  await col.createIndex({ timeframeMinutes: 1 });
}

/** One-time import from legacy data/markets.json when Mongo is empty. */
async function migrateMarketsFromDiskIfNeeded(): Promise<void> {
  const col = await collection();
  const existing = await col.estimatedDocumentCount();
  if (existing > 0) return;

  const disk = await readJsonFile<MarketsFile>(marketsFilePath());
  if (!disk || Object.keys(disk).length === 0) return;

  const docs = Object.values(disk).filter((m) => m?._id);
  if (docs.length === 0) return;

  await col.insertMany(docs, { ordered: false });
}

export async function initStorageAndSeed(): Promise<void> {
  await initStorage();
  await ensureMarketIndexes();
  await migrateMarketsFromDiskIfNeeded();
  await seedMarkets();
  await ensureAllMarketDirs();
}

export async function seedMarkets(): Promise<void> {
  const col = await collection();
  const now = new Date().toISOString();

  for (const seed of SEED_MARKETS) {
    const existing = await col.findOne({ _id: seed.series });
    await col.updateOne(
      { _id: seed.series },
      {
        $set: {
          label: seed.label,
          timeframeMinutes: seed.timeframeMinutes,
          updatedAt: now,
        },
        $setOnInsert: {
          _id: seed.series,
          createdAt: existing?.createdAt ?? now,
        },
      },
      { upsert: true },
    );
  }
}

export async function ensureAllMarketDirs(): Promise<void> {
  await Promise.all(SEED_SERIES_IDS.map((series) => ensureMarketDirs(series)));
}

export async function ensureAllMarketIndexes(): Promise<void> {
  await ensureMarketIndexes();
  await ensureAllMarketDirs();
}

export async function listMarkets(): Promise<MarketDocument[]> {
  const col = await collection();
  const docs = await col.find({ _id: { $in: [...SEED_SERIES_IDS] } }).toArray();
  const byId = new Map(docs.map((d) => [d._id, d]));
  return SEED_SERIES_IDS.map((series) => byId.get(series)).filter(
    (market): market is MarketDocument => market != null,
  );
}

export async function getMarket(series: string): Promise<MarketDocument | null> {
  const col = await collection();
  return col.findOne({ _id: series });
}

export { getDataDir };
