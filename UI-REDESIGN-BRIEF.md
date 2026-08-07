# Bulls ⚔ Unicorns — UI redesign brief

For a fresh rebuild of the front end. Not a reskin, not more CSS on the current layout.
The product is a **real-money mainnet Solana game**; the interface currently reads as a prototype,
and that is the gap to close.

---

## Part 1 — What is actually wrong today

Observed, not assumed. Each of these is visible in the live build.

### Layout
1. **The canvas is not the hero.** The arena — the entire product — is squeezed between two fixed
   side panels. The controls a player uses every single round (Deploy, Wallet) sit furthest from
   where they are looking.
2. **Five stacked bands before the game.** Brand → arena/mode pickers → nav+status → ticker →
   RPC banner. The fold is consumed before anything happens.
3. **The arena and mode pickers render as unreadable icon soup** — token glyphs at ~11px with no
   labels, several falling back to tofu boxes. A player cannot tell which arena they are in from
   the picker; they have to read the "UWU vs SOL" pill elsewhere.
4. **Dead space.** The right of line one is empty except a single stray control.

### Information architecture
5. **The dashboard still shows pre-engine figures.** "TOTAL DEPLOYED · BULLS" and "MATCH WINS ·
   BULLS" appear while the live arena is UWU vs SOL. BULL is ANSEM's label and must never appear
   in an arena it is not part of.
6. **"STOLEN ALL SESSION" is captioned "ALL-TIME"** on the tiles beneath it. One of the two is a lie.
7. **Bot lifecycle noise is presented as product stats** — "42,207 accounts created", "42,074 busted
   (went broke)". This is house plumbing. To a player it reads as 42,000 people losing their money.
8. **Fighter rows show a token net with no currency framing** — "−46.34 UWU · +1.25 SOL" next to
   "−$0.05" invites the reader to think they conflict when they do not.

### Trust
9. Nothing on screen explains **why the house has bots**, how they are funded, or that they are
   funded only between rounds. For a real-money product this is the single most important thing to
   say plainly, and it is currently said nowhere.
10. The footer still says **"Prototype · saved locally"** on a live mainnet product.

---

## Part 2 — Principles

- **A trading terminal that happens to be a game.** Confident, quiet, dense with real numbers.
  Not a casino. Restraint reads as trustworthy, and this product handles real money.
- **Every figure names its unit and its token.** No bare numbers. The house has already shipped two
  separate unit bugs (SOL-as-USD, tokens-as-dollars); the UI must make that class of error visible.
- **One source per fact.** If two panels can disagree, one of them is wrong. P/L, ROI and round
  counts come from the engine round log (`/standings`) and nowhere else.
- **A figure with no backing shows `—`, never `0`.** Zero is a claim.
- **Token names come from the live arena**, never hardcoded.

---

## Part 3 — Required layout

```
┌──────────────────────────────────────────────────────────────────────┐
│ line 1   brand · arena picker (NAMED) · mode          wallet summary │
│ line 2   round state · timer · fair badge · house float              │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│                   ARENA CANVAS — as large as fits                    │
│                                                                      │
│      ┌──────────────┐                        ┌──────────────┐        │
│      │ WALLET       │  floating, draggable   │ DEPLOY       │        │
│      │ collapsible  │  snap to edges         │ collapsible  │        │
│      └──────────────┘                        └──────────────┘        │
├──────────────────────────────────────────────────────────────────────┤
│ round standings                                                      │
│ previous rounds (expandable, each linking to its on-chain anchor)    │
└──────────────────────────────────────────────────────────────────────┘
```

1. **Canvas is the hero** — as large as the viewport allows, centre stage.
2. **Deploy and Wallet float over/beside the canvas**, draggable, position remembered per user
   (localStorage), snap to edges, collapse to a title bar, never covering the centre by default.
   Deploy opens bottom-right, Wallet top-right.
3. **Arena picker shows names**, not bare glyphs: `UWU vs SOL`, `ANSEM vs UWU`. Icon plus text.
4. **Standings sit above previous rounds**, both directly under the canvas.
5. **The big-wins ticker gets its own stacking context** and an opaque label, so it can never
   overlay the winners bar or have the marquee slide through its own label.
6. **Hall of Fame rows are one line** — rank, name, deposit → final, return.

---

## Part 4 — The dashboard to build

Three bands, in descending order of "would a player care".

**Band A — the arena right now**
Hero figure: total on the table this round, `$X across N fighters`.
Then: `THIS ROUND` (pot, fighters, seconds) · `LAST ROUND` (winner, pot, link to its anchor) ·
`HOUSE FLOAT` (USD, split per token) · `BACKING` (solvency coverage, green when ok).

**Band B — your position** (only when connected; all from `/standings`, filtered)
`YOUR P&L` in **dollars AND coins side by side** — the coin figure is the honest one, dollars alone
conflate winning rounds with the token pumping · `ROUNDS PLAYED` W/L · `IN THE RING` · `BEST ROUND`.

**Band C — the house**
Deployment split bar, named by the live tokens · raided bar per currency, all-time (these are
*different currencies*; never sum them) · `TREASURY` with the fee rate stated · `ANCHORS`
(memos posted/failed, link to latest).

**Drop entirely:** accounts created / busted, all-time totals with no backing, any "BULLS/UNICORNS"
label in an arena those tokens are not in, "all session" figures captioned "all-time".

---

## Part 5 — Mainnet-readiness (non-negotiable)

1. Remove **"Prototype · saved locally"**. It is live and custodial.
2. **A visible fairness panel**: commit hash before deploys open, seed revealed at fight start, a
   one-click recompute, and a link to the on-chain anchor for any past round.
3. **A plain-English house disclosure**, permanently reachable, saying:
   - the house fields its own fighters, funded from a house float
   - **they are funded only between rounds, never mid-fight**
   - the house takes 0.2% of deploys and 0.3% of converts
   - the matched book slightly favours smaller positions
   - balances are custodial, held by the engine against an on-chain vault
   This is a selling point when stated plainly and an accusation when discovered.
4. **Solvency visible to players** — coverage ratio from `/solvency`, not buried.
5. **Every money figure carries its unit and token.**
6. Error and refusal states must be legible: frozen withdrawals, stale price feed, closed deploys.

---

## Part 6 — Constraints

- Works at **1280×800**, degrades to a single column on mobile.
- Draggable panels need a **keyboard-accessible** dock/undock control.
- **No new external dependencies.** The page is self-contained by design and stays that way — a
  strict CSP is in force and the one CDN script is pinned by SRI.
- Keep the palette: near-black `#0a0a10`, green `#18e08a`, purple `#c46bff`, gold `#ffc048`,
  mono/sans pairing.
- Canvas floaters must not drift into DOM chrome.

---

## Part 0 — PREREQUISITE: one ledger, engine-side only

The client carries a parallel ledger from the pre-engine local-sim era, persisted in localStorage
and layered UNDER the engine data rather than replaced by it. That is what produced three different
P/L figures for one wallet with three different round counts. Rebuilding the UI on top of it would
rebuild against numbers that are about to be replaced, so this comes FIRST.

**Engine endpoints — DONE, these were the blockers:**
- `/standings` — per-wallet record (rounds, wins, staked, returned, pnl, roi, best, tokNet)
- `/hall?limit=N` — best single-round returns across all wallets, dust-filtered
- `/history?id=WALLET&limit=N` — every round one wallet played, with P/L and result
- `/float`, `/solvency`, `/memo` — house float, backing, anchors

**Client state to DELETE (ref counts at time of writing):**

| symbol | refs | replace with |
|---|---|---|
| `w.accounts` | 14 | `/standings` |
| `INVESTED` | 10 | `/standings.staked` |
| `w.legends` | 8 | `/hall` |
| `w.dep` | 8 | `house.depBull` / `house.depUwu` |
| `w.stolenAll` | 5 | `statsA.stolenA/stolenB` |
| `w.matchWins` | 5 | `statsA.winsA/winsB` |
| `w.raidCount` | 4 | round record |
| `userWorth()` | 3 | `/standings.pnl` |

**Acceptance:** no money or record figure is computed in the browser. Every one traces to an engine
endpoint. Two panels showing the same fact must read the same field, not merely agree today.

**Note on testing this:** unit tests are not enough on their own here. I wrote `/hall` against
`in`/`out` when the record carries `inUsd`/`outUsd`; it matched nothing and served an empty list,
and the tests passed because the fixtures used the same wrong names. Cross-check every new reader
against `standingsFromLog` over the same log — if the fields diverge, the totals disagree.

---

## Part 7 — Order of work

0. **One ledger (Part 0)** — prerequisite; everything below renders numbers that come from it
1. Kill the wrong figures (labels, unit captions, dropped tiles) — cheap, and they are lies today
2. Rebuild the dashboard to Part 4
3. Two-line top bar, named arena picker, wallet top-right
4. Standings above previous rounds; ticker stacking
5. Floating draggable panels — biggest change, do last
6. Mainnet disclosure + fairness panel before any public launch
