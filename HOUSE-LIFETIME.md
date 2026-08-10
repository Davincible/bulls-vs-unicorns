# Lifetime revenue per acquired player — the denominator the other two documents got wrong

Measured 2026-08-10 against the deployed algorithm (`engine/src/er-sim.ts`, asserted byte-identical to
`advance_fight` by `sandbox/house-edge/parity.ts`), the deployed keeper policy, and — for the first
time in this project — a small amount of **real recorded player data**.

**Nothing was deployed. No Rust was touched. No TypeScript mirror was modified. Nothing was
committed.** All work is in `sandbox/house-edge/`, which nothing in `engine/`, `er-demo/` or
`programs/` imports.

**Companion documents.** `HOUSE-EDGE-STUDY.md` measures the GAME. `HOUSE-STRATEGY.md` measures the
OPERATOR per round. This document measures the OPERATOR **per acquired player, over that player's
whole life** — and that change of denominator overturns the ranking of dials in `HOUSE-STRATEGY.md`
§4.

---

## 0. READ THIS FIRST — the two numbers that decide everything are not dials, and neither is measured

**The top two terms in every ranking below are the MARKET, not settings we control**, and both
currently rest on imported priors rather than observation:

| | what it is | status | where |
|---|---|---|---|
| **ε** | elasticity of deposits w.r.t. the **posted** fee | **prior only** (−0.8 to −1.5, from parimutuel racing) | §2.3, §7.2 |
| **ρ** | the rate at which real humans extract early | **never observed.** `Treasury.penalties_accrued` = 0 | §4 |

Everything that follows is either a **measurement** (reproducible, with a CI) or a **bet** (a
measurement conditioned on ε or ρ). They are labelled throughout, and a ranking whose leading entries
rest on priors should say so in its first paragraph rather than its footnotes. **This one does.**

### The two experiments that convert the bets into measurements

Both are cheap, and neither needs a redeploy. **Nothing else in this document is worth as much.**

1. **Measure ε.** A small posted-rate experiment — `set_fee_bps` is live and needs no deploy. Move the
   rate, watch deposits per acquired player. The whole fee question (§2.3) collapses to this one
   number, and every model here is blind to it by construction.
2. **Measure ρ.** Render `secondsToFree`, which `data/extractTerms.ts` **already computes and does not
   display**, then read `Treasury.penalties_accrued`. That is the first observation the extract-penalty
   stream has ever had a chance of producing (§4.6). Cost: one component.

### Findings, in the order they matter

1. **MEASUREMENT — the fee is a SPEED dial, not a revenue dial.** With ruin as the only exit, every
   rate above ~50 bps collects the whole bankroll; a 10× rate change moves lifetime revenue by −1.8%
   and rounds-to-death by 3.5×. §2, §2.2.
2. **MEASUREMENT — no loss-driven churn rule can produce an interior fee optimum, and the reason is
   that the rake is invisible.** Per-round σ is 38.5% against a 1% rake; over a whole 38-round life the
   rake is ~a tenth of one standard deviation. A player quitting on a drawdown is quitting on *noise*.
   §2.2.
3. **BET, and the central deliverable — 100 bps is optimal iff ε ≈ 0.90** [0.77, 1.02]. The imported
   prior is 0.8–1.5, so **η\* sits at the low edge: the revenue-maximising fee is at or slightly BELOW
   100 bps.** **Leave the rate alone.** A confirmed setting, per the brief, is worth as much as a
   changed one. §2.3.
4. **MEASUREMENT — `HOUSE-STRATEGY.md` §1's gas figure is stale by 24×, in the house's favour, and the
   saving is built, enabled by default, and pointed at the wrong program.** Post-reclaim, one real
   player at 100 bps covers gas **10.1×**; pre-reclaim it did not cover it at all. **This is worth more
   than any fee change and it is an operations fix, not an economics one.** §1.
5. **DO NOT SHIP — a tiered rate card is farmed in one round**, 75% of honest rake drained, $472/day to
   a single $80 adversary. The only mechanic tested that fails the disclosure test outright: the
   disclosure *is* the exploit. §8.
6. **MEASUREMENT — cadence contributes exactly 0.0% of the gain attributed to it**, as a structural
   identity rather than an approximation. The factorial decomposition is FEE 100.0% / CADENCE 0.0%.
   Cadence survives only as idle-arena cost control (−$873/day at zero players). §8.
7. **MEASUREMENT — house count cannot move expected profit** (residual CI `[−$0.316, +$0.115]`, zero
   inside). The optimal policy is **`H = 0` with nobody real in the room, otherwise exactly the `cover`
   fighter and nothing more** — identical at cap 16 and cap 48. That beats the deployed ladder by
   **+$0.093/round while holding $4 of capital instead of $63.** §9.
8. **MEASUREMENT — the `MAX_FIGHTERS` 16 → 48 migration landed mid-analysis, was done correctly, and
   MY RECOMMENDATION WAS WRONG.** I proposed clamping the penalty horizon; that would have destroyed
   **76%** of the penalty stream. The shipped fix — splitting `MAX_STEPS` and lengthening the bell —
   is better than the defect. §10.3 records the error and why I made it.
9. **The bigger board neither helps nor hurts the house.** The optimum never wanted more than one or
   two seats, so the extra 32 are unusable for revenue. It is a product decision with no revenue
   payback, and it makes §1's program-id fix **2.54× more urgent** because Round PDA rent grew by that
   factor. §10.4.
8. **Real player data exists and both prior studies said it did not** — `engine/data/ledger.db` is
   gitignored. Median rounds played per real wallet: **1**. But 900 of 911 accounts are bots and human
   deposits total $393.55, so it is one weak data point, not a calibration. §5.

---

## 1. THE GAS FIGURE IS STALE BY 24×, AND THAT MOVES BREAK-EVEN MORE THAN ANY FEE CHANGE COULD

`HOUSE-STRATEGY.md` §1 states, and `er-demo/scripts/keeper/config.ts:108-114` still says:

> every round ever … costs the payer 0.008503160 SOL of round-PDA rent that is never coming back …
> the all-in figure is **0.00981 SOL per round**

**That is no longer true.** v7 added `close_round_account` — `programs/bulls-arena/src/lib.rs:1860`,
commit `1a9f941` ("v7: a round's rent comes back, behind a retention window the chain enforces"). The
keeper drives it (`er-demo/scripts/keeper/roundCloser.ts`, commit `b400e55`) and it is **on by
default**: `config.ts:235`, `export const CLOSE_ROUNDS_ENABLED = envFlag("KEEPER_CLOSE_ROUNDS", true)`.

The program's own doc comment (`lib.rs:131-137`) carries the measurement, against v6 rounds #3 and #4:

> 0.008971 SOL per round all-in, of which 0.008561 (95.4%) is Round PDA rent that nothing ever
> reclaimed … Reclaiming the rent takes the per-round cost to **~0.00041, a factor of 22**

| | pre-reclaim | post-reclaim | ratio |
|---|---|---|---|
| SOL per round | 0.00981 | **0.00041** | 23.9× |
| USD per round at SOL $150 | $1.4715 | **$0.0615** | |
| break-even real gross/round at 100 bps, fee only | $147.15 | **$6.15** | |
| rounds funded by 3.66 SOL | 373 | **8,927** | |
| hours funded at the ~110s cadence | 11.4 | **272.8** | |

**But it is not currently being realised, and that is a live operational finding rather than a
modelling one.** `er-demo/public/keeper-status.json` — heartbeat `1786356073` = 2026-08-10 10:01 UTC,
i.e. live — reports `chain.programId = "D5S8oJ3sArpJ39zBG2N6PgxwWjVogWpemeJ9ryn9zhhM"`.
`er-demo/src/chain/constants.ts:58` identifies that key as **v6**, and `constants.ts:67` and
`lib.rs:109` both declare the current program to be v7, `EpRY6fkv4RcazjYSJyk8rppeVTVMcWhCcVtTVrKkTLT4`.
**v6 predates `close_round_account`.** The saving is written, enabled by default, and aimed at a
program that cannot serve it.

### 1.1 And the break-even in `HOUSE-STRATEGY.md` §2 is three times too optimistic

§2 reports "$41–49 of real player volume per round just to pay its own gas". That is computed at a
~3% take rate, of which roughly 60% is the extract penalty under an **assumed** 30% early-extraction
rate that nothing has ever measured — and §4.1 of that same document says to stress every plan at
P(extract) = 0. Doing so leaves the entry fee alone:

| fee | take rate (fee only) | break-even real gross/round, **pre**-reclaim | **post**-reclaim |
|---|---|---|---|
| 20 bps | 0.20% | $735.75 | $30.75 |
| 50 bps | 0.50% | $294.30 | $12.30 |
| **100 bps** | **1.00%** | **$147.15** | **$6.15** |
| 200 bps | 2.00% | $73.57 | $3.07 |
| 300 bps | 3.00% | $49.05 | $2.05 |

The two corrections run in opposite directions and roughly cancel at the headline level, which is
worth knowing before anyone quotes either one alone.

**Against the live board, both are academic.** `keeper-status.json` round #20: `fighterCount: 1`,
`houseFighterCount: 1`, **`realFighterCount: 0`**, `roundsCompleted: 0`. Real gross is $0.00/round, so
the arena is short at every fee setting. **No value of `fee_bps` reaches break-even from zero
volume**, and that — not the rate — is the binding constraint.

---

## 2. THE STRUCTURAL RESULT: the fee is a speed dial

This section is closed-form arithmetic, not simulation, because the conclusion is strong enough to
deserve a proof rather than a sample.

The fight is a martingale in `hp + banked` (HOUSE-EDGE-STUDY.md §11.5), so a player staking a fraction
`f` of their balance each round at rake `φ` has `E[balance_t] = B(1 − φf)^t` **exactly**. Let the
per-round probability of quitting for reasons unrelated to money be `λ`. Then

```
lifetime rake  L(φ)  =  Σ_t  P(alive at t) · φf · E[B_t]
                     =  φfB · Σ_t [(1−λ)(1−φf)]^t
                     =  φfB / (λ + φf(1−λ))
```

**Two corollaries, and they are the whole answer to "what fee maximises lifetime revenue".**

**(a) If ruin is the only exit (`λ = 0`), `L = φfB/(φf) = B` exactly, for any fee above zero.** The
house eventually takes the entire bankroll whatever the rate. The fee changes only how many rounds it
takes. Under this model the fee is not a revenue dial at all.

**(b) With fee-blind churn (`λ > 0` and constant), `dL/dφ = λfB / (λ + φf(1−λ))² > 0` everywhere.**
Lifetime revenue is monotone increasing in the fee, saturating at `B`. **There is no interior optimum
to find; the optimum is the corner, `MAX_FEE_BPS = 1000`.**

| fee | λ=0.001 | λ=0.004 | λ=0.02 | λ=0.10 |
|---|---|---|---|---|
| 25 bps | $71.48 | $38.52 | $11.14 | $2.44 |
| 50 bps | $83.40 | $55.68 | $20.08 | $4.78 |
| **100 bps** | **$90.99** | **$71.63** | **$33.56** | **$9.17** |
| 200 bps | $95.33 | $83.61 | $50.51 | $16.95 |
| 500 bps | $98.14 | $92.94 | $72.46 | $34.48 |
| 1000 bps | $99.11 | $96.53 | $84.75 | $52.63 |

(Lifetime rake per acquired player, $100 bankroll, `f = 1.0`. Closed form, no sampling error.)

**Read the concavity, because it is the practical content.** At λ=0.004, 100 bps already captures
**71.6%** of the theoretical maximum of $100. Going to 1000 bps — a tenfold rate increase, the legal
ceiling — buys **96.5%**, a 35% revenue gain. Most of what is available is already being collected.

### 2.1 So where does an interior optimum come from? Exactly one place.

Let churn respond to the rake: `λ(φ) = λ₀ + k(φf)^a`. Then `L ~ φ / (λ₀ + kφ^a)`, whose numerator
grows like `φ` and denominator like `φ^a`, so `L ~ φ^(1−a)` at large `φ` — **which decays only when
`a > 1`.**

| `k` | a = 0.5 | a = 1.0 | a = 1.5 | a = 2.0 |
|---|---|---|---|---|
| 0.0 | corner | corner | corner | corner |
| 0.5 | corner | corner | 753 bps | corner |
| 2.0 | corner | corner | 266 bps | 470 bps |
| 10.0 | corner | corner | **88 bps** | 204 bps |
| 50.0 | corner | corner | 30 bps | 90 bps |

**An interior fee optimum exists if and only if churn responds superlinearly to the rake.** A linear
response — "players quit in proportion to what they lose" — is not enough; the corner still wins.

### 2.2 SIMULATED: no loss-driven churn rule produces an interior optimum — and here is why

```
cd engine
npx tsx ../sandbox/house-edge/strategy-lifetime.ts 20000 all
```
20,000 simulated lives per cell. The pool is validated first, and cross-checked against **300,000 real
`newRound`/`enter`/`tick`/`settle` fights** (1,500 players × 200 rounds at 100 bps). They agree on every
mean: lifetime rake $53.33 ±3.19 real vs $50.83 ±0.27 pooled; rounds played 107.6 ±2.8 vs 107.0 ±0.2;
median terminal balance $0.0081 vs $0.0080.

**(a) Ruin-only — confirmed exactly.**

| fee | lifetime rake/player | rounds lived | P(ruin) | withdrawn |
|---|---|---|---|---|
| 25 bps | $88.68 ±5.77 | 422.8 | 99.7% | $11.07 |
| 50 bps | $103.29 ±6.03 | 274.4 | 100.0% | $0.62 |
| **100 bps** | **$101.19 ±4.21** | **165.5** | 100.0% | $0.01 |
| 1000 bps | $99.39 ±1.07 | 47.3 | 100.0% | $0.01 |

Every rate above ~50 bps collects the whole $100 bankroll. **A 10× rate change moves lifetime revenue
by −1.8% and rounds-to-death by 3.5×.** The fee is a speed dial.

**(b) and (c)** are both monotone to the corner as predicted. **But the inversion I asked for —
"what churn elasticity makes 100 bps optimal" — has no solution.** `L(110bps) − L(90bps)` stays
strictly positive at every magnitude of both hazard parameters:

| parameter | value | L(110) − L(90) | sign |
|---|---|---|---|
| `hazardDrawdown` | 0.5 | $1.60 ±0.18 | positive |
| `hazardDrawdown` | 18.0 | $0.42 ±0.03 | positive |
| `hazardDrawdown` | **54.0** | **$0.41 ±0.03** | **positive** |
| `hazardStreak` | 18.0 | $0.35 ±0.03 | positive |

At `hazardDrawdown = 54` a player 30% down quits with probability ≈1 that round — **and the fee still
wants to be higher.** The argmax is 1000 bps in all nine sweep rows and all twenty sensitivity rows.

> **THE MECHANISM, AND IT SUPERSEDES §2.1's "SUPERLINEAR" CONDITION.** A loss-driven quit rule cannot
> respond to the fee **because the fee is invisible inside the noise.** Per-round ROI has a standard
> deviation of **38.5%** (§11.4) against a 1% rake. Over a whole 38-round life the rake accumulates to
> ~23% of bankroll while the cumulative noise is ~237% — **the rake is about a tenth of one standard
> deviation over an entire lifetime.** §11.4 measured the same thing from the other end: at 100 bps a
> player needs **1,528 rounds** before the rake exceeds a one-sigma swing in their own results. A
> player who quits on a drawdown is quitting on *noise*, not on the rake. Churn cannot respond to
> something it cannot see.
>
> So §2.1's condition is right but unreachable by this route: no *money-path* churn rule is
> superlinear in the rake, because it is barely even linear in it. **The fee is invisible as an
> experience and visible only as a posted number** — which means the elasticity that matters acts on
> the published rate, not on the loss path.

### 2.3 THE ANSWER: the deposit elasticity 100 bps requires is **η\* = 0.90**, and that is defensible

Write revenue as `Rev(φ) = D(φ)·g(φ)`, where `g` is rake-per-deposited-dollar (a property of the game,
already measured) and `D` is deposits (behaviour). At an optimum, `−dlnD/dlnφ = dln g/dlnφ ≡ η*`. So
**η\* is derived from the game, with no invented demand curve.** Paired finite difference at 90/110 bps,
n=20,000, paired bootstrap CI:

| churn model | **η\* at 100 bps** | 95% CI |
|---|---|---|
| `BASE_PLAYER` | **0.8990** | [0.7660, 1.0233] |
| fee-blind churn, `hazardBase` 0.004 | 0.7605 | [0.5872, 0.9311] |
| loss-sensitive, `hazardDrawdown` 0.1 | 0.9614 | [0.8467, 1.0902] |
| 50% drawdown-from-peak hard stop | 0.8363 | [0.6374, 1.0458] |
| ruin-only | −0.0332 | [−0.3261, 0.2467] |

**In plain English: 100 bps is the revenue-maximising fee if and only if a 1% increase in the posted
rate makes players deposit about 0.90% less. Equivalently — doubling the fee from 100 to 200 bps would
have to cut deposits per acquired player by 46% to be revenue-neutral.**

**And that number can now be judged, because §7.2 supplies the prior.** For products whose price is
*posted and computable* — parimutuel takeout, the correct comparable — published elasticities run
**−0.8 to −1.5**, centred near −1.1 to −1.4 (Thalheimer & Ali 1995, 2003 [A]).

> **η\* = 0.90 sits at the LOW edge of that band. So if the true elasticity is anywhere near the
> centre of the published range, the revenue-maximising fee is at or slightly BELOW 100 bps.**
>
> **The current setting is near-optimal and, if anything, marginally high. This is a confirmed
> setting, not a changed one — and per the brief that is worth as much.**

### 2.4 Flatness verdict: the curve is NOT flat, and that must be reported plainly

| fee | lifetime rake/player | % of peak |
|---|---|---|
| 50 bps | $12.507 ±0.223 | 14.6% |
| **100 bps** | **$23.029 ±0.404** | **26.9%** |
| 200 bps | $40.303 ±0.673 | 47.1% |
| 400 bps | $62.023 ±0.944 | 72.4% |
| 1000 bps | $85.623 ±0.936 | **100.0% (peak)** |

Only 1 of 11 rates is indistinguishable from the peak. **100 bps collects 26.9% of what 1000 bps
collects from the same acquired player.** That is the opposite of a comfortable result and it should
not be softened: **every model in this family is blind to the posted rate, so none of them can ever
recommend 100 bps.** The entire case for the current rate lives in η\* (§2.3) and in the reputational
cost of a visible rake. Arguing for 100 bps on lifetime-revenue grounds alone is arguing against this
table.

---

## 3. THE BEHAVIOURAL MODEL IS PARTLY IN THE CODE ALREADY, AND NOBODY USED IT

Both prior documents treat player behaviour as wholly invented. It is not. `er-demo/src/v2/data/`
ships an auto-deploy rule with **hard, disclosed, default limits** — `autoPolicy.ts:268`:

```ts
export const DEFAULT_LIMITS: AutoLimits = {
  budgetUsd: 250,
  perRoundCapUsd: STAKE_CAP_USD,   // $100
  drawdownStopPct: 50,
  maxRounds: null,
};
```

**`budgetUsd` IS A TURNOVER CAP, NOT A LOSS CAP, AND THAT CHANGES THE ANSWER COMPLETELY.** I first read
it as a loss budget and was wrong. `autoPolicy.ts:501` accumulates **gross stake** on every confirmed
entry —

```ts
spentUsd: t.spentUsd + (Number.isFinite(amountUsd) ? amountUsd : 0),
```

— and `autoPolicy.ts:362` stops the run at `budgetLeftUsd = limits.budgetUsd − tally.spentUsd`.
Winnings do not refill it. So the bound is arithmetic rather than statistical:

> **An armed auto-deploy run can stake at most `budgetUsd` in total, and therefore pay at most
> `budgetUsd × φ` in rake — EVER. At the live rate that is $250 × 1% = $2.50.**

Measured (20,000 lives, $250 bankroll): lifetime rake **$2.4994 ±0.0002** at 100 bps over **3.00
rounds**, and the binding limit is the turnover budget in **99.2–100%** of runs — **the 50% drawdown
stop essentially never fires.** Within that bound rake is exactly *linear* in the fee ($0.62 at 25 bps,
$25.00 at 1000 bps), so this regime's optimum is also the corner.

Three consequences, all load-bearing:

1. **The shipped auto-deploy defaults are worth $2.50 of lifetime rake per armed run.** Not $125 — I
   said $125 earlier on the assumption the drawdown stop binds, and it does not. A run is ~3 rounds
   and roughly 5 minutes long. The defaults are conservative to the point of being a rounding error
   on revenue, which is a product decision worth surfacing rather than a modelling result.
2. **`perRoundCapUsd = $100` is a lever on `f`, and it is expensive.** At a $1,000 bankroll it forces
   `f ≈ 0.1` and extends life 1.65× (35.3 → 58.5 rounds) — but it **cuts lifetime rake by 84.7%**
   ($383.17 → $58.44) and spreads what remains over more rounds, each billed for gas. It is by a wide
   margin the most expensive player-protection device in the product, and it was not installed as one.
   In its favour: the uncapped rows carry enormous confidence intervals (±$45.71), so the cap is
   variance control for the house's book too.
3. **It enters and it never extracts.** `autoPolicy.ts:21` states this as a hard architectural
   principle, enforced structurally — `runUnattendedEntry` accepts nothing but an entry. **Every
   auto-deploy player therefore contributes exactly zero extract-penalty revenue**, which puts the
   owner's stated growth goal in direct structural conflict with the penalty stream (§4.4).

---

## 4. THE EXTRACT PENALTY, PRICED AS AN OPTION — and why it does not belong in a forecast

```
cd engine
HE_FEE_BPS=100 npx tsx ../sandbox/house-edge/strategy-penalty.ts 20000
```

The reframe: the fight is a martingale, so extracting has **zero expected value** and buys exactly one
thing — certainty. `EXTRACT_PENALTY_START_BPS` is therefore not a tax rate, it is the **price of an
option**, and 2,000 bps is a price that has never been tested against demand. `Treasury.penalties_accrued`
is `0`; nobody has ever extracted mid-fight in production. Every number here is a forecast.

**Two corrections to the framing this study started from, both verified against the code.**

**(i) The horizon is shorter than assumed.** `PENALTY_HORIZON_STEPS[n−2]` for n=8 is **566**, not 675
(675 is n=9). Against the then-1,920-step budget the penalty reached zero **29.5%** of the way through
the fight, not ~35%. That shortness decides the shape of the whole surface.

> **POST-MIGRATION NOTE — this section's surface was measured before the seat-cap change and the
> numbers are now historical in one specific way.** `FIGHT_TIMEOUT_SECONDS` went 120 → 180 (§10.2), so
> the budget at n=8 is now `2 × 180 × 8 = 2,880` steps rather than 1,920. The horizon is unchanged at
> 566, so **the penalty now reaches zero at 19.7% of the fight instead of 29.5%** — the free window is
> a *larger* share of every round. Directionally that moves penalty revenue **down** at every n, which
> reinforces §4.6's conclusion rather than weakening it. The argmax and the fragility results are
> unaffected; only the absolute dollar figures would shift, and they were already headed for $0.00 in
> the recommendation.

**(ii) `HOUSE-STRATEGY.md` §4.1's "one sentence of public knowledge away from zero" is wrong, because
the sentence has already shipped.** `er-demo/src/v2/ui/IntroOverlay.tsx:130-132`, in the onboarding
overlay every new player sees, reads verbatim: *"the house takes a slice of whatever you pull out, 20%
at the opening bell and less with every step after, down to nothing once the fight has run its
course. It is a premium on an option, and it decays because the option does."* `StakeDock.tsx:301`
prints the live rate on the Extract button and the words **"· no fee"** the instant it reaches zero,
and `data/extractTerms.ts` already computes `freeAtStep`, `secondsToFree` and a forward decay table —
**the countdown is built and merely not rendered.** The distance to zero is **zero sentences**.
Secrecy is already gone; only inattention remains, and inattention is not a revenue model.

### 4.1 The rig reproduces §11.1 exactly, then re-prices analytically

20,000 rounds × 8 seats, seed `house-edge-v1`, fee 100 bps, mean gross **$335.01/round**:

| regime | published §11.1 | re-measured | 95% CI | conservation |
|---|---|---|---|---|
| nobody extracts | 1.0000% | **1.0000%** | [1.0000, 1.0000] | exact, all 20,000 |
| all wait for the horizon | 1.0000% | **1.0000%** | [1.0000, 1.0000] | exact, all 20,000 |
| uniform random cursor | 2.5427% | **2.5427%** | [2.5188, 2.5685] | exact, all 20,000 |
| a quarter panic early | 2.3036% | **2.3036%** | [2.2809, 2.3261] | exact, all 20,000 |

All four to four decimals. Trajectories are then recorded once and re-priced under any `(START,
horizon)` — legitimate because the penalty rate does not affect the fight (`extract` sets `hp = 0`;
no later draw can tell which split was applied). The one approximation — a departure `dead`s a slot
and slows the fight for whoever remains — was measured against a real simulation at the worst case of
**all eight seats leaving**: the priced figure is **−2.44%** low, CI [−0.1358, −0.1214] on $5.26. The
bias understates revenue, so every number below is conservative.

### 4.2 The demand model, and the one measured fact inside it

Four models, all invented except where noted: a hold fraction `π_hold` who never extract, a reservation
price `v` (what a player would pay for certainty), and an arrival cursor `τ` (when they want out).
**A** = exogenous, `τ` uniform. **B** = endogenous, `τ` fires when `hp` first drops below half the
stake. **C** = 50/50. **D** = informed, `v = 0` for everyone.

**Measured, not assumed:** the endogenous trigger fires for **86.8%** of seats, at mean cursor **112**
of 1,920 — only 20% of the way to the free point. Losers arrive early, where the price is highest and
their remaining ring is already shrinking. That correlation is what makes the surface single-peaked.

### 4.3 The surface, and where the shipped setting sits on it

| model | argmax (START, horizon) | peak $/round | shipped (2000, ×1.0) | **shipped as % of peak** | paired gain, 95% CI |
|---|---|---|---|---|---|
| A exogenous | (3000, ×4.0) | $1.7802 ±0.046 | $0.7123 ±0.026 | 40.0% | $1.068 [1.027, 1.108] |
| **B endogenous (realistic)** | (3000, ×0.5) | $1.7617 ±0.033 | **$1.7055 ±0.032** | **96.8%** | **$0.056 [0.043, 0.069]** |
| C mixed | (2000, ×4.0) | $1.5701 ±0.036 | $1.2124 ±0.029 | 77.2% | $0.358 [0.334, 0.382] |
| **D informed** | none | **$0.0000** | **$0.0000** | — | every one of 50 cells |

**The mechanism the brief predicted is confirmed under endogenous arrival.** Raising START from 2,000
to 6,000 bps converts the share who pay immediately from 11.2% to **1.9%** — nearly everyone simply
waits — while the mean rate actually paid rises only 519 → 607 bps and the base collapses **$6.74 →
$4.99 (−26%)**. Net revenue falls 22%. There is a genuine interior optimum at 1,500–2,000 bps and
**the shipped 2,000 is sitting on it.**

It is *refuted* under exogenous arrival, for a structural reason worth keeping: because the horizon is
only 29.5% of the fight, a waiter can only wait a bounded time, so the base they can destroy is capped.
That cap binds under uniform arrival and the surface goes monotone-then-flat instead of peaked.

**But the argmax is a function of the guess, not of the game.** The revenue-maximising START sits at a
near-constant **×5–6 multiple of the median reservation price** across the whole sweep. So 2,000 bps
is right if and only if the median player would pay ~330–500 bps for certainty — a number with **zero**
observations behind it. Every row of that sweep is an equally defensible world.

### 4.4 Fragility — three independent routes to zero, one of which is the roadmap

**(a) Inattention.** Model C's penalty stops covering gas at **π_hold = 0.388**. Even at π_hold = 0 it
covers gas only ×1.63, while the entry fee covers it ×2.28 on its own.

**(b) The roadmap deletes it on purpose.** `er-demo/src/v2/data/autoPolicy.ts:21-30` states as a hard
architectural principle: *"THE SECOND PRINCIPLE: IT ENTERS, AND IT NEVER EXTRACTS… the only unattended
sender here is `runUnattendedEntry`, why its payload type is an entry and cannot be anything else."*
It is enforced structurally — there is no unattended path that can reach `extract()`. **So every
auto-deployed seat has `π_hold = 1` by construction**, and revenue is exactly linear in auto-deploy
share:

| auto-deploy share of volume | penalty $/round | total house $/round | vs gas |
|---|---|---|---|
| 0% | $1.2124 | $4.5625 | ×3.10 |
| 50% | $0.6062 | $3.9563 | ×2.69 |
| **100%** | **$0.0000** | $3.3501 | ×2.28 |

**The entry fee is untouched — a robot pays it on every entry. The fee is the stream that survives the
roadmap; the penalty is the one the roadmap deletes.** "Deposit $1,000 for a week" is a plan to drive
that column to its bottom row.

**(c) Churn.** With an **invented** elasticity (quit probability `κ × rate paid`), at E[rounds] = 250
the argmax collapses from 2,000 bps to 1,500 at κ=0.05 and to **0 bps** at κ=0.25. **A player who pays
20% to leave needs only a 2.3% chance of never coming back (κ=0.115) for the shipped setting to be
net-negative.** That is not implausible; it is unmeasured.

### 4.5 The hard constraint bites here, and the analysis stops

**The revenue-maximising horizon for models A and C is ×4.0 — 2,264 steps against a 1,920-step fight,
i.e. a setting where the penalty never reaches zero before the bell.** That peak is only reachable by
**deleting the free option**, which converts an option premium into an exit toll and removes the one
property that makes the design defensible. Model D prices that identical cell at **$0.0000**. The peak
exists only while demand does not respond.

Per the standing constraint — model only what could be printed in the rules without changing its value
— **this is where the analysis ends rather than continues.** The setting pays while players are
inattentive, not while they are uninformed, and the disclosure is already shipped in three places.
Reporting that is the result.

### 4.6 Verdict: put $0.00 in the plan

```
ROBUST      P(early extract) = 0            $0.0000/round   fee alone = 1.0000% of gross
MODELLED    A / B / C at the shipped setting  $0.71 / $1.71 / $1.21 per round
OPTIMISTIC  §11.1 uniform random cursor      $5.1682/round
ENTRY FEE   for scale                        $3.3501/round, ZERO variance
GAS FLOOR                                    $1.4715/round (pre-reclaim), $0.0615 (post)
```

**Do not move `EXTRACT_PENALTY_START_BPS`.** Under the only realistic demand model the shipped value is
already at **96.8%** of the peak, and the entire available gain is **$0.056/round — about $1.84/hour**.
The constant has **no setter** (`lib.rs:197-198`), so capturing that would cost a program upgrade
against live rounds, an IDL bump and the full mirror-parity chain re-asserted, to chase a behavioural
guess with zero observations behind it, on a dial the roadmap is already zeroing.

**The cheap move is the opposite one: render `secondsToFree`, which is already computed, and read
`Treasury.penalties_accrued`.** That would be the first observation this stream has ever had a chance
of producing — and it costs nothing but a component.

---

## 5. THE ONLY REAL PLAYER DATA IN THE PROJECT

`HOUSE-STRATEGY.md` §7 says "Nothing in the repo records it" and HOUSE-EDGE-STUDY.md §8 agrees. **Both
are wrong, and the reason is that the file is gitignored:** `engine/data/ledger.db`, a 299 KB SQLite
database in the working tree, 911 accounts, of which **11 have `isBot: false`**.

| wallet | staked | returned | **games** | wins | deposited | withdrawn |
|---|---|---|---|---|---|---|
| 3i858WZdTD | $10.00 | $9.42 | 2 | 0 | $400 | $0 |
| B9qgER94YU | $139.56 | $168.62 | 4 | 3 | $300 | $0 |
| AVAtA7C4Ho | $42.00 | $40.87 | **9** | 4 | $300 | $0 |
| AKiSHTgmiD | $20.00 | $20.93 | 1 | 1 | $120 | $15 |
| ALiMVrTrgz | $5.00 | $1.16 | 1 | 0 | $0 | $0 |
| DFdp5ENXrN | $100.00 | $74.24 | 1 | 0 | $800 | $400 |
| 9u7K9qbEdq | $30.00 | $27.47 | 5 | 4 | $600 | $0 |
| 7GEWhShPyE | $0.00 | $0.00 | 0 | 0 | $200 | $150 |
| 3LopeeQLwy | $10.00 | $12.09 | 1 | 1 | $100 | $90 |
| 8cML1s3gT7 | $16.99 | $14.10 | 5 | 3 | $100 | $90 |
| 55JG3J23GE | $20.00 | $4.38 | 1 | 0 | $80 | $10 |

**Rounds played: `[0,1,1,1,1,1,2,4,5,5,9]` — mean 2.7, median 1.**

**How much weight this deserves: very little, and it must be said before the number is quoted.** n=11.
Devnet play money. The wallet names (`You`, `@MJCryptoBD`) say these are the developer's own. It is a
DIFFERENT product — the custodial `engine/` server at a 20 bps rake, not the on-chain arena at 100 bps.
And `games` may be truncated by the observation window rather than by churn.

**But the direction is not subtle.** `strategy-retention.ts` models a 200-round horizon. The only
observed horizon is **two orders of magnitude shorter**. If real retention is ~3 rounds, lifetime rake
is ~3% of bankroll, every curve in §2 collapses to its left-hand edge, and **no fee setting matters
much** — what matters is acquisition and whether anyone plays a second round at all.

---

## 6. CONVERSION SPREAD — a second revenue stream both prior documents missed

`engine/src/arenas.ts:40` declares `CONVERT_FEE = 0.003` with the comment "PumpSwap pool fee, swapped
on-chain at mainnet" — **and the comment is wrong about who earns it.** `engine/src/server.ts:1926-1935`:

> The player receives what the swap ACTUALLY returned, so pool fees and slippage come out of their
> amount rather than the vault's. **Our house cut is taken on top of that.**

The AMM fee is already inside the returned amount; `CONVERT_FEE` is skimmed after it and credited to
`convFees` (`engine/src/ledger.ts:93`). **The operator earns it.** That comment/behaviour mismatch is a
documentation defect and is flagged, not fixed.

From the same `ledger.db` `meta` rows:

| | |
|---|---|
| `convFees` | **$3,381.19** |
| `treasury` | $4,945.41 (normal) + $5,808.50 (extraction) = **$10,753.91** |
| `totalDeployed` | $2,553,824.93 + $2,947,793.55 = **$5,501,618.48** |
| `rounds` | 2,017 + 3,642 = 5,659 |

Rake as a share of deploy volume: $10,753.91 / $5,501,618.48 = **0.1955%**, which recovers the 20 bps
`FEE` to within rounding and validates the reading. **Conversion revenue was 31.4% of rake revenue.**

**The correct way to carry that number forward, which is not the naive way.** The 31.4% ratio was
earned against a **20 bps** rake. Per unit of deploy volume, convert revenue is 6.15 bps against the
rake's 19.55 bps. At the arena's current **100 bps**, the same conversion behaviour would be worth
roughly **6% of rake, not 31%.** Quoting 31.4% at the current rate would overstate it fivefold.

### 6.1 The obvious argument for it is WRONG, and it was measured rather than reasoned

The intuitive case — "a spread scales with volume rather than with losses, and is charged once per
cycle rather than compounding every round, so it is gentler on player lifetime" — **is false.** At
matched lifetime revenue, spread-only versus flat rake (20,000 lives per row):

| mechanic | p(convert) | spread | lifetime rake | 95% CI | rounds lived | player sd/round | ruin |
|---|---|---|---|---|---|---|---|
| entry rake, flat 100 bps | — | — | $22.883 | ±0.397 | 37 | 31.98% | 5.6% |
| spread only | 0.020 | 2504 bps | $24.099 | ±0.809 | 38 | 31.96% | 5.2% |
| spread only | 0.100 | 486 bps | $23.780 | ±0.693 | 39 | 31.93% | 4.9% |
| spread only | 0.500 | 98 bps | $24.405 | ±0.714 | 39 | 31.86% | 5.0% |
| spread only | 1.000 | 50 bps | $23.511 | ±0.671 | 39 | 32.03% | 5.2% |

**Identical rounds lived, identical variance, identical ruin, at every conversion frequency.** A dollar
taken off a balance shortens a life by exactly as much however it is labelled. "Charged on volume, not
losses" and "once per cycle, not per round" describe the **accounting**, not the balance path — and the
balance path is what ends a life. I asserted the opposite earlier in this document on reasoning alone;
the measurement overturned it and the claim is withdrawn.

**What is true is the whole case for it: the spread is ADDITIVE.** Rake at 100 bps *plus* a 30 bps
spread raises lifetime revenue by **+3.8%** (p=0.02), **+8.7%** (p=0.10), **+28.3%** (p=0.50) and
**+52.4%** (p=1.0) — at unchanged rounds lived. It is a second stream, not a gentler first one.

### 6.2 The caveat that nearly voids the headline

**900 of the 911 accounts carry `isBot: true`. Bot deposits total $4,228,857; human deposits total
$393.55 — 0.0093% of the whole.** The $3,381.19 of `convFees` was therefore generated almost entirely
by the bot policy in `server.ts`, not by human demand. **The plumbing is proven; the volume is not
evidence about people.** The implied conversion ratio (one dollar converted per 5–16 deployed) is a
statement about a bot's configuration and should never be quoted as a demand estimate.

Modelled at the arena's own volumes, the shipped 30 bps spread is worth **$0.031–$0.102/round at four
real players** — 1.8%–6.1% of the entry fee alone, and **0.02–0.07× the pre-reclaim gas**. It does not
pay for a round on its own at any volume yet observed.

Finally, ARENAS.md is explicit that "Price drift between the two is the house's exposure" — so a
conversion spread is partly **payment for inventory risk the operator already bears**, not free alpha.
The surplus fraction is unmeasured.

---

## 7. THE OUTSIDE VIEW — what comparable products actually charge

§2 proves the fee answer depends on one unmeasured elasticity. Nothing in this repository can measure
it. But other people have measured it on other products, and that external evidence is the only thing
that can discipline the guess. Sourced separately; reliability graded **[A]** regulatory/peer-reviewed,
**[B]** operator disclosure, **[C]** industry analysis, **[D]** anecdote.

### 7.1 The headline rate is at the market. The velocity is not.

**1% per round is the crypto-casino Schelling point.** Stake, BC.Game and Roobet independently
converged on exactly **99% RTP / 1.00% house edge** for provably-fair originals (crash, dice) — and
crash games are the *only* comparable-velocity product in the entire comparison set [B]. Per entry, the
arena is cheaper than Polymarket (2.0–3.5% of stake [B]), Kalshi (3.5% at 50¢ [B]), online poker
(≈5% of pot at micro stakes [C]) and Solana PvP wagering platforms (~5% [C]).

**But the honest modelling unit is per hour, and there the picture inverts.** At `f = 1.0` and 32.7
rounds/hour, `(1 − 0.01)^32.7 = 0.720` — **28.0% of bankroll per hour**, half-life 69 rounds ≈ 2.1 hours.

| product | loss/hour as % of committed bankroll |
|---|---|
| **this arena at f = 1.0** | **28%** |
| slot machine ($1 × 600 spins × 8% hold on a $100–250 session bankroll) | 19–48%, central ≈32% |
| online poker cash, 100bb stack (7.3 bb/100 × ~100 hands/hr) | ~7% |
| blackjack (12.2% hold of drop per 2–3 hr visit) | ~5% |
| roulette (00) | ~4% |

**The arena is squarely slot-machine harsh, ~4× online poker and ~6× a table game — and the cause is
entirely velocity, not rate.** Which yields the single most useful external conclusion:

> **The redeploy fraction `f` is a bigger lever than the rate.** Halving `f` from 1.0 to 0.5 takes the
> hourly burn from 28.0% to 15.1% and roughly doubles bankroll half-life. Halving the *fee* does the
> same thing to revenue-per-round that halving `f` does, but `f` costs the house nothing per round —
> and §3 already shows the shipped `perRoundCapUsd = $100` is a lever on `f` that is **already
> deployed**.

### 7.2 The elasticity: this product is in the elastic cluster, not the inelastic one

The published literature splits in two, and which half applies turns on **one variable: whether the
player can compute the price.**

- **Concealed price → near-inelastic.** Lucas & Singh (2011) [A]: 10,000 simulated players could not
  reject equal payback between a **3% and a 12%** house-edge slot — a 400% price increase. Lucas &
  Spilde (2018–2021) [A]: visually identical live-floor machines at pars from **7.98% to 14.93%** over
  nine months showed **no migration** to the cheaper game.
- **Posted, computable price → elastic.** Thalheimer & Ali (1995), *Management Science* [A], on
  parimutuel racing 1960–1987: "**demand is price elastic in every case**." Casino slot handle
  elasticity w.r.t. win percentage ≈ **−1.1 to −1.4** (Thalheimer & Ali 2003 [A]; Landers 2008
  disagrees downward — a genuine dispute).

**Do not import the "players cannot detect price" result.** Its necessary precondition — concealed par,
visually identical machines, no A/B comparison possible — is *inverted* by an on-chain contract with a
public `fee_bps` field, a published study, and a population that self-selects for people who compute
things. The right comparable is parimutuel racing: posted takeout, high-frequency recyclers, elastic
demand.

**Working prior: elasticity of volume w.r.t. effective rake ≈ −0.8 to −1.5, centred near unit-elastic.**
Labelled as an assumption; nobody has measured it for this product class, which is a genuine gap in the
literature.

**And unit-elastic is exactly the flat-curve case the brief asked about.** If volume falls roughly in
proportion to the rate, revenue is roughly *flat* in the rate over a wide band. That converges with
§2's closed form from the opposite direction: one says lifetime revenue is sharply concave and mostly
captured at 100 bps, the other says revenue is near-flat around it. **Both say the fee is not where the
money is.**

### 7.3 The one structure every mature operator chose, and this arena did not

| operator | headline | give-back |
|---|---|---|
| online poker rooms | 3–5% of pot | **hard cap $3–$5** → effective rate falls ~13× from micro to mid stakes [C] |
| FanDuel / Flutter, Q4 2025 | **15.5%** structural margin | **8.9%** net — ~43% recycled as promo [A] |
| Rollbit | 5% edge | up to **70% of house edge** returned via staking [B] |
| Polymarket | 2–3.5% taker | 25% maker rebate; tiered taker rebate to **50%** [B/C] |
| Kalshi | 3.5% taker | maker = **25%** of taker [B] |
| **this arena** | **1.00%** | **none** |

**Four independent industries converged on the same structure — a high headline rate with heavy,
volume-graduated give-back. A flat, uncapped, un-rebated rake is the one structure none of them chose.
That is the strongest external signal in this research, and it points at fee *structure*, not fee
*level*.** Note the poker rationale transfers exactly: a cap exists so the highest-volume players are
not driven out, because they are the liquidity.

### 7.4 The 20% exit penalty is the most externally exposed number in the design

| benchmark | margin |
|---|---|
| Betfair Exchange cash-out vs manual green-up | ~**2%** [D] |
| sportsbook cash-out haircut, widest credible range | **5–15%** of fair value [D] |
| **`EXTRACT_PENALTY_START_BPS`** | **20%** |

Every cash-out margin figure in public is [D]-grade — **there is genuinely no reliable public data**,
and I will not manufacture a point estimate. But every quoted range tops out below 20%, and the
exchange-style convenience price is an order of magnitude lower.

**The causal finding is the actionable one.** Bennett et al. (2024), *Psychological Science* [A], n=240,
two randomised experiments: **the availability of a cash-out option increased bet sizes by up to 35%**,
because being able to avoid losing the whole stake makes larger bets feel acceptable. Cashed-out funds
are also immediately re-stakeable, prolonging sessions.

> **So the *feature* is revenue-accretive independently of the *price*.** Those are two separable
> levers and the design currently conflates them. The extract button plausibly raises stake size and
> re-staking velocity — which raises rake, the stream that actually survives (§4.4) — while the 20%
> opening rate is above every external benchmark and, per §4.6, worth only $0.056/round to optimise.

### 7.5 What the outside view says does *not* exist

Stated so nobody fills the gap with vendor content: **no published relationship between house edge and
player lifetime or survival curve**; **no operator-disclosed LTV-vs-hold analysis**; **no measured
attrition response to an inactivity fee**; **no % of handle cashed out at any sportsbook**. Every
"LTV vs RTP" figure returned by search is unsourced iGaming vendor marketing and none of it belongs in
a model.

Also relevant to §8: **a carry on idle balances has no real-world analogue at a sub-monthly timescale.**
Every documented example (bet365: €2/mo or 5% of balance after 365 days [B]; UK operators generally at
~12 months) is annual, and the UK Gambling Commission requires such fees to be **cost-reflective rather
than a revenue lever**. Interactive Brokers abolished its $10–20/mo inactivity fee on 1 July 2021
explicitly so there would be "no impediments to maintaining an account" [A/B], and the brokerage
industry followed.

---

## 8. THE FOUR NEW MECHANICS, RANKED

```
cd engine
npx tsx ../sandbox/house-edge/strategy-mechanics.ts 20000 4000
```
20,000 player-lives per cell; 4,000 real 16-seat fights per adversary cell. The script asserts its own
schedule engine against `lifetime-core`'s `simulateLife` on 2,000 paired lives (worst |rake diff|
**$0.000000000000**) and exits non-zero if that ever fails.

### 8.1 Fee structures — one of them must never ship

| schedule | lifetime rake | 95% CI | player sd/round | ruin | **drained by a 16-seat adversary** |
|---|---|---|---|---|---|
| **flat 100 bps (today)** | **$23.473** | ±0.401 | 31.91% | 5.6% | **0.0% — sybil-immune** |
| tiered marginal 25/100/125 | $23.562 | ±0.428 | 32.05% | 4.8% | **75.0% — FARMABLE** |
| tiered cliff 25/100/100 | $23.613 | ±0.414 | 31.96% | 5.0% | **75.1% — FARMABLE** |
| rake cap $0.25/entry | $7.869 | ±0.117 | 30.85% | 5.0% | 0.0% |
| rake cap $1.00/entry | $23.520 | ±0.405 | 31.89% | 5.2% | 0.0% |
| **50 bps entry + 391 bps on winnings** | $23.384 | ±0.432 | **31.32%** | 5.4% | 0.0% |
| 0 bps entry + 770 bps on winnings | $23.190 | ±0.460 | **30.81%** | 5.1% | 0.0% |
| flat $0.05/entry ticket | $1.923 | ±0.025 | 29.77% | 9.1% | 0.0% |
| flat $0.737/entry (matched) | $23.689 | ±0.325 | 29.77% | **21.9%** | 0.0% |

> **THE TIERED RATE CARD IS THE $150.87/ROUND SYBIL FARM WEARING A RATE CARD INSTEAD OF A DAMAGE
> RULE, AND IT MUST NOT SHIP.** An $80 stake paying 100 bps yields $0.80. Split across 8 wallets of
> $10 in a 25 bps band it yields `8 × $10 × 0.0025 = $0.20`. **75% drained, worth $472/day to one $80
> adversary.** There is no learning curve — the attack is one subtraction on the published card, so
> the answer to "how fast does a sophisticated player neutralise it" is **ONE ROUND**. Marginal
> brackets do not help: they still leave 75% drained. Per the hard constraint, disclosure IS the
> exploit here, so **the analysis stops rather than continues.**

The fight itself pays nothing for splitting — re-confirmed at zero fee across k = 1…16, worst
deviation **0.64σ**, reproducing §11.5. The farm is entirely in the rate card, not the game.

**Rake caps** remove 41–67% of revenue off the top of the stake distribution, which is where the volume
is (a $1.00 cap is nearly inert only because `STAKE_CAP_USD = 100` already binds). **The flat ticket**
is violently regressive — a **2000×** effective-rate spread from $0.01 to $100 — and is reverse-farmed
by consolidating; at matched revenue it takes ruin from 5.6% to 21.9%.

**The one structural improvement available: a settlement rake.** Moving from "100 bps on entry" to
"50 bps entry + 391 bps on winnings" costs **−1.2% revenue** and buys **−3.5% player variance**. It is
proportional, split-neutral, sybil-immune, and taxes winners rather than turnover — and lower variance
is what buys lifetime. **Unexpected bonus:** its effective rate *rises* toward small stakes
(E[(R−1)⁺] = 0.1729 at $5 vs 0.1222 at $80 — small fighters have fatter positive tails), so the tilt
runs 1.21× **against** the splitter, bounded by the pool rather than by a design choice. It needs a new
instruction and therefore a deploy.

### 8.2 Cadence — contributes exactly zero, as an identity

My challenge to the first-pass result was confirmed, and the flaw was worse than I suspected. Under a
per-round hazard, the simulator **never reads the cadence**: churn, stake rule and payoff draw are all
per-round, so at a fixed fee the 8/hr and 32.7/hr cells are *literally the same simulation*. The first
pass seeded on the cadence label, turning a structural identity into two independent samples that
merely landed close. Reseeded on model parameters:

```
|rake(8/hr, 100bps) − rake(32.7/hr, 100bps)| = $0.000000000000
|rake(8/hr, 409bps) − rake(32.7/hr, 409bps)| = $0.000000000000
```

**Factorial decomposition of the $41.910/player move: FEE 100.0%, CADENCE 0.0%, interaction 0.0%.**
Under a per-*hour* hazard, where cadence genuinely enters, it is **−8.6%** — and slowing the cadence at
a fixed fee costs **−75.6% of revenue per player-day**.

**Where cadence actually lives:** `net/hour = c × (rev/round − gas)`. Both terms are linear in `c`, so
cadence cannot change the **sign** of profitability, only its magnitude. It survives solely as **idle-
arena cost control**: at zero real players, slowing 32.7 → 8 rounds/hr cuts burn from $48.16 to
$11.77/hr — **−$873/day**. Given `realFighterCount: 0` on the live board, that is not a small finding.

**And the 409 bps recommendation it was bundled with dies inside the prior.** With `N(φ) = N₀(φ/φ₀)^ε`
it dies at **ε = −0.827** fee-only and **ε = −0.257** bundled with the slow cadence — both at or inside
the imported −0.8/−1.5 band, the bundled version at a third of the optimistic end. **Do not ship
409 bps.** Measure ε first (§0).

### 8.3 Carry on parked capital — exactly $0.00, and bounded by inflow even under custody

Verified from source rather than cited: zero occurrences of `anchor_spl`/`token::transfer`/
`TokenAccount` in the program, `Enter<'info>` carries 5 accounts and none is a token account,
`programs/vault` is out of the workspace and still declares `VauLt1111…`. **There is no parked capital
to charge a carry on. Revenue today is $0.0000/round at every rate.**

Under custody (Regime B), the binding constraint is not the rate:

| bps/day | dormant AUM needed to pay for ONE round of gas ($1.4715) |
|---|---|
| 1 | **$11,557,964** |
| 10 | **$1,155,796** |
| 100 | $115,580 |

And with a withdrawal hazard rising in the rate (**invented** elasticity), revenue `D·x/(h₀+κx)`
**saturates at `D/κ`** — a ceiling set by dormant *inflow*, not by the rate. At κ=20 the carry cannot
pay the gas at any rate unless dormant inflow exceeds **$23,116/day**. Active players are untouchable
regardless: 100 bps/entry at 32.7 rounds/hr is **28.03%/hour**, against which a 100 bps/*day* carry is
673× smaller. **Not worth building.**

### 8.4 Final ranking

| # | mechanic | $/round | neutralised how fast | survives disclosure | needs custody | needs redeploy | **status** |
|---|---|---|---|---|---|---|---|
| **1** | conversion spread *(already shipped in `engine/`)* | $0.031–$0.102 | never — it prices an action players want | **yes** | has it | **no** | **BET on ρ** (evidence 99.99% bot) |
| **2** | settlement rake (50+391 bps) | revenue-neutral, −3.5% player sd | never — proportional, split-neutral | **yes** | no | yes | **measurement** |
| 3 | cadence, as idle-cost control only | −$873/day at zero players | n/a — a cost structure | yes | no | no | **measurement** |
| 4 | rake cap | −41% to −67% | by consolidating to the $100 cap | yes, pays less | no | yes | not worth doing |
| 5 | flat per-entry ticket | regressive 2000× | by playing bigger | yes, and ugly | no | yes | not worth doing |
| 6 | carry on parked capital | **$0.0000** | by withdrawing | yes | **required, absent** | yes | not worth doing |
| ✗ | **tiered by stake** | **negative** | **ONE ROUND, 75% drained** | **NO** | n/a | n/a | **DO NOT SHIP** |

Against the **post-reclaim** gas floor of $0.0615/round: the entry rake at four real players ($5.028)
covers it **82×**; the conversion spread covers it 0.5–1.7×; the carry, zero.

---

## 9. HOUSE COUNT AS A POLICY — `H = f(R)`

```
cd engine
npx tsx ../sandbox/house-edge/strategy-house-count.ts 1000 400 800
```

> "the number of players that join from the house can be variable and dynamic… We can optimize the
> player count from the house to maximize the profit and we can simulate that."

### 9.1 First-order: confirmed negative, and tested as a residual rather than by eye

If the house book is zero-mean, `residual = housePnl + feeHouse + penHouse` must be zero at every `H`:

| H | 1 | 2 | 4 | 6 | 8 | 10 | 14 |
|---|---|---|---|---|---|---|---|
| residual $/round | −0.05 | +0.06 | −0.45 | −0.04 | +0.08 | −0.17 | −0.10 |

**Combined 95% CI `[−$0.316, +$0.115]` — zero inside.** House count cannot move expected profit.
`min(attacker.hp, defender.hp)` holds.

**That negative is also a control variate, and it is the methodological result here.** If the house
book is zero-mean then `E[net] == E[fee_real + penalty_real]` *exactly* — so measuring the second
quantity removes a $7–$11/round standard deviation. Both estimators agree at every `H` (at H=8: $2.818
vs $2.656) while the CI is ~2× tighter, i.e. **4× fewer samples for the same answer.** Without it the
surface is pure noise: an earlier draft's "significant" policy differences all evaporated once the
house book was stripped out.

### 9.2 The answer

| R | optimal H, cap 16 | optimal H, cap 48 |
|---|---|---|
| 0 | **0** | **0** |
| 1 | **1** | **1** |
| 2 | **1** | **1** |
| 4 | **1** | 1 * |
| 8 | 0 * | 2 * |
| 16 | **0** | 24 * |

`*` = not statistically separable from other `H` on that row (paired 95%); the row is flat and the
"optimum" is a sampling artefact.

> **The optimal shape is: `H = 0` when nobody real is in the room; otherwise exactly the `cover`
> fighter, and nothing more. It is identical at cap 16 and cap 48.**

**Two effects that must not be conflated.** At R=2, cap 16:

| P(extract) | COVER (H = 0→1) | BOARD SIZE (H = 1→8) |
|---|---|---|
| 0.00 | **+$0.430** [0.398, 0.463] | −$0.005 |
| 0.30 | **+$1.616** [1.396, 1.857] | −$0.142 |
| 0.60 | **+$2.630** [2.351, 2.925] | −$0.264 |

**Cover is worth 10–20× the board-size term at every extraction rate — and the board-size term, which
is the owner's actual question, is small and NEGATIVE.**

| policy | mean H | E[net] $/rd | vs deployed | house capital | circular | fightable |
|---|---|---|---|---|---|---|
| DEPLOYED ladder | 5.20 | $3.550 | — | $62.57 | 15.0% | 80% |
| **`H` = cover only** | **0.32** | **$3.639** | **+$0.093** [0.061, 0.127] **BETTER** | **$4.02** | **1.1%** | 80% |
| `H` = 2 constant | 1.60 | $3.571 | +$0.024 better | $19.73 | 5.2% | 80% |
| fill to T=16 | 9.80 | $3.544 | −$0.009 n.s. | $122.63 | 25.7% | 80% |
| fill to T=48 | 25.60 | $3.477 | **−$0.088 WORSE** | $321.09 | 48.0% | 80% |
| `H` = 0 | 0.00 | $2.901 | **−$0.644 WORSE** | $0.00 | 0% | **48%** |

**`H` = cover-only beats the deployed ladder by 2.6% while holding $4 of capital instead of $63.** And
`H = 0` loses 18% of revenue for a reason that is not about the fight at all: half of two-real-player
lobbies land both players on the same side, where **no fight can happen**. The cover fighter is not
liquidity optics — it is the difference between a round and no round.

**Circular fees** scale exactly as expected: treasury overstates net revenue by 1.00× at H=0, **1.62×**
at the deployed ladder with one real player (45.2% circular), and **48.0% circular** at fill-to-48.

**Ruin (Regime A) is a countdown, not a probability** — the program moves zero tokens, so the ~3.09 SOL
is gas: 7,537 rounds (230 h) at H=0 against 4,828 rounds (148 h) at H=46, post-reclaim. Pre-reclaim the
same balance bought 315 rounds (9.6 h).

### 9.3 The caveat that limits all of it

**The sign of the board-size term is set entirely by an unmeasured behavioural assumption.**
Uniform-on-the-horizon extraction → argmax `H = 1`. Uniform-on-the-whole-fight → argmax `H = cap`.
Nobody has measured which describes real players. The magnitude is a few percent of revenue either way,
and **the `cover` term is the only part of the policy supported by evidence rather than assumption.**
This is the same ρ from §0: *when* players press extract decides it.

---

## 10. `MAX_FIGHTERS` 16 → 48: THE MIGRATION LANDED MID-ANALYSIS, IT WAS DONE CORRECTLY, AND MY RECOMMENDATION WAS WRONG

**Everything I wrote in this section as a warning is now history, and one of my recommendations was
actively harmful.** The migration shipped while the sweep was running: `MAX_FIGHTERS` is **48** in both
`programs/bulls-arena/src/lib.rs:240` and `engine/src/er-sim.ts:62`. Both defects I identified were
real, and both are fixed. This section is kept as the before/after record rather than rewritten to
agree with the outcome.

### 10.1 Defect 1 — a guardrail that worked

`const PENALTY_HORIZON_STEPS: [u16; MAX_FIGHTERS - 1]` (lib.rs:852) has its **length type-parameterised
on the cap**, so raising the constant without extending the table is a **compile error**. The build
stops you. The TypeScript mirror was the unprotected one (`BigInt(undefined)` → `TypeError`).

**Fixed correctly, and verified here:** the table now has **47 entries** for n = 2..48, and every one
equals `round(25·n^1.5)`. Checked directly — `n=8 → 566`, `n=16 → 1600` (both **unchanged**), `n=48 →
8314`. **No existing lineup was repriced.**

### 10.2 Defect 2 — the one with no guardrail, and the fix is better than the defect

`MAX_STEPS = 4_000` saturated the step budget for every n ≥ 17 while fight length grew as `25·n^1.5`,
crossover at **n ≈ 29.5**. At n=48 a fight needed 8,314 steps and had 4,000 — 48% of what it needs.

**`MAX_STEPS` is now gone.** lib.rs:355 states the diagnosis exactly: *"THIS REPLACES `MAX_STEPS`,
WHICH WAS DOING TWO JOBS AND IS THE SINGLE REASON THE CAP COULD NOT MOVE."* It is split into
`MAX_STEPS_PER_CALL = 3_000` (a compute bound on one instruction) and the bell as the cursor ceiling,
with `FIGHT_TIMEOUT_SECONDS` **120 → 180**. So `budget(n) = 360n` with **no saturation**.

| | v7 (before) | v8 (now) |
|---|---|---|
| budget at n=48 | 4,000 (saturated) | **17,280** |
| horizon at n=48 | 8,314 — **never reached** | 8,314 = **48% of the round** |
| fights reaching a conclusion, n=32 | **0.0%** | **62.3%** |
| fights reaching a conclusion, n=48 | **0.0%** | **55.0%** |
| expected exit toll, n=16 → n=48 | 278 → **1,519 bps** | 278 → **481 bps** |

**Value conservation held in integers in every round of every cell under both branches — zero
failures.** Payout dispersion barely moves: `sd(real ROI)` 0.251 at n=16 → 0.224 at n=48.

### 10.3 MY BRANCH (B) RECOMMENDATION WAS WRONG, AND THE ERROR IS INSTRUCTIVE

I recommended **clamping the horizon at n=16's 1,600 steps** and argued it needed no code change. That
would have **collapsed the penalty stream**: penalty revenue at n=48 would be **$0.403/round against
the $1.675 actually shipped — a 76% loss.**

**The error was scope.** I evaluated the horizon while holding the bell fixed at `MAX_STEPS = 4000`,
because that is what the code said when I read it. Under *that* constraint branch (A) really did break
the mechanic — the horizon would have outrun a fight that could never reach it. The migration changed
the binding constraint underneath the recommendation: by lengthening the bell to `360n` it made
branch (A) correct and my branch (B) harmful. **I optimised one constant against another that was
itself about to move, and did not flag the pairing as load-bearing.** The lesson is the one this
document keeps re-learning — the horizon and the bell are a *ratio*, and neither is meaningful alone.

Measured against the program's own criterion, the shipped result is the good one: under v7 the expected
exit toll would have run 278 → 1,519 bps as the board grew, a floor no player could ever wait out —
the *"design goal fails outright"* case. Under v8 it runs 278 → 481 bps and **remains a genuinely
decaying option.**

### 10.4 Verdict on the bigger board: it neither helps nor hurts the house

**And that is the whole finding.** §9 shows the optimal policy never wanted more than one or two house
seats, so **the extra 32 are unusable for revenue.** The "surface this loudly if a bigger board is
worse" trigger does **not** fire — the migration fixed both defects, preserved the penalty curve exactly
for every existing lineup, and lengthened the bell rather than accelerating the fight.

What it costs: Round PDA rent **0.009243 → 0.023497 SOL (2.54×)** — float while `close_round_account`
is running, but the dominant per-round cost if it ever stops — a 180-second round instead of 120, and
~2.4 SOL of the 3.09 on hand to deploy. **In Regime A the seat count generates no revenue at all, so
that spend has no payback period. It is a product decision and should be argued on product grounds.**

**This raises the stakes on §1's program-id finding.** Round rent is now 2.54× larger, so the keeper
running against a program without `close_round_account` is 2.54× more expensive than it was.


## 11. THE RECOMMENDED CONFIGURATION

**Almost all of it is "leave it alone", and the one big win is an operations fix rather than an
economics one.**

| setting | now | **recommended** | why | evidence |
|---|---|---|---|---|
| `Arena.fee_bps` | 100 | **100 — unchanged** | η\* = 0.90 sits at the low edge of the imported 0.8–1.5 band, so the optimum is at or slightly below where it already is | §2.3, §7.2 |
| `EXTRACT_PENALTY_START_BPS` | 2000 | **2000 — unchanged** | already 96.8% of the peak under the only realistic demand model; the whole available gain is $0.056/round and the constant has no setter | §4.6 |
| keeper program id | **v6** | **v7 (`EpRY6…`)** | **24× gas reduction, already built and enabled by default** | §1 |
| tiered rate card | — | **never** | 75% drained in one round by a published-card adversary | §8.1 |
| carry on parked capital | — | **do not build** | $0.00 without custody; bounded by inflow with it | §8.3 |
| cadence | ~110 s | unchanged when busy; **slow it when idle** | contributes 0.0% of revenue; worth −$873/day at zero players | §8.2 |
| **house count `H = f(R)`** | ladder to 10 | **`cover` only (mean H ≈ 0.3)** | **+$0.093/round and $4 of capital instead of $63**; the extra seats are pure variance | §9.2 |
| `MAX_FIGHTERS` → 48 | **landed** | accept; argue it on product grounds | no revenue payback, but correctly executed | §10.4 |
| settlement rake | — | **the only structure worth a deploy** | −1.2% revenue for −3.5% player variance, sybil-immune | §8.1 |

### 11.1 Expected revenue, and its variance

Per acquired player at 100 bps (`BASE_PLAYER`, n=20,000): **lifetime rake $23.54 ±0.41** over **37.9
rounds**, of which gas takes **$2.33 post-reclaim** (was $55.77 pre-reclaim) — **net $21.21, covering
gas 10.1×.**

Per day at four real players per round, 785.5 rounds/day:

| | pre-reclaim | **post-reclaim** |
|---|---|---|
| rake (1% of $165.87/round) | $1,302.9/day | $1,302.9/day |
| gas | −$1,155.8/day | **−$48.3/day** |
| **net** | **$147.1/day** | **$1,254.6/day** |

**The program-id fix alone is worth ~$1,108/day at that volume — roughly 8.5× the entire current net.**

**Variance:** the fee itself has **zero** variance — it is arithmetic applied at `enter`, not a
statistical edge (§11.1 of the study; the CI is degenerate). All house-side variance comes from house
*fighters*, which have zero expectancy (§3 of `HOUSE-STRATEGY.md`). With zero house seats the rake
accumulates arithmetically from round one.

### 11.2 What would falsify this

Stated in advance, as kill criteria rather than as caveats:

- **ε measured above ~1.0** → the fee is too high; lower it. **ε below ~0.7** → raising it is justified
  and §2.4's table becomes the operative one. This is the single measurement that would most change
  the recommendation.
- **`Treasury.penalties_accrued` still 0** after `secondsToFree` is rendered → the penalty stream is
  confirmed dead and every "~3% take rate" figure in `HOUSE-STRATEGY.md` §2 must be restated at 1%.
- **`realFighterCount` stays 0** → none of this matters. The arena has never had a paying round, and no
  fee setting reaches break-even from zero volume.
- **Real retention near the observed median of 1 round** → lifetime rake is ~$2.42/player against
  ~$4.03 of pre-reclaim gas, the entire legal fee range moves it by $19.72, and the only variables
  that matter are acquisition and retention — neither of which the fee touches.
- **Acquisition cost was not modelled at all.** "Revenue per acquired player" is half a business; a CAC
  above ~$23 inverts every conclusion here.

---

## 12. Reconciliation of the keeper constants

The brief asked whether `sandbox/house-edge/strategy-live-policy.ts` and `HOUSE-STRATEGY.md` §2.1 had
gone stale against the keeper. **They have not — the values are current.** Verified against the live
defaults:

| constant | sandbox / §2.1 | live | source |
|---|---|---|---|
| `HOUSE_WALLET_COUNT` | 10 | 10 | `config.ts:524` |
| `HOUSE_BOARD_TARGET` | 10 | 10 | `config.ts:604` |
| `HOUSE_DISPLACEMENT` | 1 | 1 | `config.ts:626` |
| `HOUSE_STAKE_MIN/MAX_USD` | $5 / $20 | $5 / $20 | `config.ts:644,645` |
| `HOUSE_FLOOR` | 2 | 2 | `houseSizing.ts:71` |
| `HOUSE_MAX_WITHOUT_REAL_PLAYER` | 1 | 1 | `houseSizing.ts:114` |

**What HAS drifted is the citations, not the values.** `HOUSE-STRATEGY.md` §2.1 and the header comment
of `strategy-live-policy.ts` cite `config.ts:539`, `:551` and `:570` for board target, displacement and
stake max; the file has grown and they are now `:604`, `:626` and `:645`. `:524` is still correct.

**And one framing correction.** §2.1 records the policy change as having been made by "another writer
mid-session" with the direction of change treated as an unexplained event. It is now a committed change
with a written rationale — `e0bfb82`, "keeper: fill the board, and close the treasury hole that filling
it would have widened", which argues the seat increase and explains that the stake band was *lowered*
$5–50 → $5–20 deliberately because "liveliness is bought with SEATS; risk is created by STAKE." That
does not change any measured number in §2.1, but it does change whether the change should be read as
drift or as design.

---

## 13. Reproducing this

```
cd engine
npx tsx ../sandbox/house-edge/parity.ts                              # validate the rig FIRST
HE_FEE_BPS=100 npx tsx ../sandbox/house-edge/parity.ts

npx tsx ../sandbox/house-edge/strategy-lifetime.ts 20000 all         # §2.2, §2.3, §2.4, §3, §5   (~8 min)
HE_FEE_BPS=100 npx tsx ../sandbox/house-edge/strategy-penalty.ts 20000  # §4                      (~4 min first, 16s cached)
npx tsx ../sandbox/house-edge/strategy-mechanics.ts 20000 4000       # §6, §8                     (~4 min)
npx tsx ../sandbox/house-edge/strategy-house-count.ts                # §9, §10.4
```

Files added by this study, all in `sandbox/house-edge/`, none imported by anything shipped:

| file | what it is |
|---|---|
| `lifetime-core.ts` | the shared core: the validated payoff pool, `PlayerModel`, `simulateLife`, `verifyPool` |
| `strategy-lifetime.ts` | the fee curve, the η\* inversion, the sensitivity table, the `ledger.db` calibration |
| `strategy-penalty.ts` | the extract penalty priced as an option; the `(START, horizon)` surface |
| `strategy-mechanics.ts` | carry, conversion spread, fee structures, cadence; the 16-seat adversary |
| `strategy-house-count.ts` | the house-count policy `H = f(R)` at seat caps 16 and 48 |

**The pool.** The first run of any of these builds ~150,000 real fights on `er-sim.ts` (~4 minutes) and
caches it outside the repo; later runs load it in milliseconds. `verifyPool()` runs first and prints a
pass/fail — **if it fails, discard every number downstream.** Every script is seeded and reproduces
exactly; `strategy-lifetime.ts` was run end to end twice and every number is byte-identical.

**What the rig asserts about itself, so a reader knows what is load-bearing:**
- `parity.ts` — `BASELINE` is byte-identical to `engine/src/er-sim.ts` over 300 random lineups, at both
  20 and 100 bps.
- `verifyPool` — E[R] = 1 within **2.44σ** in every stake bin above $0.10.
- `strategy-lifetime.ts` Part 0b — the pool reproduces **300,000 real fights** on every mean.
- `strategy-penalty.ts` — reproduces HOUSE-EDGE-STUDY §11.1's four regimes to four decimals.
- `strategy-mechanics.ts` — its schedule engine matches `simulateLife` to $0.000000000000 on 2,000
  paired lives, and exits non-zero if it ever stops matching.
