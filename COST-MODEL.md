# What the arena costs to run

Measured 2026-08-14 against v8 (`ECD1dX2fUSGVY25y2cHWHWXYUQr9XzfFdTxcMzHj7zKe`) on devnet, at
`MAX_FIGHTERS = 48`. Every figure below has a command that produced it; where a number is derived
rather than observed it says so, and where it is *unobserved at the current scale* it says that too —
which is the case for the single most important one.

The question this answers: **what does it cost to run games continuously, with no real players?**

---

## 0. The answer, and the number that is 330× larger

**Steady state: ~0.030 SOL/day.** ~0.9/month, ~11/year, at 424 rounds/day.

**Gross flow: ~11.4 SOL/day.** Almost all of it returns. It nets to the figure above *only while rent
reclamation keeps working*.

**If reclamation stops: ~9.96 SOL/day, permanently.** At a 14.95 SOL balance that is about 36 hours.

The distance between 0.03 and 9.96 is the whole risk, and §4 is about nothing else.

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
| `DelegateRound` | **0.003221 SOL** | at undelegation, same round |
| ~5 transactions of fees | **~0.00007 SOL** | **never** |
| **Total out** | **~0.0268 SOL** | |

**Only the fees are spent. Everything else is float.**

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

At 424 × 0.00007 SOL: **0.030 SOL/day**.

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

### The honest caveat on the headline figure

**Rent reclamation has never run at 48 fighters.** v8's counter is at 4 and the retention window is
twenty, so nothing on this program has been closed yet. The 0.030 SOL/day depends on a mechanism that
is built, tested and *unobserved at this account size* — where rent is 2.7× what it was when it was
last observed working (0.008561 at sixteen fighters).

**What has since been established, and what has not.** `scripts/reclaim-status.ts` simulates
`close_round_account` against every live round without sending anything, and against v8 it shows the
instruction is REACHABLE at the current 3,248-byte size: rounds 1–3 are terminal, swept and
undelegated, and the only thing refusing them is `RoundTooRecent` (6021) — the retention guard doing
its job. Round 4 is delegated and refuses with `AccountOwnedByWrongProgram` (3007), also correct.

So the gating is proven at this size and nothing structural has broken. **The lamport transfer itself
is still unproven at 48 fighters**, and it cannot be proven without either running twenty rounds or
opening twenty-two against the live arena — the latter being a second writer to `arena.round_counter`,
which is the failure `extendHouseBank.ts` opens by warning about. Continuous mode reaches round 20 in
about seventy minutes and exercises it in production, which is the better proof and the reason that
mode exists.

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
