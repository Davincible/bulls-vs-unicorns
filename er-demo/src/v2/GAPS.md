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

### 3. "All-time" over a retention-window log
`useHistory` reads the newest rounds **still on chain** — `historyScan.ts` walks back from
`round_counter`, stops on a short run of accounts `close_round_account` has already reclaimed, caps at
`MAX_ROUNDS` — and tolerates failed reads. `SideRecord` was built to refuse the phrase "all time" for
exactly this reason — but `standings` inherits the same window and the Leaderboard's All-time tab, the
Dashboard's all-time figures and the fighter rail all say it anyway. This used to be a bug waiting for
a 250-round arena; with the keeper reclaiming rent the window is now close to `MIN_RETAINED_ROUNDS`,
so it is a bug on any arena that has run more rounds than the chain retains.

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

**~~X/Twitter identity as the fighter's face.~~ NOW BEING BUILT — see `SOCIAL.md` and
`TWITTER-CONNECT.md`.** The original entry read: *"No account in the program has a string field, so
this could only be off-chain — and this page's own rule would then require a `sim` marker on a
fighter's face, which is the one place a marker cannot go. `nameFor(wallet)` covers readability."*

Both halves of that were right, and neither turned out to be the blocker:

- **Off-chain, yes, and deliberately so.** `TWITTER-CONNECT.md` §3.5 considered an on-chain PDA
  register and rejected it *with regret*, on irreversibility rather than on space: a link is a fact
  settled until Tuesday, and the chain is for facts settled forever. The mapping lives behind
  `/api/links`, and every record is delivered with a detached ed25519 signature the browser verifies
  (`data/xLink.ts`), so the API is trusted for **availability** rather than for correctness. It can
  withhold a link. It cannot invent one.
- **The marker problem dissolved rather than being overruled.** This entry was correct that a `SIM`
  marker cannot go on a face. The resolution (`SOCIAL.md` §2.6) is that an identity is not a
  money-shaped figure, so the honest question is not "is this chain-derived" but "who verified it" —
  and that is answered by a sentence rather than a badge.
- **`nameFor(wallet)` still covers readability, and remains the main path.** Most players never link;
  unlinked renders as the side's coin face plus a pseudonym, which is a complete rendering and never
  an error state. An avatar *replaces* something rather than filling a hole.

The one thing the original entry did not anticipate is the reason the feature was worth the care it
got: the previous build already had X Connect, with real OAuth — and a `prompt("Your X handle")`
fallback beside it that wrote an indistinguishable record, so typing a handle put that person's real
name and photograph on your fighter. The new design's job was never to add a proof; it was to make
the **absence** of one unrepresentable.

**Draggable floating panels.** Replaced by the fixed, phase-aware dock and the side rail, which are
keyboard-reachable by construction and do not cover the field.
