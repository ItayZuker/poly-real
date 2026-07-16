/**
 * Restore schedule-card live stats after an accidental header reset.
 * Events were never deleted — rebuilds activatedPlacementIds (including zero-trade
 * gaps between slots with activity), clears liveResetAt.
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

async function main(): Promise<void> {
  const client = new MongoClient(uri!);
  await client.connect();
  const db = client.db(dbName);

  const eventsCol = db.collection("trading_stat_events");
  const metaCol = db.collection("trading_session_memory");
  const placementsCol = db.collection("schedual_setups_real");

  const events = await eventsCol.find({}).toArray();
  console.log(`Found ${events.length} trading_stat_events`);

  const placements = await placementsCol.find({}).toArray();
  console.log(`Found ${placements.length} schedule placements`);

  let green = 0;
  let red = 0;
  let blue = 0;
  let pnl = 0;
  for (const e of events) {
    green += Number(e.green) || 0;
    red += Number(e.red) || 0;
    blue += Number(e.blue) || 0;
    pnl += Number(e.pnl) || 0;
  }
  console.log("Event totals:", { green, red, blue, pnl: Number(pnl.toFixed(4)) });

  const metaDocs = await metaCol.find({}).toArray();
  for (const doc of metaDocs) {
    const userId = String(doc._id);
    const userEvents = events.filter((e) => !e.userId || e.userId === userId);
    const userPlacements = placements.filter((p) => !p.userId || String(p.userId) === userId);

    const fromEvents = userEvents
      .map((e) => e.placementId)
      .filter((id): id is string => typeof id === "string" && id.length > 0);

    const prev = Array.isArray(doc.activatedPlacementIds)
      ? doc.activatedPlacementIds.filter((id: unknown) => typeof id === "string")
      : [];

    const seed = new Set<string>([...prev, ...fromEvents]);

    // Fill timeline gaps between known activations → gray +$0.00 for zero-trade slots.
    const keyed = userPlacements
      .map((p) => ({
        id: String(p._id),
        key: sortKey(p.day as DayId, Number(p.startHour) || 0),
      }))
      .sort((a, b) => a.key - b.key);
    const knownKeys = keyed.filter((k) => seed.has(k.id)).map((k) => k.key);
    if (knownKeys.length >= 1) {
      const minK = Math.min(...knownKeys);
      const maxK = Math.max(...knownKeys);
      for (const k of keyed) {
        if (k.key >= minK && k.key <= maxK) seed.add(k.id);
      }
    }

    const merged = [...seed];
    await metaCol.updateOne(
      { _id: doc._id },
      {
        $set: {
          liveResetAt: null,
          activatedPlacementIds: merged,
          updatedAt: new Date().toISOString(),
        },
      },
    );
    console.log(
      `Restored user ${userId.slice(0, 8)}…: liveResetAt=null, activatedPlacementIds=${merged.length} (was ${prev.length})`,
    );
  }

  await client.close();
  console.log("Done. Restart the server (or POST /api/trading/stats/rehydrate) to reload RAM.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
