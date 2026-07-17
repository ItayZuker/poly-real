import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;

/**
 * Resolve a 32-byte AES key from WALLET_ENCRYPTION_KEY.
 * Accepts 64-char hex or any string (hashed with SHA-256).
 * Falls back to a deterministic key from MONGODB_URI so local/dev still works.
 */
export function getWalletEncryptionKey(): Buffer {
  const raw = process.env.WALLET_ENCRYPTION_KEY?.trim();
  if (raw) {
    if (/^[0-9a-fA-F]{64}$/.test(raw)) {
      return Buffer.from(raw, "hex");
    }
    return createHash("sha256").update(raw, "utf8").digest();
  }

  const mongo = process.env.MONGODB_URI?.trim();
  if (mongo) {
    return createHash("sha256").update(`poly-real:wallet:${mongo}`, "utf8").digest();
  }

  throw new Error(
    "WALLET_ENCRYPTION_KEY (or MONGODB_URI for derived key) is required to store wallet secrets",
  );
}

/** Encrypt plaintext → `iv:tag:ciphertext` (all base64). */
export function encryptSecret(plaintext: string): string {
  const key = getWalletEncryptionKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

/** Decrypt `iv:tag:ciphertext` payload. */
export function decryptSecret(payload: string): string {
  const key = getWalletEncryptionKey();
  const parts = payload.split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid encrypted secret format");
  }
  const [ivB64, tagB64, dataB64] = parts;
  const iv = Buffer.from(ivB64!, "base64");
  const tag = Buffer.from(tagB64!, "base64");
  const data = Buffer.from(dataB64!, "base64");
  if (iv.length !== IV_LEN || tag.length !== TAG_LEN) {
    throw new Error("Invalid encrypted secret lengths");
  }
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

export function privateKeyHint(normalizedHexKey: string): string {
  const hex = normalizedHexKey.startsWith("0x") ? normalizedHexKey.slice(2) : normalizedHexKey;
  return hex.slice(-4).toLowerCase();
}

/** Short address hint for logs (last 4 hex chars) — never log full funder/signer. */
export function addressHint(address: string | undefined | null): string {
  if (!address?.trim()) return "????";
  const hex = address.trim().startsWith("0x") ? address.trim().slice(2) : address.trim();
  if (hex.length < 4) return "????";
  return hex.slice(-4).toLowerCase();
}
