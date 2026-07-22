# Market

Live trading console for the selected series.

## Trade controls

| Control | Meaning |
|---------|---------|
| **Allow trade** | Off = demo; on = real orders when other gates pass |
| **Auto Trade** | Bot may trade using the active setup |
| **Use Schedule** | With Auto Trade: the UTC schedule cell picks the setup |
| **Size** | Manual / fallback order size |

Scheduled live: **Allow trade** + **Auto Trade** + **Use Schedule** on.

Edit phases on the chart: **Auto Trade** on, **Use Schedule** off.

## Chart and phases

Shows PTB, price, gap, and **3 phases** for the active setup. Click a phase band to edit when editable.

| Mode | Source of phases | Editable on chart? |
|------|------------------|--------------------|
| Auto Trade on, Use Schedule off | Graph setup | Yes |
| Use Schedule on | Schedule setup for current UTC slot | No — edit on [Schedule](doc:schedule) |

Field reference: [Setups & phases](doc:setups-phases).

## Quotes, positions, log

- Up/Down quotes; click to place manual orders when trading is armed
- Live and Demo position cards
- Log of bot / order activity

Wallet credentials: [Settings & wallet](doc:settings).
