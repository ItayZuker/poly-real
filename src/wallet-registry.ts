import type { WalletRegistry, WalletRegistryEntry } from "./types.js";
import { walletsFilePath } from "./db/data-dir.js";
import { readJsonFile, writeJsonFile } from "./db/file-store.js";

let cache: WalletRegistry | null = null;
let writeChain: Promise<void> = Promise.resolve();

function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

async function loadRegistry(): Promise<WalletRegistry> {
  if (cache) return cache;
  const loaded = await readJsonFile<WalletRegistry>(walletsFilePath());
  cache = loaded ?? {};
  return cache;
}

async function persistRegistry(registry: WalletRegistry): Promise<void> {
  await writeJsonFile(walletsFilePath(), registry);
}

function withRegistryLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export interface RegisterWindowTradersResult {
  newWallets: number;
  knownWallets: number;
}

/** Classify wallets against the registry without writing (for live UI during a window). */
export async function classifyWindowTraders(
  addresses: string[],
): Promise<RegisterWindowTradersResult> {
  const unique = [...new Set(addresses.map(normalizeAddress).filter(Boolean))];
  if (unique.length === 0) {
    return { newWallets: 0, knownWallets: 0 };
  }

  const registry = await loadRegistry();
  let newWallets = 0;
  let knownWallets = 0;

  for (const address of unique) {
    if (registry[address]) {
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
  const unique = [...new Set(addresses.map(normalizeAddress).filter(Boolean))];
  if (unique.length === 0) {
    return { newWallets: 0, knownWallets: 0 };
  }

  return withRegistryLock(async () => {
    const registry = await loadRegistry();
    const nowSec = Math.floor(Date.now() / 1000);
    let newWallets = 0;
    let knownWallets = 0;

    for (const address of unique) {
      const existing = registry[address];
      if (!existing) {
        const entry: WalletRegistryEntry = {
          address,
          firstSeenAt: nowSec,
          lastSeenAt: nowSec,
          markets: { [marketSeries]: 1 },
          totalSightings: 1,
        };
        registry[address] = entry;
        newWallets += 1;
        continue;
      }

      knownWallets += 1;
      existing.lastSeenAt = nowSec;
      existing.totalSightings += 1;
      existing.markets[marketSeries] = (existing.markets[marketSeries] ?? 0) + 1;
    }

    cache = registry;
    await persistRegistry(registry);
    return { newWallets, knownWallets };
  });
}

export async function getWalletRegistry(): Promise<WalletRegistry> {
  return withRegistryLock(async () => loadRegistry());
}

export async function getWalletCount(): Promise<number> {
  const registry = await getWalletRegistry();
  return Object.keys(registry).length;
}
