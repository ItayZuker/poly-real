# Overview

Poly Real is schedule-driven Polymarket **up/down** trading: build phase-based setups, place them on a UTC week grid, preview in demo, then go live.

## What you can do

- Watch live windows (quotes, chart, PTB vs price)
- Build **setups** with timed buy/sell phases
- Place setups on a **Schedule** (day × UTC hour)
- Use **Replay** mode on Schedule to trial setups over recent history (separate board from Live)
- Run **demo**, then **live** with your wallet
- Use the **Heatmap** for historical window activity

## Pages

| Page | Purpose |
|------|---------|
| **Market** | Live window, trades, positions — [Market](doc:market) |
| **Schedule / Heatmap** | Setups, grid, heatmap — [Schedule](doc:schedule) |
| **Settings** | Profile and wallet — [Settings & wallet](doc:settings) |

## Concepts

| Term | Meaning |
|------|---------|
| **Series** | Market type, e.g. `btc-5m` — schedule and trading are per series |
| **Window** | One timed up/down market until expiry |
| **Setup** | Template with **3 phases** — [Setups & phases](doc:setups-phases) |
| **Schedule** | Which setup is active each UTC weekday/hour (**Live** board). **Replay** is a separate board for historical what-if runs |
| **Demo vs live** | Demo simulates; live sends CLOB orders when **Allow trade** is on and the wallet is set |
