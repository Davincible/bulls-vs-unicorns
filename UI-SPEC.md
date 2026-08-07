# Dashboard rebuild + UI overhaul — product spec

Written from the stats the engine **actually** exposes today, not from what the current dashboard
claims to show. Several existing tiles are wrong or unbacked; those are called out and dropped
rather than restyled.

---

## Part 1 — Audit of what exists

### Data the engine really has

| Source | Field | Trustworthy? |
|---|---|---|
| `/standings` | `rounds, wins, staked, returned, pnl, roi, tokNet` per wallet | **Yes** — from the permanent round log, survivorship-free, on-chain anchored |
| `/float` | per token: `pool, bots, treasury, real, open, trueTotal` + `chain` | **Yes** |
| `/solvency` | per asset: `liability, holdings, ok, shortfall` | **Yes** |
| `/memo` | `posted, failed, queued, lastSig` | **Yes** |
| `roundHistory` | every settled round, every player's in/out, `sig` | **Yes** |
| `state.leaders` | live balances | **No** — survivorship-biased, mid-round reads ~0 |
| `treasury[mode]` | USD counter | Partly — now backed by a real account, but the counter and the account can drift |

### Current dashboard tiles — verdict

| Tile | Verdict |
|---|---|
| Total deployed · Bulls / Unicorns | **Keep, rename.** "Bulls/Unicorns" is wrong in a UWU/SOL arena — must be the live token names |
| Match wins · Bulls / Unicorns | Keep, rename per arena |
| House take + % | **Fix.** Should read the treasury *account*, not the counter |
| Accounts / created / busted | **Drop.** Bot lifecycle noise; means nothing to a player |
| Total deposited / returned | **Fix.** Currently mixes units; use `/standings` totals |
| Net P/L | **Fix.** Same unit problem |
| All-time total ≈ 9,000 | **Drop.** Not a real figure — this is what prompted "that does make sense" |
| Damage · Bulls / Unicorns | **Replace** with per-currency stolen |
| Hall of Fame | Keep, one line per row |
| Battle report | **Rebuild** — currently stale and per-session only |

### Bugs to fix in place
1. **ROI on a profile ≠ ROI on the leaderboard** — profile computes locally from balances, leaderboard from the round log. One source: `/standings`.
2. **"Big wins" ticker shows losses.** It is a *wins* ticker.
3. **Ticker overlays the sliding winners bar** (z-index/stacking).
4. **"Staked all time" labelled BULL while playing UWU/SOL.** BULL is ANSEM's label and must never appear in a UWU/SOL arena.
5. **Stolen "all session"** should be **all-time**, per currency, by side.
6. **Verify "deployed"** against `/standings.staked`.

---

## Part 2 — The dashboard to build

Three bands, in descending order of "would a player care".

### Band A — The arena right now
One hero figure, four tiles.

- **Hero:** total on the table this round, `$X across N fighters`
- `THIS ROUND` · pot, fighters, seconds left
- `LAST ROUND` · winner, pot, link to its on-chain anchor
- `HOUSE FLOAT` · `/float.trueTotal` in USD, split per token
- `BACKING` · `/solvency` coverage, true ratio, green when `ok`

### Band B — Your position
Only when a wallet is connected. Everything from `/standings` filtered to that wallet, so it can
never disagree with the leaderboard.

- `YOUR P&L` — **dollars AND coins**, side by side. The coin figure is the honest one: dollars alone
  conflate winning rounds with the token pumping.
- `ROUNDS PLAYED` · W/L
- `IN THE RING` · `balance.inRingUsd`
- `BEST ROUND`

### Band C — The house
- **Deployment split bar** — per side, named by the live tokens
- **Stolen bar** — per currency, all-time. These are *different currencies*; never sum them
- `TREASURY` — from the treasury account, both tokens, with the fee rate stated
- `ANCHORS` — memos posted / failed, link to the latest

### Rules
- Every figure names its unit. No bare numbers.
- Token names come from the arena, never hardcoded.
- Nothing derived from live balances — round log only.
- A figure with no backing data shows `—`, never `0`.

---

## Part 3 — UI overhaul prompt

> Redesign the layout of **Bulls ⚔ Unicorns**, a real-money Solana arena game. Keep the existing
> dark palette (near-black `#0a0a10`, green `#18e08a`, purple `#c46bff`, gold `#ffc048`) and the
> mono/sans pairing. This is a layout and information-architecture change, not a reskin.
>
> **The problem:** the game canvas is the product, but it is squeezed between two fixed side panels,
> and the controls a player uses every round (deploy, wallet) are the furthest things from it. The
> top bar wraps badly and the wallet is stranded on the left.
>
> **Required layout**
> 1. **Game canvas is the hero** — as large as the viewport allows, centre stage.
> 2. **Deploy and Wallet become floating, draggable panels** over/beside the canvas. Remember
>    position per user (localStorage). Snap to edges, collapse to a title bar, never cover the
>    centre of the arena by default. Deploy opens bottom-right, Wallet top-right.
> 3. **Top bar on two lines:** line 1 = brand, arena picker, mode; line 2 = round state, timer, fair
>    badge. **Wallet summary pinned top-right**, never left.
> 4. **Round standings sit above previous rounds**, both directly under the canvas.
> 5. **Big-wins ticker gets its own stacking context** so it can never overlay the winners bar.
> 6. **Hall of Fame rows are one line each** — rank, name, deposit → final, return.
>
> **Constraints**
> - Must work at 1280×800 and degrade to a single column on mobile.
> - Draggable panels need a keyboard-accessible fallback (a dock/undock control).
> - No new external dependencies — the page is self-contained by design, and stays that way.
> - Every money figure carries its unit and its token name.
>
> **Tone:** a trading terminal that happens to be a game. Confident, quiet, dense with real numbers.
> Not a casino. Restraint reads as trustworthy, and this product handles real money.

---

## Part 4 — Suggested order

1. Fix the wrong figures (label bugs, ROI source, stolen totals) — **cheap, and they are lies today**
2. Rebuild the dashboard to Part 2
3. Top bar two lines + wallet top-right + standings order — **layout, no new mechanics**
4. Ticker stacking fix
5. Floating draggable panels — **biggest change, do last**
