# Market

The **Market** page is the live trading console for the selected series.

## Header context

- Market selector chooses the active series
- Session summaries can show Market / Live / Schedule PnL
- Window countdown tracks the current market window

## Wallet strip

Shows connection status and USDC balance (refresh available). Credentials are managed in **Settings**.

## Trade controls

- **Allow trade** — off = demo / simulation path; on = real orders when other gates pass
- **Auto Trade** — bot may place according to active rules
- **Use Schedule** — when on with Auto Trade, the UTC schedule placement drives which setup is active
- **Size** — order size in shares or USDC (as shown in the UI)

## Chart and phases

The simulator panel shows PTB, current price, gap, and tick context. The chart marks **3 phases** for the active setup. You can open the phase editor from the Market UI when editing setup timing/rules.

## Quotes and manual orders

Up/Down buy/sell quotes update with the book. Clicking quotes can place manual orders when trading is armed (demo or live depending on **Allow trade**).

## Positions and log

- **Live** and **Demo** position cards
- A **Log** stream of bot / order activity for the session
