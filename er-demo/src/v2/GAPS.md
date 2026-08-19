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

### 2. House-bot disclosure — **WITHDRAWN, and the concept removed with it**
This gap was built and has since been deleted, which is a different outcome from either "done" or
"dropped" and is worth the paragraph.

**WHAT THIS ENTRY USED TO SAY, VERBATIM.** A reversal that erases the sentence it reversed is
indistinguishable from a rule nobody ever wrote, so the promise stays on the page:

> The keeper seats house wallets so a lobby is never empty. `keeperStatus.ts` publishes
> `house.wallets`, `houseFighterCount` and `realFighterCount`, and `isHouseWallet()` is exported,
> tested, and called by nothing. (An earlier draft of this doc called it `isHouseFighter()`, which
> does not exist — the name was copied from the audit rather than from the file.) So a six-fighter
> lobby reads as six people. That helper's own comment calls this "a misrepresentation of who is in
> the round", and `README.md`'s go-live list still has `[ ] Bot disclosure in UI` open. **This is an
> obligation, not a feature.**

**THE OWNER WITHDREW IT.** Not an engineer, not a refactor, not something that fell off a backlog: a
decision about what this product says about itself, taken by the person entitled to take it, and
written down here on the day it was taken. The wallets are not deleted and not denied — they are
INTERNAL. We have them; we do not talk about them. Everything below follows from that one sentence,
and anyone who later reads the block above as an abandoned promise should read this paragraph as the
answer rather than reopening it.

It was built as described: the keeper published `house.wallets` and a disclosure sentence, the browser
resolved each fighter against that list, and every surface that named a fighter said which ones were
the arena's own. It worked. What changed is not the UI but the product decision underneath it — the
arena's own wallets are anonymous and are not published, named, or counted anywhere a browser can
read. There is therefore nothing left for a page to disclose *from*, and the front end has no basis
for the concept at all.

**The removal had to be total, and that is the part worth recording.** A `house: false` field left
behind on a fighter would read as "checked, and this one is a person" — a stronger claim than the
disclosure ever made, made with no evidence, on every row. Likewise "0 house" in a caption. A concept
this shape cannot be half-removed: it goes completely or it lies. So `FighterView.house`, the counts,
the tag, the captions and the fixture's own invented house all went in one pass, and
`KEEPER_STATUS_SCHEMA` was bumped to 5 with a **hard reject** so that a not-yet-redeployed keeper's v4
file cannot be fetched or cached by a page built after the change — making the removal a property of
the system rather than a habit of the UI.

What survives is the one rule that was never about disclosure: **a face means a person.** The arena's
wallets may not wear one. That is enforced on the server at both ends of a link's life —
`/api/x/link` refuses to create such a link, `/api/links` refuses to serve one — and the client-side
third guard is gone, because a browser that cannot read the list cannot check it.
`data/linkFighters.ts`'s header carries that argument where the guard used to be.

**AND THE PROTECTION THAT NEVER LIVED IN THE BROWSER AT ALL, WHICH IS THE SUBSTANTIVE ONE.** The
keeper's internal classifier (`houseBank.classify`) is untouched, and it still drives the treasury
rule: a lobby with nobody real standing in it holds **exactly one** of the arena's own fighters —
fixed at 1 in `houseSizing.ts`, deliberately without a knob, because a knob whose only safe value is
1 is a way to lose the rule by typo — and one is below the program's `enough_to_fight`. So a
house-only room cannot be drawn into a fight by this keeper *or* by a permissionless caller: the
chain refuses it, rather than a process promising not to. `abandon_round` stays legal, so such a
round still terminates instead of wedging.

That is worth stating plainly next to a withdrawn disclosure, because the two are easily confused.
Disclosure was always the weaker half of "the house does not play itself" — it told you what had
happened. The half that is *enforced*, on chain, never depended on publishing the list to anybody,
and it did not move. The identity API's refusal is the same shape: it still declines to put a
person's face on one of these wallets, at both ends of a link's life, and it does that by reading the
roster over an authenticated channel rather than by the browser having been told.

**THE LOOSE END, NAMED RATHER THAN TIDIED.** The withdrawn text above cites "`README.md`'s go-live
list still has `[ ] Bot disclosure in UI` open". That citation was never to a file in this directory:
`er-demo/README.md` is the stock Vite template and has no go-live list at all. The line is in the
MONOREPO ROOT `README.md` (line 76 — `- [ ] Bot disclosure in UI; throttle-down plan`), and it is
**still open**. It is now open against a requirement that no longer exists, which is worse than
stale: to anyone working that checklist it reads as an outstanding obligation, which is precisely the
misreading this section exists to prevent. The root README is outside this directory and was not
edited from here. Somebody with it in scope should close that box and point the line at this section.

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

> **2026-08-19 — the third bullet is superseded.** `nameFor(wallet)` is deleted, so it covers nothing
> and there is no pseudonym: an unlinked row's name slot is empty, and the truncated address on the
> row is what identifies it (`data/namePlate.ts`). The bullet's conclusion is untouched — unlinked is
> still the main path, still a complete rendering rather than an error state, and an avatar still
> replaces something rather than filling a hole. Only the thing carrying readability changed, from a
> generated word to the address, which is a fact a reader can check. The rule is linked versus
> unlinked and is applied identically to every wallet on the page. The verbatim quotation higher up
> keeps its `nameFor(wallet)` sentence exactly as written: it is the record of what this entry once
> said, and a corrected quotation would be no record at all.

**Draggable floating panels.** Replaced by the fixed, phase-aware dock and the side rail, which are
keyboard-reachable by construction and do not cover the field.
