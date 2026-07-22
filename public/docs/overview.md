# Overview

Poly Real is a **schedule-driven Polymarket up/down trading** app. You design phase-based setups, place them on a UTC week grid, preview in demo mode, then go live with your wallet.

Use the **Search** field in the Docs sidebar to find topics across these pages. Docs live at `/docs` and release notes at `/version`. When you are signed in, you can also open Docs from **Settings → Documentation**; use **Back** to return to the app.

## What you can do

- Watch live market windows (quotes, chart, PTB vs current price)
- Build **setups** with timed phases (buy rules, size, exits)
- Place setups on a **Schedule** grid (day × UTC hour)
- Run **demo** trades first, then enable **live** trading
- Inspect a **Heatmap** of historical window activity

## Pages after login

| Page | Purpose |
|------|---------|
| **Market** | Live window, quotes, chart, trade controls, positions — see [Market](doc:market) |
| **Schedule / Heatmap** | Setup templates, week grid placements, heatmap — see [Schedule](doc:schedule) |
| **Settings** | Profile and Polymarket wallet credentials — see [Settings & wallet](doc:settings) |

## Important concepts

- **Series / market** — e.g. `btc-5m`, `eth-15m`. Schedule and trading are per series.
- **Window** — one timed up/down market slice until expiry.
- **Setup** — a named template with **3 phases** (timing splits + buy/sell rules). See [Setups & phases](doc:setups-phases).
- **Schedule** — which setup is active for each UTC weekday/hour.
- **Demo vs live** — demo simulates fills; live sends real CLOB orders when trading is armed and wallet credentials are set.
- **Information flow** — REST vs SSE vs server WebSockets — see [Information flow](doc:data-flow).

## See also

- [Getting started](doc:getting-started)
- [Market](doc:market)
- [Schedule](doc:schedule)
- [Setups & phases](doc:setups-phases)
- [Information flow](doc:data-flow)
- [Settings & wallet](doc:settings)
