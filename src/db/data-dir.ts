import fs from "fs/promises";
import path from "path";

const DEFAULT_DATA_DIR = "data";

let dataDir: string | null = null;

export function getDataDir(): string {
  if (!dataDir) {
    const configured = process.env.DATA_DIR?.trim();
    dataDir = path.resolve(configured || DEFAULT_DATA_DIR);
  }
  return dataDir;
}

export async function initStorage(): Promise<void> {
  await fs.mkdir(getDataDir(), { recursive: true });
}

export function marketsFilePath(): string {
  return path.join(getDataDir(), "markets.json");
}

/** Legacy path — read once to migrate into Mongo `trader_wallets`. */
export function walletsFilePath(): string {
  return path.join(getDataDir(), "wallets.json");
}

export function marketDir(series: string): string {
  return path.join(getDataDir(), series.replace(/-/g, "_"));
}

export function marketTicksDir(series: string): string {
  return path.join(marketDir(series), "ticks");
}

export function windowTicksDir(series: string, windowStart: number): string {
  return path.join(marketTicksDir(series), String(windowStart));
}

export function clobRawTicksPath(series: string, windowStart: number): string {
  return path.join(windowTicksDir(series, windowStart), "clob-raw.jsonl");
}

export function clobBookTicksPath(series: string, windowStart: number): string {
  return path.join(windowTicksDir(series, windowStart), "clob-book.jsonl");
}

export function chainlinkTicksPath(series: string, windowStart: number): string {
  return path.join(windowTicksDir(series, windowStart), "chainlink.jsonl");
}

export function marketWindowsDir(series: string): string {
  return path.join(marketDir(series), "windows");
}

/** @deprecated Heatmap JSON is no longer written; kept for one-time migration reads. */
export function marketHeatmapDir(series: string): string {
  return path.join(marketDir(series), "heatmap");
}

export function marketArchiveDir(series: string): string {
  return path.join(marketDir(series), "archive");
}

export async function ensureMarketDirs(series: string): Promise<void> {
  await Promise.all([
    fs.mkdir(marketTicksDir(series), { recursive: true }),
    fs.mkdir(marketWindowsDir(series), { recursive: true }),
    fs.mkdir(marketArchiveDir(series), { recursive: true }),
  ]);
}

export function parseWindowStartFromFilename(filename: string): number | null {
  const match = /^(\d+)(?:\.(json|jsonl))?$/.exec(filename);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}
