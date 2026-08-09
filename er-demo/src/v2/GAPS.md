# Closing the gap with the original game

A full cross-check of `web/index.html` (the shipped mainnet product) against `src/v2/**` produced
eight things still missing that are worth having. This is the plan for all eight, and the record of
what was deliberately left out.

The governing constraint has not changed: the original ran on an off-chain Node engine with a
Postgres ledger and a pooled custody vault; this runs on an Anchor program and nothing else. For each
gap the question is not "is it there" but **"can it be real here"**. Anything that cannot be backed is
simulated and marked `sim`, or it does not exist.

## The shared vocabulary (already landed, in `contract.ts`)

Three additions, so three workstreams can build against one agreed shape rather than three guesses:

| | what it is |
|---|---|
| `FighterView.house: boolean` | this fighter is a keeper-seated house wallet |
| `TreasuryState` | the on-chain `Treasury` PDA: `feesAccrued`, `penaltiesAccrued`, `roundsSwept` |
| `CombatEvent` | one hit, resolved to both fighters, with `mine` for toast filtering |

`houseTook()` and `grossDeposits()` were already in `contract.ts` with no callers. They get callers.

## The eight

### 1. The real house take (data + dashboard)
The program has a `Treasury` PDA and `Round.fees_collected`. `treasuryPda()`,
`program.account.treasury.fetchNullable()`, `houseTook()`, `grossDeposits()` and
`RoundSummary.feesCollected` are all written and **called by nothing**, while the Dashboard renders a
`sim` treasury out of localStorage beside them. `UI-SPEC.md` Part 1 named this exact tile: *"House
take + % — Fix. Should read the treasury account, not the counter."*

Second-order, and the reason this is not merely cosmetic: `pot` is **net of fee**, so every figure the
page calls "staked" or "deployed" understates what players were charged. `grossDeposits()` exists to
fix that.

### 2. House-bot disclosure
The keeper seats house wallets so a lobby is never empty. `keeperStatus.ts` publishes
`house.wallets`, `houseFighterCount` and `realFighterCount`, and `isHouseWallet()` is exported,
tested, and called by nothing. (An earlier draft of this doc called it `isHouseFighter()`, which does
not exist — the name was copied from the audit rather than from the file.) So a six-fighter lobby reads as six people. That helper's own comment
calls this "a misrepresentation of who is in the round", and `README.md`'s go-live list still has
`[ ] Bot disclosure in UI` open. This is an obligation, not a feature.

### 3. "All-time" over a 250-round window
`useHistory` reads the newest `MAX_ROUNDS = 250` rounds and tolerates failed reads. `SideRecord` was
built to refuse the phrase "all time" for exactly this reason — but `standings` inherits the same
window and the Leaderboard's All-time tab, the Dashboard's all-time figures and the fighter rail all
say it anyway. Nothing is wrong today, which is how this class of bug ships.

### 4. Fullscreen
`UI-SPEC.md` Part 3's first requirement is "game canvas is the hero, as large as the viewport
allows". The layout delivers that; fullscreen is what cashes it. The canvas already has a
`ResizeObserver`, so this is a button and `requestFullscreen()`.

### 5. A way back to the intro
The overlay explains the extract penalty, that Mayhem/Extraction is UI intent rather than something
the program enforces, and what `sim` means. It shows once per browser and there is no other route to
it. Dismissed once, unreachable forever.

### 6. Dead-end states
An `Abandoned` round renders an empty white field with no explanation. And `Phase::Drawing` has no
on-chain exit: if the VRF callback never lands the round is wedged permanently, and `abandon_round`
only accepts `Lobby`. Nothing on screen says either thing.

### 7. The hit log
The original narrated who took what from whom, per round and per fighter. v2 computes the identical
stream (`hitEvents`, already threaded to the canvas) and renders none of it, so you watch your number
fall and cannot find out who took it. Live round first — the stream is in memory. History second, which
needs a replay per round.

### 8. The arena's voice
Same source, different surface. Today the page speaks only about your own transactions; between
Deploy and the settled plate it says nothing to you personally. This is the biggest drop in *feel*
between the two products and the cheapest to fix once (7) exists. It needs throttling — the original
carried a comment about its own flood problem.

## Deliberately not doing

**The per-round multiplier.** No multiplier exists on chain, and the original's was partly theatre:
`rollMult` rolled up to 10× but combat applied `min(multiplier, 4)`, so the "10× round" chip quoted a
number the fight never used. Per-lineup pace and the decaying extract premium replace it with
mechanics that are real.

**The other four arenas as live.** One `Arena` PDA; `settle_sides` sums into exactly two buckets.
3-WAY and FFA are structurally impossible without a new program. `ARENAS.md` describes the off-chain
engine's nine arenas and is not a spec for this program. Keep them visible and disabled.

**Real deposits, withdrawals, faucet, custodial balances, proof of reserves, solvency.** Nothing is
custodied. The `sim` cashier is the honest maximum.

**Round anchoring / memos.** Every round *is* its own account; a memo anchoring a fact already on
chain is ceremony.

**X/Twitter identity as the fighter's face.** No account in the program has a string field, so this
could only be off-chain — and this page's own rule would then require a `sim` marker on a fighter's
face, which is the one place a marker cannot go. `nameFor(wallet)` covers readability.

**Draggable floating panels.** Replaced by the fixed, phase-aware dock and the side rail, which are
keyboard-reachable by construction and do not cover the field.
