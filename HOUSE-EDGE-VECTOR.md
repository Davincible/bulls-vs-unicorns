# House-edge study — the TWO-MINT fight

**G12**, the gate `ADR-001-two-mints.md` §1 opened. Measured 2026-08-20 against the same rig, the
same seed (`house-edge-v1`), and the same bars as `HOUSE-EDGE-STUDY.md` §11.

**Nothing was deployed. No Rust was touched. `engine/src/er-sim.ts` was not modified.** All work is
in `sandbox/house-edge/`. `er-demo`'s suite is unchanged at **2,646 tests / 89 files**.

> **This document measures the GAME under a mint vector.** `HOUSE-EDGE-STUDY.md` measures the game
> under a single scalar and stays correct as a record of that; `HOUSE-STRATEGY.md` measures the
> operator. Where this document and `ADR-001-two-mints.md` disagree, §8 says so explicitly, because
> they do disagree and the disagreement is the most useful thing here.

---

## 0. THE HEADLINE — the retired measurements are not re-derived, they are REINSTATED UNCHANGED

`ADR-001-two-mints.md` §1 says, of the five facts it retires:

> **None of those carry over.** They are properties of `min(a.hp, d.hp)` being one number.

**That is false for the arena being built, and this is the finding.** With the recommended basis, in
the extraction economy the arena already runs, the two-mint fight is not *similar* to the
single-scalar fight — it is **bit-identical to it**, in `hp`, `banked` and `dead`, on every fighter
of every round tested. Not within a standard error. Identical.

```
cd engine
HE_FEE_BPS=100 npx tsx ../sandbox/house-edge/check-vector.ts 2000 0
  ok  EXTRACTION keeps every ring mono-slot (0 violations)
  ok  every value-min candidate is BIT-IDENTICAL to the scalar fight in hp/banked/dead (6000/6000 round-configs)
```

**Why, in one paragraph.** `ARCHITECTURE-N-TEAM.md` §3.1 denominates the holdings vector in *value
units*, not in raw tokens: a deposit credits `units = amt × price[m]` into the slot for mint `m`. So
`ring` is a **partition of the scalar `hp`**, not a replacement for it. And §3.4(c)'s extraction
economy banks every raid — winnings land in `banked[origin]`, never in the ring — so a fighter's
**ring only ever holds their own mint**. `sum(ring)` is therefore `ring[own]`, which is `hp`, and

```text
basis = min( sum(A.ring), sum(D.ring) )   ≡   min( A.hp, D.hp )
```

is not an approximation of the shipped rule. It **is** the shipped rule, evaluated over a vector
that happens to have one non-zero entry. The martingale, the seat law, the band flatness and the
sybil result are all properties of that expression, and all of them survive verbatim.

**The recommendation is therefore C4**, and §1 states it precisely.

---

## 1. THE RECOMMENDED BASIS

```text
basis = min( sum(A.ring), sum(D.ring) )          value units, ARCHITECTURE-N-TEAM.md §3.1
dmg   = basis × roll / 100                       unchanged
        then drain dmg out of D's ring SLOT-PRESERVING, greedily, in the §3.4(b) order:
        stolen slots by ring DESCENDING (stable, ties by ascending index), own slot last
        crediting each slot's take to A.banked[that slot]
```

Three properties decide it over the alternatives, and only the first is about fairness:

1. **It reads the same number the scalar rule reads**, so every measured fact transfers exactly
   rather than being re-earned approximately.
2. **It moves exactly `dmg`, with no division at all.** The greedy walk is a compare and a subtract
   per slot. A proportional split (C3) needs one division per slot per exchange to do the same job
   no better.
3. **It cannot break per-slot conservation**, because it only ever moves units *within* a slot index
   — which is §3.1's own solvency argument, made operational.

**And the take order is inert in the arena being built.** In the extraction economy the defender's
ring is mono-slot, so there is nothing to order. C4 (`stolen-first`), C5 (`own-first`) and C3
(`proportional`) are byte-for-byte the same fight (§2). §3.4(b)'s ordering rule is a **mayhem-only
rule**, and §8 records that as a correction to how it is currently written.

---

## 2. THE CANDIDATES, AND WHAT FAILED

```
cd engine
HE_FEE_BPS=100 npx tsx ../sandbox/house-edge/check-vector.ts 3000 1
```
3,000 rounds × 8 fighters. ROIs are gross of the entry fee (the rig credits net stakes), so the
fair value of every cell is **0.0000%**, not −1.00%. The rake appears in §4.

| id | basis / take order | exchanges/round | concluded | ANSEM ROI | UWU ROI | spread | σ |
|---|---|---|---|---|---|---|---|
| **C0** | scalar control, no vector | 524.0 | 90.1% | −0.234% | +0.235% | −0.469% | 0.68 |
| C1 | slot-min, per slot independently | **0.0** | **0.0%** | +0.000% | +0.000% | +0.000% | — |
| C2 | token-min, raw amounts, unpriced | 479.4 | 97.1% | **−80.318%** | **+80.503%** | **−160.821%** | **203.58** |
| C3 | value-min + proportional split | 524.0 | 90.1% | −0.234% | +0.235% | −0.469% | 0.68 |
| **C4** | **value-min + stolen-first (§3.4b)** | **524.0** | **90.1%** | **−0.234%** | **+0.235%** | **−0.469%** | **0.68** |
| C5 | value-min + own-first | 524.0 | 90.1% | −0.234% | +0.235% | −0.469% | 0.68 |

### 2.1 C1 — "min per slot, applied independently" DEADLOCKS. It is not a slow fight, it is no fight.

The obvious generalisation of `min` to a vector is `dmg_i = min(A.ring[i], D.ring[i]) × roll / 100`,
each slot settled on its own. **In a two-mint arena every one of those minima is structurally zero.**
A Bull holds only ANSEM (slot 0); a Unicorn holds only UWU (slot 1); `min(A.ring[0], D.ring[0]) =
min(X, 0) = 0` and `min(A.ring[1], D.ring[1]) = min(0, Y) = 0`. Total damage: zero, on every
exchange, forever. **0.0 exchanges per round and 0.0% of fights concluding, over 3,000 rounds.**

This is worth stating loudly because it is the candidate a reasonable engineer reaches for first,
and because it fails *silently in the direction of looking safe*: conservation is perfect, no money
moves, every invariant holds, and the game does not exist.

### 2.2 C2 — "min over raw token amounts" is the mugging §3.1 warned about, at 203σ.

If the vector stores **tokens** rather than value units — i.e. if the price conversion is skipped —
the basis compares 100 raw ANSEM against 100 raw UWU. At $0.17 and $0.033 a token that is $17
against $3.30. Measured: **ANSEM −80.318%, UWU +80.503%, a spread of −160.821% at 203.58σ.** The
cheaper token wins essentially the entire pot, every round.

`ARCHITECTURE-N-TEAM.md` §3.1 predicts this in words ("not a fight, it is a mugging"). It is here as
a runnable configuration so that the prediction is a measurement, and so that any future
implementation that quietly stores tokens in `ring` is caught by a test rather than by a player.

### 2.3 The −0.469% in the C0 row is INHERITED, not introduced, and it is noise.

Side 0 and side 1 *are* the two mints in a two-mint arena, so an ANSEM-versus-UWU spread is exactly
the failure mode G12 exists to find. It would have been easy to report −0.469% as one.

**It is not.** The scalar control — the fight as it ships today, with no vector anywhere — shows the
same −0.469% on the same lobbies, to the last micro-unit. It is sampling noise in the lobby draw at
0.68σ, and at 20,000 rounds it converges to **−0.0934%** (§6). The vector introduces **zero** new
spread. The C0 row is in the table for this reason and should stay there.

---

## 3. EXACT CONSERVATION — 80,000 round-simulations, worst residual ZERO

```
cd engine
HE_FEE_BPS=100 npx tsx ../sandbox/house-edge/check-vector.ts 20000 2
```
20,000 rounds × 4 configurations = **80,000 round-simulations**, matching §11.1's precedent exactly.
Three identities are checked independently, because a scalar total that balances while a *slot* does
not is precisely the failure the vector exists to prevent — the vault holding surplus UWU and owing
ANSEM it does not have.

| configuration | worst \|residual\| | per-slot worst | partition worst | rounds exact |
|---|---|---|---|---|
| C3 proportional | **0** | 0 | 0 | 20,000 / 20,000 |
| C4 stolen-first | **0** | 0 | 0 | 20,000 / 20,000 |
| C5 own-first | **0** | 0 | 0 | 20,000 / 20,000 |
| C4 **mayhem** | **0** | 0 | 0 | 20,000 / 20,000 |

All in micro-units. Not "below a tolerance" — **zero**, in integers, in all 80,000.

The three identities:
- **per-slot:** `Σ_fighters (ring[i] + banked[i]) + penalties[i] == pot[i]` for every slot `i`
- **scalar:** the §11.1 identity, still true
- **partition:** `sum(ring) == hp` and `sum(vbank) == banked`, on every fighter after every exchange

---

## 4. THE NEW FAILURE MODE — does what you brought change what you get back?

This is the check nobody had run, and it is the one ADR-001 §1(b) names. It is measured through the
**full token round trip**: USD → token base units at the true price → value units at the frozen
price → fight → `units / price` back to tokens → valued at the true price. Both floor divisions live.

```
cd engine
HE_FEE_BPS=100 npx tsx ../sandbox/house-edge/check-vector.ts 4000 3
```
4,000 rounds × 8 fighters, frozen price == true price.

| basis | mint | deposited (tok) | paid out (tok) | **house take** | player ROI (USD, true px) |
|---|---|---|---|---|---|
| **C4** | ANSEM | 4,010,967,496,330 | 3,970,857,771,485 | **1.0000%** | −1.2144% ± 0.4208 |
| **C4** | UWU | 20,581,549,822,181 | 20,375,734,080,079 | **1.0000%** | −0.7847% ± 0.4224 |
| C3 | ANSEM | — | — | 1.0000% | −1.2144% ± 0.4208 |
| C3 | UWU | — | — | 1.0000% | −0.7847% ± 0.4224 |
| C2 *(control)* | ANSEM | — | — | 1.0000% | **−80.5230% ± 0.1261** |
| C2 *(control)* | UWU | — | — | 1.0000% | **+78.8360% ± 0.6534** |

**The house takes exactly 1.0000% of gross entries IN EACH MINT SEPARATELY.** The degenerate CI of
§11.1 survives the vector, and for the same reason: the fee is arithmetic applied at `enter`, per
mint, and the fight redistributes what is left without crossing a slot boundary.

**Which mint you brought is worth −0.4297%, at 0.72σ** — i.e. it is the §2.3 lobby noise and nothing
else. The C2 row is the control that shows this test has power: it detects a real mint asymmetry at
**239.48σ** when one is present.

### 4.1 Extract, four regimes — and the take is still mint-neutral

```
cd engine
HE_FEE_BPS=100 npx tsx ../sandbox/house-edge/check-vector.ts 4000 7
```
Runs against `engine/src/er-sim.ts` **directly** — its own `enter`/`tick`/`extract` — exactly as
`check-house-accrual.ts` does, with the per-slot ledger derived in closed form beside it. The closed
form is licensed by §0: in a two-team two-mint extraction arena a fighter's ring holds only their own
mint and their bank holds only the other side's, because a raid may only cross the side line. So
`(hp, banked, side)` determines the entire vector, and the only value that escapes that pattern is
what `extract` moves from a fighter's own ring into their own bank, which is tracked as it happens.

| regime | house take, % of gross | ANSEM take | UWU take | worst per-slot residual | divisions/extract |
|---|---|---|---|---|---|
| nobody extracts | **1.0000%** | 1.0000% | 1.0000% | **0** | — |
| all at the free horizon | **1.0000%** | 1.0000% | 1.0000% | **0** | **1.00** |
| uniform random cursor | 2.0411% | 2.0653% | 2.0167% | **0** | **1.00** |
| a quarter panic-extract | 2.3049% | 2.2852% | 2.3246% | **0** | **1.00** |

Per-slot conservation exact in every round of every regime. The mint gap is at most **0.0485
points** on the behavioural rows, which is the regime's own sampling noise, not a structural tilt.

**`penalties_collected` must still become a vector** — `ARCHITECTURE-N-TEAM.md` §3.2 is right and
this measurement does not soften it. The ring being mono-slot means each *individual* extract skims
one mint, but *which* mint depends on the extracting fighter's side, so a scalar counter would
conflate ANSEM and UWU penalties and per-slot conservation would break on the first mixed round.

---

## 5. THE BARS FROM §11, RE-RUN

```
cd engine
HE_FEE_BPS=100 NODE_OPTIONS=--max-old-space-size=12288 npx tsx ../sandbox/house-edge/check-vector.ts 4000 4
HE_FEE_BPS=100 npx tsx ../sandbox/house-edge/check-vector.ts 400 5
HE_FEE_BPS=100 npx tsx ../sandbox/house-edge/check-vector.ts 4000 6
```

### 5.1 Stake bands — no band with positive expectation, and every band identical to the scalar's

4,000 rounds × 8 fighters, gross of the fee, so the fair value is the rake.

| band | C0 scalar (control) | **C4 vector** | difference |
|---|---|---|---|
| whale ($80–100) | −0.887% ± 0.33 | **−0.887% ± 0.33** | **+0.0000%** |
| big ($50–80) | −1.460% ± 0.45 | **−1.460% ± 0.45** | **+0.0000%** |
| medium ($20–50) | −0.288% ± 0.61 | **−0.288% ± 0.61** | **+0.0000%** |
| small ($8–20) | −1.753% ± 0.66 | **−1.753% ± 0.66** | **+0.0000%** |
| minnow ($3–8) | −0.098% ± 0.70 | **−0.098% ± 0.70** | **+0.0000%** |

Every band sits on the rake within one to two standard errors, and the difference column is exactly
zero rather than small. §11.5's `spread −0.6%` against v5's `+707.7%` is unaffected.

### 5.2 The eight-wallet sybil farm — closed, and closed by the same amount

`study-split.ts`'s own construction, so the numbers are comparable to §11.2 rather than merely
similar in spirit: a full 48-seat lobby, an $80 budget across k seats **alternating sides**,
background filling the rest. 2,500 rounds.

Alternating sides means that for k > 1 the splitter is **holding both mints** — which is the one
genuinely new sybil shape ADR-001 creates, and it was already in the harness.

| wallets | C0 scalar $/round | **C4 vector $/round** | vs k=1 (§11.2's metric) | **difference C4−C0** |
|---|---|---|---|---|
| 1 | −$1.1296 ± 0.749 | −$1.1296 ± 0.749 | $0.0000 | **0.00000000** |
| 2 | −$1.9341 ± 0.573 | −$1.9341 ± 0.573 | −$0.8045 | **0.00000000** |
| 4 | −$0.6785 ± 0.423 | −$0.6785 ± 0.423 | +$0.4511 | **0.00000000** |
| **8** | **−$1.1503 ± 0.288** | **−$1.1503 ± 0.288** | **−$0.0206** | **0.00000000** |
| 12 | −$1.3462 ± 0.232 | −$1.3462 ± 0.232 | −$0.2165 | **0.00000000** |

The eight-wallet farm's split premium is **−$0.02 ± 0.29**, consistent with §11.2's published
−$0.31 and indistinguishable from zero. **Splitting across both mints buys nothing.** The v5 farm
was worth +$150.87/round; it is still shut.

### 5.3 Fight length and the bell — unchanged to the step

400 seeds, **equal $10 stakes alternating sides** with `seed = sha256("penalty-horizon" ‖ u64le(s))`
— `check-variance-bell.ts`'s construction, which is `tests/fight_length.rs` byte for byte, so the
control row has the published target to land on.

| config | n=8 median | n=16 median | **n=48 median** | **n=48 before bell** |
|---|---|---|---|---|
| C0 scalar (control) | 67.3s / 96.0% | 91.1s / 91.0% | **126.4s** | **78.0%** |
| **C4 stolen-first** | 67.3s / 96.0% | 91.1s / 91.0% | **126.4s** | **78.0%** |
| C3 proportional | 67.3s / 96.0% | 91.1s / 91.0% | **126.4s** | **78.0%** |
| **C4 MAYHEM** | 180.0s / 22.5% | 180.0s / **3.3%** | **180.0s** | **0.0%** |

Against the bar of 124s / 76.2% (and `check-variance-bell.ts`'s own SHIPPED reference of 127s /
77.8%), C4 lands on it because it *is* it. **Pace is not a thing the vector changes.**

### 5.4 Rounding — it changes DIRECTION, and gets thirty times smaller

`units / price` floors at claim and the residue is stranded in the escrow, so unlike §11.1's
single-mint rounding — which went the **player's** way — this goes the **house's** way. That
direction change is real and should be stated. Its size is not.

| | per round |
|---|---|
| measured, 4,000 rounds × 8 seats | **$0.00000054124** |
| bound, 8 seats both slots occupied | $0.00000162400 |
| bound, `MAX_FIGHTERS = 48` | $0.00000974400 |
| **single-mint comparison (§11.1)** | **$0.000016**, the player's way |

**The two-mint claim dust is about 30× smaller than the single-mint rounding it replaces**, and it is
bounded by one token base unit per occupied slot per fighter — by seats, not by money, so it cannot
be farmed. ADR-001 §3's "rounding stops being free" is directionally right and quantitatively
backwards; see §8.

---

## 6. THE PRICE — what a wrong frozen number is worth

```
cd engine
HE_FEE_BPS=100 npx tsx ../sandbox/house-edge/check-vector-price.ts 20000
```
20,000 rounds per row. The price is frozen at `open_round`, so within a round it cannot move; this
measures a price frozen **wrong**.

### 6.1 The mechanism, stated before the numbers so they can be checked against it

A fighter is credited `units = amt × p / SCALE` and redeems slot `i` at the **same** `p`. If all
their terminal units were still in their own slot, `p` would cancel exactly and a wrong price would
be worth nothing. It does not cancel, because terminal holdings are part own-slot ring and part
**foreign-slot bank** — the value they raided, which redeems into the *other* side's token at the
*other* side's frozen price. Writing β for the share of a stake ending in a foreign slot and ε for
the fractional over-pricing of the other mint:

```text
Δ(true return)  ≈  − β · ε / (1 + ε)          and the gap between the sides is twice that
```

### 6.2 β is large, and that is the whole story

```
beta = 75.306% of staked units end in a foreign slot
```

**Three quarters of every stake ends the round denominated in the other side's token.** In the
extraction economy everything you raid is banked in the slot you took it from and never comes back,
so the foreign share only grows. It grows with the lineup too:

| seats | β | implied gap slope per 1% of price error |
|---|---|---|
| 8 | 74.232% | 148.5 bps |
| 16 | 82.122% | 164.2 bps |
| **48** | **89.898%** | **179.8 bps** |

### 6.3 The sweep

UWU's frozen price over-stated by ε, ANSEM correct. The ε = 0 row is the control and is subtracted;
it is **−0.0934%** at this sample size, converging to zero as §2.3 says it should.

| ε | ANSEM ROI (true $) | UWU ROI (true $) | UWU advantage | excess of ε=0 | predicted | error |
|---|---|---|---|---|---|---|
| −10% | +6.8802% ± 0.191 | −8.8491% ± 0.190 | −15.7292% | −15.7292% | −16.7347% | 3.74σ |
| −5% | +2.8679% ± 0.191 | −4.8527% ± 0.190 | −7.7206% | −7.7206% | −7.9270% | 0.77σ |
| −1% | −0.2057% ± 0.191 | −1.7912% ± 0.190 | −1.5854% | −1.5854% | −1.5213% | −0.24σ |
| **0** | −0.9532% ± 0.191 | −1.0466% ± 0.190 | −0.0934% | +0.0000% | +0.0000% | 0.00σ |
| **+1%** | −1.6928% ± 0.190 | −0.3099% ± 0.190 | +1.3828% | **+1.4762%** | +1.4912% | −0.04σ |
| +5% | −4.5714% ± 0.190 | +2.5573% ± 0.189 | +7.1287% | +7.2221% | +7.1720% | 0.13σ |
| +10% | −8.0035% ± 0.189 | +5.9759% ± 0.189 | +13.9794% | +14.0728% | +13.6920% | 1.00σ |
| +50% | −29.9820% ± 0.175 | +27.8676% ± 0.189 | +57.8496% | +57.9430% | +50.2041% | 20.78σ |

`predicted` is a **one-parameter model with β measured at ε = 0 and not refitted per row.** It
tracks every row inside ±5% to **0.77σ**. It degrades past ~10% because a badly mis-stated price
also changes the relative sizes in the ring, which changes how much gets raided at all — a
second-order term the model ignores on purpose.

### 6.4 THE GOVERNANCE NUMBER

```
MEASURED (least squares through the origin, the four rows inside +-5%): 149.6 bps
PREDICTED from beta alone, with no fitting at all:                      150.6 bps
```

> **A price error of 1% moves the gap between the two sides by ≈150 basis points of one-round
> return — about 75 bps onto the over-priced side and the same off the other. At 48 seats it is
> ≈180 bps.**

Against a 100 bps rake:

| price error | consequence for the favoured side |
|---|---|
| **1.34%** | hands back its **entire entry fee** |
| **2.67%** | makes playing that side **positive-expectation outright** |

**That is the finding, and it is worse than the documents imply.** `ARENA-VAULT.md` risk #9 says the
price authority can tilt a fight, with the arena's own wallets on the board. It can tilt it past the
house edge with an error smaller than the intraday range of either token, and a 1.34% mis-statement
is well inside what an honest oracle could produce on a thin pump.fun pair. **A price feed for this
arena needs a staleness bound, a deviation bound, and a named owner before it needs anything else.**

Note the asymmetry that makes this a governance problem and not merely a risk: the effect is
**linear in ε and bounded by nothing**, while the rake is fixed. There is no fee rate that
out-runs it.

---

## 7. WHAT FAILED ON THE WAY

Recorded because `HOUSE-EDGE-STUDY.md` records its own mistakes and a study that only reports its
successful runs is not evidence.

1. **The claim-dust figure was wrong by 6.6×, in the alarming direction.** The first version computed
   the residue as `units − creditUnits(claimTokens(units, p), p)` — re-flooring the tokens back into
   units, charging the player a second rounding the real money path never performs. It printed
   **$1.08e-5/round** against a true bound of $1.6e-6 and read as "the vector is dustier than
   single-mint". The exact residue is `units − tokens × p / SCALE` with no floor on the second term;
   computed in scaled integers it is **$5.41e-7/round**. Fixed in `vector-core.ts::claimDust`, with
   the reason written at the call site.

2. **The fight-length bar was measured against the wrong lineup and briefly showed a phantom
   regression.** A banded 48-seat lobby concludes before the bell **45.0%** of the time — against a
   quoted bar of 76.2% — and the first run reported that as a failure. It is not a regression: the
   **scalar control does the same thing on the same lobby**, because 124s / 76.2% was measured
   against *equal $10 stakes alternating sides* (`check-fight-length.ts`, "the same shape the horizon
   was fitted against"). Switching to that construction and to `check-variance-bell.ts`'s exact seed
   derivation puts the control on 126.4s / 78.0%, where it belongs.

3. **β was guessed at ~17% from a misread of §11.2 and is actually 75%.** §11.2's "83.0% of the pot
   is still sitting in rings at the bell" is about one whale lineup, not the general case; over
   ordinary lobbies with ~524 exchanges most value has been raided at least once. Had the guess
   stood, this study would have understated the price risk by a factor of 4.4 — quoting ~34 bps per
   1% instead of ~150.

4. **The mint-symmetry assertion was written too strong and had to be replaced with a control.**
   It first demanded a literally zero ANSEM-vs-UWU spread, and failed at −0.469%. The spread is real
   in the sample and entirely inherited from the lobby draw — the scalar fight has it too. The fix
   was to put C0 in the table and assert *"introduces zero NEW spread"*, which is both the true claim
   and the one G12 actually asks for.

5. **The first price sweep omitted the ε=0 baseline** and reported the model as failing by 1.5
   points, when subtracting the control brought it to 0.005 points at ε=+1%. Every excess column is
   now net of the control, and the tolerance is stated in σ rather than in points, because the rows
   are *not* paired — a different frozen price changes the units and the trajectories diverge.

**One thing that did not have to be fixed:** the rig was extended rather than rebuilt.
`parity.ts` asserts `BASELINE` byte-identical to `engine/src/er-sim.ts` over 300 lineups, at both fee
rates, **with the vector knob compiled in and unset** — so the loop pinned to the chain is the loop
measured here, and `tests/compute.rs`'s `bench_fight` drift story does not repeat.

---

## 8. WHERE THIS CONTRADICTS `ADR-001-two-mints.md` AND `ARENA-VAULT.md` §3.1

Stated plainly, as instructed, because three of these are load-bearing.

### 8.1 ADR-001 §1: "None of those carry over." — **OVERTURNED for the extraction economy.**

All five carry over, bit-identically, and §0–§5 are the measurement. The ADR's reasoning is sound
for a *general* vector basis and it is right that the question had to be asked — C1 and C2 show what
a wrong answer costs. But the conclusion as written is too strong, and it priced G12 as
"re-earn the evidence" when the actual cost was **"confirm the evidence transfers"**. The gate was
worth running; the retirement was not necessary.

### 8.2 ADR-001 §3: "Three floor divisions per extract plus `units / price` at claim, so dust, so a residue in the escrow." — **QUANTITATIVELY BACKWARDS.**

Measured: **one** floor division per extract, not three (§4.1) — the ring is mono-slot, so the
penalty is skimmed from one slot. And the claim residue is **$5.4e-7/round against single-mint's
$1.6e-5/round** (§5.4) — thirty times *smaller* than the rounding it replaces. What is true is the
**direction**: single-mint rounding favoured the player, this favours the house. That is the sentence
worth keeping; the arithmetic around it should be replaced with the measured bound.

### 8.3 ARENA-VAULT §2.1: "A slot-preserving raid over a vector reads a different basis." — **TRUE ONLY IF YOU CHOOSE ONE.**

`value-min` reads the same basis. The sentence should say that a slot-preserving raid *may* read a
different basis, and that C1 and C2 are what happens when it does.

### 8.4 ARCHITECTURE-N-TEAM §3.4(b)'s take order is a MAYHEM-ONLY RULE, and is currently written as though it were general.

In the extraction economy the defender's ring is mono-slot, so "stolen slots first, largest first,
then own" orders a set with at most one element. C4, C5 and C3 are the same fight (§2). The stability
requirement §3.4(b) argues for so carefully — `sort_by` not `sort_unstable_by`, ties by ascending
index — **is correct and is unreachable in the arena being built.** It should be documented as
conditional on `economy == mayhem` so that nobody spends a parity fixture on a code path the live
arena never enters.

### 8.5 The one place the docs UNDERSTATE the risk: #9, the price authority.

`ARENA-VAULT.md` §2.1 lists the price feed as one bullet among five and §3.1 argues, correctly, that
a wrong price cannot cause **insolvency**. Both true. But the fairness exposure is set by β, β is
**75–90%**, and the resulting slope is **~150–180 bps per 1% of price error** against a 100 bps rake
(§6.4). Risk #9 is not one bullet among five. On these numbers it is the largest single fairness
exposure the two-mint arena has, and it is the only one that no amount of fight-loop care can fix.

### 8.6 What is CONFIRMED and should not be softened

- **`penalties_collected` must become a vector** (§3.2). Confirmed in §4.1.
- **Value units, not raw tokens** (§3.1). C2 is what the alternative costs: 203σ of mint bias.
- **Per-mint conservation is exact by construction.** Confirmed at 80,000 round-simulations, §3.
- **A wrong price cannot cause insolvency.** Credit and redemption use the same frozen number; the
  per-slot residual is zero in every run here.

---

## 9. THE ONE CONFIGURATION THAT GENUINELY DOES NOT SURVIVE — `economy == mayhem`

Everything above is the extraction economy, which is what the live arena already is
(§3.4(c): "the deployed program has no such branch, so today's live arena is really `au-extraction`").

**Under mayhem the ring goes multi-slot, the take order comes alive, and the fight stops ending.**

| lineup | concludes before the 180s bell |
|---|---|
| 8 | 22.5% |
| 16 | **3.3%** |
| 48 | **0.0%** |

Conservation still holds exactly (§3, row 4) and the value-martingale is untouched — mayhem changes
only *where* winnings sit. But **not one 48-seat mayhem fight in 400 concluded before the bell**,
which means every round settles on who was ahead rather than on who was standing, and
`PENALTY_HORIZON_STEPS` — fitted to "steps until one side has nobody standing" — is calibrated
against a quantity that no longer occurs. This is the same mechanism `check-variance-bell.ts` records
for `retain@stake` (8.3% before the bell) and it is rejected there for the same reason.

**If mayhem is ever considered, none of §0–§5 transfers to it and this study must be re-run.**
`ARCHITECTURE-N-TEAM.md` §3.4(c) already makes FFA Mayhem unrepresentable via `require!`; on this
evidence **team mayhem needs the same treatment**, or a re-fitted horizon and bell.

---

## 10. WHAT THIS DOES NOT ESTABLISH

1. **It does not establish that the house receives any money.** §11.6's finding is untouched: the
   deployed program moves no tokens. This measures a ledger.
2. **No player-behaviour model.** §4.1's spread between 1.0000% and 2.30% is behavioural, and nobody
   has measured whether players actually bail early. Unchanged from §8's uncertainty 2.
3. **The lobby distribution is still invented** and the bands are still `engine/src/study.ts`'s.
4. **Two mints, two teams.** The closed form in §4.1 depends on both. `MAX_TOKENS = 3` and the 3-way
   arena are **not measured here** — with three mints a fighter's bank can hold two foreign slots,
   the take order stops being inert even in extraction, and §8.4 would need re-checking.
5. **The price representation is a modelling choice.** §3.1 writes `units = amt × price[m]` as a
   plain multiply, which assumes every token's base unit is worth at least one micro-USD. UWU's is
   worth 0.0033, so the rig uses `amt × price / PRICE_SCALE` with `PRICE_SCALE = 1e12`. A different
   fixed-point choice moves §5.4's dust bound, though not by enough to matter, and moves nothing else.
6. **Bootstrap SEs assume independent rounds**, as they did in §11.
7. **`extract` was measured through `er-sim.ts`, not through the vector loop**, using the closed form
   §4.1 justifies. That is sound for two mints and two teams and is exactly the assumption item 4
   flags.

---

## 11. REPRODUCING THIS

Everything is seeded from `STUDY_SEED = "house-edge-v1"` and reproduces exactly.

```
cd engine

# validate the rig FIRST — the vector knob must not have touched the shipped fight
npx tsx ../sandbox/house-edge/parity.ts                                     # PARITY OK
HE_FEE_BPS=100 npx tsx ../sandbox/house-edge/parity.ts                      # PARITY OK

# G12, part by part
HE_FEE_BPS=100 npx tsx ../sandbox/house-edge/check-vector.ts 2000  0   # §0  bit-identity
HE_FEE_BPS=100 npx tsx ../sandbox/house-edge/check-vector.ts 3000  1   # §2  the candidates
HE_FEE_BPS=100 npx tsx ../sandbox/house-edge/check-vector.ts 20000 2   # §3  80,000 round-sims
HE_FEE_BPS=100 npx tsx ../sandbox/house-edge/check-vector.ts 4000  3   # §4  take by mint
HE_FEE_BPS=100 NODE_OPTIONS=--max-old-space-size=12288 \
  npx tsx ../sandbox/house-edge/check-vector.ts 4000 4                 # §5.1-5.2 bands, sybil
HE_FEE_BPS=100 npx tsx ../sandbox/house-edge/check-vector.ts 400   5   # §5.3 length and the bell
HE_FEE_BPS=100 npx tsx ../sandbox/house-edge/check-vector.ts 4000  6   # §5.4 claim dust
HE_FEE_BPS=100 npx tsx ../sandbox/house-edge/check-vector.ts 4000  7   # §4.1 extract regimes

# the price half
HE_FEE_BPS=100 npx tsx ../sandbox/house-edge/check-vector-price.ts 20000    # §6

# or everything at once
HE_FEE_BPS=100 NODE_OPTIONS=--max-old-space-size=12288 \
  npx tsx ../sandbox/house-edge/check-vector.ts 4000 all
```

Both scripts **exit non-zero if any invariant fails**, so they are usable as the G12 gate and not
only as a report.

| file | what it is |
|---|---|
| `sandbox/house-edge/fight-variant.ts` | extended, not forked. One new optional `cfg.vector` knob; every default reproduces the shipped fight, which `parity.ts` proves at both fee rates. |
| `sandbox/house-edge/vector-core.ts` | mints, the frozen price, credit/claim conversion, the per-slot residual, the five candidates as `FightConfig`s. |
| `sandbox/house-edge/check-vector.ts` | parts 0–7. |
| `sandbox/house-edge/check-vector-price.ts` | §6, the price sensitivity and the governance number. |

---

## 12. THE ONE SENTENCE

**Use `basis = min(sum(A.ring), sum(D.ring))` over value units with a slot-preserving greedy take:
in the extraction economy it is bit-identical to the fight that shipped, so every measurement
`ADR-001` retired transfers unchanged and G12's three conditions are met — but the price feed it
drags into the money path is worth ~150 bps of one-round return per 1% of error against a 100 bps
rake, and that, not the damage basis, is the thing that still needs an owner.**
