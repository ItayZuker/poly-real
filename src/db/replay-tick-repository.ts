import type {
  ChainlinkTickDocument,
  ClobBookTickDocument,
  MarketDocument,
  ReplayTickDocument,
} from "../types.js";
import { bestPrice, takeLevels } from "../book-depth.js";
import { tickTiming } from "../tick-compact.js";
import { listChainlinkTicks, listClobBookTicks } from "./tick-repository.js";

function topFromState(state: Partial<ClobBookTickDocument>): ReturnType<typeof topOfBook> {
  return topOfBook({
    _id: "",
    windowStart: state.windowStart ?? 0,
    windowEnd: state.windowEnd ?? 0,
    tMs: state.tMs ?? 0,
    yesBids: state.yesBids ?? [],
    yesAsks: state.yesAsks ?? [],
    noBids: state.noBids ?? [],
    noAsks: state.noAsks ?? [],
    yesPrice: state.yesPrice,
    noPrice: state.noPrice,
  });
}
function topOfBook(tick: ClobBookTickDocument): {
  yesBid?: number;
  yesAsk?: number;
  yesBidSize?: number;
  yesAskSize?: number;
  noBid?: number;
  noAsk?: number;
  noBidSize?: number;
  noAskSize?: number;
} {
  const yesBids = takeLevels(tick.yesBids);
  const yesAsks = takeLevels(tick.yesAsks);
  const noBids = takeLevels(tick.noBids);
  const noAsks = takeLevels(tick.noAsks);
  return {
    yesBid: bestPrice(yesBids),
    yesAsk: bestPrice(yesAsks),
    yesBidSize: yesBids[0]?.size,
    yesAskSize: yesAsks[0]?.size,
    noBid: bestPrice(noBids),
    noAsk: bestPrice(noAsks),
    noBidSize: noBids[0]?.size,
    noAskSize: noAsks[0]?.size,
  };
}

export function mergeReplayTicks(
  bookTicks: ClobBookTickDocument[],
  chainlinkTicks: ChainlinkTickDocument[],
): ReplayTickDocument[] {
  type TimelineEvent =
    | { kind: "book"; tMs: number; tick: ClobBookTickDocument }
    | { kind: "chainlink"; tMs: number; tick: ChainlinkTickDocument };

  const events: TimelineEvent[] = [
    ...bookTicks.map((tick) => ({ kind: "book" as const, tMs: tick.tMs, tick })),
    ...chainlinkTicks.map((tick) => ({
      kind: "chainlink" as const,
      tMs: tick.tMs,
      tick,
    })),
  ];
  events.sort((a, b) => a.tMs - b.tMs || (a.kind === "book" ? -1 : 1));

  const bookState: Partial<ClobBookTickDocument> = {};
  const assetState: Partial<ChainlinkTickDocument> = {};
  const replay: ReplayTickDocument[] = [];

  for (const event of events) {
    if (event.kind === "book") {
      Object.assign(bookState, event.tick);
    } else {
      Object.assign(assetState, event.tick);
    }

    const tick = event.tick;
    const timing = tickTiming(tick.tMs, tick.windowStart);
    const top = event.kind === "book" ? topOfBook(event.tick) : topFromState(bookState);
    replay.push({
      tMs: tick.tMs,
      t: timing.t,
      elapsedSec: timing.elapsedSec,
      source: event.kind === "book" ? "clob-book" : "chainlink-tick",
      yesPrice: bookState.yesPrice,
      noPrice: bookState.noPrice,
      yesBid: top.yesBid,
      noBid: top.noBid,
      yesAsk: top.yesAsk,
      noAsk: top.noAsk,
      yesBidSize: top.yesBidSize,
      noBidSize: top.noBidSize,
      yesAskSize: top.yesAskSize,
      noAskSize: top.noAskSize,
      yesBids: bookState.yesBids,
      yesAsks: bookState.yesAsks,
      noBids: bookState.noBids,
      noAsks: bookState.noAsks,
      assetPrice: assetState.assetPrice,
      prevCloseAsset: assetState.prevCloseAsset,
      assetGap: assetState.assetGap,
      ptbCrossings: assetState.ptbCrossings,
      minAssetPrice: assetState.minAssetPrice,
      maxAssetPrice: assetState.maxAssetPrice,
      assetRange: assetState.assetRange,
      rangeTop: assetState.rangeTop,
      rangeBottom: assetState.rangeBottom,
    });
  }

  return replay;
}

export function bookTicksToReplay(bookTicks: ClobBookTickDocument[]): ReplayTickDocument[] {
  return bookTicks.map((tick) => {
    const timing = tickTiming(tick.tMs, tick.windowStart);
    const top = topOfBook(tick);
    return {
      tMs: tick.tMs,
      t: timing.t,
      elapsedSec: timing.elapsedSec,
      source: "clob-book" as const,
      yesPrice: tick.yesPrice,
      noPrice: tick.noPrice,
      yesBid: top.yesBid,
      noBid: top.noBid,
      yesAsk: top.yesAsk,
      noAsk: top.noAsk,
      yesBidSize: top.yesBidSize,
      noBidSize: top.noBidSize,
      yesAskSize: top.yesAskSize,
      noAskSize: top.noAskSize,
      yesBids: tick.yesBids,
      yesAsks: tick.yesAsks,
      noBids: tick.noBids,
      noAsks: tick.noAsks,
    };
  });
}

/** Book-only replay — used by schedule backtest (no chainlink merge). */
export async function listBookReplayTicks(
  market: MarketDocument,
  windowStart: number,
  limit = 10_000,
): Promise<ReplayTickDocument[]> {
  const bookTicks = await listClobBookTicks(market, windowStart, limit);
  return bookTicksToReplay(bookTicks);
}

export async function listReplayTicks(
  market: MarketDocument,
  windowStart: number,
  limit = 10_000,
): Promise<ReplayTickDocument[]> {
  const perSourceLimit = limit;
  const [bookTicks, chainlinkTicks] = await Promise.all([
    listClobBookTicks(market, windowStart, perSourceLimit),
    listChainlinkTicks(market, windowStart, perSourceLimit),
  ]);
  const merged = mergeReplayTicks(bookTicks, chainlinkTicks);
  return merged.slice(0, limit);
}

/** @deprecated Use listReplayTicks for merged book + chainlink replay */
export const listTicks = listReplayTicks;
