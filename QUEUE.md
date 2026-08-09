# Work queue — Bulls ⚔ Unicorns

Worked top to bottom. Anything blocked or needing a decision moves to **PARKED** rather than
stalling the run.

`[ ]` todo · `[~]` in progress · `[x]` done · `[!]` parked

---

## A. Money correctness — wrong on screen right now

- [x] **A1. P/L wrong (−$8.17 instead of ≈−$0.78).** `priceUSD` returns null once a quote is 5
      minutes old, so `usdPer` collapsed to 0 and valued a $3.68 UWU balance at nothing. The engine
      already keeps a last-good price for settlement; the ledger now does too, or the two disagree.
- [x] **A2. SOL wallet shown twice.** Cells were painted `(sideA, sideB, sol)` — in UWU/SOL, sideB
      *is* sol. The third cell now shows whichever token is not in this arena.
- [ ] **A3. In-ring size reads $0** while money is staked. `w.userCircles` is only populated when a
      round starts with your entry; a mid-round join or reconnect leaves it empty.
- [ ] **A4. Wire `/standings` into the Leaderboard tab.** Engine already derives survivorship-free
      standings from the round log; the UI still reads live balances — the view that made everyone
      look unprofitable. **Biggest correctness win left.**
- [ ] **A5. Battle report shows stale/zero figures**; all-time stolen totals not wired.

## B. Gameplay

- [x] **B1. Fighters hunted their own wallet.** Clashes were already harmless (friendly-fire keys on
      the wallet) but targeting only skipped same *side*, so a bot fielding both armies chased
      itself around the arena — indistinguishable from self-dealing to anyone watching.
- [ ] **B2. Verify normal engagement still works** after B1: opposing fighters from *different*
      wallets must still converge and clash as before. B1 must not have made anyone passive.
- [ ] **B3. Sub-cent damage on screen.** `fmt` renders 3dp below a cent, but confirm floaters and
      the standings rows actually show `$0.001` rather than rounding to `$0.00`.
- [ ] **B4. Auto-deploy is unreliable** — fires some rounds, not others. **Fixed in `er-demo/src/v2/`
      (`data/autoDeploy.ts`); still open in `web/index.html`, which carries its own repeat control.**
      Four causes, all real, all reproduced: a failed deploy marked the round done *before* awaiting
      the transaction, so any failure dropped that round for good; the rule lived inside the Deploy
      panel, which the screen switch unmounts, so reading the Leaderboard silently disarmed it; the
      armed amount was read from a control that reset on that same unmount; and — the root cause —
      `phase === "Lobby"` is not "you can deposit", because the program refuses `enter` from
      `lobby_closes_at` while the phase only moves when an operator's `close_lobby_and_draw` lands.
      Whichever of those the old stack shares, port the shape rather than the patch: the rule is a
      pure function (`decideAutoDeploy`) with 41 tests, because "fires some rounds" is a claim about
      a distribution and one run cannot answer it.
- [ ] **B5. Auto-deploy must always fire at the START of a round**, not mid-lobby. **Fixed in v2;
      still open in `web/`.** Arming never deposits into the round already on screen — it names the
      round it will start from — and once armed it deposits within a second or two of a new lobby
      opening. Measured on devnet: 1s, 2s, 1s after lobby-open across three consecutive rounds.
- [ ] **B6. Reactive whale response.** Bots currently match only at the moment a player enters. They
      should keep watching the book and *raise* if a whale enters after them — overage is refunded
      by the matched book anyway, so there is no downside to over-committing.
- [ ] **B7. Queue deposits during a live round.** Deposits are lobby-only, which is a narrow window;
      they should queue and apply at the next lobby.
- [ ] **B8. Server-side auto-deploy** so it keeps playing with the tab closed.

## C. UI backlog

- [ ] **C1. Previous rounds under the arena page** (currently only in History).
- [ ] **C2. History rows do not expand** when clicked.
- [ ] **C3. Solscan link + timestamp per history row.**
- [ ] **C4. X share button on one line.**
- [ ] **C5. Second bar: stolen vs deployed.**
- [ ] **C6. Profile viewer** (click a fighter → their record).

## D. Operational

- [ ] **D1. Auto-rebalance the pool when the vault's token mix changes on-chain.** A convert moves
      the vault but not the ledger pool, so float silently strands. This has needed a manual
      `RESYNC_POOL_ON_BOOT` **three times** — it should be automatic.
- [ ] **D2. Separate operator fee-payer wallet** so network fees never touch player-backed SOL.
      Needs a funded keypair.
- [ ] **D3. Full seed in the memo** (currently 16 hex chars — enough to anchor, not to recompute).

---

## PARKED — needs a decision, or something I cannot do

- [!] **P1. Add float.** ~$104 supports the current arena. More would allow bigger lobbies. Max's
      call, not a code change.
- [!] **P2. Fee-payer keypair** (D2) — needs Max to fund a wallet.
- [!] **P3. Mainnet canary** — deposit → play → convert → withdraw with real money, to exercise the
      genuine Jupiter swap. Only Max can spend the funds.

---

## Done this session (for the dev log)

Money: unit-mixing root cause (`bull + uwu + sol` summed token counts with dollars) · treasury made
a real account so fees stop un-booking the vault · cross-decimal swap under-crediting 1000× · one
price per round · shutdown refunds open stakes · OTC liquidity cap · anchoring fees charged to the
house, not the float.

Anchoring: on-chain memo per round, human-readable, anonymised, constant-size via a results hash
(235 bytes at 200 players) · compute-budget fix that had silently killed 14 anchors.

Arena: rounds went from 3 fighters to 6–15 · swarm matching in uneven slices · bots fight for the
coin they hold and may take either army · self-attack and self-targeting closed · round numbering
and match history survive restarts · standings derived from the permanent round log.

**201 tests.**
