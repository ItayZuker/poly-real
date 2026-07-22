# Getting started

## 1. Create an account

On the **Main** tab, choose **Sign up** (email + password). A display name is optional. You do **not** need a wallet to create an account.

```demo
auth-buttons|Log in|Sign up
```

## 2. Add trading credentials

Open **Settings** and fill **Trading credentials**:

1. **Funder address** — your Polymarket proxy / profile wallet that holds USDC
2. **Private key** — the EOA signer key (stored encrypted; not shown again after save)

Until **both** are saved, **Market** and **Schedule** stay locked and the app sends you to Settings.

Details: [Settings & wallet](doc:settings).

## 3. Pick a market

Use the market selector in the header (series such as BTC/ETH/SOL 5m or 15m).

## 4. Preview on Market

On **Market**:

- Leave **Allow trade** off to stay in demo / preview mode
- Watch quotes, chart phases, and the log
- Optionally click quotes for manual demo orders when armed for demo flow

```demo
trade-toggle|Allow trade|off
trade-toggle|Auto Trade|off
trade-toggle|Use Schedule|off
```

More: [Market](doc:market).

## 5. Build a setup and schedule it

On **Schedule / Heatmap**:

1. Create or edit a **setup** (phases, sizes, triggers) — [Setups & phases](doc:setups-phases)
2. Drag or place it onto Mon–Sun × UTC hours — [Schedule](doc:schedule)
3. Enable **Use Schedule** + **Auto Trade** on Market when you want the grid to drive trades

```demo
trade-toggle|Auto Trade|on
trade-toggle|Use Schedule|on
```

## 6. Go live carefully

1. Confirm wallet balance and credentials in Settings / Market
2. Turn **Allow trade** on for real orders
3. Start with small size and verify the log and positions

```demo
trade-toggle|Allow trade|on
```

## See also

- [Overview](doc:overview)
- [Market](doc:market)
- [Schedule](doc:schedule)
- [Setups & phases](doc:setups-phases)
- [Settings & wallet](doc:settings)
