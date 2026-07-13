# Poly Recorder — Storage Schema & Key Mapping

Reference for reading recorded Polymarket up/down window data and replaying it in a trade simulator or analysis app.

**Data directory:** `DATA_DIR` env var (default `./data`).

---

## Quick start for simulation agents

### What this data is

Poly Recorder records **parallel auditable timelines** for each window: every CLOB websocket message (YES/NO tokens only), a **top-5 book snapshot** after each message, and **Chainlink asset price** updates. A simulator replays book snapshots and walks depth for fills.

### Recommended replay flow

1. **Pick a market** — read `data/markets.json`; series id is e.g. `btc-5m`, on-disk folder is `btc_5m` (`-` → `_`).
2. **Pick a window** — list `data/btc_5m/windows/*.json`; filename = `windowStart` (unix seconds).
3. **Load window metadata** — read the window JSON for outcome, PTB, final prices, stream counts.
4. **Load tick timelines** (parallel, align by `tMs`):
   - `data/btc_5m/ticks/{windowStart}/clob-raw.jsonl` — raw WS payloads
   - `data/btc_5m/ticks/{windowStart}/clob-book.jsonl` — top-5 depth snapshots
   - `data/btc_5m/ticks/{windowStart}/chainlink.jsonl` — asset price only
5. **Step through time** — sim steps on **book** ticks; merge chainlink by `tMs` for chart/settlement.
6. **Score the window** — at `windowEnd`, compare `assetPrice` vs `prevCloseAsset`, or read `windowOutcome`.

API: `GET /api/ticks?series=&windowStart=&stream=merged|book|raw|chainlink`

### What is NOT in the data

| Missing | Why |
|---------|-----|
| Individual trade events | Only aggregate trader counts per window |
| Wallet addresses per window | Only counts; addresses live in global `wallets.json` |
| Non YES/NO CLOB traffic | Raw log filters to active window token IDs only |

---

## Conventions

### Compact numeric keys

Tick, window, and heatmap files store fields under **numeric string keys** (`"0"`, `"1"`, …) instead of names. **The same key number means different fields in different document types** — always use the document-type table below.

Logical names in this doc map to those keys. When reading raw JSON files, translate keys using the tables in each section.

### Numbers and omission

- Stored numbers are rounded to **4 decimal places**.
- Optional numeric fields are **omitted** when null, undefined, or non-finite.
- Fields marked **“only if > 0”** are also omitted when zero.
- `tickCount` on window docs is **always** stored (key `17`).
- `windowStart`, `windowEnd`, `savedAt` are always stored where applicable.

### Timestamps

| Field | Unit | Where |
|-------|------|-------|
| `windowStart`, `windowEnd` | Unix **seconds** | ticks, windows, heatmap |
| `tMs`, `savedAt`, `updatedAt` | Unix **milliseconds** | ticks (`tMs`), windows/heatmap (`savedAt`) |
| `firstSeenAt`, `lastSeenAt` | Unix **seconds** | `wallets.json` |
| `createdAt`, `updatedAt` | ISO 8601 strings | `markets.json` |

### Market series ↔ folder name

| Series id (`markets.json` key) | Data folder |
|-------------------------------|-------------|
| `btc-5m` | `data/btc_5m/` |
| `eth-5m` | `data/eth_5m/` |
| `sol-5m` | `data/sol_5m/` |
| `btc-15m` | `data/btc_15m/` |
| etc. | Replace `-` with `_` |

### Window lifecycle

- A window spans `[windowStart, windowEnd)` in unix seconds (`windowEnd - windowStart` = 300 for 5m, 900 for 15m).
- Ticks are recorded only while the window is active.
- On window end: ticks are flushed, trader stats fetched, `windows/{windowStart}.json` written, `wallets.json` updated.
- Files older than **7 days** (hardcoded) are zipped by UTC day into `{market}/archive/YYYY-MM-DD.zip` and removed from hot storage. Archiving runs every hour and after each window finalizes, **even when recording is off**.

---

## Folder layout

```
data/
  markets.json                 # market config (normal field names)
  wallets.json                 # global wallet registry (normal field names)
  btc_5m/
    ticks/
      {windowStart}/          # hot: last 7 days (unzipped)
        clob-raw.jsonl
        clob-book.jsonl
        chainlink.jsonl
    archive/
      YYYY-MM-DD.zip          # one UTC day per zip (ticks + windows + heatmap)
    windows/
      {windowStart}.json       # full window summary
    heatmap/
      {windowStart}.json       # slim stats for heatmap / bulk scan
```

| Path | Purpose | Use in simulator |
|------|---------|------------------|
| `markets.json` | Which markets exist, retention, recording flags | Market selection |
| `{market}/ticks/*.jsonl` | Time-series replay source | **Primary input** for stepping through a window |
| `{market}/windows/*.json` | Full per-window summary + stats | Window metadata, settlement, heatmap metrics, trader counts |
| `{market}/heatmap/*.json` | **Legacy** — no longer written | Use `windows/`; run `npm run migrate:heatmap-to-windows` to merge old files |
| `wallets.json` | Global wallet registry | Optional; not needed for price replay |

---

## Master key index

**Warning:** key numbers are reused across document types.

| Key | Book tick (`0`=1) | Chainlink tick (`0`=2) | Window | Heatmap |
|-----|-------------------|------------------------|--------|---------|
| `_id` | `{windowStart}:{seq}` | `{windowStart}:{seq}` | `{windowStart}` | `{windowStart}` |
| `0` | type = **1** | type = **2** | — | — |
| `1` | windowStart | windowStart | windowStart | windowStart |
| `2` | tMs | tMs | windowEnd | windowEnd |
| `3` | yesPrice | assetPrice | savedAt (ms) | savedAt (ms) |
| `4` | yesBid | prevCloseAsset (PTB) | updatedAt (ms) | windowOutcome |
| `5` | yesAsk | ptbCrossings* | slug | ptbCrossings* |
| `6` | yesBidSize | minAssetPrice | question | minAssetPrice |
| `7` | yesAskSize | maxAssetPrice | conditionId | maxAssetPrice |
| `8` | noPrice | — | assetPrice | rangeTop* |
| `9` | noBid | — | prevCloseAsset (PTB) | rangeBottom* |
| `10` | noAsk | — | windowOutcome | uniqueTraders* |
| `11` | noBidSize | — | yesPrice | newWallets* |
| `12` | noAskSize | — | noPrice | knownWallets* |
| `13` | — | — | ptbCrossings* | — |
| `14` | — | — | minAssetPrice | — |
| `15` | — | — | maxAssetPrice | — |
| `16` | — | — | uniqueTraders* | — |
| `17` | — | — | tickCount | — |
| `18` | — | — | newWallets* | — |
| `19` | — | — | knownWallets* | — |

\* Omitted when value is 0 (or null).

---

## `markets.json`

Object keyed by market series id. Uses **normal field names** (not compact keys).

| Field | Type | Description |
|-------|------|-------------|
| `_id` | string | Series id, e.g. `btc-5m` |
| `label` | string | Human label |
| `timeframeMinutes` | number | `5` or `15` |
| `recordingEnabled` | boolean | Whether recorder is running for this market |
| `retentionDays` | number | Days of tick/window/heatmap data to keep (`0` = no pruning) |
| `createdAt` | string | ISO timestamp |
| `updatedAt` | string | ISO timestamp |

---

## `wallets.json` (global registry)

Top-level object keyed by wallet address (lowercase `0x…`). Each value is a `WalletRegistryEntry`. Uses **normal field names**.

| Field | Type | Description |
|-------|------|-------------|
| `address` | string | Proxy wallet address (same as object key) |
| `firstSeenAt` | number | Unix seconds — first sighting in any market |
| `lastSeenAt` | number | Unix seconds — most recent window finalize sighting |
| `markets` | object | Map of series id → count of windows that wallet traded in |
| `totalSightings` | number | Total windows seen across all markets (once per window per wallet) |

Updated **once per completed window** when traders are registered. Live UI polls do not write here.

**Example entry:**
```json
{
  "0xabc…": {
    "address": "0xabc…",
    "firstSeenAt": 1783661402,
    "lastSeenAt": 1783663506,
    "markets": { "btc-5m": 3 },
    "totalSightings": 3
  }
}
```

---

## `ticks` — `{market}/ticks/{windowStart}.jsonl`

One JSON object per line. Book and Chainlink events are **interleaved** in a single file, sorted by append order (not strictly by `tMs` on disk — sort by `2` when replaying).

### Recording cadence

- **Book ticks:** stored on every CLOB value change (bid, ask, sizes, display prices).
- **Chainlink ticks:** stored on every asset price or dynamics change.
- **Heartbeat:** every **500ms** (minimum **450ms** since last tick) stores current snapshot if feeds are idle — reduces replay gaps.

### Tick type discriminator

| Key | Field | Values |
|-----|-------|--------|
| `0` | type | **`1`** = CLOB book tick, **`2`** = Chainlink asset tick |

### Common keys (both types)

| Key | Field | Type | Description |
|-----|-------|------|-------------|
| `_id` | _id | string | `{windowStart}:{seq}` — monotonic seq per window |
| `1` | windowStart | number | Window start, unix **seconds** |
| `2` | tMs | number | Event time, unix **milliseconds** |

### Book tick keys (`0` = 1)

Polymarket CLOB top-of-book. Contract prices in **0–1** range; sizes in **shares**.

| Key | Field | Type | Description |
|-----|-------|------|-------------|
| `3` | yesPrice | number | YES display/trigger price (see Price semantics) |
| `4` | yesBid | number | YES best bid |
| `5` | yesAsk | number | YES best ask |
| `6` | yesBidSize | number | YES bid size at best bid |
| `7` | yesAskSize | number | YES ask size at best ask |
| `8` | noPrice | number | NO display/trigger price |
| `9` | noBid | number | NO best bid |
| `10` | noAsk | number | NO best ask |
| `11` | noBidSize | number | NO bid size at best bid |
| `12` | noAskSize | number | NO ask size at best ask |

### Chainlink tick keys (`0` = 2)

Underlying asset (BTC, ETH, etc.) spot price and running window dynamics.

| Key | Field | Type | Description |
|-----|-------|------|-------------|
| `3` | assetPrice | number | Chainlink spot price (USD) |
| `4` | prevCloseAsset | number | Price to beat (PTB) — reference for up/down outcome |
| `5` | ptbCrossings | number | PTB crossings so far — **only if > 0** |
| `6` | minAssetPrice | number | Running minimum asset price this window |
| `7` | maxAssetPrice | number | Running maximum asset price this window |

### Derived on read (not stored on chainlink ticks)

Compute these when expanding chainlink or merged replay ticks:

| Field | Formula |
|-------|---------|
| `assetGap` | `assetPrice − prevCloseAsset` |
| `assetRange` | `max(0, maxAssetPrice − minAssetPrice)` |
| `rangeTop` | `max(0, maxAssetPrice − prevCloseAsset)` |
| `rangeBottom` | `max(0, prevCloseAsset − minAssetPrice)` |
| `t` | `floor(tMs / 1000)` |
| `elapsedSec` | `tMs / 1000 − windowStart` |

### Price semantics (for simulators)

- **`yesBid` / `yesAsk` / `noBid` / `noAsk`:** use these for simulated market orders (buy hits ask, sell hits bid).
- **`yesPrice` / `noPrice`:** display/trigger prices picked from midpoint, last trade, or book — useful for UI, not necessarily the fill price.
- **`prevCloseAsset`:** PTB; if `assetPrice > prevCloseAsset` at window end → **up**; if below → **down**.
- YES + NO prices should sum to ~1; each side is a separate token.

### Legacy chainlink tick layout

Older recordings may use a previous key layout where chainlink ticks stored derived fields (`assetGap`, `assetRange`, `rangeTop`, `rangeBottom`) directly. Current layout omits those and derives on read. Code in `src/tick-compact.ts` (`CK_LEGACY`) handles both.

---

## Simulator replay algorithm

### Option A — raw JSONL (recommended for offline sim)

```
1. Parse each line of ticks/{windowStart}.jsonl
2. Sort all ticks by key "2" (tMs); tie-break: book (type 1) before chainlink (type 2)
3. Maintain bookState and assetState objects (latest field values)
4. For each tick in order:
     if type == 1: merge into bookState
     if type == 2: merge into assetState; compute derived asset fields
     emit merged snapshot at this tMs
5. Simulator steps through emitted snapshots
```

### Option B — HTTP API (merged replay)

```
GET /api/ticks?series=btc-5m&windowStart=1783610100&limit=5000
```

Response:
```json
{
  "series": "btc-5m",
  "windowStart": 1783610100,
  "count": 4014,
  "ticks": [ { "tMs": ..., "t": ..., "elapsedSec": ..., "source": "clob-book"|"chainlink-tick", ... } ]
}
```

Each tick in `ticks` is a **merged** snapshot: book fields + latest chainlink fields at that instant. `source` tells which feed triggered the update. Implementation: `src/db/replay-tick-repository.ts` → `mergeReplayTicks()`.

### Replay tick fields (API / logical)

| Field | Type | Description |
|-------|------|-------------|
| `tMs` | number | Event time (ms) |
| `t` | number | `floor(tMs / 1000)` |
| `elapsedSec` | number | Seconds since `windowStart` |
| `source` | string | `"clob-book"` or `"chainlink-tick"` |
| `yesPrice`, `noPrice` | number | Display/trigger prices |
| `yesBid`, `yesAsk`, `noBid`, `noAsk` | number | Top of book |
| `yesBidSize`, `yesAskSize`, `noBidSize`, `noAskSize` | number | Top-of-book sizes |
| `assetPrice` | number | Chainlink spot |
| `prevCloseAsset` | number | PTB |
| `assetGap`, `assetRange`, `rangeTop`, `rangeBottom` | number | Derived |
| `ptbCrossings`, `minAssetPrice`, `maxAssetPrice` | number | Running dynamics |

### Settlement

Read from `windows/{windowStart}.json` (or last chainlink tick):

| Check | Rule |
|-------|------|
| Outcome | `windowOutcome`: `1` = up, `2` = down |
| Verify | `assetPrice` vs `prevCloseAsset` at window end |
| Contract payoff | Up window: YES → $1, NO → $0; Down window: YES → $0, NO → $1 |

---

## `windows` — `{market}/windows/{windowStart}.json`

Full summary written once when a window completes. Primary metadata source for a single window.

### Always present

| Key | Field | Type | Description |
|-----|-------|------|-------------|
| `_id` | _id | string | `String(windowStart)` |
| `1` | windowStart | number | Unix seconds |
| `2` | windowEnd | number | Unix seconds |
| `3` | savedAt | number | Unix **milliseconds** |
| `4` | updatedAt | number | Unix **milliseconds** |
| `17` | tickCount | number | Total ticks recorded (book + chainlink) |

### Optional keys

| Key | Field | Type | Omission | Description |
|-----|-------|------|----------|-------------|
| `5` | slug | string | if empty | Polymarket event slug, e.g. `btc-updown-5m-1783610100` |
| `6` | question | string | if empty | Market question text |
| `7` | conditionId | string | if empty | On-chain condition id (`0x…`) |
| `8` | assetPrice | number | if null | Final Chainlink asset price |
| `9` | prevCloseAsset | number | if null | PTB at window end |
| `10` | windowOutcome | number | if unknown | **`1`** = up, **`2`** = down |
| `11` | yesPrice | number | if null | Final YES contract price |
| `12` | noPrice | number | if null | Final NO contract price |
| `13` | ptbCrossings | number | **only if > 0** | Total PTB crossings |
| `14` | minAssetPrice | number | if null | Window minimum asset price |
| `15` | maxAssetPrice | number | if null | Window maximum asset price |
| `16` | uniqueTraders | number | **only if > 0** | Distinct traders in window |
| `18` | newWallets | number | **only if > 0** | Wallets new to global registry |
| `19` | knownWallets | number | **only if > 0** | Wallets already in registry |
| `20` | rangeTop | number | **only if > 0** | Max excursion above PTB |
| `21` | rangeBottom | number | **only if > 0** | Max excursion below PTB |

`newWallets + knownWallets = uniqueTraders` when all three are present.

### Derived on read (when not stored)

| Field | Formula |
|-------|---------|
| `assetGap` | `assetPrice − prevCloseAsset` |
| `assetRange` | `max(0, maxAssetPrice − minAssetPrice)` |
| `rangeTop` | key `20`, or `max(0, maxAssetPrice − prevCloseAsset)` |
| `rangeBottom` | key `21`, or `max(0, prevCloseAsset − minAssetPrice)` |

### Outcome codes

| Code | Meaning |
|------|---------|
| `1` | **up** — asset finished above PTB |
| `2` | **down** — asset finished below PTB |

---

## `heatmap` — legacy (deprecated)

**No longer written.** The heatmap UI and schedule backtest read from `windows/` only. Merge old files with `npm run migrate:heatmap-to-windows`, then delete `data/*/heatmap/`.

Legacy key layout (archives may still contain these files):

| Key | Field |
|-----|-------|
| `4` | windowOutcome |
| `5`–`12` | ptbCrossings, min/max asset, rangeTop/Bottom, trader counts |

### Data source

| Need | Use |
|------|-----|
| Everything (metadata, heatmap, schedule backtest) | `windows/` |
| Time-series simulation | `ticks/` |

---

## HTTP API (live + replay)

Base URL: `http://localhost:3847` (or `PORT` env).

| Endpoint | Params | Returns | Simulator use |
|----------|--------|---------|---------------|
| `GET /api/markets` | — | All market configs | List available series |
| `GET /api/ticks` | `series`, `windowStart`, `limit?` | Merged replay ticks | **Primary replay feed** |
| `GET /api/window` | `series` | Live current window state | Live UI only |
| `GET /api/quotes` | `series` | Live quotes | Live UI only |
| `GET /api/book` | `series` | Live order book depth | Live UI only |
| `GET /api/stream` | — | SSE live updates | Live UI only |

For offline simulation, read files directly under `DATA_DIR`. The API expands compact keys to logical field names on read.

---

## Legacy formats

Older data from the MongoDB era may use **named fields** (`windowStart`, `yesBid`, …) instead of numeric keys. Reader code in `src/tick-compact.ts`, `src/window-compact.ts`, and `src/heatmap-compact.ts` accepts both. New recordings always use compact numeric keys.

---

## Source code references

| Mapping | File | Export |
|---------|------|--------|
| Tick type + book keys | `src/tick-compact.ts` | `TK`, `TickType`, `BK` |
| Chainlink tick keys | `src/tick-compact.ts` | `CK`, `CK_LEGACY` |
| Recorded window keys | `src/window-compact.ts` | `WK`, `WindowOutcomeCode` |
| Heatmap keys | `src/heatmap-compact.ts` | `HK` |
| Replay merge | `src/db/replay-tick-repository.ts` | `mergeReplayTicks`, `listReplayTicks` |
| File paths | `src/db/data-dir.ts` | `marketDir`, `marketTicksDir`, … |

---

## Examples (raw compact JSON)

**Book tick** (`data/btc_5m/ticks/{windowStart}.jsonl`):
```json
{ "_id": "1783659300:1", "0": 1, "1": 1783659300, "2": 1783659303441, "3": 0.455, "4": 0.45, "5": 0.46, "6": 386.94, "7": 103.38, "8": 0.545, "9": 0.54, "10": 0.55, "11": 241.38, "12": 386.94 }
```

**Chainlink tick** (same file):
```json
{ "_id": "1783659300:5", "0": 2, "1": 1783659300, "2": 1783659302000, "3": 64039.2707, "4": 64041.87, "6": 64039.2707, "7": 64041.8698 }
```

**Recorded window** (`data/btc_5m/windows/1783610100.json`):
```json
{ "_id": "1783610100", "1": 1783610100, "2": 1783610400, "3": 1783610400568, "4": 1783610402724, "5": "btc-updown-5m-1783610100", "6": "Bitcoin Up or Down - July 9, 11:15AM-11:20AM ET", "7": "0x4fc4625d…", "8": 62971.5973, "9": 63037.6847, "10": 2, "14": 62931.3127, "15": 63010.3744, "16": 316, "17": 4014 }
```

**Heatmap window** (`data/btc_5m/heatmap/1783659300.json`):
```json
{ "_id": "1783659300", "1": 1783659300, "2": 1783659600, "3": 1783659600615, "4": 2, "6": 63989.6076, "7": 64041.8698, "9": 52.2624, "10": 17 }
```

**Wallet registry entry** (`data/wallets.json`):
```json
{ "0xabc…": { "address": "0xabc…", "firstSeenAt": 1783661402, "lastSeenAt": 1783663506, "markets": { "btc-5m": 3 }, "totalSightings": 3 } }
```
