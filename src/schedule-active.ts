import { listSchedulePlacements } from "./db/schedule-placement-repository.js";
import { getTradingSetupById } from "./db/trading-setup-repository.js";
import type { ScheduleDayId, TradingPhaseSetup } from "./types.js";

const VALID_DAYS: ScheduleDayId[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

export interface ActiveScheduleContext {
  placementId: string;
  setupId: string;
  title: string;
  setup: TradingPhaseSetup;
  day: ScheduleDayId;
  startHour: number;
  durationHours: number;
}

export function getUtcScheduleClock(now = new Date()): { day: ScheduleDayId; hour: number } {
  const dayIndex = now.getUTCDay();
  const dayMap: ScheduleDayId[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const day = dayMap[dayIndex] ?? "mon";
  const hour =
    now.getUTCHours() +
    now.getUTCMinutes() / 60 +
    now.getUTCSeconds() / 3600;
  return { day, hour };
}

/** Sort key within the UTC week (Sun=0 … Sat=6, then start hour). */
export function schedulePlacementSortKey(placement: {
  day: ScheduleDayId;
  startHour: number;
}): number {
  const dayMap: Record<ScheduleDayId, number> = {
    sun: 0,
    mon: 1,
    tue: 2,
    wed: 3,
    thu: 4,
    fri: 5,
    sat: 6,
  };
  return (dayMap[placement.day] ?? 0) * 24 + placement.startHour;
}

/** True when this week's slot has fully ended (before the current UTC clock). */
export function isSchedulePlacementElapsed(
  placement: { day: ScheduleDayId; startHour: number; durationHours: number },
  now = new Date(),
): boolean {
  const { day, hour } = getUtcScheduleClock(now);
  const nowKey = schedulePlacementSortKey({ day, startHour: hour });
  const endKey = schedulePlacementSortKey(placement) + placement.durationHours;
  return endKey <= nowKey + 1e-9;
}

export function isScheduleContextActive(
  ctx: Pick<ActiveScheduleContext, "day" | "startHour" | "durationHours">,
  now = new Date(),
): boolean {
  const { day, hour } = getUtcScheduleClock(now);
  return (
    ctx.day === day && hour >= ctx.startHour && hour < ctx.startHour + ctx.durationHours
  );
}

export async function findActiveScheduleContext(
  userId: string,
  now = new Date(),
): Promise<ActiveScheduleContext | null> {
  const { day, hour } = getUtcScheduleClock(now);
  if (!VALID_DAYS.includes(day)) return null;

  const placements = await listSchedulePlacements(userId);
  const placement = placements.find(
    (p) => p.day === day && hour >= p.startHour && hour < p.startHour + p.durationHours,
  );
  if (!placement) return null;

  const doc = await getTradingSetupById(userId, placement.setupId);
  if (!doc?.setup) return null;

  return {
    placementId: placement._id,
    setupId: placement.setupId,
    title: doc.title,
    setup: doc.setup,
    day: placement.day,
    startHour: placement.startHour,
    durationHours: placement.durationHours,
  };
}
