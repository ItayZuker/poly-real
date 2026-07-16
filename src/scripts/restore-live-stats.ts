/**
 * Repair live card activations: collection started Tue 22:00 UTC this week.
 * Slots before that stay pre-run (dashes). From that floor onward, elapsed /
 * between-fill slots get gray +$0.00 zeros.
 */
import "dotenv/config";
import { MongoClient } from "mongodb";

const uri = process.env.MONGODB_URI?.trim();
if (!uri) {
  console.error("MONGODB_URI missing");
  process.exit(1);
}
const dbName = process.env.MONGODB_DB?.trim() || "poly_recorder";

type DayId = "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat";

function sortKey(day: DayId, startHour: number): number {
  const dayMap: Record<DayId, number> = {
    sun: 0,
    mon: 1,
    tue: 2,
    wed: 3,
    thu: 4,
    fri: 5,
    sat: 6,
  };
  return (dayMap[day] ?? 0) * 24 + startHour;
}

/** Most recent Tuesday 22:00 UTC at or before now. */
function lastTuesday2200Utc(now = new Date()): Date {
  const day = now.getUTCDay(); // Sun=0 … Tue=2
  const daysBack = (day - 2 + 7) % 7;
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysBack, 22, 0, 0, 0),
  );
}

function clockFromMs(ms: number): { day: DayId; hour: number } {
  const d = new Date(ms);
  const dayMap: DayId[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const day = dayMap[d.getUTCDay()] ?? "mon";
  const hour = d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
  return { day, hour };
}

async function main(): Promise<void> {
  const client = new MongoClient(uri!);
  await client.connect();
  const db = client.db(dbName);

  const eventsCol = db.collection("trading_stat_events");
  const metaCol = db.collection("trading_session_memory");
  const placementsCol = db.collection("schedual_setups_real");

  const events = await eventsCol.find({}).toArray();
  const placements = await placementsCol.find({}).toArray();
  const startedAt = lastTuesday2200Utc();
  const floor = sortKey(clockFromMs(startedAt.getTime()).day, clockFromMs(startedAt.getTime()).hour);

  console.log(`Collection start: ${startedAt.toISOString()} (floorKey=${floor})`);
  console.log(`Events=${events.length}, placements=${placements.length}`);

  const metaDocs = await metaCol.find({}).toArray();
  for (const doc of metaDocs) {
    const userId = String(doc._id);
    const userEvents = events.filter((e) => !e.userId || e.userId === userId);
    const userPlacements = placements.filter((p) => !p.userId || String(p.userId) === userId);

    const keyed = userPlacements
      .map((p) => ({
        id: String(p._id),
        key: sortKey(p.day as DayId, Number(p.startHour) || 0),
        end: sortKey(p.day as DayId, Number(p.startHour) || 0) + (Number(p.durationHours) || 0),
      }))
      .sort((a, b) => a.key - b.key);

    const eventIds = new Set(
      userEvents
        .map((e) => e.placementId)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    );

    const seed = new Set<string>();
    for (const k of keyed) {
      if (k.key + 1e-9 < floor) continue;
      if (eventIds.has(k.id)) seed.add(k.id);
    }

    const seedKeys = keyed.filter((k) => seed.has(k.id)).map((k) => k.key);
    if (seedKeys.length >= 1) {
      const minK = Math.min(...seedKeys);
      const maxK = Math.max(...seedKeys);
      for (const k of keyed) {
        if (k.key + 1e-9 < floor) continue;
        if (k.key >= minK && k.key <= maxK) seed.add(k.id);
      }
    }

    // Elapsed since floor through now (UTC week clock).
    const nowClock = clockFromMs(Date.now());
    const nowKey = sortKey(nowClock.day, nowClock.hour);
    for (const k of keyed) {
      if (k.key + 1e-9 < floor) continue;
      if (k.end <= nowKey + 1e-9) seed.add(k.id);
    }

    const merged = [...seed];
    await metaCol.updateOne(
      { _id: doc._id },
      {
        $set: {
          liveResetAt: null,
          liveCollectionStartedAt: startedAt.toISOString(),
          activatedPlacementIds: merged,
          updatedAt: new Date().toISOString(),
        },
      },
      { upsert: true },
    );
    console.log(
      `User ${userId.slice(0, 8)}…: activated=${merged.length} (pre-run slots excluded before Tue 22:00)`,
    );
  }

  await client.close();
  console.log("Done. Restart server / rehydrate to reload RAM.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
