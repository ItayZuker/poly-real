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

let ensureUserIdPromise: Promise<void> | null = null;

/** One-time: assign bootstrap owner to placements missing userId. */
export async function ensureSchedulePlacementsUserId(bootstrapUserId: string): Promise<void> {
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
          `[schedule-placements] Assigned userId to ${result.modifiedCount} legacy placement(s)`,
        );
      }
    })().catch((err) => {
      ensureUserIdPromise = null;
      throw err;
    });
  }
  await ensureUserIdPromise;
}

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

async function listDocsForDay(
  userId: string,
  day: ScheduleDayId,
  excludeId?: ObjectId,
): Promise<SchedulePlacementDoc[]> {
  const mongo = await getMongoClient();
  const filter: Record<string, unknown> = { userId, day };
  if (excludeId) filter._id = { $ne: excludeId };
  return mongo
    .db(getMongoDbName())
    .collection<SchedulePlacementDoc>(COLLECTION)
    .find(filter)
    .toArray();
}

async function assertNoOverlap(
  userId: string,
  day: ScheduleDayId,
  startHour: number,
  durationHours: number,
  excludeId?: ObjectId,
): Promise<void> {
  const existing = await listDocsForDay(userId, day, excludeId);
  for (const doc of existing) {
    if (rangesOverlap(startHour, durationHours, doc.startHour, doc.durationHours)) {
      throw new Error("Placement overlaps an existing card in this column");
    }
  }
}

export async function listSchedulePlacements(userId: string): Promise<SchedulePlacementListItem[]> {
  const { getBootstrapUserId } = await import("./user-repository.js");
  await ensureSchedulePlacementsUserId(await getBootstrapUserId());

  const mongo = await getMongoClient();
  const docs = await mongo
    .db(getMongoDbName())
    .collection<SchedulePlacementDoc>(COLLECTION)
    .find({ userId })
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
  userId: string,
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

  await assertNoOverlap(userId, day, startHour, durationHours);

  const now = new Date();
  const doc: SchedulePlacementRecord = {
    userId,
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
  userId: string,
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
    .findOne({ _id: oid, userId });
  if (!existing) return null;
  if (existing.userId !== userId) return null;

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

  await assertNoOverlap(userId, day, startHour, durationHours, oid);

  const updatedAt = new Date();
  await mongo
    .db(getMongoDbName())
    .collection<SchedulePlacementDoc>(COLLECTION)
    .updateOne(
      { _id: oid, userId },
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
  userId: string,
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
    .findOne({ _id: oid, userId });
  return doc ? serializePlacement(doc) : null;
}

export async function countPlacementsBySetupId(userId: string, setupId: string): Promise<number> {
  const mongo = await getMongoClient();
  return mongo
    .db(getMongoDbName())
    .collection(COLLECTION)
    .countDocuments({ userId, setupId: String(setupId) });
}

export async function listDistinctPlacementSetupIds(userId: string): Promise<string[]> {
  const mongo = await getMongoClient();
  const ids = await mongo
    .db(getMongoDbName())
    .collection(COLLECTION)
    .distinct("setupId", { userId });
  return ids.map((id) => String(id)).filter(Boolean);
}

export async function deleteSchedulePlacement(userId: string, id: string): Promise<boolean> {
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

export async function deletePlacementsBySetupId(userId: string, setupId: string): Promise<number> {
  const mongo = await getMongoClient();
  const result = await mongo
    .db(getMongoDbName())
    .collection(COLLECTION)
    .deleteMany({ userId, setupId });
  return result.deletedCount;
}

export async function deletePlacementsByDay(userId: string, dayInput: string): Promise<number> {
  const day = normalizeDay(dayInput);
  if (!day) throw new Error("Invalid schedule day");
  const mongo = await getMongoClient();
  const result = await mongo
    .db(getMongoDbName())
    .collection(COLLECTION)
    .deleteMany({ userId, day });
  return result.deletedCount;
}

/** Replace one day with twelve contiguous two-hour placements. */
export async function replaceDayWithSetup(
  userId: string,
  dayInput: string,
  setupIdInput: string,
  titleInput: string,
): Promise<SchedulePlacementListItem[]> {
  const day = normalizeDay(dayInput);
  const setupId = String(setupIdInput ?? "").trim();
  const title = String(titleInput ?? "").trim();
  if (!day || !setupId || !title) throw new Error("Invalid day fill fields");

  const mongo = await getMongoClient();
  const collection = mongo.db(getMongoDbName()).collection<SchedulePlacementRecord>(COLLECTION);
  await collection.deleteMany({ userId, day });

  const now = new Date();
  const docs: SchedulePlacementRecord[] = Array.from({ length: 12 }, (_, index) => ({
    userId,
    setupId,
    title,
    day,
    startHour: index * 2,
    durationHours: 2,
    createdAt: now,
    updatedAt: now,
  }));
  await collection.insertMany(docs);
  return listSchedulePlacements(userId);
}

export async function updatePlacementTitlesBySetupId(
  userId: string,
  setupId: string,
  title: string,
): Promise<number> {
  const mongo = await getMongoClient();
  const result = await mongo
    .db(getMongoDbName())
    .collection(COLLECTION)
    .updateMany({ userId, setupId }, { $set: { title, updatedAt: new Date() } });
  return result.modifiedCount;
}

export async function replaceAllPlacementsSetup(
  userId: string,
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
    .updateMany({ userId }, { $set: { setupId: setupIdNorm, title: titleNorm, updatedAt } });

  return listSchedulePlacements(userId);
}
