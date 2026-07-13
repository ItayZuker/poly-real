import { archiveColdMarketData } from "./db/tick-archive.js";
import { listMarkets } from "./db/market-repository.js";
import { logService } from "./log-service.js";

const ARCHIVE_INTERVAL_MS = 60 * 60 * 1000;

let archiveTimer: ReturnType<typeof setInterval> | null = null;
let archiveInFlight = false;

export async function runArchiveForAllMarkets(): Promise<void> {
  if (archiveInFlight) return;
  archiveInFlight = true;
  try {
    const markets = await listMarkets();
    for (const market of markets) {
      try {
        await archiveColdMarketData(market);
      } catch (err) {
        logService.error("archive", `Failed for ${market._id}: ${String(err)}`);
      }
    }
  } finally {
    archiveInFlight = false;
  }
}

export function startArchiveScheduler(): void {
  if (archiveTimer) return;
  logService.info("archive", "Scheduler started");
  void runArchiveForAllMarkets();
  archiveTimer = setInterval(() => {
    void runArchiveForAllMarkets();
  }, ARCHIVE_INTERVAL_MS);
}

export function stopArchiveScheduler(): void {
  if (archiveTimer) {
    clearInterval(archiveTimer);
    archiveTimer = null;
  }
}
