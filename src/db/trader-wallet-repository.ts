import { getMongoClient, getMongoDbName } from "./mongo-client.js";
import type { WalletRegistry, WalletRegistryEntry } from "../types.js";

const COLLECTION = "trader_wallets";

export interface TraderWalletDocument {
  _id: string;
  address: string;
  firstSeenAt: number;
  lastSeenAt: number;
  markets: Record<string, number>;
  totalSightings: number;
}

async function collection() {
  const mongo = await getMongoClient();
  return mongo.db(getMongoDbName()).collection<TraderWalletDocument>(COLLECTION);
}

export async function ensureTraderWalletIndexes(): Promise<void> {
  const col = await collection();
  await col.createIndex({ lastSeenAt: 1 });
}

function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

function toEntry(doc: TraderWalletDocument): WalletRegistryEntry {
  return {
    address: doc.address,
    firstSeenAt: doc.firstSeenAt,
    lastSeenAt: doc.lastSeenAt,
    markets: doc.markets ?? {},
    totalSightings: doc.totalSightings ?? 0,
  };
}

export async function findTraderWalletsByAddresses(
  addresses: string[],
): Promise<Map<string, WalletRegistryEntry>> {
  const unique = [...new Set(addresses.map(normalizeAddress).filter(Boolean))];
  const out = new Map<string, WalletRegistryEntry>();
  if (unique.length === 0) return out;

  const col = await collection();
  const docs = await col.find({ _id: { $in: unique } }).toArray();
  for (const doc of docs) {
    out.set(doc._id, toEntry(doc));
  }
  return out;
}

export async function upsertTraderWalletsForWindow(
  marketSeries: string,
  addresses: string[],
): Promise<{ newWallets: number; knownWallets: number }> {
  const unique = [...new Set(addresses.map(normalizeAddress).filter(Boolean))];
  if (unique.length === 0) {
    return { newWallets: 0, knownWallets: 0 };
  }

  const col = await collection();
  const nowSec = Math.floor(Date.now() / 1000);
  const existing = await findTraderWalletsByAddresses(unique);
  let newWallets = 0;
  let knownWallets = 0;

  const ops = unique.map((address) => {
    const prev = existing.get(address);
    if (!prev) {
      newWallets += 1;
      const doc: TraderWalletDocument = {
        _id: address,
        address,
        firstSeenAt: nowSec,
        lastSeenAt: nowSec,
        markets: { [marketSeries]: 1 },
        totalSightings: 1,
      };
      return {
        updateOne: {
          filter: { _id: address },
          update: { $setOnInsert: doc },
          upsert: true,
        },
      };
    }

    knownWallets += 1;
    return {
      updateOne: {
        filter: { _id: address },
        update: {
          $set: { lastSeenAt: nowSec },
          $inc: {
            totalSightings: 1,
            [`markets.${marketSeries}`]: 1,
          },
        },
      },
    };
  });

  if (ops.length > 0) {
    await col.bulkWrite(ops, { ordered: false });
  }

  return { newWallets, knownWallets };
}

export async function listAllTraderWallets(): Promise<WalletRegistry> {
  const col = await collection();
  const docs = await col.find({}).toArray();
  const registry: WalletRegistry = {};
  for (const doc of docs) {
    registry[doc._id] = toEntry(doc);
  }
  return registry;
}

export async function countTraderWallets(): Promise<number> {
  const col = await collection();
  return col.countDocuments();
}

/** One-time import from legacy data/wallets.json shape. */
export async function importTraderWalletsFromRegistry(registry: WalletRegistry): Promise<number> {
  const entries = Object.values(registry);
  if (entries.length === 0) return 0;

  const col = await collection();
  const existingCount = await col.estimatedDocumentCount();
  if (existingCount > 0) return 0;

  const docs: TraderWalletDocument[] = entries.map((entry) => {
    const address = normalizeAddress(entry.address);
    return {
      _id: address,
      address,
      firstSeenAt: entry.firstSeenAt,
      lastSeenAt: entry.lastSeenAt,
      markets: entry.markets ?? {},
      totalSightings: entry.totalSightings ?? 0,
    };
  });

  if (docs.length === 0) return 0;
  await col.insertMany(docs, { ordered: false });
  return docs.length;
}
