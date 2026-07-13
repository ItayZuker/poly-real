import type {
  ChainlinkTickDocument,
  ClobBookTickDocument,
  ClobRawTickDocument,
  MarketDocument,
} from "../types.js";
import {
  chainlinkTicksPath,
  clobBookTicksPath,
  clobRawTicksPath,
  marketTicksDir,
  parseWindowStartFromFilename,
  windowTicksDir,
} from "./data-dir.js";
import { appendJsonlLines, readJsonlFile } from "./file-store.js";
import fs from "fs/promises";
import path from "path";

async function appendTicks<T>(filePath: string, docs: T[]): Promise<void> {
  await appendJsonlLines(filePath, docs);
}

export async function insertClobRawTicks(
  market: MarketDocument,
  ticks: ClobRawTickDocument[],
): Promise<void> {
  if (ticks.length === 0) return;
  const byWindow = new Map<number, ClobRawTickDocument[]>();
  for (const tick of ticks) {
    const batch = byWindow.get(tick.windowStart) ?? [];
    batch.push(tick);
    byWindow.set(tick.windowStart, batch);
  }
  await Promise.all(
    [...byWindow.entries()].map(([windowStart, batch]) =>
      appendTicks(clobRawTicksPath(market._id, windowStart), batch),
    ),
  );
}

export async function insertClobBookTicks(
  market: MarketDocument,
  ticks: ClobBookTickDocument[],
): Promise<void> {
  if (ticks.length === 0) return;
  const byWindow = new Map<number, ClobBookTickDocument[]>();
  for (const tick of ticks) {
    const batch = byWindow.get(tick.windowStart) ?? [];
    batch.push(tick);
    byWindow.set(tick.windowStart, batch);
  }
  await Promise.all(
    [...byWindow.entries()].map(([windowStart, batch]) =>
      appendTicks(clobBookTicksPath(market._id, windowStart), batch),
    ),
  );
}

export async function insertChainlinkTicks(
  market: MarketDocument,
  ticks: ChainlinkTickDocument[],
): Promise<void> {
  if (ticks.length === 0) return;
  const byWindow = new Map<number, ChainlinkTickDocument[]>();
  for (const tick of ticks) {
    const batch = byWindow.get(tick.windowStart) ?? [];
    batch.push(tick);
    byWindow.set(tick.windowStart, batch);
  }
  await Promise.all(
    [...byWindow.entries()].map(([windowStart, batch]) =>
      appendTicks(chainlinkTicksPath(market._id, windowStart), batch),
    ),
  );
}

export async function listClobRawTicks(
  market: MarketDocument,
  windowStart: number,
  limit = 10_000,
): Promise<ClobRawTickDocument[]> {
  return readJsonlFile<ClobRawTickDocument>(clobRawTicksPath(market._id, windowStart), limit);
}

export async function listClobBookTicks(
  market: MarketDocument,
  windowStart: number,
  limit = 10_000,
): Promise<ClobBookTickDocument[]> {
  const ticks = await readJsonlFile<ClobBookTickDocument>(
    clobBookTicksPath(market._id, windowStart),
    limit,
  );
  return ticks.sort((a, b) => a.tMs - b.tMs);
}

export async function listChainlinkTicks(
  market: MarketDocument,
  windowStart: number,
  limit = 10_000,
): Promise<ChainlinkTickDocument[]> {
  const ticks = await readJsonlFile<ChainlinkTickDocument>(
    chainlinkTicksPath(market._id, windowStart),
    limit,
  );
  return ticks.sort((a, b) => a.tMs - b.tMs);
}

export async function countClobRawTicksForWindow(
  market: MarketDocument,
  windowStart: number,
): Promise<number> {
  const raw = await readJsonlFile<ClobRawTickDocument>(
    clobRawTicksPath(market._id, windowStart),
    Number.MAX_SAFE_INTEGER,
  );
  return raw.length;
}

export async function countClobBookTicksForWindow(
  market: MarketDocument,
  windowStart: number,
): Promise<number> {
  const raw = await readJsonlFile<ClobBookTickDocument>(
    clobBookTicksPath(market._id, windowStart),
    Number.MAX_SAFE_INTEGER,
  );
  return raw.length;
}

export async function countChainlinkTicksForWindow(
  market: MarketDocument,
  windowStart: number,
): Promise<number> {
  const raw = await readJsonlFile<ChainlinkTickDocument>(
    chainlinkTicksPath(market._id, windowStart),
    Number.MAX_SAFE_INTEGER,
  );
  return raw.length;
}

/** @deprecated Use listClobBookTicks */
export const listBookTicks = listClobBookTicks;

export async function pruneTicks(market: MarketDocument, cutoff: number): Promise<number> {
  const ticksRoot = marketTicksDir(market._id);
  let deleted = 0;
  try {
    const entries = await fs.readdir(ticksRoot, { withFileTypes: true });
    for (const entry of entries) {
      const windowStart = parseWindowStartFromFilename(entry.name);
      if (windowStart == null || windowStart >= cutoff) continue;
      const target = path.join(ticksRoot, entry.name);
      if (entry.isDirectory()) {
        await fs.rm(target, { recursive: true, force: true });
      } else {
        await fs.unlink(target);
      }
      deleted += 1;
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw err;
  }
  return deleted;
}

export async function ensureWindowTickDir(series: string, windowStart: number): Promise<void> {
  await fs.mkdir(windowTicksDir(series, windowStart), { recursive: true });
}
