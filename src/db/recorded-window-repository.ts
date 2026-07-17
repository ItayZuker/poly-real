import type { MarketDocument, RecordedWindowDocument } from "../types.js";
import {
  fromStoredRecordedWindow,
  toStoredRecordedWindow,
  type StoredWindowDocument,
  WK,
} from "../window-compact.js";
import { marketWindowsDir } from "./data-dir.js";
import { deleteWindowFilesBefore, listWindowFiles, readJsonFile, writeJsonFile } from "./file-store.js";
import path from "path";

/**
 * Local JSON window files under data/{series}/windows — legacy offline helpers.
 * Live heatmap uses Mongo (`recorded-window-mongo-repository`).
 * Prefer Mongo for any new code paths.
 */

function windowFilePath(market: MarketDocument, windowStart: number): string {
  return path.join(marketWindowsDir(market._id), `${windowStart}.json`);
}

export async function saveRecordedWindow(
  market: MarketDocument,
  doc: Omit<RecordedWindowDocument, "_id" | "updatedAt">,
): Promise<void> {
  const now = new Date().toISOString();
  const stored = toStoredRecordedWindow({ ...doc, updatedAt: now });
  await writeJsonFile(windowFilePath(market, doc.windowStart), stored);
}

export async function getRecordedWindow(
  market: MarketDocument,
  windowStart: number,
): Promise<RecordedWindowDocument | null> {
  const doc = await readJsonFile<StoredWindowDocument>(windowFilePath(market, windowStart));
  return doc ? fromStoredRecordedWindow(doc) : null;
}

export async function listRecordedWindows(
  market: MarketDocument,
): Promise<RecordedWindowDocument[]> {
  const dir = marketWindowsDir(market._id);
  const files = await listWindowFiles(dir);
  const windows = await Promise.all(
    files.map(async (filename) => {
      const doc = await readJsonFile<StoredWindowDocument>(path.join(dir, filename));
      return doc ? fromStoredRecordedWindow(doc) : null;
    }),
  );
  return windows
    .filter((window): window is RecordedWindowDocument => window != null)
    .sort((a, b) => a.windowStart - b.windowStart);
}

export async function getWindowDataVersion(
  market: MarketDocument,
  windows?: RecordedWindowDocument[],
): Promise<string> {
  const list = windows ?? (await listRecordedWindows(market));
  if (list.length === 0) return "0";
  const latest = list.reduce((best, current) =>
    current.windowStart > best.windowStart ? current : best,
  );
  return `${latest.windowStart}:${latest.savedAt}`;
}

export async function pruneRecordedWindows(
  market: MarketDocument,
  cutoff: number,
): Promise<number> {
  return deleteWindowFilesBefore(marketWindowsDir(market._id), cutoff);
}

export { WK };
