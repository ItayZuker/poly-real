# Setups & phases

A **setup** is a named trading template with **3 time phases** inside each market window. Setup cards live on [Schedule / Heatmap](doc:schedule); you can also edit phases from the [Market](doc:market) chart when Auto Trade is on and **Use Schedule** is off.

## Setup cards (Schedule)

On **Schedule**, the setups list holds your templates:

| Action | What it does |
|--------|----------------|
| **Add / create** | Opens the setup editor with default 3 phases |
| **Edit** | Opens the editor (title, description, border color, phase chart) |
| **Reorder** | Drag cards in the list to change sort order |
| **Delete** | Removes the template (placements that used it are cleared) |
| **Place on grid** | Drag a setup onto Mon–Sun × UTC hours (or use day-fill helpers) |

### Setup editor fields

| Field | Meaning |
|-------|---------|
| **Title** | Name shown on the card and placements (required) |
| **Description** | Optional notes |
| **Border color** | Color swatch for the card / placements |
| **Phase chart** | Same 3-phase timeline as Market; click a phase band to edit that phase’s rules; drag the vertical split bars to change when Phase 1 / 2 / 3 start and end |

Saving the editor stores the full `phaseSplit` + all three phase configs with the setup.

## How phases work in a window

Each up/down **window** runs from start → end. The setup divides that time into **Phase 1**, **Phase 2**, and **Phase 3** using two split points (default roughly ⅓ and ⅔ of the window).

- Only the **current** phase’s buy/sell rules apply as time progresses.
- Splits are fractions of the window (0 → 1), not clock times.
- On Market, phase bands overlay the price chart; hovering a band shows a summary.

### When phases appear / are editable

| Situation | Phases on chart | Edit phase settings |
|-----------|-----------------|---------------------|
| **Auto Trade** on, **Use Schedule** off | Yes (graph setup) | Yes — click a phase band |
| **Use Schedule** on (with Auto Trade) | Yes — active schedule setup | No on Market — edit the setup card on Schedule instead (or turn off Use Schedule) |
| Auto Trade off | Usually hidden unless a setup is being shown for context | — |

## Phase settings (phase modal)

Open a phase from the chart (Market or setup editor). Each phase has its own Buy and Sell section.

### Buy

| Setting | Range / values | What it does |
|---------|----------------|--------------|
| **Allow buy in this phase** | on / off | If off, no buys are placed during this phase |
| **Shares to buy** | 1+ | Order size in shares for buys in this phase |
| **Trigger (¢)** | 1–99 | Ask / limit price in cents. Label shows **GTD** or **FAK** based on Optimize |
| **Abort on crossing** | 0–1000 | **0 = off.** Abort *unfilled* buys after this many PTB crossings *during this phase*. Cancel can arrive after a fill because of latency |
| **Optimize** | on / off | **Off → GTD** resting limit. **On → FAK** (fill-and-kill): after the trigger is touched, hunt a better (≤ trigger) fill |
| **Max gap ($)** | 0+ | Max \|asset − PTB\| in dollars. **0 = None** (no max filter) |
| **Min gap ($)** | 0+ | Min \|asset − PTB\| in dollars. **0 = None** (no min filter) |
| **Gap vs PTB** | None / With / Opposite | Direction filter relative to the side being bought (see below) |

With **Optimize** on, the trigger label shows **FAK** and Gap vs PTB may be **None**.

#### Gap vs PTB

Gap magnitude always uses **\|asset price − PTB\|**. Direction is separate:

| Value | Meaning |
|-------|---------|
| **With** | Buy Up only when asset is **above** PTB; buy Down only when **below** PTB |
| **Opposite** | Buy Up only when asset is **below** PTB; buy Down only when **above** PTB |
| **None** | Ignore direction. Allowed for **Optimize (FAK)**; with Optimize off the app keeps a directional value (defaults toward **With**) |

If min/max gap are both 0 and Gap vs PTB is **None** (FAK), buys are not blocked by gap.

### Sell

| Setting | Range | What it does |
|---------|-------|--------------|
| **Profit from buy (¢)** | 1–100 | Sell limit ≈ buy fill + this many cents. **100 = off** — hold to settlement (no sell) for fills from this phase |

## Buy place & cancel (phases)

| Mode | When placed | When cancelled |
|------|-------------|----------------|
| **GTD** (Optimize off) | When the phase starts (and gap rules allow), as a resting limit | **Phases 1–2:** ~**3 seconds before** the phase ends (so the next phase can place without waiting on cancel). Also on phase change, gap fail, buy off, fill, or **window end**. **Phase 3:** no next-phase cancel — cleared at **window end** (or fill / gap / buy off). |
| **FAK** (Optimize on) | After ask **exactly** touches the trigger (then hunts ≤ trigger) | Watch drops on phase change, abort, or after the buy fires |

GTD cancel starts early because live cancel can take about a second (sometimes longer). Starting ~3s before the boundary reduces overlap with the next phase’s resting order. The next phase **does not wait** for the prior cancel to finish; a late fill on the old order is still recorded.

## Defaults (new phase)

| Setting | Default |
|---------|---------|
| Allow buy | on |
| Shares | 10 |
| Trigger | 40¢ |
| Optimize | off (GTD) |
| Min / max gap | 0 (None) |
| Gap vs PTB | With |
| Abort on crossing | 0 (off) |
| Profit from buy | 20¢ |

## Tips

- Build and tune setups on Schedule; place them on the UTC grid; then enable **Use Schedule** + **Auto Trade** on Market.
- To tweak phases live on the Market chart without the schedule, turn **Use Schedule** off and keep **Auto Trade** on.
- Start in demo (**Allow trade** off) until the phase rules behave as you expect.

## See also

- [Schedule](doc:schedule)
- [Market](doc:market)
- [Getting started](doc:getting-started)
- [Overview](doc:overview)
