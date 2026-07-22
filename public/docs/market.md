# Market

The **Market** page is the live trading console for the selected series.

## Header context

- Market selector chooses the active series
- Session summaries can show Market / Live / Schedule PnL
- Window countdown tracks the current market window

## Wallet strip

Shows connection status and USDC balance (refresh available). Credentials are managed in [Settings & wallet](doc:settings).

Live quotes and window state arrive over the live stream (SSE), not a browser WebSocket. Details: [Information flow](doc:data-flow).

## Trade controls

These toggles sit on the Market trade panel:

```demo
trade-toggle|Allow trade|off
trade-toggle|Auto Trade|on
trade-size|10|shares
trade-toggle|Use Schedule|on
```

| Control | Meaning |
|---------|---------|
| **Allow trade** | Off = demo / simulation path; on = real orders when other gates pass |
| **Auto Trade** | Bot may place according to active rules |
| **Use Schedule** | When on with Auto Trade, the UTC schedule placement drives which setup is active |
| **Size** | Manual / fallback order size in shares or USDC (as shown in the UI) |

Typical scheduled live path:

```demo
trade-toggle|Allow trade|on
trade-toggle|Auto Trade|on
trade-toggle|Use Schedule|on
```

Graph-only editing path (edit phases on the chart):

```demo
trade-toggle|Auto Trade|on
trade-toggle|Use Schedule|off
```

## Chart and phases

The simulator panel shows PTB, current price, gap, and tick context. The chart marks **3 phases** for the active setup. Click a phase band to open the phase editor (when editable). Full field reference: [Setups & phases](doc:setups-phases).

Phase splits and rules come from either:

- The **graph setup** (Auto Trade on, Use Schedule off), or
- The **scheduled setup** for the current UTC slot (Use Schedule on) — see [Schedule](doc:schedule)

## Quotes and manual orders

Up/Down buy/sell quotes update with the book. Clicking quotes can place manual orders when trading is armed (demo or live depending on **Allow trade**).

## Positions and log

- **Live** and **Demo** position cards
- A **Log** stream of bot / order activity for the session

## See also

- [Getting started](doc:getting-started)
- [Schedule](doc:schedule)
- [Setups & phases](doc:setups-phases)
- [Settings & wallet](doc:settings)
