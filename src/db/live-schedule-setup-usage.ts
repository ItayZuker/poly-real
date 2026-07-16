import {
  countPlacementsBySetupId,
  listDistinctPlacementSetupIds,
} from "./schedule-placement-repository.js";
import { listTradingSetups, setLiveScheduleInUse } from "./trading-setup-repository.js";

/** Syncs `liveScheduleInUse` on a setup from current live schedule placements. */
export async function syncLiveScheduleInUseForSetup(
  userId: string,
  setupId: string,
): Promise<void> {
  const id = String(setupId ?? "").trim();
  if (!id) return;
  const count = await countPlacementsBySetupId(userId, id);
  await setLiveScheduleInUse(userId, id, count > 0);
}

/**
 * Reconciles the flag for every trading setup vs live placements.
 * Call after bulk placement changes and on server start.
 */
export async function reconcileLiveScheduleInUseFlags(userId: string): Promise<void> {
  const [setups, placedIds] = await Promise.all([
    listTradingSetups(userId),
    listDistinctPlacementSetupIds(userId),
  ]);
  const placed = new Set(placedIds);
  await Promise.all(
    setups.map((setup) => setLiveScheduleInUse(userId, setup._id, placed.has(setup._id))),
  );
}
