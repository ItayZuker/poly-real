/**
 * Repair loss/win rows whose stored P/L sign disagrees with status,
 * then dedupe cards that match the same Polymarket fill.
 */
import "dotenv/config";
import { MongoClient } from "mongodb";

const uri = process.env.MONGODB_URI?.trim();
if (!uri) {
  console.error("MONGODB_URI missing");
  process.exit(1);
}
const dbName = process.env.MONGODB_DB?.trim() || "poly_recorder";

async function main(): Promise<void> {
  const client = new MongoClient(uri!);
  await client.connect();
  const db = client.db(dbName);
  const col = db.collection("trading_stat_events");
  const backup = db.collection("trading_stat_events_repair_backup_20260718b");

  const rows = await col.find({}).toArray();
  let fixed = 0;

  for (const e of rows) {
    const card = (e.card ?? {}) as Record<string, unknown>;
    const buyCost = Number(card.buyCost);
    const buyFees = Number(card.buyFees ?? 0);
    const shares = Number(card.shares);
    const pl = Number(e.pnl);
    if (!Number.isFinite(buyCost) || !Number.isFinite(shares) || !Number.isFinite(pl)) continue;
    if (e.status !== "loss" && e.status !== "win") continue;

    const disagrees = (pl > 1e-9 && e.status === "loss") || (pl < -1e-9 && e.status === "win");
    if (!disagrees) continue;

    // Status came from token curPrice; recompute held P/L to match it.
    const won = e.status === "win";
    const nextPl = (won ? shares : 0) - buyCost - buyFees;
    const green = 0;
    const red = won ? 0 : 1;
    const blue = won ? 1 : 0;
    const side = String(card.side || "");
    const outcome = won ? side : side === "up" ? "down" : "up";

    await backup.replaceOne(
      { _id: e._id },
      { ...e, repairBackupAt: new Date().toISOString(), repairReason: "pnl-status-mismatch" },
      { upsert: true },
    );
    await col.updateOne(
      { _id: e._id },
      {
        $set: {
          status: e.status,
          green,
          red,
          blue,
          pnl: nextPl,
          "card.status": e.status,
          "card.pl": nextPl,
          "card.outcome": outcome,
          updatedAt: new Date().toISOString(),
        },
      },
    );
    fixed += 1;
    console.log(`fixed ${e.cardId}: ${e.status} ${pl} -> ${nextPl}`);
  }

  const after = await col.find({}).toArray();
  const groups = new Map<string, typeof after>();
  for (const e of after) {
    const x = (e.card ?? {}) as Record<string, unknown>;
    const usable = Boolean(x.conditionId && x.asset && Number.isFinite(Number(x.buyAt)));
    const key = usable
      ? [e.userId || "", x.conditionId, x.asset, x.buyAt].join("|")
      : `card:${e.cardId}`;
    const list = groups.get(key) ?? [];
    list.push(e);
    groups.set(key, list);
  }

  let deleted = 0;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => String(a.cardId).localeCompare(String(b.cardId)));
    for (const doc of group.slice(1)) {
      await backup.replaceOne(
        { _id: doc._id },
        { ...doc, repairBackupAt: new Date().toISOString(), repairReason: "duplicate" },
        { upsert: true },
      );
      deleted += (await col.deleteOne({ _id: doc._id })).deletedCount;
    }
  }

  const kept = await col.find({}).toArray();
  const totals = kept.reduce(
    (a, e) => ({
      events: a.events + 1,
      green: a.green + (Number(e.green) || 0),
      red: a.red + (Number(e.red) || 0),
      blue: a.blue + (Number(e.blue) || 0),
      pnl: a.pnl + (Number(e.pnl) || 0),
    }),
    { events: 0, green: 0, red: 0, blue: 0, pnl: 0 },
  );
  const active = kept
    .filter((e) => e.placementId === "6a5aaf9327a5c51624983059")
    .map((e) => ({ status: e.status, pnl: e.pnl, green: e.green, red: e.red, blue: e.blue }));

  console.log(JSON.stringify({ fixed, deleted, totals, active }, null, 2));
  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
