# What the arena costs to run

Measured 2026-08-14 against v8 (`ECD1dX2fUSGVY25y2cHWHWXYUQr9XzfFdTxcMzHj7zKe`) on devnet, at
`MAX_FIGHTERS = 48`. Every figure below has a command that produced it; where a number is derived
rather than observed it says so, and where it is *unobserved at the current scale* it says that too —
which is the case for the single most important one.

The question this answers: **what does it cost to run games continuously, with no real players?**

---

## 0. The answer, and the number that is 330× larger

**Steady state: ~0.178 SOL/day.** ~5.4/month, ~65/year, at 424 rounds/day.

> **CORRECTED 2026-08-15, and the original figure was wrong by 6x.** This said ~0.030 SOL/day on the
> strength of §1's "only the fees are spent". Measured against 206 unattended rounds of continuous
> running: **420,108 lamports/round**, agreeing to 0.03% with the keeper's own burn brake (420,000).
> The cause is not fees — it is delegation, and §1 had it filed as float. See §1.1.

**Gross flow: ~11.4 SOL/day.** Almost all of it returns. It nets to the figure above *only while rent
reclamation keeps working*.

**If reclamation stops: ~9.96 SOL/day, permanently.** At a 14.95 SOL balance that is about 36 hours.

The distance between 0.178 and 9.96 is the whole risk, and §4 is about nothing else. (It was
written as "0.03 and 9.96"; the left-hand number was wrong by 6x — §1.1 — and the risk it describes
is unchanged, because a reclamation outage adds rent to the burn regardless of what the burn was.)

---

## 1. What one round actually costs

Measured from v8 round #1, a real fight with 44 fighters:

```
node -e '…getSignaturesForAddress(roundPda)…'   →  5 base-layer transactions
                                                   0.000073 SOL in fees
                                                   0.023497 SOL rent still held
```

Sampling 25 operator transactions for what actually leaves the wallet:

| Instruction | Leaves the operator | Comes back |
|---|---|---|
| `OpenRound` | **0.023502 SOL** | at `close_round_account`, 20 rounds later |
| `DelegateRound` | **0.003221 SOL** | **only 0.002816 of it** — see §1.1 |
| ~5 transactions of fees | **~0.00007 SOL** | **never** |
| **Total out** | **~0.0268 SOL** | |

**This table used to end "Only the fees are spent. Everything else is float." That is false, and it
is the single largest error this document has made.** See §1.1.

### 1.1 Delegation is not free, and it is the whole operating cost

`DelegateRound` pays an escrow and `ProcessUndelegation` returns it — but **not all of it**. Measured
on three consecutive rounds, byte-identical each time rather than varying:

```
DelegateRound         operator delta   -3,220,520 lamports   (x3, identical)
ProcessUndelegation   operator delta   +2,815,520 lamports   (x3, identical)
                                        ───────────
                      NOT RETURNED         405,000 lamports/round   = 0.000405 SOL
```

That is **96% of the arena's entire running cost**, and the old model classified it as float because
it saw money go out at delegation and come back at undelegation without comparing the two numbers.

```
delegation, unreturned    405,000 lamports/round      0.172 SOL/day
transaction fees           ~15,000                    0.006 SOL/day
------------------------------------------------------------------
measured total            420,108 lamports/round      0.178 SOL/day
```

The reconciliation that makes this trustworthy rather than a plausible story: **the operator wallet
fell 0.0865 SOL across rounds 37 → 243**, which is 420,108 lamports/round, and the keeper's burn
brake — computed independently, from balance readings straddling each `open_round` — reports 420,000.
Two instruments, one number, 0.03% apart.

**Transaction count was never the problem.** 200 consecutive operator transactions span 136.8
minutes at 1.5/min, which is **exactly 5.0 per round** — precisely what §1 claims — with **zero
failures**. The model counted the right transactions and mispriced one of them.

**What this does not change:** the arena is still cheap and still sustainable. At 24.45 SOL the
runway is ~137 days (the keeper reports 141), and the reclamation mechanism §4 is about still works —
rent genuinely does come back, 220 times and counting. What changes is that "essentially free" was
never true, and anyone sizing a mainnet deployment off the old figure would have been out by 6x.

### Why only five transactions

A 44-fighter round costs five base-layer transactions: `OpenRound`, `DelegateRound`,
`ProcessUndelegation`, `SweepHouseTake`, and one more. The forty-four `enter` calls, every `tick` and
the `resolve` all execute **inside the ephemeral rollup**, and none of them touches the base layer.

That is the MagicBlock economics doing exactly what it is for, and it is worth stating as a number:
**a fight with 44 participants costs the same five transactions as a fight with two.**

### The house wallets do not spend

Checked directly rather than assumed, because "they are at exactly 0.01" could equally mean "the
keeper just refilled them":

```
house wallet 0: HmgphzstA3jMwrfPMv2JrHKNF8vk4M9vHxsigWkjwbZS
base-layer transactions touching it: 1     (its funding, 2026-08-09)
balance: 0.010000 SOL                       (target 0.010000)
```

One transaction, ever. It has played rounds since. So ER entries cost the house wallets nothing
measurable, and no refill has been needed in five days.

---

## 2. The cadence

Continuous play needs hold-open off and a fixed cadence. From the constants and the program's own
measured fight-length table (400 seeds per lineup, `lib.rs`):

```
lobby        60s     DEFAULT_LOBBY_SECONDS
fight       124s     median at n=48; 76.2% conclude before the 180s bell
result hold  12s     RESULT_HOLD_SECONDS
overhead      8s     draw, undelegate, sweep round-trips
-----------------
cycle       204s  →  424 rounds/day
```

At 424 × 0.000420 SOL (the MEASURED per-round burn, not the fee estimate this line used to
multiply): **0.178 SOL/day**. §1.1 has the derivation and the reconciliation.

Fight length is the term that moves with the seat cap. At n=16 the median was 83s and the cycle would
be ~163s — 530 rounds/day and a slightly *higher* daily fee bill, because the rounds are shorter.
Bigger boards are cheaper per day, not dearer.

---

## 3. Working capital

Distinct from burn. This is money parked, not spent:

| | |
|---|---|
| Rent float — 20 rounds × 0.023497 (`MIN_RETAINED_ROUNDS`) | **0.470 SOL** |
| Delegation escrow, one round outstanding | 0.003 SOL |
| House wallets, 48 × 0.01 | **0.480 SOL** |
| **Standing total** | **~0.95 SOL** |

The retention window is counted in ROUNDS, not time — so at 424 rounds/day, twenty rounds is
sixty-eight minutes, and the float does not grow with the cadence.

---

## 4. The failure mode, which is the only part that matters

Everything above rests on `close_round_account` reclaiming 0.023497 SOL per round. It closes **one
round per keeper pass at 1 Hz**, blocked only during a live fight (`housekeepingIsWelcome`). A
204-second cycle spends ~136s in fight-and-hold, leaving ~68 seconds of housekeeping per round —
room for roughly 68 closes where one is needed. **Throughput is not the risk.**

The risk is that closing *fails*, and it already does, in three known ways:

1. **`CLOSE_ATTEMPTS_PER_ROUND = 3`.** After three failures the cursor steps past a round and never
   returns to it. That is deliberate — one unfixable round must not block every older one — and every
   skip is 0.023497 SOL gone permanently.
2. **A round stuck in `Lobby` can never be closed.** `close_round_account` requires `house_swept`, and
   sweeping requires a terminal phase. There are **19 such rounds** from before hold-open landed,
   holding ~0.16 SOL that no instruction will ever return.
3. **A round still delegated cannot be closed at all** — the Delegation Program owns the account. If
   an ER validator dies mid-round, that rent waits for the backstop. Note that forced undelegation
   exists in the delegation program's v3.1.0 API but is **not deployed on the devnet we run on**
   (verified twice: ProgramData ~4 months stale, and a `simulateTransaction` probe with a control).

**At 424 rounds/day, a reclamation outage costs 9.96 SOL/day.** Not eventually — immediately, at the
rate rounds are opened.

### The caveat, and its resolution — 2026-08-15

**This section used to say rent reclamation had never run at 48 fighters, and that the 0.030 SOL/day
headline therefore rested on a mechanism nobody had watched work at the current account size. That is
no longer true, and the resolution is recorded here rather than by deleting the doubt.**

The proof came from continuous mode, which is most of why that mode exists. The arena ran unattended
past the twenty-round retention window and closed its first round without anybody prompting it:

```
close_round_account #1    err: null    landed in 668ms
  operator delta   +0.023491960 SOL
  expected         +0.023492000 SOL     (0.023497 rent - 0.000005 fee)
  RECONCILES
  signature 3UcCC7mnGhxhScuP4dMBcrr76xk3JLF5bR4Lv28ykm7JZVZhvAhu9m21GjZZvq7z7pvpMXhCNhgwhev5sUo3ht9q
```

Reconciled against the ledger's own record of that transaction rather than a `getBalance` pair, for
the reason `verify-round-close.ts` gives at length. Round #1's account reads back gone. Closing has
continued every round since, with the sweep gap flat at 1 and **zero stranded**.

**Two things this does and does not settle.** It settles that the lamport transfer works at 3,248
bytes, where rent is 2.7× what it was when the mechanism was last observed working (0.008561 at
sixteen fighters). It does not settle the multi-day behaviour — §4's failure modes are about
reclamation *stopping*, and a few hours of it working is not evidence that it cannot.

**What established the gating first**, and remains the cheap check to reach for: `scripts/reclaim-status.ts`
simulates `close_round_account` against every live round and sends nothing, so it is safe to run beside
the keeper. Before the window opened it showed rounds 1–3 terminal, swept, undelegated and refused
only by `RoundTooRecent` (6021), with the delegated live round refused by `AccountOwnedByWrongProgram`
(3007) — both correct, and together they proved the instruction reachable at this size without
spending anything.

The path not taken, recorded because it is the tempting one: `verify-round-close.ts` proves the same
instruction far more thoroughly, but does it by **opening twenty-two rounds against the live arena** —
a second writer to `arena.round_counter`, which is the failure `extendHouseBank.ts` opens by warning
about. Waiting seventy minutes for production to do it was both cheaper and better evidence.

**Watch `Treasury.rounds_swept` against `Arena.round_counter` for the first day of continuous
running** — `GET /reclamation.json`, or `scripts/reclaim-status.ts` locally. If the gap grows, the
burn is 330× the headline and the balance is gone in a day and a half.

### Two brakes, because one of them is blind at exactly the wrong moment

**The burn brake** measures net lamports between consecutive `open_round` balance readings and stops
the keeper opening rounds above 0.005 SOL/round — ~70× the healthy figure and ~4.7× below the broken
one, so ordinary variance cannot reach it and a real outage clears it on the first steady-state
sample. It latches; a brake that reopened would resume draining.

It has one residual that is worth stating rather than discovering: **it needs ~45 samples to arm, and
its ring is process memory, so it restarts empty.** A keeper that restarts more often than ~2.6h
therefore runs unbraked, and the restarts are not hypothetical — a `fly deploy` and a
`fly secrets set` are one each. Persisting the ring is architecturally blocked (`fly.toml` rule 2
forbids a volume, and the keeper's design is to re-derive from chain rather than remember).

**The sweep-gap stop** covers exactly that window, because it needs no history: `round_counter −
rounds_swept` is two numbers read off chain, healthy at 1, and it climbs monotonically and never
recovers if sweeping stops. It is armed the instant the process starts. Threshold 25 — five rounds of
headroom past the twenty-round retention, about seventeen minutes at 430 rounds/day.

---

## 5. For comparison: what idle costs, and what it used to cost

**Idle, as shipped today: effectively nothing.** With no real players the treasury rule caps the house
at one fighter, which is below `enough_to_fight`, so the chain refuses to draw a house-only round. One
lobby is held for up to seven days and then abandoned. Measured operator activity: **4 transactions
today, 6 three days ago** — against 990 on the day of active work.

**The original fixed cadence cost ~0.32 SOL/hour — 7.7 SOL/day** — at sixteen fighters with rent that
nothing reclaimed. The present figure is **250× cheaper**, and the improvement is almost entirely
`close_round_account` converting rent from a cost into float. Which is precisely why §4 is the section
that matters.

---

## 6. Reproducing this

```bash
# per-round base-layer cost, from a real fought round
cd er-demo && node -e '…getSignaturesForAddress(round_1_pda)…'

# what actually leaves the operator, by instruction
cd er-demo && node -e '…sample operator txs, diff preBalances/postBalances…'

# house wallets: do they spend?
cd er-demo && node -e '…getSignaturesForAddress(house_wallet_0)…'

# idle rate
cd er-demo && node -e '…bucket operator signatures by day…'
```

The fight-length table is `programs/bulls-arena/src/lib.rs` (search `median fight`). The cadence
constants are `DEFAULT_LOBBY_SECONDS` in `er-demo/src/chain/constants.ts` and `RESULT_HOLD_SECONDS`
in `er-demo/scripts/keeper/config.ts`.

---

## 7. What this document got wrong on the way

Recorded because the corrections are the useful part.

**The headline was 0.030 SOL/day and the real figure is 0.178 — wrong by 6x, for over a day.** The
error was structural, not arithmetic: §1 watched `DelegateRound` pay an escrow and `ProcessUndelegation`
return one, and filed the line as float WITHOUT SUBTRACTING THE TWO. 405,000 lamports a round never
came back. The tell was available the whole time and nobody looked: the keeper's own burn brake was
reporting 420,000 lamports/round against a document claiming ~70,000, and the brake was armed and
green because its threshold (5,000,000) is set to catch reclamation failure, not to police the model.
A gauge reading six times the documented value is a finding even when it is inside its limits.

**The first figure was 0.000073 SOL/round and it counted the wrong thing.** It summed fees on
transactions *touching the round PDA*, which silently excludes everything the operator pays elsewhere
— and it missed that `OpenRound` and `DelegateRound` move 0.0267 SOL out of the wallet in the same
breath. The answer happened to survive, because those two are float; the method did not.

**"House wallets are at exactly 0.01, therefore they do not spend" was not evidence.** The keeper
refills them to exactly that number. It became evidence only after checking that the wallet has one
transaction in its entire history.

**Four ER validators reported STALE and it was the probe that was wrong**, not the validators — it
compared them against a local `.so` rebuilt after the deploy. Against the on-chain bytecode all four
match. A staleness check whose reference is a build artefact answers a different question than the one
being asked.
