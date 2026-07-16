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
  cacheDefaultSignerAddress,
  getDefaultWalletCredentials,
  type WalletCredentials,
} from "./db/user-repository.js";
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

let tradingClient: ClobClient | null = null;
let accountStatus: TradingAccountStatus = { connected: false };
let cachedCredentials: WalletCredentials | null = null;

type BalanceListener = (status: TradingAccountStatus) => void;
const balanceListeners = new Set<BalanceListener>();

export function onBalanceRefresh(listener: BalanceListener): () => void {
  balanceListeners.add(listener);
  return () => balanceListeners.delete(listener);
}

function emitBalanceRefresh(status: TradingAccountStatus): void {
  for (const listener of balanceListeners) listener(status);
}

function normalizePrivateKey(raw: string): `0x${string}` {
  const trimmed = raw.trim();
  const hex = trimmed.startsWith("0x") ? trimmed.slice(2) : trimmed;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("PRIVATE_KEY must be a 32-byte hex string");
  }
  return `0x${hex}`;
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

/** Env fallback when Mongo wallet is empty (pre-migration / emergency). */
function credentialsFromEnv(): WalletCredentials | null {
  const key = process.env.PRIVATE_KEY?.trim();
  const funder = process.env.FUNDER_ADDRESS?.trim();
  if (!key || !funder) return null;
  try {
    return {
      privateKey: normalizePrivateKey(key),
      funderAddress: funder,
      signatureType: parseSignatureType(process.env.SIGNATURE_TYPE ?? "1"),
    };
  } catch {
    return null;
  }
}

export function isTradingConfigured(): boolean {
  if (cachedCredentials?.privateKey && cachedCredentials.funderAddress) return true;
  return Boolean(process.env.PRIVATE_KEY?.trim() && process.env.FUNDER_ADDRESS?.trim());
}

async function resolveCredentials(): Promise<WalletCredentials | null> {
  const fromUser = await getDefaultWalletCredentials();
  if (fromUser) return fromUser;
  return credentialsFromEnv();
}

export async function initTradingClient(): Promise<TradingAccountStatus> {
  const creds = await resolveCredentials();
  cachedCredentials = creds;

  if (!creds) {
    tradingClient = null;
    accountStatus = {
      connected: false,
      hasPrivateKey: false,
      error: "Set private key and funder address in Wallet",
    };
    logService.warn("trading", "Trading account not configured");
    return accountStatus;
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

    tradingClient = new ClobClient({
      host,
      chain,
      signer,
      creds: apiCreds,
      signatureType,
      funderAddress,
      throwOnError: true,
    });

    const [apiKeys, balance] = await Promise.all([
      tradingClient.getApiKeys(),
      tradingClient.getBalanceAllowance({ asset_type: AssetType.COLLATERAL }),
    ]);

    accountStatus = {
      connected: true,
      signerAddress: account.address,
      funderAddress,
      signatureType,
      collateralBalance: balance.balance,
      apiKeyCount: apiKeys.apiKeys?.length ?? 0,
      hasPrivateKey: true,
    };

    void cacheDefaultSignerAddress(account.address).catch(() => {});

    logService.success(
      "trading",
      `Account connected — signer ${account.address}, funder ${funderAddress}, ` +
        `balance $${formatUsdcBalance(balance.balance)} USDC`,
    );

    emitBalanceRefresh(getTradingAccountStatus());
    return accountStatus;
  } catch (err) {
    tradingClient = null;
    const message = err instanceof Error ? err.message : String(err);
    accountStatus = {
      connected: false,
      funderAddress,
      hasPrivateKey: true,
      error: message,
    };
    logService.error("trading", `Account connection failed: ${message}`);
    emitBalanceRefresh(getTradingAccountStatus());
    throw err;
  }
}

/** Re-read wallet from Mongo/env and reconnect the CLOB client. */
export async function reconnectTradingClient(): Promise<TradingAccountStatus> {
  tradingClient = null;
  cachedCredentials = null;
  return initTradingClient();
}

export function getTradingClient(): ClobClient | null {
  return tradingClient;
}

export function getTradingAccountStatus(): TradingAccountStatus {
  return { ...accountStatus };
}

/** Re-fetch USDC collateral balance from the CLOB and update cached account status. */
export async function refreshCollateralBalance(): Promise<TradingAccountStatus> {
  if (!tradingClient || !accountStatus.connected) {
    return getTradingAccountStatus();
  }

  try {
    const balance = await tradingClient.getBalanceAllowance({
      asset_type: AssetType.COLLATERAL,
    });
    accountStatus = {
      ...accountStatus,
      collateralBalance: balance.balance,
    };
    const status = getTradingAccountStatus();
    emitBalanceRefresh(status);
    return status;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logService.warn("trading", `Balance refresh failed: ${message}`);
    return getTradingAccountStatus();
  }
}
