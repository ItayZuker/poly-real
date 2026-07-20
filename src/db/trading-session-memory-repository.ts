import type {
  PlacementLiveStats,
  TradingPositionCard,
  TradingPositionCardStatus,
} from "../types.js";
import { getMongoClient, getMongoDbName } from "./mongo-client.js";

const META_COLLECTION = "trading_session_memory";
const EVENTS_COLLECTION = "trading_stat_events";
const LEGACY_META_DOC_ID = "live";

/** @deprecated Snapshot shape from archive-on-reset; still summed for week/all. */
export interface TradingSessionMemoryEntry {
  closedAt: string;
  startedAt?: string;
  green: number;
  red: number;
  blue: number;
  pnl: number;
  placementStats: PlacementLiveStats[];
}

/** Settled position fields needed to rebuild market-page cards after restart. */
export type TradingStatEventCard = Pick<
  TradingPositionCard,
  | "windowKey"
  | "series"
  | "side"
  | "shares"
  | "buyPrice"
  | "buyCost"
  | "buyFees"
  | "buyAt"
  | "status"
  | "pl"
  | "outcome"
  | "asset"
  | "conditionId"
  | "slug"
  | "confirmed"
  | "placementId"
  | "sellPrice"
  | "sellProceeds"
  | "sellFees"
  | "soldAt"
>;

export interface TradingStatEvent {
  /** Same as TradingPositionCard.id — upsert key. */
  cardId: string;
  placementId?: string;
  status: Exclude<TradingPositionCardStatus, "open">;
  green: number;
  red: number;
  blue: number;
  pnl: number;
  /** When this card first contributed a settled stat. */
  settledAt: string;
  updatedAt: string;
  /** Optional full card snapshot for Positions UI hydrate. */
  card?: TradingStatEventCard;
}

type TradingSessionMemoryDoc = {
  _id: string;
  /** Events with settledAt > this count toward the Live header range. */
  liveResetAt?: string | null;
  /**
   * When schedule live collection armed (Start Trading). Slots before this stay pre-run (dashes).
   * Survives header Live reset.
   */
  liveCollectionStartedAt?: string | null;
  /**
   * Schedule placements that were live while `startTrading` was on (even with no fills).
   * Survives restart and header Live reset — cleared only when the placement is removed.
   * Cards show 0/0/0 instead of "—" until the first fill.
   */
  activatedPlacementIds?: string[];
  sessions?: TradingSessionMemoryEntry[];
  updatedAt: string;
};

type TradingStatEventDoc = TradingStatEvent & { _id: string; userId: string };

export type SessionMemoryTotals = {
  green: number;
  red: number;
  blue: number;
  pnl: number;
  sessionCount: number;
  hasData: boolean;
};

let ensureUserIdPromise: Promise<void> | null = null;

/**
 * One-time: migrate legacy meta `_id: "live"` → bootstrap userId, and stamp
 * userId on events missing it.
 */
export async function ensureTradingSessionMemoryUserId(bootstrapUserId: string): Promise<void> {
  if (!ensureUserIdPromise) {
    ensureUserIdPromise = (async () => {
      const mongo = await getMongoClient();
      const db = mongo.db(getMongoDbName());
      const meta = db.collection<TradingSessionMemoryDoc>(META_COLLECTION);
      const events = db.collection(EVENTS_COLLECTION);

      const legacy = await meta.findOne({ _id: LEGACY_META_DOC_ID });
      if (legacy) {
        const existing = await meta.findOne({ _id: bootstrapUserId });
        if (!existing) {
          const { _id: _legacyId, ...rest } = legacy;
          await meta.insertOne({ _id: bootstrapUserId, ...rest });
          console.log(
            `[trading-session-memory] Migrated meta doc "${LEGACY_META_DOC_ID}" → user ${bootstrapUserId.slice(0, 8)}…`,
          );
        }
        await meta.deleteOne({ _id: LEGACY_META_DOC_ID });
      }

      const eventResult = await events.updateMany(
        {
          $or: [
            { userId: { $exists: false } },
            { userId: null },
            { userId: "" },
          ],
        },
        { $set: { userId: bootstrapUserId } },
      );
      if (eventResult.modifiedCount > 0) {
        console.log(
          `[trading-session-memory] Assigned userId to ${eventResult.modifiedCount} legacy event(s)`,
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
  const { getBootstrapUserId } = await import("./user-repository.js");
  await ensureTradingSessionMemoryUserId(await getBootstrapUserId());
}

function emptyTotals(): SessionMemoryTotals {
  return { green: 0, red: 0, blue: 0, pnl: 0, sessionCount: 0, hasData: false };
}

function sumEntries(entries: TradingSessionMemoryEntry[]): SessionMemoryTotals {
  const totals = emptyTotals();
  for (const entry of entries) {
    totals.sessionCount += 1;
    totals.green += entry.green ?? 0;
    totals.red += entry.red ?? 0;
    totals.blue += entry.blue ?? 0;
    totals.pnl += entry.pnl ?? 0;
    totals.hasData = true;
  }
  return totals;
}

function sumEvents(events: TradingStatEvent[]): SessionMemoryTotals {
  const totals = emptyTotals();
  const tradeIdentities = new Set<string>();
  for (const event of events) {
    // Provisional local settlement is retained so it can be confirmed after restart,
    // but it must not affect real-trade Week / All-time statistics.
    if (event.card?.confirmed === false) continue;
    const card = event.card;
    const identity =
      card?.conditionId && card.asset && Number.isFinite(card.buyAt)
        ? `${card.conditionId}|${card.asset}|${card.buyAt}`
        : null;
    if (identity && tradeIdentities.has(identity)) continue;
    if (identity) tradeIdentities.add(identity);

    const pl = Number(event.pnl);
    if (!Number.isFinite(pl)) continue;

    let green = 0;
    let red = 0;
    let blue = 0;
    if (event.status === "sold") {
      if (pl > 0) green = 1;
      else red = 1;
    } else if (event.status === "win" || event.status === "loss") {
      if (pl > 1e-9) blue = 1;
      else red = 1;
    } else {
      continue;
    }

    totals.sessionCount += 1;
    totals.green += green;
    totals.red += red;
    totals.blue += blue;
    totals.pnl += pl;
    totals.hasData = true;
  }
  return totals;
}

function mergeTotals(a: SessionMemoryTotals, b: SessionMemoryTotals): SessionMemoryTotals {
  return {
    green: a.green + b.green,
    red: a.red + b.red,
    blue: a.blue + b.blue,
    pnl: a.pnl + b.pnl,
    sessionCount: a.sessionCount + b.sessionCount,
    hasData: a.hasData || b.hasData,
  };
}

function sessionClosedMs(entry: TradingSessionMemoryEntry): number {
  const ms = Date.parse(entry.closedAt);
  return Number.isFinite(ms) ? ms : 0;
}

function settledMs(event: TradingStatEvent): number {
  const ms = Date.parse(event.settledAt);
  return Number.isFinite(ms) ? ms : 0;
}

async function metaCollection() {
  const mongo = await getMongoClient();
  return mongo.db(getMongoDbName()).collection<TradingSessionMemoryDoc>(META_COLLECTION);
}

async function eventsCollection() {
  const mongo = await getMongoClient();
  return mongo.db(getMongoDbName()).collection<TradingStatEventDoc>(EVENTS_COLLECTION);
}

async function loadMeta(userId: string): Promise<TradingSessionMemoryDoc | null> {
  return (await metaCollection()).findOne({ _id: userId });
}

export async function getLiveResetAt(userId: string): Promise<string | null> {
  await ensureReady();
  const doc = await loadMeta(userId);
  return doc?.liveResetAt ?? null;
}

export async function getLiveCollectionStartedAt(userId: string): Promise<string | null> {
  await ensureReady();
  const doc = await loadMeta(userId);
  return doc?.liveCollectionStartedAt ?? null;
}

/** Persist when schedule live collection first armed; no-ops if already set. */
export async function ensureLiveCollectionStartedAt(
  userId: string,
  at = new Date().toISOString(),
): Promise<string> {
  await ensureReady();
  const existing = await getLiveCollectionStartedAt(userId);
  if (existing) return existing;
  const now = new Date().toISOString();
  await (await metaCollection()).updateOne(
    { _id: userId },
    {
      $setOnInsert: { liveResetAt: null, activatedPlacementIds: [] },
      $set: { liveCollectionStartedAt: at, updatedAt: now },
    },
    { upsert: true },
  );
  // Race: another writer may have set it first
  return (await getLiveCollectionStartedAt(userId)) ?? at;
}

/** Overwrite collection start (restore / repair). */
export async function setLiveCollectionStartedAt(
  userId: string,
  at: string | null,
): Promise<void> {
  await ensureReady();
  const now = new Date().toISOString();
  await (await metaCollection()).updateOne(
    { _id: userId },
    { $set: { liveCollectionStartedAt: at, updatedAt: now } },
    { upsert: true },
  );
}

/**
 * Mark Live header-range start. Does not delete events, and does not clear
 * activatedPlacementIds — schedule cards keep collecting until removed.
 */
export async function markLiveReset(userId: string, at = new Date().toISOString()): Promise<void> {
  await ensureReady();
  const now = new Date().toISOString();
  await (await metaCollection()).updateOne(
    { _id: userId },
    { $set: { liveResetAt: at, updatedAt: now } },
    { upsert: true },
  );
}

export async function listActivatedPlacementIds(userId: string): Promise<string[]> {
  await ensureReady();
  const doc = await loadMeta(userId);
  const ids = doc?.activatedPlacementIds;
  return Array.isArray(ids) ? ids.filter((id) => typeof id === "string" && id.length > 0) : [];
}

/** Replace the full activated-placement set (e.g. prune pre-run slots). */
export async function setActivatedPlacementIds(userId: string, placementIds: string[]): Promise<void> {
  await ensureReady();
  const now = new Date().toISOString();
  const unique = [...new Set(placementIds.filter((id) => typeof id === "string" && id.length > 0))];
  await (await metaCollection()).updateOne(
    { _id: userId },
    {
      $set: { activatedPlacementIds: unique, updatedAt: now },
      $setOnInsert: { liveResetAt: null },
    },
    { upsert: true },
  );
}

/** Remember a schedule placement was live this session (zeros until first fill). */
export async function addActivatedPlacementId(userId: string, placementId: string): Promise<void> {
  await ensureReady();
  if (!placementId) return;
  const now = new Date().toISOString();
  await (await metaCollection()).updateOne(
    { _id: userId },
    {
      $addToSet: { activatedPlacementIds: placementId },
      $set: { updatedAt: now },
      $setOnInsert: { liveResetAt: null },
    },
    { upsert: true },
  );
}

/**
 * Upsert one settled-trade contribution. Idempotent on cardId — pl/status corrections overwrite.
 */
export async function upsertTradingStatEvent(
  userId: string,
  event: Omit<TradingStatEvent, "settledAt" | "updatedAt"> & { settledAt?: string },
): Promise<TradingStatEvent> {
  await ensureReady();
  const col = await eventsCollection();
  const now = new Date().toISOString();
  const existing = await col.findOne({ _id: event.cardId, userId });
  const settledAt = existing?.settledAt ?? event.settledAt ?? now;

  const doc: TradingStatEventDoc = {
    _id: event.cardId,
    userId,
    cardId: event.cardId,
    status: event.status,
    green: event.green,
    red: event.red,
    blue: event.blue,
    pnl: event.pnl,
    settledAt,
    updatedAt: now,
  };
  if (event.placementId) doc.placementId = event.placementId;
  else if (existing?.placementId) doc.placementId = existing.placementId;
  if (event.card) {
    doc.card = event.card;
    // Keep previously stored placement id on the card snapshot when a rewrite omits it.
    if (!doc.card.placementId && existing?.card?.placementId) {
      doc.card = { ...doc.card, placementId: existing.card.placementId };
    }
    if (!doc.placementId && doc.card.placementId) {
      doc.placementId = doc.card.placementId;
    }
  } else if (existing?.card) {
    doc.card = existing.card;
    if (!doc.placementId && existing.card.placementId) {
      doc.placementId = existing.card.placementId;
    }
  }

  await col.replaceOne({ _id: event.cardId, userId }, doc, { upsert: true });

  await (await metaCollection()).updateOne(
    { _id: userId },
    { $set: { updatedAt: now }, $setOnInsert: { liveResetAt: null } },
    { upsert: true },
  );

  const { _id: _, userId: _uid, ...out } = doc;
  return out;
}

export async function listTradingStatEvents(
  userId: string,
  options: {
    fromMs?: number;
    toMs?: number;
    afterLiveReset?: boolean;
  } = {},
): Promise<TradingStatEvent[]> {
  await ensureReady();
  const col = await eventsCollection();
  const docs = await col.find({ userId }).toArray();
  let liveResetMs: number | null = null;
  if (options.afterLiveReset) {
    const resetAt = await getLiveResetAt(userId);
    liveResetMs = resetAt ? Date.parse(resetAt) : null;
    if (liveResetMs != null && !Number.isFinite(liveResetMs)) liveResetMs = null;
  }

  return docs
    .map(({ _id, userId: _uid, ...rest }) => rest)
    .filter((event) => {
      const at = settledMs(event);
      if (liveResetMs != null && at <= liveResetMs) return false;
      if (options.fromMs != null && at < options.fromMs) return false;
      if (options.toMs != null && at > options.toMs) return false;
      return true;
    });
}

/** @deprecated Prefer upsertTradingStatEvent — kept for any callers of archive-on-reset. */
export async function appendTradingSessionMemory(
  userId: string,
  entry: TradingSessionMemoryEntry,
): Promise<void> {
  await ensureReady();
  const mongo = await getMongoClient();
  const now = new Date().toISOString();
  await mongo
    .db(getMongoDbName())
    .collection<TradingSessionMemoryDoc>(META_COLLECTION)
    .updateOne(
      { _id: userId },
      {
        $push: { sessions: entry },
        $set: { updatedAt: now },
      },
      { upsert: true },
    );
}

export async function listTradingSessionMemory(userId: string): Promise<TradingSessionMemoryEntry[]> {
  await ensureReady();
  const doc = await loadMeta(userId);
  return Array.isArray(doc?.sessions) ? doc.sessions : [];
}

export async function sumTradingSessionMemory(
  userId: string,
  options: {
    fromMs?: number;
    toMs?: number;
  } = {},
): Promise<SessionMemoryTotals> {
  const events = await listTradingStatEvents(userId, {
    fromMs: options.fromMs,
    toMs: options.toMs,
  });
  const eventTotals = sumEvents(events);

  const sessions = await listTradingSessionMemory(userId);
  const filteredSessions = sessions.filter((entry) => {
    const closed = sessionClosedMs(entry);
    if (options.fromMs != null && closed < options.fromMs) return false;
    if (options.toMs != null && closed > options.toMs) return false;
    return true;
  });
  const sessionTotals = sumEntries(filteredSessions);

  return mergeTotals(eventTotals, sessionTotals);
}

export async function sumLiveTradingStatEvents(userId: string): Promise<SessionMemoryTotals> {
  const events = await listTradingStatEvents(userId, { afterLiveReset: true });
  return sumEvents(events);
}

/** All-time confirmed real-trade stats for one market series (no live-reset filter). */
export async function sumTradingStatEventsForSeries(
  userId: string,
  series: string,
): Promise<SessionMemoryTotals> {
  const events = await listTradingStatEvents(userId, {});
  const filtered = events.filter((event) => {
    const s = event.card?.series;
    return !s || s === series;
  });
  return sumEvents(filtered);
}
