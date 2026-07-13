import { createRequire } from "node:module";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import type { Archiver } from "archiver";

const require = createRequire(import.meta.url);
const archiver = require("archiver") as (format: string, options?: { zlib?: { level?: number } }) => Archiver;
import { hotCutoffSec, utcDayKey } from "../retention.js";
import { logService } from "../log-service.js";
import type { MarketDocument } from "../types.js";
import {
  marketArchiveDir,
  marketTicksDir,
  marketWindowsDir,
  parseWindowStartFromFilename,
} from "./data-dir.js";

export interface ArchiveDayResult {
  dayKey: string;
  windowCount: number;
  zipPath: string;
  skippedExisting: boolean;
}

export interface ArchiveMarketResult {
  series: string;
  cutoffSec: number;
  days: ArchiveDayResult[];
  orphansRemoved: number;
}

async function listColdWindowStarts(series: string, cutoffSec: number): Promise<Set<number>> {
  const cold = new Set<number>();

  const scanDir = async (dir: string) => {
    try {
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const windowStart = parseWindowStartFromFilename(entry.name);
        if (windowStart == null || windowStart >= cutoffSec) continue;
        cold.add(windowStart);
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw err;
    }
  };

  await Promise.all([
    scanDir(marketTicksDir(series)),
    scanDir(marketWindowsDir(series)),
  ]);

  return cold;
}

async function zipExists(zipPath: string): Promise<boolean> {
  try {
    await fsp.access(zipPath);
    return true;
  } catch {
    return false;
  }
}

async function removeHotWindowFiles(
  series: string,
  windowStart: number,
): Promise<void> {
  const tickDir = path.join(marketTicksDir(series), String(windowStart));
  await fsp.rm(tickDir, { recursive: true, force: true });

  const windowFile = path.join(marketWindowsDir(series), `${windowStart}.json`);
  await fsp.rm(windowFile, { force: true });
}

async function appendWindowToArchive(
  archive: Archiver,
  series: string,
  windowStart: number,
): Promise<void> {
  const tickDir = path.join(marketTicksDir(series), String(windowStart));
  try {
    await fsp.access(tickDir);
    archive.directory(tickDir, `ticks/${windowStart}`);
  } catch {
    // no tick dir
  }

  const windowFile = path.join(marketWindowsDir(series), `${windowStart}.json`);
  try {
    await fsp.access(windowFile);
    archive.file(windowFile, { name: `windows/${windowStart}.json` });
  } catch {
    // no window file
  }
}

async function buildDayZip(
  series: string,
  dayKey: string,
  windowStarts: number[],
): Promise<string> {
  const archiveDir = marketArchiveDir(series);
  await fsp.mkdir(archiveDir, { recursive: true });
  const zipPath = path.join(archiveDir, `${dayKey}.zip`);

  await new Promise<void>((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 6 } });

    output.on("close", () => resolve());
    archive.on("error", reject);
    output.on("error", reject);
    archive.pipe(output);

    void (async () => {
      try {
        for (const windowStart of windowStarts.sort((a, b) => a - b)) {
          await appendWindowToArchive(archive, series, windowStart);
        }
        await archive.finalize();
      } catch (err) {
        reject(err);
      }
    })();
  });

  return zipPath;
}

/** Zip cold window data by UTC day and remove hot copies. Runs regardless of recording state. */
export async function archiveColdMarketData(
  market: MarketDocument,
): Promise<ArchiveMarketResult> {
  const series = market._id;
  const cutoffSec = hotCutoffSec();
  const coldWindows = await listColdWindowStarts(series, cutoffSec);

  const byDay = new Map<string, number[]>();
  for (const windowStart of coldWindows) {
    const dayKey = utcDayKey(windowStart);
    const batch = byDay.get(dayKey) ?? [];
    batch.push(windowStart);
    byDay.set(dayKey, batch);
  }

  const days: ArchiveDayResult[] = [];
  let orphansRemoved = 0;

  for (const [dayKey, windowStarts] of [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const zipPath = path.join(marketArchiveDir(series), `${dayKey}.zip`);
    const exists = await zipExists(zipPath);

    if (exists) {
      for (const windowStart of windowStarts) {
        await removeHotWindowFiles(series, windowStart);
        orphansRemoved += 1;
      }
      days.push({
        dayKey,
        windowCount: windowStarts.length,
        zipPath,
        skippedExisting: true,
      });
      continue;
    }

    if (windowStarts.length === 0) continue;

    await buildDayZip(series, dayKey, windowStarts);

    for (const windowStart of windowStarts) {
      await removeHotWindowFiles(series, windowStart);
    }

    days.push({
      dayKey,
      windowCount: windowStarts.length,
      zipPath,
      skippedExisting: false,
    });

    logService.success(
      "archive",
      `Archived ${windowStarts.length} windows for ${series} (${dayKey})`,
    );
  }

  return { series, cutoffSec, days, orphansRemoved };
}
