import type { ObjectId } from "mongodb";
import { isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { TradingConfig } from "../types.js";
import { decryptSecret, encryptSecret, privateKeyHint } from "../wallet-crypto.js";
import { getMongoClient, getMongoDbName } from "./mongo-client.js";
import { tradingConfigFilePath } from "./data-dir.js";
import { readJsonFile } from "./file-store.js";

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
  name?: string;
  wallet: UserWalletStored;
  trading: TradingConfig;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserPublic {
  id: string;
  slug: string;
  email?: string;
  name?: string;
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
  const next: TradingConfig = {
    autoTrade: Boolean(raw.autoTrade),
    useSchedule: Boolean(raw.useSchedule),
    startTrading: Boolean(raw.startTrading),
    manualShares: amount,
    manualOrderUnit: unit,
  };
  if (!next.autoTrade) {
    next.useSchedule = false;
    next.startTrading = false;
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
  return {
    id: String(doc._id),
    slug: doc.slug,
    email: doc.email,
    name: doc.name,
    trading: normalizeTrading(doc.trading),
    wallet: {
      funderAddress: doc.wallet?.funderAddress,
      signerAddress: doc.wallet?.signerAddress,
      signatureType: doc.wallet?.signatureType ?? 1,
      hasPrivateKey: Boolean(doc.wallet?.privateKeyEnc),
      privateKeyHint: doc.wallet?.privateKeyHint,
    },
  };
}

async function migrateTradingConfigFromDisk(): Promise<TradingConfig | null> {
  try {
    const loaded = await readJsonFile<Partial<TradingConfig>>(tradingConfigFilePath());
    if (!loaded) return null;
    return normalizeTrading(loaded);
  } catch {
    return null;
  }
}

/**
 * Ensure the bootstrap `default` user exists.
 * Migrates trading-config.json and env wallet credentials once when empty.
 */
export async function ensureDefaultUser(): Promise<UserPublic> {
  const col = await collection();
  const existing = await col.findOne({ slug: DEFAULT_SLUG });
  if (existing) {
    return toPublic(existing);
  }

  const now = new Date();
  const diskTrading = await migrateTradingConfigFromDisk();
  const trading = diskTrading ?? defaultTrading();

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

  const doc: Omit<UserDocument, "_id"> & { _id?: ObjectId } = {
    slug: DEFAULT_SLUG,
    wallet,
    trading,
    createdAt: now,
    updatedAt: now,
  };

  const result = await col.insertOne(doc as UserDocument);
  const inserted = await col.findOne({ _id: result.insertedId });
  if (!inserted) {
    throw new Error("Failed to create default user");
  }
  return toPublic(inserted);
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

export async function updateDefaultUserTrading(
  patch: Partial<TradingConfig>,
): Promise<TradingConfig> {
  const user = await getDefaultUser();
  const next = normalizeTrading({ ...user.trading, ...patch });
  const now = new Date();
  const col = await collection();
  await col.updateOne(
    { _id: user._id },
    { $set: { trading: next, updatedAt: now } },
  );
  return next;
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
  const $set: Record<string, unknown> = { updatedAt: new Date() };
  const $unset: Record<string, ""> = {};

  if ("name" in input) {
    const name = normalizeOptionalText(input.name, 80);
    if (name === "" || name == null) $unset.name = "";
    else $set.name = name;
  }
  if ("email" in input) {
    const email = normalizeEmail(input.email);
    if (email === "" || email == null) $unset.email = "";
    else $set.email = email;
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

  if (!wallet.funderAddress && !wallet.privateKeyEnc) {
    // Allow clearing nothing — require at least one field when patching.
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
