export function collectionSuffix(marketSeries: string): string {
  return marketSeries.replace(/-/g, "_");
}

export const SEED_MARKETS = [
  { series: "btc-5m", label: "Bitcoin - 5 minutes", timeframeMinutes: 5 },
  { series: "eth-5m", label: "Ethereum - 5 minutes", timeframeMinutes: 5 },
  { series: "sol-5m", label: "Solana - 5 minutes", timeframeMinutes: 5 },
  { series: "btc-15m", label: "Bitcoin - 15 minutes", timeframeMinutes: 15 },
  { series: "eth-15m", label: "Ethereum - 15 minutes", timeframeMinutes: 15 },
  { series: "sol-15m", label: "Solana - 15 minutes", timeframeMinutes: 15 },
] as const;

export function getWindowDurationSeconds(timeframeMinutes: number): number {
  return timeframeMinutes * 60;
}
