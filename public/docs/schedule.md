# Schedule & Heatmap

Toggle **Schedule** and **Heatmap** on this page. At the bottom of the setups list, switch **Live** vs **Replay** workspace.

## Setups

Reusable templates — full fields: [Setups & phases](doc:setups-phases).

- Create, edit, reorder, delete
- **3 phases** with buy/sell rules
- Drag onto the UTC week grid to place
- Deleting a setup **always** asks for confirmation; if it is on the schedule, the prompt notes that those cards will be removed with it
- Removing a **locked** schedule card (already traded) also asks for confirmation

**Add setup** works the same in Live and Replay; each workspace stores its own setups and placements.

## Schedule grid

- Days × UTC hours
- Place or clear setups (drag or day-fill helpers)
- Current UTC cell is highlighted
- Double-click a placement to highlight it; highlighted cards feed the **Custom** header total (and still work with Heatmap)
- Header range (**Market** / **Live** / **Schedule**): **Market** = all-time confirmed totals for the selected market series; **Live** = since last header reset; **Schedule** = sum of cards on the week grid
- Counts and P/L always show numeric values (`0` / `+$0.00`) when empty — never dashes

With **Use Schedule** + **Auto Trade** on [Market](doc:market), the **Live** setup on the current cell drives trading for that series. Replay placements never trade.

## Live vs Replay

| | **Live** | **Replay** |
|---|----------|------------|
| Purpose | Real schedule for auto-trade | What-if board over recent history |
| Setups | Own list | Own list (separate from Live) |
| Placements | Own week grid | Own week grid |
| Card stats | Live trade outcomes | Filled when you press **Replay** |
| Header total | Same summary chrome (**Market** = series all-time, **Live** = since reset, **Schedule** = sum of cards) | Same — totals update as replay results arrive |

In **Replay**, a **Replay** button appears above the Live/Replay switcher. It sends the placed cards (and their setups) for the areas they cover on the week grid. Results stream back **one card at a time** (green / red / blue + PnL). The top summary shows the **total**.

The external replay worker URL is not configured yet — the UI and storage are ready; pressing **Replay** reports that the service is not configured until it is wired.

## Heatmap

Day × hour intensity from recorded windows (e.g. crossings, range). Use it to choose where to place setups — it does not trade by itself. Schedule/Heatmap and Live/Replay are independent toggles.
