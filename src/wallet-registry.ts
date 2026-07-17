import type { WalletRegistry } from "./types.js";
import { walletsFilePath } from "./db/data-dir.js";
import { readJsonFile } from "./db/file-store.js";
import {
  countTraderWallets,
  ensureTraderWalletIndexes,
  findTraderWalletsByAddresses,
  importTraderWalletsFromRegistry,
  listAllTraderWallets,
  upsertTraderWalletsForWindow,
} from "./db/trader-wallet-repository.js";

let migratePromise: Promise<void> | null = null;

async function migrateFromDiskIfNeeded(): Promise<void> {
  if (!migratePromise) {
    migratePromise = (async () => {
      try {
        const loaded = await readJsonFile<WalletRegistry>(walletsFilePath());
        if (!loaded || Object.keys(loaded).length === 0) return;
        const imported = await importTraderWalletsFromRegistry(loaded);
        if (imported > 0) {
          // Keep the file for backup; Mongo is now source of truth.
        }
      } catch {
        // No legacy file or unreadable — fine.
      }
    })();
  }
  await migratePromise;
}

export async function ensureWalletRegistryReady(): Promise<void> {
  await ensureTraderWalletIndexes();
  await migrateFromDiskIfNeeded();
}

export interface RegisterWindowTradersResult {
  newWallets: number;
  knownWallets: number;
}

function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

/** Classify wallets against the registry without writing (for live UI during a window). */
export async function classifyWindowTraders(
  addresses: string[],
): Promise<RegisterWindowTradersResult> {
  await migrateFromDiskIfNeeded();
  const unique = [...new Set(addresses.map(normalizeAddress).filter(Boolean))];
  if (unique.length === 0) {
    return { newWallets: 0, knownWallets: 0 };
  }

  const existing = await findTraderWalletsByAddresses(unique);
  let newWallets = 0;
  let knownWallets = 0;

  for (const address of unique) {
    if (existing.has(address)) {
      knownWallets += 1;
    } else {
      newWallets += 1;
    }
  }

  return { newWallets, knownWallets };
}

/** Register each wallet once for this window; bump per-market counts once per window per wallet. */
export async function registerWindowTraders(
  marketSeries: string,
  addresses: string[],
): Promise<RegisterWindowTradersResult> {
  await migrateFromDiskIfNeeded();
  return upsertTraderWalletsForWindow(marketSeries, addresses);
}

export async function getWalletRegistry(): Promise<WalletRegistry> {
  await migrateFromDiskIfNeeded();
  return listAllTraderWallets();
}

export async function getWalletCount(): Promise<number> {
  await migrateFromDiskIfNeeded();
  return countTraderWallets();
}
