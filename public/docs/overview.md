# Overview

Poly Real is a **schedule-driven Polymarket up/down trading** app. You design phase-based setups, place them on a UTC week grid, preview in demo mode, then go live with your wallet.

## What you can do

- Watch live market windows (quotes, chart, PTB vs current price)
- Build **setups** with timed phases (buy rules, size, exits)
- Place setups on a **Schedule** grid (day × UTC hour)
- Run **demo** trades first, then enable **live** trading
- Inspect a **Heatmap** of historical window activity

## Pages after login

| Page | Purpose |
|------|---------|
| **Market** | Live window, quotes, chart, trade controls, positions |
| **Schedule / Heatmap** | Setup templates, week grid placements, heatmap |
| **Settings** | Profile and Polymarket wallet credentials |

## Important concepts

- **Series / market** — e.g. `btc-5m`, `eth-15m`. Schedule and trading are per series.
- **Window** — one timed up/down market slice until expiry.
- **Setup** — a named template with up to **3 phases** (when buys are allowed, size, trigger ¢, abort rules, sell targets).
- **Schedule** — which setup is active for each UTC weekday/hour.
- **Demo vs live** — demo simulates fills; live sends real CLOB orders when trading is armed and wallet credentials are set.
