import type { ObjectId } from "mongodb";
import { ObjectId as MongoObjectId } from "mongodb";
import { isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hashPassword, verifyPassword } from "../auth/password.js";
import { DEFAULT_MARKET_SERIES } from "../collections.js";
import type { TradingConfig } from "../types.js";
import { decryptSecret, encryptSecret, privateKeyHint } from "../wallet-crypto.js";
import { getMongoClient, getMongoDbName } from "./mongo-client.js";

const COLLECTION = "users";
const DEFAULT_SLUG = "default";

export interface UserWalletStored {
  funderAddress?: string;
  /** AES-GCM ciphertext of `0x…` private key. */
  privateKeyEnc?: string;
  privateKeyHint?: string;
  /** Polymarket CLOB signature type 0–3. Hidden in UI; default Proxy (1). */
  signatureType: number;
  /** Cached after successful connect. */
  signerAddress?: string;
}

export interface UserDocument {
  _id: ObjectId;
  slug: string;
  email?: string;
  /** Lowercase trimmed email for unique login lookup. */
  emailKey?: string;
  name?: string;
  /** Lowercase trimmed name for unique display-name lookup. */
  nameKey?: string;
  /** scrypt password hash — required for login. */
  passwordHash?: string;
  wallet: UserWalletStored;
  /** Legacy flat trading config (also mirrored for DEFAULT_MARKET_SERIES). */
  trading: TradingConfig;
  /** Per-market trading settings. */
  tradingBySeries?: Record<string, TradingConfig>;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserPublic {
  id: string;
  slug: string;
  email?: string;
  name?: string;
  hasPassword: boolean;
  /** True when funder + private key are both stored. */
  walletReady: boolean;
  trading: TradingConfig;
  wallet: {
    funderAddress?: string;
    signerAddress?: string;
    signatureType: number;
    hasPrivateKey: boolean;
    privateKeyHint?: string;
  };
}

export interface WalletCredentials {
  privateKey: `0x${string}`;
  funderAddress: string;
  signatureType: number;
}

export interface UpdateWalletInput {
  funderAddress?: string;
  privateKey?: string;
  signatureType?: number;
}

function defaultTrading(): TradingConfig {
  return {
    autoTrade: false,
    useSchedule: false,
    startTrading: false,
    manualShares: 10,
    manualOrderUnit: "shares",
    buyOverrideEnabled: false,
    buyOverridePriceCents: 0,
    buyOverrideShares: 0,
    buyOverrideDirection: "with",
  };
}

function normalizeTrading(raw: Partial<TradingConfig> | null | undefined): TradingConfig {
  const base = defaultTrading();
  if (!raw || typeof raw !== "object") return base;
  const unit = raw.manualOrderUnit === "usdc" ? "usdc" : "shares";
  const amountRaw = Number(raw.manualShares);
  const amount =
    unit === "usdc"
      ? Math.max(0.01, Math.min(100000, Math.round((Number.isFinite(amountRaw) ? amountRaw : 10) * 100) / 100))
      : Math.max(1, Math.min(100000, Math.floor(Number.isFinite(amountRaw) ? amountRaw : 10) || 10));
  const priceRaw = Number(raw.buyOverridePriceCents);
  const sharesRaw = Number(raw.buyOverrideShares);
  const next: TradingConfig = {
    autoTrade: Boolean(raw.autoTrade),
    useSchedule: Boolean(raw.useSchedule),
    startTrading: Boolean(raw.startTrading),
    manualShares: amount,
    manualOrderUnit: unit,
    buyOverrideEnabled: Boolean(raw.buyOverrideEnabled),
    buyOverridePriceCents: Number.isFinite(priceRaw)
      ? Math.max(0, Math.min(99, Math.floor(priceRaw)))
      : 0,
    buyOverrideShares: Number.isFinite(sharesRaw)
      ? Math.max(0, Math.min(100000, Math.floor(sharesRaw)))
      : 0,
    buyOverrideDirection: raw.buyOverrideDirection === "opposite" ? "opposite" : "with",
  };
  if (!next.autoTrade) {
    next.useSchedule = false;
  }
  return next;
}

function normalizePrivateKey(raw: string): `0x${string}` {
  const trimmed = raw.trim();
  const hex = trimmed.startsWith("0x") ? trimmed.slice(2) : trimmed;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("PRIVATE_KEY must be a 32-byte hex string");
  }
  return `0x${hex}`;
}

function normalizeFunderAddress(raw: string): string {
  const addr = raw.trim();
  if (!isAddress(addr)) {
    throw new Error("FUNDER_ADDRESS must be a valid Ethereum address");
  }
  return addr;
}

function normalizeSignatureType(raw: unknown): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 3) {
    throw new Error("SIGNATURE_TYPE must be 0, 1, 2, or 3");
  }
  return value;
}

function defaultSignatureTypeFromEnv(): number {
  const raw = process.env.SIGNATURE_TYPE?.trim();
  if (raw == null || raw === "") return 1;
  try {
    return normalizeSignatureType(raw);
  } catch {
    return 1;
  }
}

async function collection() {
  const mongo = await getMongoClient();
  return mongo.db(getMongoDbName()).collection<UserDocument>(COLLECTION);
}

function toPublic(doc: UserDocument): UserPublic {
  const hasPrivateKey = Boolean(doc.wallet?.privateKeyEnc);
  const funderAddress = doc.wallet?.funderAddress;
  return {
    id: String(doc._id),
    slug: doc.slug,
    email: doc.email,
    name: doc.name,
    hasPassword: Boolean(doc.passwordHash),
    walletReady: hasPrivateKey && Boolean(funderAddress?.trim()),
    trading: normalizeTrading(doc.trading),
    wallet: {
      funderAddress,
      signerAddress: doc.wallet?.signerAddress,
      signatureType: doc.wallet?.signatureType ?? 1,
      hasPrivateKey,
      privateKeyHint: doc.wallet?.privateKeyHint,
    },
  };
}

function normalizeNameKey(raw: string): string {
  return raw.trim().toLowerCase();
}

function normalizeEmailKey(raw: string): string {
  return raw.trim().toLowerCase();
}

function normalizeLoginEmail(raw: unknown): string {
  const text = String(raw ?? "").trim();
  if (!text) throw new Error("Email is required");
  if (text.length > 254) throw new Error("Email must be at most 254 characters");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
    throw new Error("Email must be a valid address");
  }
  return text;
}

function normalizePassword(raw: unknown): string {
  const text = String(raw ?? "");
  if (text.length < 6) throw new Error("Password must be at least 6 characters");
  if (text.length > 200) throw new Error("Password is too long");
  return text;
}

export async function ensureUserIndexes(): Promise<void> {
  const col = await collection();
  // Backfill nameKey for legacy docs that only have name.
  const missingNameKey = await col
    .find({ name: { $type: "string" }, nameKey: { $exists: false } })
    .toArray();
  for (const doc of missingNameKey) {
    const name = String(doc.name || "").trim();
    if (!name) continue;
    await col.updateOne(
      { _id: doc._id },
      { $set: { nameKey: normalizeNameKey(name), updatedAt: new Date() } },
    );
  }
  // Backfill emailKey for legacy docs that only have email.
  const missingEmailKey = await col
    .find({ email: { $type: "string" }, emailKey: { $exists: false } })
    .toArray();
  for (const doc of missingEmailKey) {
    const email = String(doc.email || "").trim();
    if (!email) continue;
    await col.updateOne(
      { _id: doc._id },
      { $set: { emailKey: normalizeEmailKey(email), updatedAt: new Date() } },
    );
  }
  await col.createIndex(
    { nameKey: 1 },
    { unique: true, partialFilterExpression: { nameKey: { $type: "string" } } },
  );
  await col.createIndex(
    { emailKey: 1 },
    { unique: true, partialFilterExpression: { emailKey: { $type: "string" } } },
  );
  await col.createIndex({ slug: 1 }, { unique: true });
}

/**
 * Ensure the bootstrap `default` user exists.
 * Seeds wallet credentials from env when empty.
 */
export async function ensureDefaultUser(): Promise<UserPublic> {
  const col = await collection();
  const existing = await col.findOne({ slug: DEFAULT_SLUG });
  if (existing) {
    const $set: Record<string, unknown> = {};
    if (existing.name?.trim() && !existing.nameKey) {
      $set.nameKey = normalizeNameKey(existing.name);
    } else if (!existing.name?.trim()) {
      const bootstrapName = process.env.DEFAULT_USER_NAME?.trim() || "default";
      $set.name = bootstrapName;
      $set.nameKey = normalizeNameKey(bootstrapName);
    }
    if (existing.email?.trim() && !existing.emailKey) {
      $set.emailKey = normalizeEmailKey(existing.email);
    }
    if (Object.keys($set).length > 0) {
      $set.updatedAt = new Date();
      await col.updateOne({ _id: existing._id }, { $set });
      const updated = await col.findOne({ _id: existing._id });
      if (updated) return toPublic(updated);
    }
    return toPublic(existing);
  }

  const now = new Date();
  const trading = defaultTrading();

  const wallet: UserWalletStored = {
    signatureType: defaultSignatureTypeFromEnv(),
  };

  const envKey = process.env.PRIVATE_KEY?.trim();
  const envFunder = process.env.FUNDER_ADDRESS?.trim();
  if (envKey && envFunder) {
    try {
      const normalized = normalizePrivateKey(envKey);
      const funder = normalizeFunderAddress(envFunder);
      const account = privateKeyToAccount(normalized);
      wallet.privateKeyEnc = encryptSecret(normalized);
      wallet.privateKeyHint = privateKeyHint(normalized);
      wallet.funderAddress = funder;
      wallet.signerAddress = account.address;
    } catch {
      // Leave wallet empty; user can set via UI.
    }
  }

  const bootstrapName = process.env.DEFAULT_USER_NAME?.trim() || "default";
  const bootstrapEmail = process.env.DEFAULT_USER_EMAIL?.trim();
  const doc: Omit<UserDocument, "_id"> & { _id?: ObjectId } = {
    slug: DEFAULT_SLUG,
    name: bootstrapName,
    nameKey: normalizeNameKey(bootstrapName),
    wallet,
    trading,
    createdAt: now,
    updatedAt: now,
  };
  if (bootstrapEmail) {
    const email = normalizeLoginEmail(bootstrapEmail);
    doc.email = email;
    doc.emailKey = normalizeEmailKey(email);
  }

  const bootstrapPassword = process.env.DEFAULT_USER_PASSWORD?.trim();
  if (bootstrapPassword) {
    doc.passwordHash = await hashPassword(normalizePassword(bootstrapPassword));
  }

  const result = await col.insertOne(doc as UserDocument);
  const inserted = await col.findOne({ _id: result.insertedId });
  if (!inserted) {
    throw new Error("Failed to create default user");
  }
  return toPublic(inserted);
}

/** Apply DEFAULT_USER_PASSWORD / DEFAULT_USER_EMAIL to the default user when missing. */
export async function maybeBootstrapDefaultPassword(): Promise<void> {
  const bootstrapPassword = process.env.DEFAULT_USER_PASSWORD?.trim();
  const bootstrapEmail = process.env.DEFAULT_USER_EMAIL?.trim();
  const user = await getDefaultUser();
  const col = await collection();
  const $set: Record<string, unknown> = { updatedAt: new Date() };
  let changed = false;

  if (bootstrapPassword && !user.passwordHash) {
    $set.passwordHash = await hashPassword(normalizePassword(bootstrapPassword));
    changed = true;
  }
  if (!user.name?.trim()) {
    const bootstrapName = process.env.DEFAULT_USER_NAME?.trim() || "default";
    $set.name = bootstrapName;
    $set.nameKey = normalizeNameKey(bootstrapName);
    changed = true;
  } else if (!user.nameKey) {
    $set.nameKey = normalizeNameKey(user.name);
    changed = true;
  }
  if (bootstrapEmail && !user.emailKey) {
    const email = normalizeLoginEmail(bootstrapEmail);
    $set.email = email;
    $set.emailKey = normalizeEmailKey(email);
    changed = true;
  } else if (user.email?.trim() && !user.emailKey) {
    $set.emailKey = normalizeEmailKey(user.email);
    changed = true;
  }

  if (!changed) return;
  await col.updateOne({ _id: user._id }, { $set });
}

/** Current single-tenant user until auth lands. */
export async function getDefaultUser(): Promise<UserDocument> {
  await ensureDefaultUser();
  const col = await collection();
  const doc = await col.findOne({ slug: DEFAULT_SLUG });
  if (!doc) {
    throw new Error("Default user missing after ensure");
  }
  return doc;
}

export async function getDefaultUserPublic(): Promise<UserPublic> {
  return toPublic(await getDefaultUser());
}

export async function getUserById(id: string | ObjectId): Promise<UserDocument | null> {
  let objectId: ObjectId;
  try {
    objectId = typeof id === "string" ? new MongoObjectId(id) : id;
  } catch {
    return null;
  }
  const col = await collection();
  return col.findOne({ _id: objectId });
}

export async function getUserPublicById(id: string | ObjectId): Promise<UserPublic | null> {
  const doc = await getUserById(id);
  return doc ? toPublic(doc) : null;
}

export async function findUserByEmail(email: string): Promise<UserDocument | null> {
  const emailKey = normalizeEmailKey(email);
  if (!emailKey) return null;
  const col = await collection();
  return col.findOne({ emailKey });
}

/**
 * Authenticate an existing user by email + password.
 * Users without a passwordHash cannot log in.
 */
export async function authenticateUser(
  email: string,
  password: string,
): Promise<UserPublic | null> {
  const loginEmail = normalizeLoginEmail(email);
  const user = await findUserByEmail(loginEmail);
  if (!user?.passwordHash) return null;
  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) return null;
  return toPublic(user);
}

function normalizeDisplayName(raw: unknown, fallback: string): string {
  const text = String(raw ?? "").trim();
  const name = (text || fallback).slice(0, 80);
  if (!name) throw new Error("Name is required");
  return name;
}

function uniqueSlug(): string {
  return `u-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Self-serve signup. Creates a user with email + password (no wallet yet).
 */
export async function registerUser(input: {
  email: string;
  password: string;
  name?: string;
}): Promise<UserPublic> {
  const email = normalizeLoginEmail(input.email);
  const emailKey = normalizeEmailKey(email);
  const passwordHash = await hashPassword(normalizePassword(input.password));
  const name = normalizeDisplayName(input.name, email.split("@")[0] || "trader");
  const nameKey = normalizeNameKey(name);
  const col = await collection();

  const existingEmail = await col.findOne({ emailKey });
  if (existingEmail) {
    throw new Error("An account with this email already exists");
  }
  const existingName = await col.findOne({ nameKey });
  if (existingName) {
    throw new Error("That display name is already taken");
  }

  const now = new Date();
  let slug = uniqueSlug();
  for (let i = 0; i < 5; i++) {
    const clash = await col.findOne({ slug });
    if (!clash) break;
    slug = uniqueSlug();
  }

  const doc: Omit<UserDocument, "_id"> = {
    slug,
    email,
    emailKey,
    name,
    nameKey,
    passwordHash,
    wallet: { signatureType: 1 },
    trading: defaultTrading(),
    createdAt: now,
    updatedAt: now,
  };

  try {
    const result = await col.insertOne(doc as UserDocument);
    const inserted = await col.findOne({ _id: result.insertedId });
    if (!inserted) throw new Error("Failed to create account");
    return toPublic(inserted);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/duplicate key|E11000/i.test(msg)) {
      throw new Error("An account with this email or name already exists");
    }
    throw err;
  }
}

/**
 * Set password for a user found by email. If no user has that email, assign
 * email + password to the default slug user (bootstrap path).
 */
export async function setUserPasswordByEmail(email: string, password: string): Promise<UserPublic> {
  const loginEmail = normalizeLoginEmail(email);
  const emailKey = normalizeEmailKey(loginEmail);
  const passwordHash = await hashPassword(normalizePassword(password));
  const col = await collection();
  const now = new Date();

  const existing = await col.findOne({ emailKey });
  if (existing) {
    await col.updateOne(
      { _id: existing._id },
      { $set: { passwordHash, email: loginEmail, emailKey, updatedAt: now } },
    );
    const updated = await col.findOne({ _id: existing._id });
    if (!updated) throw new Error("User missing after password update");
    return toPublic(updated);
  }

  await ensureDefaultUser();
  const defaultUser = await getDefaultUser();
  if (defaultUser.emailKey && defaultUser.emailKey !== emailKey) {
    throw new Error(
      `No user with email "${loginEmail}". Create the user document first, or use the default user's existing email.`,
    );
  }
  await col.updateOne(
    { _id: defaultUser._id },
    { $set: { passwordHash, email: loginEmail, emailKey, updatedAt: now } },
  );
  const updated = await col.findOne({ _id: defaultUser._id });
  if (!updated) throw new Error("User missing after password update");
  return toPublic(updated);
}

export async function deleteUserById(id: string | ObjectId): Promise<boolean> {
  const doc = await getUserById(id);
  if (!doc) return false;
  const col = await collection();
  const result = await col.deleteOne({ _id: doc._id });
  return result.deletedCount === 1;
}

export async function updateDefaultUserTrading(
  patch: Partial<TradingConfig>,
  series: string = DEFAULT_MARKET_SERIES,
): Promise<TradingConfig> {
  const user = await getDefaultUser();
  return updateUserTrading(user._id, patch, series);
}

export function resolveUserTradingForSeries(
  user: Pick<UserDocument, "trading" | "tradingBySeries">,
  series: string,
): TradingConfig {
  const key = String(series || DEFAULT_MARKET_SERIES).trim() || DEFAULT_MARKET_SERIES;
  const bySeries = user.tradingBySeries?.[key];
  if (bySeries) return normalizeTrading(bySeries);
  // Legacy flat `trading` belongs to the default market only.
  if (key === DEFAULT_MARKET_SERIES) return normalizeTrading(user.trading);
  return normalizeTrading(undefined);
}

export async function updateUserTrading(
  userId: string | ObjectId,
  patch: Partial<TradingConfig>,
  series: string = DEFAULT_MARKET_SERIES,
): Promise<TradingConfig> {
  const user = await getUserById(userId);
  if (!user) throw new Error("User not found");
  const key = String(series || DEFAULT_MARKET_SERIES).trim() || DEFAULT_MARKET_SERIES;
  const current = resolveUserTradingForSeries(user, key);
  const next = normalizeTrading({ ...current, ...patch });
  const now = new Date();
  const tradingBySeries = { ...(user.tradingBySeries ?? {}) };
  // Seed default market from legacy flat field once so other markets stay independent.
  if (!tradingBySeries[DEFAULT_MARKET_SERIES] && user.trading) {
    tradingBySeries[DEFAULT_MARKET_SERIES] = normalizeTrading(user.trading);
  }
  tradingBySeries[key] = next;
  const col = await collection();
  const $set: Record<string, unknown> = {
    tradingBySeries,
    updatedAt: now,
  };
  // Keep flat `trading` in sync with the default market for older readers / queries.
  if (key === DEFAULT_MARKET_SERIES) {
    $set.trading = next;
  }
  await col.updateOne({ _id: user._id }, { $set });
  return next;
}

/** Users that may need a live engine (wallet configured and/or trading armed). */
export async function listUsersForLiveTrading(): Promise<UserDocument[]> {
  const col = await collection();
  const docs = await col
    .find({
      $or: [
        { "wallet.privateKeyEnc": { $type: "string" }, "wallet.funderAddress": { $type: "string" } },
        { "trading.autoTrade": true },
        { "trading.startTrading": true },
      ],
    })
    .toArray();

  // Also include users who only armed a non-default market via tradingBySeries.
  const extra = await col
    .find({
      tradingBySeries: { $exists: true },
      "wallet.privateKeyEnc": { $type: "string" },
      "wallet.funderAddress": { $type: "string" },
    })
    .toArray();

  const byId = new Map<string, UserDocument>();
  for (const doc of docs) byId.set(String(doc._id), doc);
  for (const doc of extra) {
    const id = String(doc._id);
    if (byId.has(id)) continue;
    const map = doc.tradingBySeries ?? {};
    const armed = Object.values(map).some((t) => t?.autoTrade || t?.startTrading);
    if (armed) byId.set(id, doc);
  }
  return [...byId.values()];
}

export interface UpdateUserProfileInput {
  name?: string;
  email?: string;
}

function normalizeOptionalText(raw: unknown, maxLen: number): string | undefined {
  if (raw == null) return undefined;
  const text = String(raw).trim();
  if (!text) return "";
  if (text.length > maxLen) {
    throw new Error(`Value must be at most ${maxLen} characters`);
  }
  return text;
}

function normalizeEmail(raw: unknown): string | undefined {
  const text = normalizeOptionalText(raw, 254);
  if (text == null) return undefined;
  if (text === "") return "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
    throw new Error("Email must be a valid address");
  }
  return text;
}

export async function updateDefaultUserProfile(
  input: UpdateUserProfileInput,
): Promise<UserPublic> {
  const user = await getDefaultUser();
  return updateUserProfile(user._id, input);
}

export async function updateUserProfile(
  userId: string | ObjectId,
  input: UpdateUserProfileInput,
): Promise<UserPublic> {
  const user = await getUserById(userId);
  if (!user) throw new Error("User not found");

  const $set: Record<string, unknown> = { updatedAt: new Date() };
  const $unset: Record<string, ""> = {};

  if ("name" in input) {
    const name = normalizeOptionalText(input.name, 80);
    if (name === "" || name == null) {
      $unset.name = "";
      $unset.nameKey = "";
    } else {
      const nameKey = normalizeNameKey(name);
      const colCheck = await collection();
      const clash = await colCheck.findOne({
        nameKey,
        _id: { $ne: user._id },
      });
      if (clash) throw new Error("That name is already taken");
      $set.name = name;
      $set.nameKey = nameKey;
    }
  }
  if ("email" in input) {
    const email = normalizeEmail(input.email);
    if (email === "" || email == null) {
      $unset.email = "";
      $unset.emailKey = "";
    } else {
      const emailKey = normalizeEmailKey(email);
      const colCheck = await collection();
      const clash = await colCheck.findOne({
        emailKey,
        _id: { $ne: user._id },
      });
      if (clash) throw new Error("That email is already taken");
      $set.email = email;
      $set.emailKey = emailKey;
    }
  }

  const update: Record<string, unknown> = { $set };
  if (Object.keys($unset).length > 0) update.$unset = $unset;

  const col = await collection();
  await col.updateOne({ _id: user._id }, update);
  const updated = await col.findOne({ _id: user._id });
  if (!updated) throw new Error("User missing after profile update");
  return toPublic(updated);
}

export async function updateDefaultUserWallet(
  input: UpdateWalletInput,
): Promise<UserPublic> {
  const user = await getDefaultUser();
  return updateUserWallet(user._id, input);
}

export async function updateUserWallet(
  userId: string | ObjectId,
  input: UpdateWalletInput,
): Promise<UserPublic> {
  const user = await getUserById(userId);
  if (!user) throw new Error("User not found");
  const wallet: UserWalletStored = {
    ...user.wallet,
    signatureType: user.wallet?.signatureType ?? defaultSignatureTypeFromEnv(),
  };

  if (input.signatureType != null) {
    wallet.signatureType = normalizeSignatureType(input.signatureType);
  }

  if (input.funderAddress != null && input.funderAddress.trim() !== "") {
    wallet.funderAddress = normalizeFunderAddress(input.funderAddress);
  }

  if (input.privateKey != null && input.privateKey.trim() !== "") {
    const normalized = normalizePrivateKey(input.privateKey);
    const account = privateKeyToAccount(normalized);
    wallet.privateKeyEnc = encryptSecret(normalized);
    wallet.privateKeyHint = privateKeyHint(normalized);
    wallet.signerAddress = account.address;
  }

  const now = new Date();
  const col = await collection();
  await col.updateOne(
    { _id: user._id },
    { $set: { wallet, updatedAt: now } },
  );

  const updated = await col.findOne({ _id: user._id });
  if (!updated) throw new Error("User missing after wallet update");
  return toPublic(updated);
}

/** Decrypt wallet credentials for CLOB client init. Returns null if incomplete. */
export async function getDefaultWalletCredentials(): Promise<WalletCredentials | null> {
  const user = await getDefaultUser();
  return getWalletCredentials(user._id);
}

export async function getWalletCredentials(
  userId: string | ObjectId,
): Promise<WalletCredentials | null> {
  const user = await getUserById(userId);
  if (!user) return null;
  const wallet = user.wallet;
  if (!wallet?.privateKeyEnc || !wallet.funderAddress) {
    return null;
  }
  try {
    const privateKey = normalizePrivateKey(decryptSecret(wallet.privateKeyEnc));
    return {
      privateKey,
      funderAddress: wallet.funderAddress,
      signatureType: wallet.signatureType ?? 1,
    };
  } catch {
    return null;
  }
}

export async function cacheDefaultSignerAddress(signerAddress: string): Promise<void> {
  const user = await getDefaultUser();
  return cacheSignerAddress(user._id, signerAddress);
}

export async function cacheSignerAddress(
  userId: string | ObjectId,
  signerAddress: string,
): Promise<void> {
  const user = await getUserById(userId);
  if (!user) return;
  if (user.wallet?.signerAddress === signerAddress) return;
  const col = await collection();
  await col.updateOne(
    { _id: user._id },
    {
      $set: {
        "wallet.signerAddress": signerAddress,
        updatedAt: new Date(),
      },
    },
  );
}

/** Resolve bootstrap/default user id for one-time ownership migration. */
export async function getBootstrapUserId(): Promise<string> {
  const user = await getDefaultUser();
  return String(user._id);
}
