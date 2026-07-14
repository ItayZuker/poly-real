import type { ObjectId } from "mongodb";
import type { TradingPhaseSetup, TradingSetupRecord } from "../types.js";
import {
  colorFromId,
  normalizeSetupColor,
  pickUniqueSetupColor,
} from "../setup-colors.js";
import { getMongoClient, getMongoDbName } from "./mongo-client.js";

const COLLECTION = "trading_setups";

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
  /** True while placed on the live (real) schedule. */
  liveScheduleInUse: boolean;
  /** True while placed on the sim schedule. */
  simScheduleInUse: boolean;
}

type TradingSetupDoc = TradingSetupRecord & { _id: ObjectId };

function resolveSetupColor(doc: TradingSetupDoc): string {
  const normalized = doc.color ? normalizeSetupColor(doc.color) : null;
  if (normalized) return normalized;
  return colorFromId(String(doc._id));
}

function serializeTradingSetup(doc: TradingSetupDoc): TradingSetupListItem {
  const item: TradingSetupListItem = {
    _id: String(doc._id),
    title: doc.title,
    color: resolveSetupColor(doc),
    setup: doc.setup,
    createdAt: doc.createdAt instanceof Date ? doc.createdAt.toISOString() : String(doc.createdAt),
    liveScheduleInUse: doc.liveScheduleInUse === true,
    simScheduleInUse: doc.simScheduleInUse === true,
  };
  if (doc.description) item.description = doc.description;
  return item;
}

/** Marks whether a setup is referenced by any live schedule placement. */
export async function setLiveScheduleInUse(setupId: string, inUse: boolean): Promise<void> {
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
      .updateOne({ _id: oid }, { $set: { liveScheduleInUse: true } });
    return;
  }
  await mongo
    .db(getMongoDbName())
    .collection<TradingSetupDoc>(COLLECTION)
    .updateOne({ _id: oid }, { $unset: { liveScheduleInUse: "" } });
}

export async function listTradingSetups(): Promise<TradingSetupListItem[]> {
  const mongo = await getMongoClient();
  const docs = await mongo
    .db(getMongoDbName())
    .collection<TradingSetupDoc>(COLLECTION)
    .find({})
    .sort({ createdAt: -1 })
    .toArray();
  return docs.map(serializeTradingSetup);
}

export async function insertTradingSetup(input: CreateTradingSetupInput): Promise<TradingSetupListItem> {
  const mongo = await getMongoClient();
  const existing = await mongo
    .db(getMongoDbName())
    .collection<TradingSetupDoc>(COLLECTION)
    .find({})
    .project({ color: 1 })
    .toArray();
  const usedColors = new Set(
    existing
      .map((doc) => (doc.color ? normalizeSetupColor(doc.color) : null))
      .filter((color): color is string => color != null),
  );

  const doc: TradingSetupRecord = {
    title: input.title,
    color: pickUniqueSetupColor(usedColors, existing.length),
    setup: input.setup,
    createdAt: new Date(),
  };
  if (input.description) {
    doc.description = input.description;
  }

  const result = await mongo.db(getMongoDbName()).collection(COLLECTION).insertOne(doc);
  return serializeTradingSetup({ ...doc, _id: result.insertedId });
}

export async function getTradingSetupById(id: string): Promise<TradingSetupListItem | null> {
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
    .findOne({ _id: oid });
  return doc ? serializeTradingSetup(doc) : null;
}

export interface UpdateTradingSetupInput {
  title?: string;
  description?: string | null;
  color?: string;
  setup?: TradingPhaseSetup;
}

export function normalizePhaseSetup(setup: TradingPhaseSetup): TradingPhaseSetup | null {
  if (!setup?.phaseSplit || !Array.isArray(setup.phases) || setup.phases.length !== 3) return null;
  const [a, b] = setup.phaseSplit;
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b >= 1 || a >= b) return null;
  return setup;
}

export async function updateTradingSetup(
  id: string,
  input: UpdateTradingSetupInput,
): Promise<TradingSetupListItem | null> {
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
    .findOne({ _id: oid });
  if (!existing) return null;

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
    { _id: oid },
    mongoUpdate,
  );

  const refreshed = await mongo
    .db(getMongoDbName())
    .collection<TradingSetupDoc>(COLLECTION)
    .findOne({ _id: oid });
  return refreshed ? serializeTradingSetup(refreshed) : null;
}

export async function deleteTradingSetup(id: string): Promise<boolean> {
  const { ObjectId } = await import("mongodb");
  let oid: ObjectId;
  try {
    oid = new ObjectId(id);
  } catch {
    return false;
  }
  const mongo = await getMongoClient();
  const result = await mongo.db(getMongoDbName()).collection(COLLECTION).deleteOne({ _id: oid });
  return result.deletedCount === 1;
}
