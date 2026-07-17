import {
  AssetType,
  ClobClient,
  SignatureTypeV2,
  type ApiKeyCreds,
} from "@polymarket/clob-client-v2";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { getClobHost, getChainId } from "./clob-service.js";
import {
  cacheSignerAddress,
  getWalletCredentials,
  type WalletCredentials,
} from "./db/user-repository.js";
import { addressHint } from "./wallet-crypto.js";
import { logService } from "./log-service.js";

export interface TradingAccountStatus {
  connected: boolean;
  signerAddress?: string;
  funderAddress?: string;
  signatureType?: number;
  collateralBalance?: string;
  apiKeyCount?: number;
  hasPrivateKey?: boolean;
  error?: string;
}

type ClientSlot = {
  client: ClobClient | null;
  status: TradingAccountStatus;
  credentials: WalletCredentials | null;
};

const slots = new Map<string, ClientSlot>();

type BalanceListener = (userId: string, status: TradingAccountStatus) => void;
const balanceListeners = new Set<BalanceListener>();

export function onBalanceRefresh(listener: BalanceListener): () => void {
  balanceListeners.add(listener);
  return () => balanceListeners.delete(listener);
}

function emitBalanceRefresh(userId: string, status: TradingAccountStatus): void {
  for (const listener of balanceListeners) listener(userId, status);
}

function slotKey(userId: string): string {
  return String(userId);
}

function getSlot(userId: string): ClientSlot {
  const key = slotKey(userId);
  let slot = slots.get(key);
  if (!slot) {
    slot = { client: null, status: { connected: false }, credentials: null };
    slots.set(key, slot);
  }
  return slot;
}

function parseSignatureType(raw: number | string | undefined): SignatureTypeV2 {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 3) {
    throw new Error("SIGNATURE_TYPE must be 0, 1, 2, or 3");
  }
  return value as SignatureTypeV2;
}

function formatUsdcBalance(raw: string): string {
  const value = Number(raw);
  if (!Number.isFinite(value)) return raw;
  return (value / 1_000_000).toFixed(2);
}

export function isTradingConfigured(userId: string): boolean {
  const slot = getSlot(userId);
  if (slot.credentials?.privateKey && slot.credentials.funderAddress) return true;
  return Boolean(slot.status.hasPrivateKey && slot.status.funderAddress);
}

export async function initTradingClient(userId: string): Promise<TradingAccountStatus> {
  const slot = getSlot(userId);
  const creds = await getWalletCredentials(userId);
  slot.credentials = creds;

  if (!creds) {
    slot.client = null;
    slot.status = {
      connected: false,
      hasPrivateKey: false,
      error: "Set private key and funder address in Settings",
    };
    return slot.status;
  }

  const { privateKey, funderAddress, signatureType: sigTypeRaw } = creds;

  try {
    const account = privateKeyToAccount(privateKey);
    const signer = createWalletClient({
      account,
      chain: polygon,
      transport: http(),
    });

    const signatureType = parseSignatureType(sigTypeRaw);
    const host = getClobHost();
    const chain = getChainId();

    const bootstrapClient = new ClobClient({
      host,
      chain,
      signer,
      throwOnError: true,
    });

    let apiCreds: ApiKeyCreds;
    try {
      apiCreds = await bootstrapClient.deriveApiKey();
    } catch {
      apiCreds = await bootstrapClient.createApiKey();
    }

    slot.client = new ClobClient({
      host,
      chain,
      signer,
      creds: apiCreds,
      signatureType,
      funderAddress,
      throwOnError: true,
    });

    const [apiKeys, balance] = await Promise.all([
      slot.client.getApiKeys(),
      slot.client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL }),
    ]);

    slot.status = {
      connected: true,
      signerAddress: account.address,
      funderAddress,
      signatureType,
      collateralBalance: balance.balance,
      apiKeyCount: apiKeys.apiKeys?.length ?? 0,
      hasPrivateKey: true,
    };

    void cacheSignerAddress(userId, account.address).catch(() => {});

    logService.success(
      "trading",
      `Account connected (user ${userId.slice(0, 8)}…) — signer …${addressHint(account.address)}, funder …${addressHint(funderAddress)}, ` +
        `balance $${formatUsdcBalance(balance.balance)} USDC`,
    );

    emitBalanceRefresh(userId, getTradingAccountStatus(userId));
    return slot.status;
  } catch (err) {
    slot.client = null;
    const message = err instanceof Error ? err.message : String(err);
    slot.status = {
      connected: false,
      funderAddress,
      hasPrivateKey: true,
      error: message,
    };
    logService.error("trading", `Account connection failed (user ${userId.slice(0, 8)}…): ${message}`);
    emitBalanceRefresh(userId, getTradingAccountStatus(userId));
    throw err;
  }
}

/** Re-read wallet from Mongo and reconnect the CLOB client for this user. */
export async function reconnectTradingClient(userId: string): Promise<TradingAccountStatus> {
  const slot = getSlot(userId);
  slot.client = null;
  slot.credentials = null;
  return initTradingClient(userId);
}

export function getTradingClient(userId: string): ClobClient | null {
  return getSlot(userId).client;
}

export function getTradingAccountStatus(userId: string): TradingAccountStatus {
  return { ...getSlot(userId).status };
}

/** Re-fetch USDC collateral balance from the CLOB and update cached account status. */
export async function refreshCollateralBalance(userId: string): Promise<TradingAccountStatus> {
  const slot = getSlot(userId);
  if (!slot.client || !slot.status.connected) {
    return getTradingAccountStatus(userId);
  }

  try {
    const balance = await slot.client.getBalanceAllowance({
      asset_type: AssetType.COLLATERAL,
    });
    slot.status = {
      ...slot.status,
      collateralBalance: balance.balance,
    };
    const status = getTradingAccountStatus(userId);
    emitBalanceRefresh(userId, status);
    return status;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logService.warn("trading", `Balance refresh failed (user ${userId.slice(0, 8)}…): ${message}`);
    return getTradingAccountStatus(userId);
  }
}

export function dropTradingClient(userId: string): void {
  slots.delete(slotKey(userId));
}
