import type { ObjectId } from "mongodb";
import { DEFAULT_MARKET_SERIES } from "../collections.js";
import type { ScheduleDayId, SchedulePlacementRecord } from "../types.js";
import {
  schedulePlacementsCollection,
  type ScheduleWorkspaceMode,
} from "../schedule-workspace-mode.js";
import { getMongoClient, getMongoDbName } from "./mongo-client.js";

const LIVE_COLLECTION = schedulePlacementsCollection("live");

function collectionFor(mode: ScheduleWorkspaceMode = "live"): string {
  return schedulePlacementsCollection(mode);
}

const VALID_DAYS: ScheduleDayId[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

export interface SchedulePlacementListItem {
  _id: string;
  series: string;
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
let ensureSeriesPromise: Promise<void> | null = null;

function normalizeSeries(raw: string | undefined | null): string {
  const s = String(raw ?? "").trim();
  return s || DEFAULT_MARKET_SERIES;
}

/** One-time: assign bootstrap owner to live placements missing userId. */
export async function ensureSchedulePlacementsUserId(bootstrapUserId: string): Promise<void> {
  if (!ensureUserIdPromise) {
    ensureUserIdPromise = (async () => {
      const mongo = await getMongoClient();
      const result = await mongo
        .db(getMongoDbName())
        .collection(LIVE_COLLECTION)
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

/** One-time: assign default market series to live placements missing series. */
export async function ensureSchedulePlacementsSeries(
  defaultSeries: string = DEFAULT_MARKET_SERIES,
): Promise<void> {
  if (!ensureSeriesPromise) {
    ensureSeriesPromise = (async () => {
      const mongo = await getMongoClient();
      const result = await mongo
        .db(getMongoDbName())
        .collection(LIVE_COLLECTION)
        .updateMany(
          {
            $or: [{ series: { $exists: false } }, { series: null }, { series: "" }],
          },
          { $set: { series: defaultSeries } },
        );
      if (result.modifiedCount > 0) {
        console.log(
          `[schedule-placements] Assigned series=${defaultSeries} to ${result.modifiedCount} legacy placement(s)`,
        );
      }
    })().catch((err) => {
      ensureSeriesPromise = null;
      throw err;
    });
  }
  await ensureSeriesPromise;
}

async function ensurePlacementMigrations(mode: ScheduleWorkspaceMode = "live"): Promise<void> {
  if (mode !== "live") return;
  const { getBootstrapUserId } = await import("./user-repository.js");
  await ensureSchedulePlacementsUserId(await getBootstrapUserId());
  await ensureSchedulePlacementsSeries();
}

function serializePlacement(doc: SchedulePlacementDoc): SchedulePlacementListItem {
  return {
    _id: String(doc._id),
    series: normalizeSeries(doc.series),
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
  series: string,
  day: ScheduleDayId,
  mode: ScheduleWorkspaceMode,
  excludeId?: ObjectId,
): Promise<SchedulePlacementDoc[]> {
  const mongo = await getMongoClient();
  const filter: Record<string, unknown> = { userId, series, day };
  if (excludeId) filter._id = { $ne: excludeId };
  return mongo
    .db(getMongoDbName())
    .collection<SchedulePlacementDoc>(collectionFor(mode))
    .find(filter)
    .toArray();
}

async function assertNoOverlap(
  userId: string,
  series: string,
  day: ScheduleDayId,
  startHour: number,
  durationHours: number,
  mode: ScheduleWorkspaceMode,
  excludeId?: ObjectId,
): Promise<void> {
  const existing = await listDocsForDay(userId, series, day, mode, excludeId);
  for (const doc of existing) {
    if (rangesOverlap(startHour, durationHours, doc.startHour, doc.durationHours)) {
      throw new Error("Placement overlaps an existing card in this column");
    }
  }
}

export async function listSchedulePlacements(
  userId: string,
  series?: string | null,
  mode: ScheduleWorkspaceMode = "live",
): Promise<SchedulePlacementListItem[]> {
  await ensurePlacementMigrations(mode);

  const mongo = await getMongoClient();
  const filter: Record<string, unknown> = { userId };
  if (series != null && String(series).trim()) {
    filter.series = normalizeSeries(series);
  }
  const docs = await mongo
    .db(getMongoDbName())
    .collection<SchedulePlacementDoc>(collectionFor(mode))
    .find(filter)
    .sort({ series: 1, day: 1, startHour: 1 })
    .toArray();
  return docs.map(serializePlacement);
}

export interface CreateSchedulePlacementInput {
  series?: string;
  setupId: string;
  title: string;
  day: string;
  startHour: number;
  durationHours: number;
}

export async function insertSchedulePlacement(
  userId: string,
  input: CreateSchedulePlacementInput,
  mode: ScheduleWorkspaceMode = "live",
): Promise<SchedulePlacementListItem> {
  await ensurePlacementMigrations(mode);
  const series = normalizeSeries(input.series);
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

  await assertNoOverlap(userId, series, day, startHour, durationHours, mode);

  const now = new Date();
  const doc: SchedulePlacementRecord = {
    userId,
    series,
    setupId,
    title,
    day,
    startHour,
    durationHours,
    createdAt: now,
    updatedAt: now,
  };

  const mongo = await getMongoClient();
  const result = await mongo.db(getMongoDbName()).collection(collectionFor(mode)).insertOne(doc);
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
  mode: ScheduleWorkspaceMode = "live",
): Promise<SchedulePlacementListItem | null> {
  await ensurePlacementMigrations(mode);
  const { ObjectId } = await import("mongodb");
  let oid: ObjectId;
  try {
    oid = new ObjectId(id);
  } catch {
    return null;
  }

  const mongo = await getMongoClient();
  const col = collectionFor(mode);
  const existing = await mongo
    .db(getMongoDbName())
    .collection<SchedulePlacementDoc>(col)
    .findOne({ _id: oid, userId });
  if (!existing) return null;
  if (existing.userId !== userId) return null;

  const series = normalizeSeries(existing.series);
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

  await assertNoOverlap(userId, series, day, startHour, durationHours, mode, oid);

  const updatedAt = new Date();
  await mongo
    .db(getMongoDbName())
    .collection<SchedulePlacementDoc>(col)
    .updateOne(
      { _id: oid, userId },
      { $set: { day, startHour, durationHours, series, updatedAt } },
    );

  return serializePlacement({
    ...existing,
    series,
    day,
    startHour,
    durationHours,
    updatedAt,
  });
}

export async function getSchedulePlacementById(
  userId: string,
  id: string,
  mode: ScheduleWorkspaceMode = "live",
): Promise<SchedulePlacementListItem | null> {
  await ensurePlacementMigrations(mode);
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
    .collection<SchedulePlacementDoc>(collectionFor(mode))
    .findOne({ _id: oid, userId });
  return doc ? serializePlacement(doc) : null;
}

/** Across all markets — used to protect shared setup cards from delete. */
export async function countPlacementsBySetupId(
  userId: string,
  setupId: string,
  mode: ScheduleWorkspaceMode = "live",
): Promise<number> {
  await ensurePlacementMigrations(mode);
  const mongo = await getMongoClient();
  return mongo
    .db(getMongoDbName())
    .collection(collectionFor(mode))
    .countDocuments({ userId, setupId: String(setupId) });
}

export async function listDistinctPlacementSetupIds(
  userId: string,
  mode: ScheduleWorkspaceMode = "live",
): Promise<string[]> {
  await ensurePlacementMigrations(mode);
  const mongo = await getMongoClient();
  const ids = await mongo
    .db(getMongoDbName())
    .collection(collectionFor(mode))
    .distinct("setupId", { userId });
  return ids.map((id) => String(id)).filter(Boolean);
}

export async function deleteSchedulePlacement(
  userId: string,
  id: string,
  mode: ScheduleWorkspaceMode = "live",
): Promise<boolean> {
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
    .collection(collectionFor(mode))
    .deleteOne({ _id: oid, userId });
  return result.deletedCount === 1;
}

/** Delete every schedule placement owned by this user (account teardown). */
export async function deleteAllSchedulePlacementsForUser(
  userId: string,
  mode: ScheduleWorkspaceMode = "live",
): Promise<number> {
  const mongo = await getMongoClient();
  const result = await mongo
    .db(getMongoDbName())
    .collection(collectionFor(mode))
    .deleteMany({ userId: String(userId) });
  return result.deletedCount ?? 0;
}

export async function deletePlacementsBySetupId(
  userId: string,
  setupId: string,
  mode: ScheduleWorkspaceMode = "live",
): Promise<number> {
  const mongo = await getMongoClient();
  const result = await mongo
    .db(getMongoDbName())
    .collection(collectionFor(mode))
    .deleteMany({ userId, setupId });
  return result.deletedCount;
}

export async function deletePlacementsByDay(
  userId: string,
  dayInput: string,
  series: string = DEFAULT_MARKET_SERIES,
  mode: ScheduleWorkspaceMode = "live",
): Promise<number> {
  await ensurePlacementMigrations(mode);
  const day = normalizeDay(dayInput);
  if (!day) throw new Error("Invalid schedule day");
  const seriesKey = normalizeSeries(series);
  const mongo = await getMongoClient();
  const result = await mongo
    .db(getMongoDbName())
    .collection(collectionFor(mode))
    .deleteMany({ userId, series: seriesKey, day });
  return result.deletedCount;
}

/** Replace one day with twelve contiguous two-hour placements. */
export async function replaceDayWithSetup(
  userId: string,
  dayInput: string,
  setupIdInput: string,
  titleInput: string,
  series: string = DEFAULT_MARKET_SERIES,
  mode: ScheduleWorkspaceMode = "live",
): Promise<SchedulePlacementListItem[]> {
  await ensurePlacementMigrations(mode);
  const day = normalizeDay(dayInput);
  const setupId = String(setupIdInput ?? "").trim();
  const title = String(titleInput ?? "").trim();
  const seriesKey = normalizeSeries(series);
  if (!day || !setupId || !title) throw new Error("Invalid day fill fields");

  const mongo = await getMongoClient();
  const collection = mongo
    .db(getMongoDbName())
    .collection<SchedulePlacementRecord>(collectionFor(mode));
  await collection.deleteMany({ userId, series: seriesKey, day });

  const now = new Date();
  const docs: SchedulePlacementRecord[] = Array.from({ length: 12 }, (_, index) => ({
    userId,
    series: seriesKey,
    setupId,
    title,
    day,
    startHour: index * 2,
    durationHours: 2,
    createdAt: now,
    updatedAt: now,
  }));
  await collection.insertMany(docs);
  return listSchedulePlacements(userId, seriesKey, mode);
}

export async function updatePlacementTitlesBySetupId(
  userId: string,
  setupId: string,
  title: string,
  mode: ScheduleWorkspaceMode = "live",
): Promise<number> {
  const mongo = await getMongoClient();
  const result = await mongo
    .db(getMongoDbName())
    .collection(collectionFor(mode))
    .updateMany({ userId, setupId }, { $set: { title, updatedAt: new Date() } });
  return result.modifiedCount;
}

export async function replaceAllPlacementsSetup(
  userId: string,
  setupId: string,
  title: string,
  series: string = DEFAULT_MARKET_SERIES,
  mode: ScheduleWorkspaceMode = "live",
): Promise<SchedulePlacementListItem[]> {
  await ensurePlacementMigrations(mode);
  const setupIdNorm = String(setupId ?? "").trim();
  const titleNorm = String(title ?? "").trim();
  const seriesKey = normalizeSeries(series);
  if (!setupIdNorm || !titleNorm) {
    throw new Error("Invalid setup fields");
  }

  const mongo = await getMongoClient();
  const updatedAt = new Date();
  await mongo
    .db(getMongoDbName())
    .collection(collectionFor(mode))
    .updateMany(
      { userId, series: seriesKey },
      { $set: { setupId: setupIdNorm, title: titleNorm, updatedAt } },
    );

  return listSchedulePlacements(userId, seriesKey, mode);
}
