/**
 * Backfill windowOutcome (+ settlement prices when available) on windows/ JSON
 * from Polymarket Gamma event resolution by slug.
 *
 * Usage:
 *   npm run backfill:outcomes
 *   npm run backfill:outcomes -- btc-5m
 */
import "dotenv/config";
import { getMarket, listMarkets } from "../db/market-repository.js";
import {
  getRecordedWindow,
  listRecordedWindows,
  saveRecordedWindow,
} from "../db/recorded-window-repository.js";
import { initStorage } from "../db/data-dir.js";
import { fetchGammaWindowResolution } from "../gamma-window-resolution.js";
import { buildUpDownSlug, parseMarketSeries } from "../market-pair.js";
import { roundTo4 } from "../tick-compact.js";
import type { MarketDocument } from "../types.js";

const DELAY_MS = 300;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function backfillMarket(market: MarketDocument): Promise<void> {
  const { asset, timeframe } = parseMarketSeries(market._id);
  const windows = await listRecordedWindows(market);
  console.log(`[backfill] ${market._id}: ${windows.length} recorded windows`);

  let updated = 0;
  let unchanged = 0;
  let unresolved = 0;
  let failed = 0;

  for (let i = 0; i < windows.length; i += 1) {
    const window = windows[i];
    const label = `${i + 1}/${windows.length} ${window.windowStart}`;
    const slug =
      window.slug?.trim() ||
      buildUpDownSlug(asset, timeframe, window.windowStart);

    try {
      const resolution = await fetchGammaWindowResolution(slug);
      if (!resolution) {
        unresolved += 1;
        console.warn(`[backfill] ${label}: unresolved (${slug})`);
        await sleep(DELAY_MS);
        continue;
      }

      const { outcome, finalPrice, priceToBeat } = resolution;
      const nextAsset = finalPrice ?? window.assetPrice;
      const nextPtb = priceToBeat ?? window.prevCloseAsset;
      const nextGap =
        nextAsset != null && nextPtb != null ? roundTo4(nextAsset - nextPtb) : window.assetGap;

      const outcomeSame = window.windowOutcome === outcome;
      const pricesSame =
        window.assetPrice === nextAsset && window.prevCloseAsset === nextPtb;

      if (outcomeSame && pricesSame) {
        unchanged += 1;
        if ((i + 1) % 50 === 0) {
          console.log(`[backfill] ${label}: ${outcome} (unchanged)`);
        }
        await sleep(DELAY_MS);
        continue;
      }

      await saveRecordedWindow(market, {
        windowStart: window.windowStart,
        windowEnd: window.windowEnd,
        savedAt: window.savedAt,
        slug: window.slug,
        question: window.question,
        conditionId: window.conditionId,
        assetPrice: nextAsset,
        prevCloseAsset: nextPtb,
        assetGap: nextGap,
        windowOutcome: outcome,
        yesPrice: window.yesPrice,
        noPrice: window.noPrice,
        ptbCrossings: window.ptbCrossings,
        minAssetPrice: window.minAssetPrice,
        maxAssetPrice: window.maxAssetPrice,
        assetRange: window.assetRange,
        rangeTop: window.rangeTop,
        rangeBottom: window.rangeBottom,
        uniqueTraders: window.uniqueTraders,
        newWallets: window.newWallets,
        knownWallets: window.knownWallets,
        tickCount: window.tickCount,
        clobRawCount: window.clobRawCount,
        clobBookCount: window.clobBookCount,
        chainlinkCount: window.chainlinkCount,
      });

      updated += 1;
      console.log(
        `[backfill] ${label}: ${window.windowOutcome ?? "?"} → ${outcome}` +
          (finalPrice != null && priceToBeat != null
            ? ` (ptb=${priceToBeat} close=${finalPrice})`
            : "") +
          ` ${slug}`,
      );
    } catch (err) {
      failed += 1;
      console.error(`[backfill] ${label}: ${String(err)}`);
    }

    await sleep(DELAY_MS);
  }

  console.log(
    `[backfill] ${market._id} done: updated=${updated} unchanged=${unchanged}` +
      ` unresolved=${unresolved} failed=${failed}`,
  );
}

async function main(): Promise<void> {
  await initStorage();
  const seriesArg = process.argv[2]?.trim();
  const markets = seriesArg
    ? [await getMarket(seriesArg)].filter((m): m is MarketDocument => m != null)
    : await listMarkets();

  if (markets.length === 0) {
    console.error(seriesArg ? `Market not found: ${seriesArg}` : "No markets found");
    process.exitCode = 1;
    return;
  }

  for (const market of markets) {
    await backfillMarket(market);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
