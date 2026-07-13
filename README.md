# Poly Recorder

Passive Polymarket up/down market data recorder. Collects every CLOB book update and Chainlink price tick, persisting to local JSON files for downstream simulation.

## Requirements

- Node.js 20+

## Setup

```bash
npm install
npm start
```

Open http://localhost:3847

## Environment

| Variable | Default | Description |
|----------|---------|-------------|
| `DATA_DIR` | `./data` | Folder for all recorded data |
| `CLOB_HOST` | `https://clob.polymarket.com` | CLOB REST host |
| `CHAIN_ID` | `137` | Polygon chain ID |
| `PORT` | `3847` | HTTP server port |

No wallet, private key, CLOB API keys, or database required.

## Data layout

```
data/
  markets.json
  btc_5m/
    ticks/
      {windowStart}.jsonl    # one compact tick per line
    windows/
      {windowStart}.json     # window summary
    heatmap/
      {windowStart}.json     # heatmap stats
```

See [docs/database-schema.md](docs/database-schema.md) for numeric key mappings.

## Markets

Six markets are seeded on startup: `btc-5m`, `eth-5m`, `sol-5m`, `btc-15m`, `eth-15m`, `sol-15m`.

The last **7 days** of tick/window data stay unzipped for simulation. Older data is archived daily to `archive/YYYY-MM-DD.zip` (runs every hour, even when recording is off). Toggle **Recording** per market to start/stop capture.

## APIs

- `GET /api/markets` — list markets
- `PATCH /api/markets/:series` — toggle recording
- `GET /api/quotes?series=` — live quotes
- `GET /api/book?series=` — order book depth
- `GET /api/window?series=` — current window state
- `GET /api/ticks?series=&windowStart=` — replay ticks
- `GET /api/stream` — SSE live updates

## Replay

Read ticks from `data/btc_5m/ticks/{windowStart}.jsonl` (one JSON object per line), or use `GET /api/ticks?series=btc-5m&windowStart=…`.
