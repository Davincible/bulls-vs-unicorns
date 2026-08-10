# House-edge study — the on-chain fight

Measured 2026-08-09 against the deployed algorithm (`advance_fight` in
`programs/bulls-arena/src/lib.rs`, via its checked-in mirror `engine/src/er-sim.ts`).

**Nothing was deployed. No Rust was touched. `engine/src/er-sim.ts` was not modified.** All work is
in `sandbox/house-edge/`, which nothing in `engine/`, `er-demo/` or `programs/` imports. Every number
below is reproducible: see `sandbox/house-edge/README.md` for the exact commands and seeds.

> **That paragraph described this document on the day it was written and is now history.** Both
> defects in §0 have since been fixed in `programs/bulls-arena/src/lib.rs` and both TypeScript
> mirrors, and the sandbox rig moved with them. Still not deployed — see §10, which is the
> before/after record. Everything from §1 to §9 is left exactly as measured against v5, because a
> study rewritten to agree with its own recommendation is no longer evidence for it.
>
> **It shipped, and the rate moved.** v7 (`EpRY6fkv4RcazjYSJyk8rppeVTVMcWhCcVtTVrKkTLT4`) is live on
> devnet and serving real players at <https://bullsvsunicorns.fun>. Every "20 bps" in this document —
> §2's blend table, §233's revenue statement, and each figure derived from them — is the rate the
> measurements were TAKEN AT, and stays correct as a record of that. It is no longer the rate the
> arena charges: `set_fee_bps` moved it to **100 bps (1.00%)**, confirmed by the treasury taking
> exactly 680,000 units on round #27's gross of 68,000,000. Multiply any house-revenue figure below
> by five before quoting it as current, or better, re-run the rig at 100 — `fee_bps` is a live
> account field now, not a constant, so the study's own assumption that it is fixed is the thing that
> aged, not its arithmetic.
>
> **§11 is the re-measurement.** Added 2026-08-10: the same rig, at 100 bps, against the same seeds.
> It supersedes every rate-dependent number below and states plainly which claims it overturns. Read
> it before quoting anything from §1–§10.
>
> **This document measures the GAME. `HOUSE-STRATEGY.md` measures the OPERATOR** — what the house's
> own wallets earn (nothing, in expectation), what the treasury figure overstates, which dial actually
> controls the edge, and the fact that the deployed program moves no tokens at all.

---

## 11. CURRENT STATE — re-measured 2026-08-10 against the live algorithm at the live rate

**This section supersedes every rate-dependent number in §1–§10.** Those sections were measured at
20 bps and stay exactly as written, because a study rewritten to agree with its own recommendation is
no longer evidence for it. This section is what the same rig prints at **100 bps**, which is what the
arena charges now.

**The rig was changed in one place, and here is the change.** `fight-variant.ts` had
`export const FEE_BPS = 20n` — a hardcoded constant from a time when 20 was the only rate that had
ever existed. It is now `BigInt(process.env.HE_FEE_BPS ?? 20)`, and the five other scripts that
carried their own literal `20n` (and `check-seat-law.ts`, which carried a hardcoded `* 0.998`
net-of-fee factor) now read that one export. **The default is still 20**, so every command in
`sandbox/house-edge/README.md` reproduces the number it always printed and §1–§10 remain
reproducible. Nothing else in the rig was touched. `parity.ts` passes at both rates:

```
cd engine
npx tsx ../sandbox/house-edge/parity.ts                    # PARITY OK
HE_FEE_BPS=100 npx tsx ../sandbox/house-edge/parity.ts     # PARITY OK
```

That matters more than it looks: `BASELINE` is asserted byte-identical to `engine/src/er-sim.ts` over
300 random lineups (195,954 exchanges, 0 mismatches) at both rates, so the fee change is provably not
a change to the fight.

### 11.1 THE HEADLINE — the house takes exactly 1.0000% of gross entries, with no variance at all

```
cd engine
HE_FEE_BPS=100 npx tsx ../sandbox/house-edge/check-house-accrual.ts 20000 4
```
20,000 rounds × 8 fighters, study seed `house-edge-v1`, measured against `engine/src/er-sim.ts`
directly — its own `enter`/`tick`/`extract`/`settle` and its own `houseTook`/`grossDeposits`.

| extraction regime | house take, % of gross entries | 95% CI | fee | penalty | conservation |
|---|---|---|---|---|---|
| nobody extracts | **1.0000%** | [1.0000, 1.0000] | 100% | 0% | exact, all 20,000 |
| everyone extracts at the free horizon | **1.0000%** | [1.0000, 1.0000] | 100% | 0% | exact, all 20,000 |
| each extracts at a uniform random cursor | 2.5427% | [2.5188, 2.5685] | 39.3% | 60.7% | exact, all 20,000 |
| a quarter panic-extract early | 2.3036% | [2.2809, 2.3261] | 43.4% | 56.6% | exact, all 20,000 |

**The confidence interval on the fee is degenerate, and that is the actual finding.** The entry fee
is not a statistical edge that emerges over many rounds — it is arithmetic applied at `enter`, and the
fight is a pure redistribution of what is left (`conservationHolds` returned true in every one of
80,000 round-simulations). So the house's fee revenue has **zero variance**. There is no sample size
at which it might come out differently.

Player aggregate ROI is the same number with the sign flipped. Conservation makes "what does the house
make" and "what do players lose" one question, not two.

**The rounding goes the player's way and is bounded by seats, not by money.** `split_entry` floors, so
the house takes slightly under 1%. Measured over 20,000 rounds the total given away was 69,262
micro-units — **$0.069, or 3.46 micro-units per round**. The bound is one unit per entry, so
`MAX_FIGHTERS = 16` caps it at $0.000016/round however the money is arranged. It cannot be farmed.

**The extract penalty is a second and larger revenue stream, and it is behavioural, not structural.**
The two middle rows above are worth more than the fee. §11.6 and `HOUSE-STRATEGY.md` treat it
properly; the short version is that it pays only when players bail early, nobody has measured whether
they do, and an informed player pays nothing.

### 11.2 The seat-vs-deposit exploit is still dead at 100 bps

```
cd engine
HE_FEE_BPS=100 npx tsx ../sandbox/house-edge/study-split.ts 2500
HE_FEE_BPS=100 npx tsx ../sandbox/house-edge/demo-equalizer.ts
HE_FEE_BPS=100 npx tsx ../sandbox/house-edge/check-seat-law.ts
```

Dollars per round gained by splitting an $80 budget across k wallets, versus entering as one $80
fighter — the §10.3 table, re-run at the current rate:

| wallets | v5 (before) | SHIPPED, at 100 bps |
|---|---|---|
| 2 | +$36.73 | **−$0.32** |
| 4 | +$94.89 | **−$0.48** |
| 8 | **+$150.87** | **−$0.31** |
| 12 | +$134.78 | −$0.18 |

Every after-cell is negative and none is distinguishable from zero. **The $152/round farm is now worth
minus the gas.** The rate change did not reopen it, and there is no reason it would have: the exploit
lived in the damage basis, not in the fee.

`demo-equalizer.ts` on the $200-whale lineup at 100 bps: the whale stakes $200 and collects **$198.03
(ROI −1.0%)**; the seven $5 minnows collect $4.88–$5.01. The predictor "payout = a seat's share of the
pot" is off by a mean **145.2%**; "payout = your own deposit" is off by **1.1%**. 83.0% of the pot is
still sitting in rings at the bell, which is the mechanism §10.2 identified.

### 11.3 Entry-order bias is still gone at 100 bps

```
cd engine
HE_FEE_BPS=100 npx tsx ../sandbox/house-edge/check-positional-bias.ts 24000
```
Eight fighters all staking exactly $10, 24,000 seeds. Fair share is now $9.900 (it was $9.980 at
20 bps — the script derives it from `FEE_BPS` rather than from a literal, which is one of the things
the parameterisation fixed).

| layout | v5 (before) | at 100 bps, 24,000 seeds |
|---|---|---|
| `0,0,0,0,1,1,1,1` blocked | slots 3 and 7 **+15.1% / +15.0%**; slots 0 and 4 die 90.6% / 90.3% vs 64% | every slot within **±0.5%**, worst **1.9σ**; death rate **55.5–56.1%**, all eight |
| `0,1,0,1,0,1,0,1` interleaved | flat, ±0.8% | every slot within ±0.5%, worst 1.8σ |

The two layouts remain indistinguishable from each other. Which transaction confirmed first still buys
nothing.

### 11.4 What 20 → 100 bps did to players: exactly −0.80 points of ROI, and nothing else

```
cd engine
npx tsx ../sandbox/house-edge/check-fee-rate.ts 15000 4
```
15,000 rounds, **identical lobbies and identical hash draws at every rate** — the columns are paired,
so the differences are not sampling noise. The 0 bps column isolates the mechanism from the rake.

| band | 0 bps | 20 bps | 100 bps | 200 bps | 100 vs 20 |
|---|---|---|---|---|---|
| whale ($80–100) | +0.025% | −0.175% | −0.975% | −1.976% | **−0.800%** |
| big ($50–80) | −0.272% | −0.471% | −1.269% | −2.266% | −0.798% |
| medium ($20–50) | +0.377% | +0.176% | −0.627% | −1.631% | −0.803% |
| small ($8–20) | +0.270% | +0.069% | −0.733% | −1.736% | −0.802% |
| minnow ($3–8) | −0.292% | −0.491% | −1.289% | −2.286% | −0.798% |
| **all seats** | **+0.000%** | **−0.200%** | **−1.000%** | **−2.000%** | **−0.800%** |

**The rake is exactly proportional and does not touch the fight.** Every band moved by −0.798% to
−0.803% against a theoretical −0.800%. A band moving by materially more would have been an
interaction, and an interaction would have been a defect. There isn't one.

**But ROI is the wrong way to describe what a 5× rake does, and this is the part worth acting on.**

| rate | mean ROI | stdev of one seat's ROI | P(seat loses money) | median seat ROI | rounds until rake > 1σ |
|---|---|---|---|---|---|
| 0 bps | +0.015% | 38.88% | 53.16% | −2.78% | never |
| 20 bps | −0.185% | 38.80% | 53.39% | −2.97% | **44,167** |
| **100 bps** | **−0.985%** | **38.49%** | **54.33%** | **−3.75%** | **1,528** |
| 200 bps | −1.985% | 38.10% | 55.50% | −4.72% | 369 |

Variance is unchanged — the rake takes from the mean and leaves the spread alone. What moved is
**(σ/|μ|)², how long a player must play before the house's cut exceeds a one-standard-deviation swing
in their own results: 44,167 rounds → 1,528.** At the ~110s cadence that is roughly six weeks of
continuous play instead of three years. The rake became visible to an ordinary player about
twenty-nine times sooner. That is the real content of "5× the rake", and §11.6 follows it to its
conclusion.

Note also that the median seat already loses money at 0 bps (−2.78%): the fight's payoff is
right-skewed, so more than half of seats are below average before any fee is charged. The rake pushes
P(a seat loses money) from 53.2% to 54.3%.

### 11.5 The dice: what they actually do — and a correction to the premise

```
cd engine
npx tsx ../sandbox/house-edge/check-dice.ts 2000000
```

Three different things get called "the dice", and only one of them decides whether stake size matters.

**(1) Who is drawn.** `h[0..4] % n` for the attacker, and a rank among the `n−1` non-attackers for the
defender. Over 2,000,000 hashes at n = 8: worst attacker-slot deviation **0.74σ**, worst defender-slot
**1.30σ**, all 56 ordered pairs realised, worst cell 2.45σ. The residual modulo bias is `2^32 % n` out
of `2^32` — under 4e-9, unmeasurable at any sample size this game will produce.

**(2) How hard.** `roll = h[8] % 24 + 4`. **These dice genuinely are not uniform**, and the reason is
modulo bias, not design: `h[8]` is a uniform byte and 256 = 24×10 + 16, so residues 0–15 are reachable
eleven ways and residues 16–23 only ten.

| | measured over 2,000,000 hashes | theory |
|---|---|---|
| rolls 4–19 (11/256 each) | 68.7928% | 68.7500% |
| rolls 20–27 (10/256 each) | 31.2072% | 31.2500% |
| mean roll | **15.24102** | 15.25000 (a uniform 4–27 would be 15.5) |

Damage runs **1.67% weaker** than a uniform die would make it. That is a pacing effect — fights run
marginally longer — and it is **size-neutral**: the same die is rolled for every exchange whoever is
in it, so it cannot favour a band.

**(3) Percent of what.** `basis = min(attacker.hp, defender.hp)`. This is the only size-sensitive term
in the loop, and it is exactly symmetric: when a $100 fighter hits a $5 fighter the damage reads the
same `min` as when the $5 fighter hits back. **The expected transfer between any two fighters is zero
whatever their sizes — the fight is a martingale in `hp + banked` for every fighter.**

> **THE PREMISE IN THE BRIEF IS WRONG, AND THIS IS THE PLACE TO SAY SO PLAINLY.** "The dice were
> deliberately made non-uniform to give small players an edge" does not describe the shipped code. The
> shipped rule is deliberately size-**neutral**, and it was made that way on purpose — see §10.2 and
> §10.5.
>
> A small-stake edge and the sybil farm are **the same object seen from two sides.** Under v5 the
> basis was the defender's ring alone, so a minnow hitting a whale took a whale-sized bite; that
> produced the +660.92% minnow ROI in §10.2 and, inseparably, the $152/round eight-wallet farm in
> §10.3. §10.5 records the decision not to sell any of it back: "every `P > 0` sells back the exploit
> being closed, in proportion to `P`", and the mandate was to close a farm, not to price one.
>
> So the answer to "does the shipped curve give small players an edge" is **no, and it must not**, for
> as long as `MAX_FIGHTERS = 16` seats are the only thing rationing sybils. Re-measured at 100 bps
> (`HE_FEE_BPS=100 npx tsx ../sandbox/house-edge/study-damage.ts 4000 4`), every band sits on the
> rake and nowhere else:

| band | v5 (before) | SHIPPED, at 100 bps |
|---|---|---|
| whale ($80–100) | −52.89% ± 0.36 | **−0.90% ± 0.25** |
| big ($50–80) | −35.39% ± 0.48 | −1.50% ± 0.34 |
| medium ($20–50) | +20.57% ± 0.93 | −0.19% ± 0.44 |
| small ($8–20) | +199.01% ± 2.43 | −1.11% ± 0.49 |
| minnow ($3–8) | **+654.81% ± 6.25** | **−1.55% ± 0.53** |
| **spread** | **+707.7%** | **−0.6%** |

Every band is within one to two standard errors of −1.00%, i.e. of the fee and nothing else.

At sixteen fighters (`HE_FEE_BPS=100 npx tsx ../sandbox/house-edge/study-damage.ts 2500 8`) the same
holds: whale −0.94% ± 0.24, big −0.57% ± 0.35, medium −1.75% ± 0.42, small −1.48% ± 0.44, minnow
−1.19% ± 0.46, **spread −0.3%** against v5's **+708.2%**. The result is not a lobby-size artefact.

### 11.6 What this section does NOT establish, and one thing it overturns

**It does not establish that the house receives any money.** §11.1 measures a ledger. The deployed
program moves no tokens — verified, not assumed: zero occurrences of `anchor_spl`, `token::transfer`
or `TokenAccount` in `programs/bulls-arena/src/lib.rs`; `Enter<'info>` (lib.rs:2413–2425) carries five
accounts and none is a token account; `programs/vault/` is excluded from the workspace `members` list
and still declares the placeholder id `VauLt1111...`. `fees_collected` and `Treasury.fees_accrued` are
`u64` counters. **The 1% is exact arithmetic over money that has not moved.** See `HOUSE-STRATEGY.md`
§1, which is where that finding is developed and where the operator's real cash flow is measured.

**It overturns §10.10's closing sentence.** §10.10 said "if the target is 1% of volume, raise
`FEE_BPS` from 20 to 100." That was done, it worked exactly as predicted, and it is no longer the
binding constraint — the binding constraint is that there is no custody path for the proceeds, and no
fee rate fixes that. `MAX_FEE_BPS = 1_000` is not the ceiling that matters.

**Uncertainties 2, 3, 4, 6 and 7 in §8 are untouched by any of this.** Still no player-behaviour model
— which is now the single largest term in the revenue estimate, because the extract penalty in §11.1
swings the house's take between 1.00% and 2.54% purely on how often players bail. Still an invented
lobby distribution. Still two teams only. Still bootstrap SEs that assume independent rounds.

---

## 10. AFTER — what shipped, and what it did to the numbers

Measured 2026-08-09, same seeds, same lobbies, same rig. `sandbox/house-edge/fight-variant.ts` now
carries two named configs: `DEPLOYED_V5` (the rule every table above measures) and `BASELINE` (what
shipped). `parity.ts` asserts `BASELINE` is byte-identical to `engine/src/er-sim.ts` over 300 random
lineups — 195,954 exchanges, 0 mismatches — **and** that `DEPLOYED_V5` still reproduces the golden
vector that was the committed on-chain parity fixture before the fix. So the "before" column is
pinned to a number the chain itself once asserted, not to a memory of one.

### 10.1 The two changes

```rust
// defender draw — was a bump onto slot a+1, which taxed ENTRY ORDER
let mut d = (u32::from_le_bytes([h[4], h[5], h[6], h[7]]) as usize) % (n - 1);
if d >= a { d += 1; }                     // a rank among the n-1 who are NOT the attacker

// damage basis — was the defender's ring alone, which is what made seats beat deposits
let basis = fighters[a].hp.min(fighters[d].hp);
let mut dmg = basis.saturating_mul(roll) / 100;
if fighters[d].hp <= DUST { dmg = fighters[d].hp; }   // termination: keys on the DEFENDER only
if dmg == 0 { continue; }                             // a blow too small to register kills nobody
```

`P = 0`, i.e. plain `min`, not the blend. §10.5 says why.

### 10.2 Defect 1 — the seat law is dead

`study-damage.ts 4000 4`, eight fighters, the same five bands, common random numbers.

| band | BEFORE (v5) | AFTER (shipped) |
|---|---|---|
| whale ($80–100) | **−52.51% ± 0.36** | **−0.10% ± 0.25** |
| big ($50–80) | −34.87% ± 0.48 | −0.71% ± 0.34 |
| medium ($20–50) | +21.55% ± 0.94 | +0.62% ± 0.45 |
| small ($8–20) | +201.43% ± 2.45 | −0.31% ± 0.49 |
| minnow ($3–8) | **+660.92% ± 6.30** | **−0.75% ± 0.54** |
| **spread** | **+713.4%** | **−0.6%** |

At sixteen fighters (`study-damage.ts 2500 8`): spread **+713.9% → −0.3%**, whale
−52.98% ± 0.30 → −0.13% ± 0.24. Every band is now inside its own standard error of zero at both
lobby sizes.

`check-seat-law.ts` — the law's own predictor, run against `er-sim.ts` directly — no longer predicts
anything. In the 4v4 case with one $200 whale against seven $5 fighters, the law says the whale
collects $4.99 and each minnow $53.64; measured, the whale collects **$199.53** and the minnows
**$4.96–$5.05**. Every ROI in every case is now within **±2%**, whatever the stake.

`demo-equalizer.ts` now scores the two rival predictors against each other and prints whichever fits,
rather than asserting the one that was true when it was written. On the $200-whale lineup: "payout =
a seat's share of the pot" is off by a mean **145.2%**; "payout = your own deposit" is off by
**0.7%**.

**The mechanism that made the seat law work is gone, and it shows up in one number.** §0 explained it
by observing that essentially all value migrated out of rings and into banks by the bell (measured:
0.0% unbanked), so each side ended holding the other side's money split evenly across its seats. On
the same lineup now, **83.0% of the pot is still sitting in rings at the bell** — a whale's ring
barely decays when its attackers can only take minnow-sized bites out of it. There is no longer a
pool of banked winnings for a uniform lottery to hand out.

### 10.3 Defect 1's consequence — the wallet farm is closed

`study-split.ts 2500`, $80 budget, 16 seats. Dollars per round gained over entering as one $80 fighter:

| wallets | BEFORE (v5) | AFTER (shipped) |
|---|---|---|
| 2 | +$37.03 | −$0.33 |
| 4 | +$95.66 | −$0.48 |
| 8 | **+$152.09** | **−$0.31** |
| 12 | +$135.87 | −$0.18 |

Every after-cell is within ±$0.60 of zero and none is distinguishable from it. Splitting now costs
you the gas.

### 10.4 Defect 2 — entry order is worth nothing

`check-positional-bias.ts`, eight fighters all staking exactly $10. The script now reports a per-slot
standard error, which it previously did not — once the effect is small, a table with no error bar
cannot tell "fixed" from "smaller".

| layout | BEFORE (v5) | AFTER (shipped), 24,000 seeds |
|---|---|---|
| `0,0,0,0,1,1,1,1` (blocked) | slots 3 and 7 **+15.1% / +15.0%**, others −5%; slots 0 and 4 die **90.6% / 90.3%** vs 64% | every slot within **±0.5%**, worst **1.9σ**; death rate **55.5–56.0%** for all eight |
| `0,1,0,1,0,1,0,1` (interleaved) | flat, ±0.8% | every slot within ±0.5%, worst 1.8σ |

The two layouts are now indistinguishable from each other, which is the property that was broken:
payout no longer depends on which transaction confirmed first.

*A note on how that was checked.* At 4,000 seeds one slot sat at 3.0σ, which over 16 comparisons is
about a 4%-likely maximum — suggestive, not conclusive. Re-run at 24,000 seeds it fell to 0.9σ,
which is what noise does and bias does not. The 24,000-seed table is the one quoted.

### 10.5 Why `P = 0` (plain `min`) and not the blend this study recommended

§2's dial is real and §2.1's calibration reproduces exactly on the current rig. It was still the
wrong thing to ship, for two reasons the study did not weigh:

1. **Every `P > 0` sells back the exploit being closed, in proportion to `P`.** §4's own table says
   so: the eight-wallet farm is worth $1.10/round at P=10, $3.46 at P=40, $7.99 at P=100. The
   mandate here was to close a farm, not to price one.
2. **The blend cannot be evaluated in `u64`.** `P*ring_d + (BPS - P)*lo` overflows above a ring of
   `u64::MAX / 10_000` (~$1.8B in micro-units). An honest port needs `u128`, and §5's own table
   prices a `u128` divide at 100–300 CU — so the "+6 to +20 CU/step" estimate, made against BigInt
   arithmetic that cannot overflow, does not survive contact with the port. `min` needs no multiply,
   no divide and no widening: one load, one compare.

### 10.6 The bug in §2's recommended code block

The code in §2 is exploitable as written, and it was caught before it was ported rather than after.

```rust
if fighters[d].hp <= DUST || dmg == 0 { dmg = fighters[d].hp; }   // <- the deployed clause, kept
```

That clause is one branch serving one purpose, and the purpose only holds while `basis` is the
defender's ring: `dmg == 0` then implies `hp_d <= 24`, far below `DUST`, so it means "the defender is
spent". Under **any** basis that reads the attacker — `min`, `geo`, or the blend at small `P` —
`dmg == 0` acquires a second meaning, "the **attacker** is spent", and the clause hands that spent
attacker the defender's **entire** ring.

It needs no exotic state. `enter` requires only `stake > 0`, so a 3-unit entry — $0.000003 — has a
ring so small that `3 * roll / 100` floors to zero for every legal roll. Measured on the rig, one
step, seed chosen so the gnat swings first:

| rule | outcome |
|---|---|
| deployed (defender basis) | whale keeps 89,000,000; gnat banks 11,000,003 |
| **§2's `min` as written** | **whale hp = 0, dead; gnat banks 100,000,003 on a 3-unit stake — 33,000,000×** |
| §2's blend at P=20 bps | whale keeps 99,978,000; gnat banks 22,003 |

The shipped rule splits the clause: dust-finishing keys on the defender's ring, and a blow that
rounds to nothing simply moves nothing. Termination survives — a ring only falls when it defends,
`hp <= DUST` kills on the next defence, and any two fighters both above `DUST` always exchange at
least `DUST*4/100 = 40`. Asserted by `an_exhausted_attacker_cannot_annihilate_a_healthy_defender`,
which fails on about half of its 200 seeds if the clause is re-fused.

### 10.7 Compute — the real driver is not the `min`

§5 priced the mechanism and missed the dominant term. The `min` itself is one load and one compare.
What actually costs is that **the fix keeps fights alive longer, and a live step is dearer than a
skipped one** — `lib.rs` measures 271 CU/step falling to 198 as fighters die onto the cheap
early-`continue` path.

Measured on the rig over the full step budget (400 seeds, `stopWhenOver` off, so it counts what the
chain actually runs):

| | steps that do real work, n = 8 | n = 16 |
|---|---|---|
| before | 492 / 1,920 (25.6%) | 996 / 3,840 (25.9%) |
| after | 576 / 1,920 (30.0%) | 1,187 / 3,840 (30.9%) |

So ~191 more working steps at n = 16, ~73 CU dearer each ≈ **+14k CU**, plus the `min` on ~1,200
steps at ~5 CU ≈ **+6k**. Against the measured 864,996 CU for 4,000 steps that is **≈ +20k CU,
+2.3%**, taking the loop to ~885k — **63% of the 1.4M ceiling, against 61.8% before**. The draw
change is free or slightly cheaper: it trades one runtime modulo plus a rare second modulo for one
runtime modulo plus a compare.

**A bound that does not depend on that estimate:** even if every one of the 4,000 steps became a
working step at 271 CU, the loop costs 1,084,000 CU — 77% of the ceiling, still leaving 316k for
`resolve`'s deserialise/serialise/event/CPI remainder. The change cannot break the ceiling on its own.

**These are still estimates, and the thing that settles them is unchanged: the `bench_fight` sweep.**
`bench_fight` calls `run_fight` directly, so it already measures the new rule with no edit — sweep
`steps` on a local `solana-test-validator` and read the CU line. Do not ship on the numbers above.

### 10.8 One pacing effect, measured and not free

`check-fight-length.ts`, 200 seeds per lineup size, equal stakes — the shape `PENALTY_HORIZON_STEPS`
was originally fitted against. `min` damage means a minnow hitting a whale takes minnow-sized bites,
so fights run longer:

| n | step budget | horizon | median end BEFORE | median end AFTER | horizon as % of fight |
|---|---|---|---|---|---|
| 2 | 480 | 71 | 103 | 108 (+5%) | 69% → 66% |
| 4 | 960 | 200 | 318 | 376 (+18%) | 63% → 53% |
| 8 | 1,920 | 566 | 876 | 1,029 (+17%) | 65% → 55% |
| 16 | 3,840 | 1,600 | 2,211 | 2,795 (+26%) | 72% → 57% |

Survivors at the bell go 25% → 44% at n = 16. Rounds are longer and less decisive — a product
change, and the one thing here a reader might not want.

**`PENALTY_HORIZON_STEPS` was deliberately NOT recalibrated, and that is a decision, not an
oversight.** The horizon is denominated in steps, and steps map to wall-clock seconds at a fixed
rate, so the player-facing promise — "hold your nerve for N seconds and leaving is free" — is
unchanged by this fix. All three of its design constraints still hold and are still asserted by
passing tests: reachable before the bell, not gone within the first five seconds, monotone. What
moved is only how far through a *typical* fight the horizon lands, 63–81% → 53–76%, which loosens
the late-fight free option slightly. Re-fitting it would change extract pricing — a different
question, with its own measurement and its own owner — and bundling it here would make a
fight-outcome change and an extract-pricing change indistinguishable under a bisect. The measurement
is checked in (`check-fight-length.ts`) so that decision costs one command, not another study.

### 10.9 The parity chain had a hole exactly where this change lives

Found in adversarial review, after the fix was already green, and worth recording because it is the
most dangerous kind of gap: everything passed.

The only Rust↔TypeScript vector was `run_fight_matches_the_typescript_mirror_exactly` — four healthy
fighters, 50 steps, **zero deaths, minimum hp 20,702**, twenty times `DUST`. It therefore never
executed `if hp_d <= DUST { dmg = hp_d }` and never executed `if dmg == 0 { continue }` — which are
precisely the two branches this fix edited. The TS↔TS test does not close it either, since both
mirrors were edited by the same hand and a shared mistake passes.

A second fixture (`brawl`, in `gen-parity-fixture.mjs`) now covers them, chosen by measurement rather
than by eye: 3 dust-finishes, 3 zero-damage skips, 3 deaths. The before/after is stark — three
mutations of those branches in the Rust alone:

| mutation (Rust only, mirrors untouched) | old `calm` fixture | new `brawl` fixture |
|---|---|---|
| re-fuse the dust clause to `\|\| dmg == 0` | **survived** | caught |
| drop the dust branch entirely | **survived** | caught |
| turn the zero-skip into a kill | **survived** | caught |

### 10.10 What the fix does NOT do

It removes a defect; it does not add a house edge. Player ROI is now ~0% before fees at every stake
size, and the house's revenue is the 20 bps entry fee and the extract penalty, exactly as before.
**§7.2 stands unchanged and is now the only route to a fight-independent edge: if the target is 1% of
volume, raise `FEE_BPS` from 20 to 100.** It is `MAX_FEE_BPS`-legal, already implemented, settable
without a deploy via `set_fee_bps`, O(1), immune to splitting, and actually the same for everyone.

Uncertainties 2, 3, 4, 6 and 7 in §8 are untouched by any of this — still no player-behaviour model,
still an invented lobby distribution, still two teams only, still bootstrap SEs that assume
independent rounds. Uncertainty 1 (the CU numbers) is narrowed but not closed: see §10.7.

---

## 0. The finding that reorders everything else

The brief asks how to *introduce* a small-fighter edge, on the premise that

> Uniform selection plus damage-as-a-percentage-of-the-defender is **exactly size-neutral**.

**That premise is wrong, and it is wrong by about seven hundred percentage points.** The deployed
fight already has the largest small-stake edge the mechanism can express.

Measured on `er-sim.ts` itself, 4,000 rounds, 8 fighters, `study.ts`'s own stake bands:

| band | ROI |
|---|---|
| whale ($80–100) | **−52.5% ± 0.36** |
| big ($50–80) | −34.9% ± 0.48 |
| medium ($20–50) | +21.6% ± 0.94 |
| small ($8–20) | **+201.4% ± 2.45** |
| minnow ($3–8) | **+660.9% ± 6.30** |

The premise misses half the ledger. It is true that expected fractional *loss* per step is
`roll%/n` for everyone. But the *gain* side — `fighters[a].banked += dmg` — is an **absolute**
amount set entirely by the defender. What an attacker collects has nothing to do with what the
attacker staked, and the attacker is drawn uniformly. So every seat collects at the same rate in
dollars, while paying at the same rate in percent.

Run it to the end and there is a closed form. Call it the **seat law**:

```
payout_i  ~=  (total stake on the OPPOSING side) / (number of seats on MY side)
```

A fighter's own deposit does not appear. It enters only as the denominator of ROI. Verified against
`er-sim.ts` (`check-seat-law.ts`, 3,000 seeds/case) — the cleanest case, four $40 fighters against
four $10 fighters:

| slot | side | stake | seat-law prediction | measured | error | ROI |
|---|---|---|---|---|---|---|
| 0 | 0 | $40 | $9.98 | $10.05 | +0.7% | **−75%** |
| 1 | 1 | $10 | $39.92 | $40.03 | +0.3% | **+300%** |
| 2 | 0 | $40 | $9.98 | $9.92 | −0.6% | −75% |
| 3 | 1 | $10 | $39.92 | $39.87 | −0.1% | +299% |

Mean |error| 0.3%, worst 0.7%. Every $40 fighter gets $9.98 back. Every $10 fighter gets $39.92.

Why it holds: damage is a percentage of remaining hp, so every ring decays at the same fractional
rate and by the bell essentially all value has moved out of rings and into banks (measured: **0.0%**
of the pot still unbanked in the `demo-equalizer.ts` lineup). Banks were filled by a uniform lottery
over seats, and same-side pairs never exchange — so each side ends holding the other side's money,
split evenly across its own seats.

**The correct description of the deployed game is not "small stakes have an edge". It is "deposits
buy nothing; SEATS buy everything".** `MAX_FIGHTERS = 16` is the only thing bounding it.

### 0.1 Which makes it farmable, today, by anyone

`study-split.ts`, 2,500 rounds, 16 seats, a player with an $80 budget:

| wallets | stake each | ROI | gain vs entering as one $80 fighter | dollars/round on $80 |
|---|---|---|---|---|
| 1 | $80.00 | −47.5% | — | — |
| 2 | $40.00 | +0.4% | +47.3 pp ± 0.8 | $37.85 |
| 4 | $20.00 | +72.5% | +119.6 pp ± 1.0 | $95.67 |
| 8 | $10.00 | +142.9% | +190.7 pp ± 1.3 | **$152.54** |
| 12 | $6.67 | +122.6% | +169.9 pp ± 1.3 | $135.90 |

An $80 budget split across eight wallets earns **$152 per round more** than the same $80 as one
fighter. This is not a house edge. It is a public subsidy to whoever opens more wallets, and the
house's "many small accounts" plan is simply the first instance of an attack any player can run —
with no capital, no speed advantage and no information.

### 0.2 And a second, unrelated defect found on the way

`check-positional-bias.ts`, 4,000 seeds, **eight fighters all staking exactly $10** — nothing but
slot index distinguishes them:

| layout (order the `enter`s landed) | result |
|---|---|
| `0,0,0,0,1,1,1,1` (each side arrives as a block) | slots 3 and 7: **+15.1%** and **+15.0%**; every other slot **−5%**; slots 0 and 4 die 90% of the time vs 64% for the rest |
| `0,1,0,1,0,1,0,1` (sides interleave) | flat, every slot within ±0.8% |

Cause: `if d == a { d = (d + 1) % n }`. Slot `a+1` absorbs the bumped defender draws, and slot `a`
gets a bonus *valid* attack whenever the bump lands cross-side. Whether it lands cross-side depends
entirely on how sides are laid out across the `fighters` array — i.e. on **which transaction
confirmed first**.

At ~11σ against Monte-Carlo error, this is real. A player who enters last on a blocked lobby is
worth +15%; one who enters first is worth −5% and dies 90% of the time. Teams arriving in waves
(a bull rush, then a uwu rush) is the *likely* layout in production, not the unusual one.

This is independent of the house-edge question and should be fixed regardless. The cheap fix is to
make the bump not favour a neighbour — e.g. `d = (d + 1 + (h[9] as usize % (n - 1))) % n`, or draw
`d` from `0..n-1` and shift past `a`, which removes the collision without a second draw.

---

## 1. What actually moves the number

`study-weights.ts`, 4,000 rounds × 8 fighters, common random numbers (every config sees identical
lobbies and identical hash chains, so comparisons are paired). "spread" = minnow ROI − whale ROI.

| knob | spread | verdict |
|---|---|---|
| **DEPLOYED** (uniform/uniform, absolute dust) | **+713%** | the baseline |
| defender weighted `linear` / `sqrt` / `pow34` / capped, on ring | +700% / +700% / +703% / +706% | **inert** — Δ vs deployed is 0.0 ± 0.6 pp on whale ROI |
| dust 1% / 5% / 20% / 50% of entry stake | +713% / +696% / +647% / +587% | **near-inert**; only shortens the fight |
| attacker weighted `sqrt` on ring | +252% | works |
| attacker weighted `linear` on ring | **−0.9%** | exactly neutral |
| attacker weighted `linear` on *stake* (static) | +70% | works, but floors at +60% — cannot reach neutral |

### 1.1 Why the brief's two proposed knobs do nothing

**Defender weighting is inert because the fight runs to completion.** Weighting the defender changes
who bleeds *first*; it does not change that everyone bleeds to ~zero. The endpoint is unchanged, so
final holdings — which are almost entirely `banked` — are unchanged. Measured: whale ROI moves
−0.4 ± 0.5 pp under fully linear defender weighting. The brief's prediction (a 10× whale losing 10×
the fraction) is correct about the *rate* and irrelevant to the *outcome*.

**The dust floor is inert because of the denomination.** `DUST = 1,000` units and
`UNITS_PER_USD = 1,000,000` (`er-demo/src/v2/contract.ts`), so the absolute floor sits at **$0.001**.
A $3 minnow must lose 99.97% to reach it; a $100 whale 99.999%. Both are "total loss". The brief's
arithmetic ("a whale must lose 99% to die and a minnow only 80%") assumed 1,000 units was a
meaningful fraction of a stake. It is not, at this denomination. Making dust proportional changes
fight *length* a great deal (mean end step 1,283 → 430 at 5%) and ROI hardly at all.

**The attacker draw is the whole mechanism**, because it decides who collects, and collections are
what survive to settlement.

### 1.2 The O(n) dial, for completeness

`study-dial.ts`, `w = M·ring + mean(ring)`, one integer M — M=0 is exactly uniform, M→∞ is exactly
linear. 2,000 rounds × 8 fighters:

| M | 0 | 1 | 3 | 10 | 30 | 100 | 300 | 1000 | ∞ |
|---|---|---|---|---|---|---|---|---|---|
| spread | +707% | +446% | +278% | +121% | +47.5% | +15.5% | +4.1% | +4.0% | +1.8% |

Monotone and calibratable. It costs an O(n) weight rebuild and an O(n) cumulative walk **per step**.
Section 5 explains why that is probably unaffordable.

---

## 2. The recommended mechanism: change what the damage is a percentage *of*

> **The code block below is exploitable as written — see §10.6 before porting it.** Keeping the
> deployed `|| dmg == 0` clause under a basis that reads the attacker lets a 3-unit fighter one-shot
> a whale. What shipped is `P = 0` with that clause split in two; §10.5 says why not the blend.

Weighted selection is the expensive way to fix this. There is an O(1) way, and it is better on every
axis measured.

```rust
// today
let mut dmg = fighters[d].hp.saturating_mul(roll) / 100;

// proposed — P is a u16 in basis points; the rest of the loop is untouched
let lo   = fighters[a].hp.min(fighters[d].hp);
let base = (P as u64 * fighters[d].hp + (BPS - P as u64) * lo) / BPS;
let mut dmg = base.saturating_mul(roll) / 100;
if dmg > fighters[d].hp { dmg = fighters[d].hp; }
```

`P = 0` makes damage `min(ring_a, ring_d) · roll / 100`. `P = 10_000` is the deployed rule exactly.
No weight table, no cumulative walk, no wide modulo, **no change to which hash bytes drive the
draws**, no change to `MAX_STEPS`, no change to the account layout.

Economic rationale, which matters more than the arithmetic: this restores the shape the *old*
physics sim already had — `sqrt(ring(a)·ring(b))`, damage set by both parties, not one. The rule
"you cannot take more than you brought" is explicable to a player in one sentence, applies to
everyone, and is exactly the kind of public rule the brief wants the rake disguised as.

### 2.1 Calibration — `study-damage.ts`, 4,000 rounds × 8 fighters

| P (bps) | whale | big | medium | small | minnow | spread |
|---|---|---|---|---|---|---|
| 0 | −0.31 ± 0.27 | −0.50 ± 0.37 | +0.20 ± 0.48 | +0.63 ± 0.55 | +0.51 ± 0.57 | **+0.8%** |
| 5 | −0.47 ± 0.27 | −0.57 ± 0.38 | +0.32 ± 0.47 | +1.21 ± 0.56 | +1.97 ± 0.58 | +2.4% |
| 10 | −0.64 ± 0.28 | −0.64 ± 0.37 | +0.44 ± 0.46 | +1.79 ± 0.55 | +3.44 ± 0.57 | +4.1% |
| 15 | −0.80 ± 0.27 | −0.71 ± 0.38 | +0.56 ± 0.48 | +2.36 ± 0.56 | +4.90 ± 0.59 | +5.7% |
| **20** | **−0.97 ± 0.27** | −0.78 ± 0.37 | +0.68 ± 0.46 | +2.93 ± 0.55 | **+6.35 ± 0.59** | **+7.3%** |
| 30 | −1.29 ± 0.27 | −0.93 ± 0.37 | +0.92 ± 0.48 | +4.07 ± 0.57 | +9.24 ± 0.60 | +10.5% |
| **40** | −1.62 ± 0.27 | −1.07 ± 0.37 | +1.16 ± 0.47 | +5.19 ± 0.56 | +12.11 ± 0.62 | **+13.7%** |
| 60 | −2.25 ± 0.27 | −1.35 ± 0.36 | +1.62 ± 0.47 | +7.41 ± 0.56 | +17.78 ± 0.64 | +20.0% |
| 100 | −3.49 ± 0.25 | −1.90 ± 0.35 | +2.50 ± 0.46 | +11.73 ± 0.59 | +28.88 ± 0.73 | +32.4% |
| 200 | −6.37 ± 0.26 | −3.21 ± 0.34 | +4.52 ± 0.46 | +21.86 ± 0.63 | +55.28 ± 0.94 | +61.7% |
| 10000 *(deployed)* | −52.43 ± 0.37 | −34.77 ± 0.47 | +20.60 ± 0.92 | +201.19 ± 2.43 | +665.13 ± 6.37 | +717.6% |

`spread ≈ 0.8 + 0.316·P` over `P ∈ [0, 100]` at n=8 — linear, monotone, and resolvable to ±0.6 pp at
4,000 rounds. This is a dial, not a menu.

For reference on the same lobbies: the O(n) attacker-weight route at `M=30` gives +46.4% spread;
`geo` (`isqrt(ring_a · ring_d)`, no parameter) gives **+8.2%**, i.e. roughly `P = 23 bps`.

### 2.2 Lobby-size sensitivity — the calibration is *not* scale-free

Same script at 2,500 rounds:

| | n = 4 | n = 8 | n = 16 |
|---|---|---|---|
| P = 0 (`min`) | +10.9% spread (whale −3.07 ± 0.53) | +0.8% | +0.8% |
| slope, spread per bp of P | ≈ 0.39 | ≈ 0.316 | ≈ 0.257 |
| P = 40 | +29.8% | +13.7% | +11.3% |
| deployed (P = 10000) | +726% | +713% | +714% |

Two things follow. The deployed pathology is invariant to lobby size. But **`min` is not exactly
neutral in a 4-fighter lobby** (whale −3.1%, minnow +7.8%), and the dial's slope varies ~50% across
lobby sizes. Any P is calibrated *for a lobby size*, and small lobbies run hotter. If a single P must
serve 2–16 fighters, the tilt in a duel will be roughly 1.5× the tilt in a full lobby.

---

## 3. The headline: what buys a 1% house edge on total volume

`study-house.ts`, 2,500 rounds/cell, always 16 fighters. House plays **$5** fighters; "wide" players
are `study.ts`'s five bands (mean ~$42). Cells are house profit ÷ total gross volume.

| house seats (of 16) | house share of pot | P=10 | P=20 | P=40 | P=60 | P=100 | P=200 |
|---|---|---|---|---|---|---|---|
| 2 | 1.7% | +0.038 ± .010 | +0.072 ± .010 | +0.139 ± .010 | +0.205 ± .010 | +0.335 ± .011 | +0.646 ± .012 |
| 4 | 3.8% | +0.038 ± .015 | +0.110 ± .015 | +0.254 ± .015 | +0.396 ± .015 | +0.673 ± .016 | **+1.335 ± .019** |
| 6 | 6.7% | +0.079 ± .018 | +0.197 ± .018 | +0.429 ± .019 | +0.658 ± .019 | **+1.105 ± .021** | +2.166 ± .024 |
| 8 | 10.6% | +0.183 ± .024 | +0.356 ± .024 | +0.697 ± .024 | **+1.033 ± .025** | +1.687 ± .027 | +3.229 ± .033 |
| 10 | 16.5% | +0.232 ± .028 | +0.469 ± .029 | +0.936 ± .030 | +1.393 ± .031 | +2.282 ± .034 | +4.364 ± .043 |
| 12 | 26.5% | +0.271 ± .036 | +0.574 ± .036 | **+1.171 ± .037** | +1.754 ± .038 | +2.884 ± .042 | +5.508 ± .054 |
| 14 | 45.0% | +0.254 ± .039 | +0.586 ± .039 | +1.238 ± .041 | +1.876 ± .043 | +3.106 ± .049 | +5.943 ± .067 |

**Answer to the question as asked.** ~1% of volume is reached at any of:

| setting | house seats | house share | take/volume | player ROI |
|---|---|---|---|---|
| **P = 60 bps** | 8 of 16 | 10.6% | **1.033% ± 0.025** | −1.6% |
| **P = 100 bps** | 6 of 16 | 6.7% | **1.105% ± 0.021** | −1.7% |
| **P = 40 bps** | 12 of 16 | 26.5% | **1.171% ± 0.037** | −1.9% |
| **P = 200 bps** | 4 of 16 | 3.8% | **1.335% ± 0.019** | −1.5% |

The 20 bps entry fee is on top and unaffected, so total house revenue at any of these is
**~1.2% of volume**.

### 3.1 The brief's arithmetic — verified in form, refuted in substance

> `house_profit = house_share × edge_on_own_stake`, so 1% of volume needs a 2% edge at 50% house
> share but a 10% edge at 10% share.

The identity is exact — it is a definition, and the measured columns agree to the printed digit.
But it is only useful if `edge_on_own_stake` is a property of the mechanism you can hold fixed while
varying share. **It is not.** The game is zero-sum: `house_profit = −player_profit`. As the house
takes more of the pot it is increasingly playing itself. Decomposition at P = 40 bps:

| house share | edge on own stake | share × edge | measured take/volume |
|---|---|---|---|
| 1.7% | +8.33% | +0.139% | +0.139% |
| 3.8% | +6.63% | +0.254% | +0.254% |
| 6.7% | +6.44% | +0.429% | +0.429% |
| 10.6% | +6.55% | +0.697% | +0.697% |
| 16.5% | +5.66% | +0.936% | +0.936% |
| 26.5% | +4.42% | +1.171% | +1.171% |
| 45.0% | +2.75% | +1.238% | +1.238% |

`edge_on_own_stake` falls by 3× as share rises 1.7% → 45%. So take/volume is **not** linear in share
and **not** monotone: at P = 10 bps under the earlier O(n) dial it peaked at 12 house seats and fell
at 14. There is an interior optimum, and at 100% share the take is exactly zero however hot the dial.

**So the decay is the opposite way round from the brief's expectation.** The mechanism does not decay
as real players arrive — a *smaller* house share converts to a *higher* edge on the house's own
stake, which is why P = 200 bps with only 4 house seats (3.8% of the pot) still clears 1.3% of
volume. What it decays against is something else entirely.

### 3.2 What it *does* decay against: players who stake like the house

Same experiment, players drawn only from $3–20 (mean ~$11.5) instead of $3–100:

| house seats | share | P=20 | P=40 | P=100 | P=200 |
|---|---|---|---|---|---|
| 4 | 12.7% | +0.034 ± .046 | +0.109 ± .046 | +0.327 ± .046 | +0.673 ± .047 |
| 8 | 30.4% | +0.029 ± .065 | +0.178 ± .065 | +0.610 ± .065 | +1.288 ± .065 |
| 10 | 42.1% | +0.155 ± .073 | +0.327 ± .073 | +0.828 ± .072 | +1.610 ± .072 |
| 14 | 75.4% | +0.060 ± .064 | +0.207 ± .064 | +0.629 ± .064 | +1.282 ± .064 |

Every cell falls by roughly **2.5–4×**. The tilt pays the house only while the house is the small
one. It is a bet on stake *dispersion*, not on the house's cleverness — and the players it taxes are
exactly the whales you most want to keep. Whale ROI at P = 100 bps is −3.5%/round before fees; at
20 rounds an hour that is a whale account halving in a session, which is a churn problem, not a
revenue stream.

---

## 4. Where it breaks: splitting

`study-split.ts`, 2,500 rounds, $80 budget, 16 seats. Gain in ROI percentage points over entering as
a single $80 fighter, and the same thing in dollars per round:

| wallets | P=0 | P=10 | P=20 | P=40 | P=100 | P=10000 *(deployed)* |
|---|---|---|---|---|---|---|
| 2 | +0.6 ± 0.8 | +0.9 ± 0.8 | +1.3 ± 0.8 | +1.9 ± 0.8 | +3.9 ± 0.8 | +47.3 ± 0.8 |
| 4 | −0.0 ± 0.8 | +0.6 ± 0.8 | +1.2 ± 0.8 | +2.4 ± 0.8 | +6.0 ± 0.7 | +119.6 ± 1.0 |
| 8 | +0.4 ± 0.7 | +1.4 ± 0.7 | +2.4 ± 0.7 | +4.3 ± 0.7 | +10.0 ± 0.7 | +190.7 ± 1.3 |
| 12 | +0.3 ± 0.7 | +1.4 ± 0.7 | +2.4 ± 0.7 | +4.5 ± 0.7 | +10.5 ± 0.7 | +169.9 ± 1.3 |
| | | | | | | |
| **$/round on $80, 8-way** | $0.30 | $1.10 | $1.89 | $3.46 | $7.99 | **$152.54** |

**The house has no privileged position.** The tilt that pays the house is available to every player
at the cost of opening wallets, and the marginal wallet is worth the same to both. The bound is
structural and small: `MAX_FIGHTERS = 16`, and `enter` tops a wallet up rather than duplicating it,
so a splitter can hold at most 16 seats and in a contested lobby far fewer. Returns flatten hard —
8-way and 12-way are indistinguishable at every P — because taking more seats on your own side
dilutes the per-seat share of the opposing pot.

**The break-even, stated as a rule.** A splitter is farming your tilt whenever the gain exceeds the
cost of running k wallets (signing, session keys, gas, the operational nuisance of k funded
accounts). Calling that ~$1/round for 8 wallets:

- **P ≤ 10 bps** — splitting is worth ≤$1.10/round and is inside the noise band. Not farmable.
- **P = 20–40 bps** — $1.89–$3.46/round. Farmable by a motivated player; the house take at these
  settings is 0.36–1.17% of volume. **This is the whole usable window, and it is narrow.**
- **P ≥ 100 bps** — $8/round. Will be farmed, publicly, within days of anyone noticing.
- **Today (P = 10000)** — $152/round. Already exploitable.

There is no setting at which the house earns meaningfully and players cannot. That is not a flaw in
the parameterisation; it is what "a public rule that rewards playing small" means.

---

## 5. Compute — flagged, not solved

**Weighted selection (§1.2) is the expensive option and probably does not fit.**

`lib.rs` records the measured baseline: ~271 CU/step falling to ~198 as fighters die; 4,000 steps =
864,996 CU for the loop alone, 61.8% of the 1.4M ceiling, with the remaining 38.2% reserved for
`resolve`'s unmeasured deserialise/serialise/event/CPI remainder. Two rounds are already permanently
stuck from exceeding this.

Added cost of an O(n) weighted draw at n = 16, naively (rebuild the table, cumulative walk, `% W`):

| item | estimate |
|---|---|
| weight rebuild, 2 passes × 16 (sum + live count, then `M·v + mean`) | 130–260 CU |
| cumulative walk, ~n/2 to n compares + subtracts | 65–100 CU |
| one `u128 % u128` (no native 128-bit divide on BPF) | 100–300 CU |
| **total** | **+300 to +650 CU/step** |

That is +110% to +240%, i.e. 2.3M–3.7M CU at 4,000 steps. **Over the ceiling.** It can be cut a long
way — keep everything in u64 (a total weight of `1000 × 16 × $100k` in micro-units is ~1.6×10¹⁵,
comfortably inside u64, so no u128 is needed); maintain the total incrementally, since only the
defender's ring changes per step; and evaluate `w_i = M·ring_i + mean` inside the walk instead of
materialising a table. That gets it to roughly **+80 to +200 CU/step**, or 1.40M–1.88M at 4,000
steps — **at or over the ceiling**, with no headroom for the `resolve` remainder. It would require
lowering `MAX_STEPS`, and since 16 fighters × 32 steps/s × 120 s = 3,840 steps at the bell, that
means lowering `STEPS_PER_FIGHTER_PER_SECOND` or `FIGHT_TIMEOUT_SECONDS` too. A real change.

**The recommended mechanism (§2) costs almost nothing.** One `min`, two u64 multiplies, one add, one
divide by a compile-time constant, one clamp: **+6 to +20 CU/step**, i.e. +2% to +7%. 4,000 steps
goes from 864,996 to roughly 883k–926k CU — the existing headroom survives intact.

These are estimates, not measurements. **The measurement that settles it is the `bench_fight` sweep
`ARCHITECTURE-N-TEAM.md` §3.5 already specifies** — extend it to take the damage rule / weight kind,
keep it calling `run_fight` directly so it cannot drift, and sweep on a local `solana-test-validator`.
CU is deterministic in bytecode and inputs, so that costs no devnet SOL. Do not ship either change on
these numbers.

**One pacing effect that is measured and is not free.** `min` damage lengthens fights, because a
minnow hitting a whale now takes minnow-sized bites. At n = 16 the mean end step goes 2,969
(deployed) → 3,448 (P = 0..40) against a 3,840 budget, and survivors at the bell go 25% → 45%. The
fight now runs nearly to the bell rather than finishing early. That is a product decision (longer,
less decisive rounds) and it removes the slack that currently makes most `resolve` calls cheap.
`geo` goes the other way — 1,406 steps at n = 16, *shorter* than deployed — but costs an `isqrt`
(~100–200 CU/step on BPF), which is worse per step even though the fight is shorter, because the CU
bound is per instruction at `MAX_STEPS`, not per fight.

---

## 6. Byte layout, so a Rust port is unambiguous

**The recommended mechanism needs no layout change at all.** `h[0..4]` attacker, `h[4..8]` defender,
`h[8]` roll — exactly as deployed. The parity fixture keeps working; only the damage line changes.

**If weighted selection is pursued anyway**, a `% W` draw against a large total weight needs more
than 32 bits, and the current ranges overlap what a wider draw would consume. Use:

```
attacker : u64::from_le_bytes(h[0..8])    % n   (uniform)  or  % W_att  (weighted)
defender : u64::from_le_bytes(h[8..16])   % n   (uniform)  or  % W_def  (weighted)
roll     : h[16] % 24 + 4
```

Non-overlapping, so the two draws are independent; 15 of 32 bytes still unused. Modulo bias against a
`W` of order 10¹⁵ in a 64-bit draw is ~2⁻⁴⁹ and can be ignored. **This changes the fight for the same
seed**, so `parity_tests` and the checked-in TS/Rust fixture must be regenerated deliberately, in the
same commit, with the old vectors deleted rather than left to rot.

---

## 7. Recommendation

**7.1 — Fix the two defects. These are not optional and are independent of any edge question.**
**— DONE, both of them. See §10 for the before/after and for the two places this section was wrong.**

1. **The seat law.** A player who splits $80 across 8 wallets earns $152/round more than one who does
   not. Whales lose 52% per round by construction. Set the damage basis to `min(ring_a, ring_d)`
   (P = 0): size-neutral to ±0.6 pp at n = 8 and n = 16, splitting worth $0.30/round, O(1).
2. **The entry-order bias.** ±15% on identical stakes depending on which transaction landed first.
   Fix the `d == a` bump so it does not favour a neighbour.

**7.2 — Take the house edge from the fee, not the fight.**

If the target is 1% of volume, raise `FEE_BPS` from 20 to 100. It is `MAX_FEE_BPS = 1_000`-legal,
already implemented, already swept, O(1), independent of who plays, immune to splitting, does not
require the house to field capital or hold inventory, and is *actually* the same for everyone. A rake
that requires the house to run 8 of 16 seats and hope players stake bigger than it does is a trading
strategy with a 1% expected return and full principal at risk — not a fee.

**7.3 — If a fight-based tilt is still wanted, this is the defensible window.**

`P = 20 bps` (spread +7.3%, whale −0.97% ± 0.27, minnow +6.35% ± 0.59). House take 0.36% of volume at
8 seats, 0.57% at 12. Splitting worth $1.89/round on $80 — above noise but plausibly below the cost
of running eight wallets. Above P = 40 bps the splitting farm becomes clearly worth someone's time;
below P = 10 bps the house take is indistinguishable from zero. **The whole usable range is
P ∈ [10, 40] bps** and it yields 0.1%–1.2% of volume depending on how many seats the house holds.

Do not treat it as durable. §3.2 shows it falls 2.5–4× the moment players stake like the house does,
and §4 shows any player can copy it for the price of a wallet.

---

## 8. What I am uncertain about

**Ranked by how much it could change the recommendation.**

1. **The CU numbers in §5 are estimates and I have not run the validator.** I cannot compile the Rust
   here (`MEGA_QUEUE.md` ER-010). The +6–20 CU/step claim for the damage change is the one everything
   rests on, and it is a guess about BPF codegen for two multiplies and a constant divide. If the
   compiler emits a real 64-bit division rather than a multiply-shift, it could be 5× that. Run
   `bench_fight` before believing it. I have deliberately not tried to make this sound settled.

2. **No player-behaviour model.** Every number assumes players enter and stand there. Nobody
   extracts, nobody re-enters, nobody responds to what they see on screen. `extract` is the whole
   reason the rollup is load-bearing, and a player who extracts at the right moment changes their own
   ROI a great deal. The tables measure the *mechanism*, not the *game*, and the gap between the two
   is entirely behavioural. I did not model it because a fabricated behaviour model would make the
   tables a measurement of my assumptions.

3. **The lobby distribution is invented.** I used `study.ts`'s five bands so the tables are comparable
   with ARENAS.md, and a $3–100 range with uniform band selection. Real lobbies are probably more
   clustered, and §3.2 shows clustering roughly quarters the house take. If real stake dispersion is
   half what I assumed, halve every number in §3.

4. **Two teams only.** ARENAS.md's nine arenas include 3-way and FFA. The seat law is a
   *cross-side* statement — each side ends holding the other side's money — and it does not
   obviously survive N teams or FFA, where `fight_is_over` means one *fighter* standing.
   ARCHITECTURE-N-TEAM.md §0 is explicit that numbers do not transfer between game shapes, and that
   applies to mine too. **The FFA Mayhem −40% result in ARENAS.md is a physics-sim measurement and I
   have not reproduced anything like it here**; nothing in this study says whether it holds on chain.

5. **Calibration is not scale-free (§2.2).** One P serves lobby sizes 2–16 with a ~50% slope
   variation, and `min` is not exactly neutral at n = 4 (whale −3.1% ± 0.53 — small, but real). If
   duels are a meaningful share of volume this needs either a per-lobby-size P or an explicit
   decision to accept a hotter duel.

6. **The seat law's residuals are not fully explained.** Mean |error| is 0.3% on balanced lineups but
   reaches 20% on the 2-vs-6 headcount-lopsided case, where the last slot on the crowded side beats
   prediction by +56%. Some of that is the §0.2 positional bias; I did not decompose the rest. It
   does not affect the conclusions — the effect sizes here are hundreds of percent — but I would not
   quote the seat law as exact for lopsided lobbies.

7. **Bootstrap SEs assume rounds are independent draws.** They are, by construction, in this rig.
   They would not be in production, where the same wallets meet repeatedly and lobby composition is
   endogenous. Treat every ± here as a *lower bound* on live variance.

8. **`geo` may be the better mechanism and I stopped short of settling it.** It is a fixed +7–8%
   tilt with no parameter, restores the old sim's exact shape, and produces *shorter* fights than
   today. It loses on CU-per-step, which is the binding constraint — but if `bench_fight` shows u64
   `isqrt` is cheaper than I assumed, the ranking flips.

---

## 9. Reproducing this

```
cd engine
npx tsx ../sandbox/house-edge/parity.ts     # must print PARITY OK before anything else is believed
```

`parity.ts` asserts that the rig's `BASELINE` config is **byte-identical** to `engine/src/er-sim.ts`
over 300 random lineups (0 mismatches, 166,390 exchanges compared), that value is conserved under all
98 weight/basis combinations, and that weighted fights are deterministic from `(seed, lineup)` alone.
`demo-equalizer.ts`, `check-seat-law.ts` and `check-positional-bias.ts` run against `er-sim.ts`
**directly** rather than the variant, so the §0 findings cannot be an artefact of the rig.

Study seed `"house-edge-v1"`; per-round fight seed `sha256("he|<study seed>|<round>")`; lobby
composition from mulberry32 seeded off the same string. Full command list in
`sandbox/house-edge/README.md`.
