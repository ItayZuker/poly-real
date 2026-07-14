import {
  countPlacementsBySetupId,
  listDistinctPlacementSetupIds,
} from "./schedule-placement-repository.js";
import { listTradingSetups, setLiveScheduleInUse } from "./trading-setup-repository.js";

/** Syncs `liveScheduleInUse` on a setup from current live schedule placements. */
export async function syncLiveScheduleInUseForSetup(setupId: string): Promise<void> {
  const id = String(setupId ?? "").trim();
  if (!id) return;
  const count = await countPlacementsBySetupId(id);
  await setLiveScheduleInUse(id, count > 0);
}

/**
 * Reconciles the flag for every trading setup vs live placements.
 * Call after bulk placement changes and on server start.
 */
export async function reconcileLiveScheduleInUseFlags(): Promise<void> {
  const [setups, placedIds] = await Promise.all([
    listTradingSetups(),
    listDistinctPlacementSetupIds(),
  ]);
  const placed = new Set(placedIds);
  await Promise.all(
    setups.map((setup) => setLiveScheduleInUse(setup._id, placed.has(setup._id))),
  );
}
