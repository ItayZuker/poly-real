import type { ObjectId } from "mongodb";
import type { ScheduleDayId, SchedulePlacementRecord } from "../types.js";
import { getMongoClient, getMongoDbName } from "./mongo-client.js";

const COLLECTION = "schedual_setups_real";

const VALID_DAYS: ScheduleDayId[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

export interface SchedulePlacementListItem {
  _id: string;
  setupId: string;
  title: string;
  day: ScheduleDayId;
  startHour: number;
  durationHours: number;
  createdAt: string;
  updatedAt: string;
}

type SchedulePlacementDoc = SchedulePlacementRecord & { _id: ObjectId };

function serializePlacement(doc: SchedulePlacementDoc): SchedulePlacementListItem {
  return {
    _id: String(doc._id),
    setupId: doc.setupId,
    title: doc.title,
    day: doc.day,
    startHour: doc.startHour,
    durationHours: doc.durationHours,
    createdAt: doc.createdAt instanceof Date ? doc.createdAt.toISOString() : String(doc.createdAt),
    updatedAt: doc.updatedAt instanceof Date ? doc.updatedAt.toISOString() : String(doc.updatedAt),
  };
}

function normalizeDay(day: string): ScheduleDayId | null {
  const d = day.toLowerCase() as ScheduleDayId;
  return VALID_DAYS.includes(d) ? d : null;
}

function normalizeTime(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  const t = Math.round(value * 2) / 2;
  if (t < 0 || t > 24) return null;
  return t;
}

function normalizeStartHour(hour: number): number | null {
  const t = normalizeTime(hour);
  return t != null && t <= 23.5 ? t : null;
}

function normalizeDuration(duration: number): number | null {
  const d = normalizeTime(duration);
  return d != null && d >= 1 && d <= 24 ? d : null;
}

function rangesOverlap(
  aStart: number,
  aDuration: number,
  bStart: number,
  bDuration: number,
): boolean {
  return aStart < bStart + bDuration && bStart < aStart + aDuration;
}

async function listDocsForDay(day: ScheduleDayId, excludeId?: ObjectId): Promise<SchedulePlacementDoc[]> {
  const mongo = await getMongoClient();
  const filter: Record<string, unknown> = { day };
  if (excludeId) filter._id = { $ne: excludeId };
  return mongo
    .db(getMongoDbName())
    .collection<SchedulePlacementDoc>(COLLECTION)
    .find(filter)
    .toArray();
}

async function assertNoOverlap(
  day: ScheduleDayId,
  startHour: number,
  durationHours: number,
  excludeId?: ObjectId,
): Promise<void> {
  const existing = await listDocsForDay(day, excludeId);
  for (const doc of existing) {
    if (rangesOverlap(startHour, durationHours, doc.startHour, doc.durationHours)) {
      throw new Error("Placement overlaps an existing card in this column");
    }
  }
}

export async function listSchedulePlacements(): Promise<SchedulePlacementListItem[]> {
  const mongo = await getMongoClient();
  const docs = await mongo
    .db(getMongoDbName())
    .collection<SchedulePlacementDoc>(COLLECTION)
    .find({})
    .sort({ day: 1, startHour: 1 })
    .toArray();
  return docs.map(serializePlacement);
}

export interface CreateSchedulePlacementInput {
  setupId: string;
  title: string;
  day: string;
  startHour: number;
  durationHours: number;
}

export async function insertSchedulePlacement(
  input: CreateSchedulePlacementInput,
): Promise<SchedulePlacementListItem> {
  const day = normalizeDay(input.day);
  const startHour = normalizeStartHour(input.startHour);
  const durationHours = normalizeDuration(input.durationHours);
  const setupId = String(input.setupId ?? "").trim();
  const title = String(input.title ?? "").trim();
  if (!day || startHour == null || durationHours == null || !setupId || !title) {
    throw new Error("Invalid placement fields");
  }
  if (startHour + durationHours > 24) {
    throw new Error("Placement exceeds day bounds");
  }

  await assertNoOverlap(day, startHour, durationHours);

  const now = new Date();
  const doc: SchedulePlacementRecord = {
    setupId,
    title,
    day,
    startHour,
    durationHours,
    createdAt: now,
    updatedAt: now,
  };

  const mongo = await getMongoClient();
  const result = await mongo.db(getMongoDbName()).collection(COLLECTION).insertOne(doc);
  return serializePlacement({ ...doc, _id: result.insertedId });
}

export interface UpdateSchedulePlacementInput {
  day?: string;
  startHour?: number;
  durationHours?: number;
}

export async function updateSchedulePlacement(
  id: string,
  input: UpdateSchedulePlacementInput,
): Promise<SchedulePlacementListItem | null> {
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
    .collection<SchedulePlacementDoc>(COLLECTION)
    .findOne({ _id: oid });
  if (!existing) return null;

  const day = input.day != null ? normalizeDay(input.day) : existing.day;
  const startHour = input.startHour != null ? normalizeStartHour(input.startHour) : existing.startHour;
  const durationHours =
    input.durationHours != null ? normalizeDuration(input.durationHours) : existing.durationHours;
  if (!day || startHour == null || durationHours == null) {
    throw new Error("Invalid placement fields");
  }
  if (startHour + durationHours > 24) {
    throw new Error("Placement exceeds day bounds");
  }

  await assertNoOverlap(day, startHour, durationHours, oid);

  const updatedAt = new Date();
  await mongo
    .db(getMongoDbName())
    .collection<SchedulePlacementDoc>(COLLECTION)
    .updateOne(
      { _id: oid },
      { $set: { day, startHour, durationHours, updatedAt } },
    );

  return serializePlacement({
    ...existing,
    day,
    startHour,
    durationHours,
    updatedAt,
  });
}

export async function getSchedulePlacementById(
  id: string,
): Promise<SchedulePlacementListItem | null> {
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
    .collection<SchedulePlacementDoc>(COLLECTION)
    .findOne({ _id: oid });
  return doc ? serializePlacement(doc) : null;
}

export async function countPlacementsBySetupId(setupId: string): Promise<number> {
  const mongo = await getMongoClient();
  return mongo
    .db(getMongoDbName())
    .collection(COLLECTION)
    .countDocuments({ setupId: String(setupId) });
}

export async function listDistinctPlacementSetupIds(): Promise<string[]> {
  const mongo = await getMongoClient();
  const ids = await mongo.db(getMongoDbName()).collection(COLLECTION).distinct("setupId");
  return ids.map((id) => String(id)).filter(Boolean);
}

export async function deleteSchedulePlacement(id: string): Promise<boolean> {
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
    .deleteOne({ _id: oid });
  return result.deletedCount === 1;
}

export async function deletePlacementsBySetupId(setupId: string): Promise<number> {
  const mongo = await getMongoClient();
  const result = await mongo
    .db(getMongoDbName())
    .collection(COLLECTION)
    .deleteMany({ setupId });
  return result.deletedCount;
}

export async function updatePlacementTitlesBySetupId(setupId: string, title: string): Promise<number> {
  const mongo = await getMongoClient();
  const result = await mongo
    .db(getMongoDbName())
    .collection(COLLECTION)
    .updateMany({ setupId }, { $set: { title, updatedAt: new Date() } });
  return result.modifiedCount;
}

export async function replaceAllPlacementsSetup(
  setupId: string,
  title: string,
): Promise<SchedulePlacementListItem[]> {
  const setupIdNorm = String(setupId ?? "").trim();
  const titleNorm = String(title ?? "").trim();
  if (!setupIdNorm || !titleNorm) {
    throw new Error("Invalid setup fields");
  }

  const mongo = await getMongoClient();
  const updatedAt = new Date();
  await mongo
    .db(getMongoDbName())
    .collection(COLLECTION)
    .updateMany({}, { $set: { setupId: setupIdNorm, title: titleNorm, updatedAt } });

  return listSchedulePlacements();
}
