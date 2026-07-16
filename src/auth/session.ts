import { createHash, randomBytes } from "crypto";
import type { ObjectId } from "mongodb";
import { getMongoClient, getMongoDbName } from "../db/mongo-client.js";

const COLLECTION = "sessions";
const COOKIE_NAME = "poly_sid";
/** 30 days */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface SessionDocument {
  _id: ObjectId;
  tokenHash: string;
  userId: ObjectId;
  createdAt: Date;
  expiresAt: Date;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

async function collection() {
  const mongo = await getMongoClient();
  return mongo.db(getMongoDbName()).collection<SessionDocument>(COLLECTION);
}

export async function ensureSessionIndexes(): Promise<void> {
  const col = await collection();
  await col.createIndex({ tokenHash: 1 }, { unique: true });
  await col.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await col.createIndex({ userId: 1 });
}

export async function createSession(userId: ObjectId): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  const col = await collection();
  await col.insertOne({
    tokenHash: hashToken(token),
    userId,
    createdAt: now,
    expiresAt,
  } as SessionDocument);
  return { token, expiresAt };
}

export async function resolveSessionUserId(token: string | undefined): Promise<ObjectId | null> {
  if (!token) return null;
  const col = await collection();
  const doc = await col.findOne({ tokenHash: hashToken(token) });
  if (!doc) return null;
  if (doc.expiresAt.getTime() <= Date.now()) {
    await col.deleteOne({ _id: doc._id });
    return null;
  }
  return doc.userId;
}

export async function destroySession(token: string | undefined): Promise<void> {
  if (!token) return;
  const col = await collection();
  await col.deleteOne({ tokenHash: hashToken(token) });
}

export async function destroySessionsForUser(userId: ObjectId): Promise<void> {
  const col = await collection();
  await col.deleteMany({ userId });
}

export function getSessionCookieName(): string {
  return COOKIE_NAME;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

export function getSessionTokenFromRequest(cookieHeader: string | undefined): string | undefined {
  const cookies = parseCookies(cookieHeader);
  const raw = cookies[COOKIE_NAME];
  return raw || undefined;
}

export function buildSessionCookie(token: string, expiresAt: Date, secure: boolean): string {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000))}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function buildClearSessionCookie(secure: boolean): string {
  const parts = [
    `${COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function isSecureRequest(req: {
  protocol?: string;
  headers: Record<string, unknown> | { [key: string]: unknown };
}): boolean {
  const forwarded = req.headers["x-forwarded-proto"];
  const proto = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (typeof proto === "string") return proto.split(",")[0].trim() === "https";
  return req.protocol === "https";
}
