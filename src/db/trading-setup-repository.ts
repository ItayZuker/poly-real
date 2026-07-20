import type { ObjectId } from "mongodb";
import type { TradingPhaseSetup, TradingSetupRecord } from "../types.js";
import { normalizePhaseConfig, normalizeTradingPhaseSetup } from "../phase-config.js";
import {
  colorFromId,
  normalizeSetupColor,
  pickUniqueSetupColor,
} from "../setup-colors.js";
import { getMongoClient, getMongoDbName } from "./mongo-client.js";

/** Real-app setups only — never read/write `trading_setups_sim`. */
const COLLECTION = "trading_setups_real";
/** Shared legacy name — migration source only; not deleted. */
const LEGACY_COLLECTION = "trading_setups";

export interface CreateTradingSetupInput {
  title: string;
  description?: string;
  setup: TradingSetupRecord["setup"];
}

export interface TradingSetupListItem {
  _id: string;
  title: string;
  description?: string;
  color: string;
  setup: TradingPhaseSetup;
  createdAt: string;
  /** Lower = higher in the schedule setups list. */
  sortOrder?: number;
  /** True while placed on the live (real) schedule. */
  liveScheduleInUse: boolean;
  /** True while placed on the sim schedule. */
  simScheduleInUse: boolean;
}

type TradingSetupDoc = TradingSetupRecord & { _id: ObjectId };

let migratePromise: Promise<void> | null = null;
let ensureUserIdPromise: Promise<void> | null = null;

/**
 * One-time: if `trading_setups_real` is empty and legacy `trading_setups` has
 * docs, copy them preserving `_id` so schedule placements keep working.
 */
async function ensureTradingSetupsMigrated(): Promise<void> {
  if (!migratePromise) {
    migratePromise = (async () => {
      const mongo = await getMongoClient();
      const db = mongo.db(getMongoDbName());
      const real = db.collection(COLLECTION);
      const legacy = db.collection(LEGACY_COLLECTION);

      const realCount = await real.countDocuments({}, { limit: 1 });
      if (realCount > 0) return;

      const legacyDocs = await legacy.find({}).toArray();
      if (legacyDocs.length === 0) return;

      try {
        await real.insertMany(legacyDocs, { ordered: false });
        console.log(
          `[trading-setups] Migrated ${legacyDocs.length} doc(s) from ${LEGACY_COLLECTION} → ${COLLECTION}`,
        );
      } catch (err) {
        // Partial insert (e.g. rerun) — ignore duplicate _id; fail only if real stayed empty.
        const after = await real.countDocuments({}, { limit: 1 });
        if (after === 0) throw err;
        console.warn(
          `[trading-setups] Migration from ${LEGACY_COLLECTION} completed with some duplicates: ${String(err)}`,
        );
      }
    })().catch((err) => {
      migratePromise = null;
      throw err;
    });
  }
  await migratePromise;
}

/** One-time: assign bootstrap owner to setups missing userId. */
export async function ensureTradingSetupsUserId(bootstrapUserId: string): Promise<void> {
  if (!ensureUserIdPromise) {
    ensureUserIdPromise = (async () => {
      const mongo = await getMongoClient();
      const result = await mongo
        .db(getMongoDbName())
        .collection(COLLECTION)
        .updateMany(
          {
            $or: [
              { userId: { $exists: false } },
              { userId: null },
              { userId: "" },
            ],
          },
          { $set: { userId: bootstrapUserId } },
        );
      if (result.modifiedCount > 0) {
        console.log(
          `[trading-setups] Assigned userId to ${result.modifiedCount} legacy setup(s)`,
        );
      }
    })().catch((err) => {
      ensureUserIdPromise = null;
      throw err;
    });
  }
  await ensureUserIdPromise;
}

async function ensureReady(): Promise<void> {
  await ensureTradingSetupsMigrated();
  const { getBootstrapUserId } = await import("./user-repository.js");
  await ensureTradingSetupsUserId(await getBootstrapUserId());
}

function resolveSetupColor(doc: TradingSetupDoc): string {
  const normalized = doc.color ? normalizeSetupColor(doc.color) : null;
  if (normalized) return normalized;
  return colorFromId(String(doc._id));
}

function serializeTradingSetup(doc: TradingSetupDoc): TradingSetupListItem {
  const normalizedSetup = normalizeTradingPhaseSetup({
    phaseSplit: doc.setup.phaseSplit,
    phases: doc.setup.phases,
  });
  // Always expose normalized phases (incl. buyOrderType derived from buyOptimize).
  const setup = normalizedSetup ?? {
    phaseSplit: doc.setup.phaseSplit,
    phases: [
      normalizePhaseConfig(doc.setup.phases?.[0]),
      normalizePhaseConfig(doc.setup.phases?.[1]),
      normalizePhaseConfig(doc.setup.phases?.[2]),
    ],
  };
  const item: TradingSetupListItem = {
    _id: String(doc._id),
    title: doc.title,
    color: resolveSetupColor(doc),
    setup,
    createdAt: doc.createdAt instanceof Date ? doc.createdAt.toISOString() : String(doc.createdAt),
    liveScheduleInUse: doc.liveScheduleInUse === true,
    simScheduleInUse: doc.simScheduleInUse === true,
  };
  if (typeof doc.sortOrder === "number" && Number.isFinite(doc.sortOrder)) {
    item.sortOrder = doc.sortOrder;
  }
  if (doc.description) item.description = doc.description;
  return item;
}

function createdAtMs(value: Date | string | undefined): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : 0;
  }
  return 0;
}

/** sortOrder ascending, then newest-first for unset orders. */
function compareSetupDocs(a: TradingSetupDoc, b: TradingSetupDoc): number {
  const ao = typeof a.sortOrder === "number" && Number.isFinite(a.sortOrder) ? a.sortOrder : null;
  const bo = typeof b.sortOrder === "number" && Number.isFinite(b.sortOrder) ? b.sortOrder : null;
  if (ao != null && bo != null && ao !== bo) return ao - bo;
  if (ao != null && bo == null) return -1;
  if (ao == null && bo != null) return 1;
  return createdAtMs(b.createdAt) - createdAtMs(a.createdAt);
}

/** Marks whether a setup is referenced by any live schedule placement. */
export async function setLiveScheduleInUse(
  userId: string,
  setupId: string,
  inUse: boolean,
): Promise<void> {
  await ensureReady();
  const { ObjectId } = await import("mongodb");
  let oid: ObjectId;
  try {
    oid = new ObjectId(setupId);
  } catch {
    return;
  }
  const mongo = await getMongoClient();
  if (inUse) {
    await mongo
      .db(getMongoDbName())
      .collection<TradingSetupDoc>(COLLECTION)
      .updateOne({ _id: oid, userId }, { $set: { liveScheduleInUse: true } });
    return;
  }
  await mongo
    .db(getMongoDbName())
    .collection<TradingSetupDoc>(COLLECTION)
    .updateOne({ _id: oid, userId }, { $unset: { liveScheduleInUse: "" } });
}

export async function listTradingSetups(userId: string): Promise<TradingSetupListItem[]> {
  await ensureReady();
  const mongo = await getMongoClient();
  const docs = await mongo
    .db(getMongoDbName())
    .collection<TradingSetupDoc>(COLLECTION)
    .find({ userId })
    .toArray();
  docs.sort(compareSetupDocs);
  return docs.map(serializeTradingSetup);
}

export async function insertTradingSetup(
  userId: string,
  input: CreateTradingSetupInput,
): Promise<TradingSetupListItem> {
  await ensureReady();
  const mongo = await getMongoClient();
  const existing = await mongo
    .db(getMongoDbName())
    .collection<TradingSetupDoc>(COLLECTION)
    .find({ userId })
    .project({ color: 1, sortOrder: 1 })
    .toArray();
  const usedColors = new Set(
    existing
      .map((doc) => (doc.color ? normalizeSetupColor(doc.color) : null))
      .filter((color): color is string => color != null),
  );
  const existingOrders = existing
    .map((doc) => doc.sortOrder)
    .filter((n): n is number => typeof n === "number" && Number.isFinite(n));
  const sortOrder = existingOrders.length > 0 ? Math.min(...existingOrders) - 1 : 0;

  const setup = normalizePhaseSetup(input.setup);
  if (!setup) throw new Error("Invalid setup phases");

  const doc: TradingSetupRecord = {
    userId,
    title: input.title,
    color: pickUniqueSetupColor(usedColors, existing.length),
    setup,
    createdAt: new Date(),
    sortOrder,
  };
  if (input.description) {
    doc.description = input.description;
  }

  const result = await mongo.db(getMongoDbName()).collection(COLLECTION).insertOne(doc);
  return serializeTradingSetup({ ...doc, _id: result.insertedId });
}

export async function getTradingSetupById(
  userId: string,
  id: string,
): Promise<TradingSetupListItem | null> {
  await ensureReady();
  const { ObjectId } = await import("mongodb");
  let oid: ObjectId;
  try {
    oid = new ObjectId(id);
  } catch {
    return null;
  }
  const mongo = await getMongoClient();
  const doc = await mongo
    .db(getMongoDbName())
    .collection<TradingSetupDoc>(COLLECTION)
    .findOne({ _id: oid, userId });
  return doc ? serializeTradingSetup(doc) : null;
}

export interface UpdateTradingSetupInput {
  title?: string;
  description?: string | null;
  color?: string;
  setup?: TradingPhaseSetup;
}

export function normalizePhaseSetup(setup: TradingPhaseSetup): TradingPhaseSetup | null {
  return normalizeTradingPhaseSetup(setup);
}

export async function updateTradingSetup(
  userId: string,
  id: string,
  input: UpdateTradingSetupInput,
): Promise<TradingSetupListItem | null> {
  await ensureReady();
  const { ObjectId } = await import("mongodb");
  let oid: ObjectId;
  try {
    oid = new ObjectId(id);
  } catch {
    return null;
  }

  const mongo = await getMongoClient();
  const existing = await mongo
    .db(getMongoDbName())
    .collection<TradingSetupDoc>(COLLECTION)
    .findOne({ _id: oid, userId });
  if (!existing) return null;
  if (existing.userId !== userId) return null;

  const update: Partial<TradingSetupRecord> = {};
  if (input.title != null) {
    const title = String(input.title).trim();
    if (!title) throw new Error("title is required");
    update.title = title;
  }
  if (input.description !== undefined) {
    const description = input.description == null ? undefined : String(input.description).trim();
    update.description = description || undefined;
  }
  if (input.color != null) {
    const color = normalizeSetupColor(input.color);
    if (!color) throw new Error("Invalid color");
    const conflict = await mongo
      .db(getMongoDbName())
      .collection<TradingSetupDoc>(COLLECTION)
      .findOne({ userId, color, _id: { $ne: oid } });
    if (conflict) throw new Error("Color already in use");
    update.color = color;
  }
  if (input.setup != null) {
    const setup = normalizePhaseSetup(input.setup);
    if (!setup) throw new Error("Invalid setup phases");
    update.setup = setup;
  }

  if (Object.keys(update).length === 0) {
    return serializeTradingSetup(existing);
  }

  const mongoUpdate: { $set?: Partial<TradingSetupRecord>; $unset?: Record<string, ""> } = {
    $set: update,
  };
  if (input.description !== undefined && !update.description) {
    delete mongoUpdate.$set?.description;
    mongoUpdate.$unset = { description: "" };
  }

  await mongo.db(getMongoDbName()).collection<TradingSetupDoc>(COLLECTION).updateOne(
    { _id: oid, userId },
    mongoUpdate,
  );

  const refreshed = await mongo
    .db(getMongoDbName())
    .collection<TradingSetupDoc>(COLLECTION)
    .findOne({ _id: oid, userId });
  return refreshed ? serializeTradingSetup(refreshed) : null;
}

export async function deleteTradingSetup(userId: string, id: string): Promise<boolean> {
  await ensureReady();
  const { ObjectId } = await import("mongodb");
  let oid: ObjectId;
  try {
    oid = new ObjectId(id);
  } catch {
    return false;
  }
  const mongo = await getMongoClient();
  const result = await mongo
    .db(getMongoDbName())
    .collection(COLLECTION)
    .deleteOne({ _id: oid, userId });
  return result.deletedCount === 1;
}

/** Delete every trading setup owned by this user (account teardown). */
export async function deleteAllTradingSetupsForUser(userId: string): Promise<number> {
  await ensureReady();
  const mongo = await getMongoClient();
  const result = await mongo
    .db(getMongoDbName())
    .collection(COLLECTION)
    .deleteMany({ userId: String(userId) });
  return result.deletedCount ?? 0;
}

/** Persist list order; `orderedIds` must list every setup for the user exactly once. */
export async function reorderTradingSetups(
  userId: string,
  orderedIds: string[],
): Promise<TradingSetupListItem[]> {
  await ensureReady();
  if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
    throw new Error("orderedIds is required");
  }
  const unique = new Set(orderedIds.map(String));
  if (unique.size !== orderedIds.length) {
    throw new Error("orderedIds must be unique");
  }

  const { ObjectId } = await import("mongodb");
  const oids: ObjectId[] = [];
  for (const id of orderedIds) {
    try {
      oids.push(new ObjectId(String(id)));
    } catch {
      throw new Error(`Invalid setup id: ${id}`);
    }
  }

  const mongo = await getMongoClient();
  const col = mongo.db(getMongoDbName()).collection<TradingSetupDoc>(COLLECTION);
  const existing = await col.find({ userId }).project({ _id: 1 }).toArray();
  if (existing.length !== oids.length) {
    throw new Error("orderedIds must include every setup");
  }
  const existingIds = new Set(existing.map((doc) => String(doc._id)));
  for (const id of orderedIds) {
    if (!existingIds.has(String(id))) {
      throw new Error(`Unknown setup id: ${id}`);
    }
  }

  const ops = oids.map((oid, index) => ({
    updateOne: {
      filter: { _id: oid, userId },
      update: { $set: { sortOrder: index } },
    },
  }));
  if (ops.length > 0) {
    await col.bulkWrite(ops, { ordered: false });
  }
  return listTradingSetups(userId);
}
