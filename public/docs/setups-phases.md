# Setups & phases

A **setup** is a template with **3 time phases** inside each market window. Manage setups on [Schedule](doc:schedule). On [Market](doc:market), edit phases on the chart when **Auto Trade** is on and **Use Schedule** is off.

## Setup editor

| Field | Meaning |
|-------|---------|
| **Title** | Name on cards and placements (required) |
| **Description** | Optional notes |
| **Border color** | Card / placement color |
| **Phase chart** | Drag split bars for phase timing; click a band to edit that phase |

## How phases work

The window is split into Phase 1 → 2 → 3 (default ~⅓ and ~⅔). Only the **current** phase’s rules apply. Splits are fractions of the window (0 → 1), not clock times.

| Situation | On chart | Edit on Market chart |
|-----------|----------|----------------------|
| Auto Trade on, Use Schedule off | Graph setup | Yes |
| Use Schedule on | Active schedule setup | No — edit the setup on Schedule |
| Auto Trade off | Usually hidden | — |

## Buy

| Setting | What it does |
|---------|--------------|
| **Allow buy** | Off = no buys in this phase |
| **Shares** | Order size |
| **Trigger (¢)** | Limit / ask trigger (1–99). Label is **GTD** or **FAK** from Optimize |
| **Abort on crossing** | Abort *unfilled* buys after this many PTB crossings in the phase. **0 = off** |
| **Optimize** | Off = **GTD** resting limit. On = **FAK**: after exact trigger touch, hunt ≤ trigger |
| **Min / max gap ($)** | Filter by \|asset − PTB\|. **0 = none** |
| **Gap vs PTB** | Direction filter (below) |

### Gap vs PTB

| Value | Meaning |
|-------|---------|
| **With** | Buy Up only above PTB; Down only below |
| **Opposite** | Buy Up only below PTB; Down only above |
| **None** | Ignore direction (FAK only; GTD keeps a direction, default **With**) |

## Sell

| Setting | What it does |
|---------|--------------|
| **Profit from buy (¢)** | Sell ≈ fill + this many cents. **100 = off** (hold to settlement) |

## When buys place and cancel

| Mode | Placed | Cancelled |
|------|--------|-----------|
| **GTD** | Phase start, if gap allows | Phases 1–2: ~**3s before** phase end (next phase can place without waiting). Also gap fail, buy off, fill, or **window end**. Phase 3: at **window end** (or fill / gap / buy off) |
| **FAK** | Ask hits trigger **exactly**, then hunts ≤ | Phase change, abort, or after the buy |

Early GTD cancel (~3s) covers typical live cancel latency. A late fill on a cancelled order is still recorded.

## Defaults (new phase)

Allow buy on · 10 shares · 40¢ · GTD · gaps none · Gap **With** · abort off · profit 20¢
