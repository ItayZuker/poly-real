# Information flow

How data moves through Poly Real — **REST** for actions and saves, **SSE** for live updates. Your browser does **not** open a WebSocket; the **server** does that to Polymarket and Chainlink.

Public pages: documentation at `/docs`, release notes at `/version`.

## Channels at a glance

| Channel | Used by | For |
|---------|---------|-----|
| **REST** `/api/...` | Browser → server | Login, settings, trade toggles, setups, schedule, manual orders |
| **SSE** `/api/stream` | Server → browser | Live quotes, window, trading state, log, heatmap, schedule board |
| **WebSocket** | Server ↔ exchanges | CLOB book + Chainlink price (server only) |

```flow
# Your browser ↔ Poly Real
Browser -> REST /api -> Server
Server -> SSE /api/stream -> Browser
```

## Live market into the UI

Outside feeds are gathered on the server, then pushed to the [Market](doc:market) page over SSE.

```flow
# Where live numbers come from
Polymarket CLOB WS -> Server
Chainlink WS -> Server
Polymarket REST (window / PTB) -> Server
Server -> SSE quotes / window -> Browser UI
```

| Piece | Comes from |
|-------|------------|
| Order book / quotes | Polymarket CLOB (server WebSocket) |
| Window start/end, tokens | Polymarket market pair (server REST) |
| PTB | Published window open price (server REST) |
| Live asset price | Chainlink (prefer), else REST fallback |
| Gap / crossings | Computed on the server from asset vs PTB |

## What triggers trading

Auto-trade runs on the **server** on each market tick. The browser only turns switches on/off and can place **manual** orders.

```flow
# Auto-trade path
SSE sources update Server -> Server trading tick
Server trading tick -> Phase rules (setup)
Phase rules -> Preview markers
Phase rules -> Live CLOB orders (if Allow trade + executor)
```

```flow
# What you control from the UI
Browser -> REST trading config -> Auto Trade / Use Schedule / Allow trade
Browser -> REST manual order -> Server places order
```

- **Auto Trade** — server may act on each tick using the active setup
- **Use Schedule** — setup comes from the current UTC schedule cell — see [Schedule](doc:schedule)
- Without schedule — phases come from the graph / sim setup — see [Setups & phases](doc:setups-phases)
- **Allow trade** — off = demo/preview path; on = real orders when the server can execute

## Setups and schedule

```flow
# Saving and applying setups
Browser -> REST setups / placements -> MongoDB
Server tick -> Active UTC placement -> Phase setup -> Buy / sell rules
```

SSE also refreshes the schedule board after changes so the UI stays in sync.

## Auth

```flow
# Session
Browser -> REST login / register -> Server sets session cookie
Browser -> REST + SSE (cookie) -> Per-user trading and schedule
```

Wallet credentials live in [Settings](doc:settings); they unlock Market and Schedule and enable live signing.

## See also

- [Market](doc:market)
- [Schedule](doc:schedule)
- [Setups & phases](doc:setups-phases)
- [Settings & wallet](doc:settings)
- [Overview](doc:overview)
