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
import { logService } from "./log-service.js";

export interface TradingAccountStatus {
  connected: boolean;
  signerAddress?: string;
  funderAddress?: string;
  signatureType?: number;
  collateralBalance?: string;
  apiKeyCount?: number;
  error?: string;
}

let tradingClient: ClobClient | null = null;
let accountStatus: TradingAccountStatus = { connected: false };

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

function parseSignatureType(raw: string | undefined): SignatureTypeV2 {
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

export function isTradingConfigured(): boolean {
  return Boolean(process.env.PRIVATE_KEY?.trim() && process.env.FUNDER_ADDRESS?.trim());
}

export async function initTradingClient(): Promise<TradingAccountStatus> {
  if (!isTradingConfigured()) {
    accountStatus = {
      connected: false,
      error: "PRIVATE_KEY and FUNDER_ADDRESS are required",
    };
    logService.warn("trading", "Trading account not configured");
    return accountStatus;
  }

  const funderAddress = process.env.FUNDER_ADDRESS!.trim();

  try {
    const account = privateKeyToAccount(normalizePrivateKey(process.env.PRIVATE_KEY!));
    const signer = createWalletClient({
      account,
      chain: polygon,
      transport: http(),
    });

    const signatureType = parseSignatureType(process.env.SIGNATURE_TYPE);
    const host = getClobHost();
    const chain = getChainId();

    const bootstrapClient = new ClobClient({
      host,
      chain,
      signer,
      throwOnError: true,
    });

    let creds: ApiKeyCreds;
    try {
      creds = await bootstrapClient.deriveApiKey();
    } catch {
      creds = await bootstrapClient.createApiKey();
    }

    tradingClient = new ClobClient({
      host,
      chain,
      signer,
      creds,
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
    };

    logService.success(
      "trading",
      `Account connected — signer ${account.address}, funder ${funderAddress}, ` +
        `balance $${formatUsdcBalance(balance.balance)} USDC`,
    );

    return accountStatus;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    accountStatus = { connected: false, error: message };
    logService.error("trading", `Account connection failed: ${message}`);
    throw err;
  }
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
