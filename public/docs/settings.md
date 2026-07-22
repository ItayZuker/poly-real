# Settings & wallet

## Profile

Update display name, log out, or delete your account from Settings.

## Documentation

While signed in, open **Documentation** from Settings (or go to `/docs`). Release notes are at `/version`. Use **Back** to return to the app. Choosing **Main** while signed in also returns you to `/`.

## Trading credentials

Poly Real needs both of these to unlock Market and Schedule:

| Field | Meaning |
|-------|---------|
| **Funder address** | Polymarket proxy / profile wallet that holds USDC for trading |
| **Private key** | EOA signer used to sign CLOB orders (encrypted at rest; not re-displayed after save) |

```demo
settings-field|Funder address|0x…|mono
settings-field|Private key|••••••••|mono
```

In-app info panels next to each field explain where to find these values on Polymarket.

## Wallet gate

If funder or private key is missing:

- Market and Schedule stay locked
- The app routes you to Settings until both are saved

## Safety notes

- Never share your private key
- Prefer starting with **Allow trade** off (demo) after saving credentials
- Confirm the funder address matches the wallet you fund with USDC

```demo
trade-toggle|Allow trade|off
```

Continue in [Getting started](doc:getting-started) and [Market](doc:market).

## See also

- [Getting started](doc:getting-started)
- [Market](doc:market)
- [Overview](doc:overview)
