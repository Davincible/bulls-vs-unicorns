# Favouring small players, and making the score swing — two disclosed mechanics, measured

Measured 2026-08-11 against the deployed algorithm (`engine/src/er-sim.ts`, asserted byte-identical to
`advance_fight` by `sandbox/house-edge/parity.ts`), at the live rate of **100 bps**, on the live
program **v8 `ECD1dX2fUSGVY25y2cHWHWXYUQr9XzfFdTxcMzHj7zKe`**, `MAX_FIGHTERS = 48`.

**Nothing was deployed. No Rust was touched. No TypeScript mirror was modified. No live setting was
changed. Nothing was committed.** All work is in `sandbox/house-edge/`, which nothing in `engine/`,
`er-demo/` or `programs/` imports. `fight-variant.ts` was extended **additively** — new optional
fields whose defaults reproduce the existing behaviour exactly — and `parity.ts` prints `PARITY OK`
after every such edit, at both `HE_FEE_BPS` unset and `HE_FEE_BPS=100`.

**Companion documents.** `HOUSE-EDGE-STUDY.md` measures the GAME. `HOUSE-STRATEGY.md` measures the
OPERATOR per round. `HOUSE-LIFETIME.md` measures the operator per acquired player. This document
answers two design requests against all three.

---

## 0. THE ANSWER, BEFORE THE EVIDENCE

**No disclosed mechanic gives the operator an edge, and this is not a tuning result — it is an
identity.** A published rule cannot tell the operator's wallets from anyone else's, so the advantage
it grants a small stake is granted to every wallet of that size. A player with budget `B` who splits
into `k` wallets of `B/k` receives exactly the treatment the rule intends for a genuine `B/k` player.
**The intended effect and the farm rate are the same function evaluated at the same point** (§1). The
operator is then the worst-placed participant to hold that rule: it pays $1.4715/round of keeper gas
nobody else pays against an attacker's $0.00075 signature, it must seat every round rather than
picking spots, its wallets are published, and by a standing rule it may never wear a verified face
(§6).

**Measured in a closed 800-player population where every dollar won is a dollar another simulated
player lost, conservation asserted in integers on every lobby and every round across 186 runs (max
residual: 0 micro-units), error bars over independent replicate populations:**

| mechanic | house gain $/day | a single **$80** attacker takes | attacker : operator |
|---|---|---|---|
| **`blend-20`** — the mildest setting a player would notice | **−$10,826** | **+$2,251** | **the operator LOSES; the attacker gains** |
| `blend-100` | +$17,003 | **+$13,276** | **0.78 : 1** |
| `gated-P100` | +$17,250 | +$1,559 | 0.09 : 1 |
| SHIPPED (control) | — | **−$285 ±1,497 — zero** | — |

At `P = 100` the attacker captures **78 cents of every dollar of incremental house revenue**, on $80 of
capital, at **16,239% per day**. The house's gain is bounded by the population; **the attacker's take
scales with their capital, with the number of attackers, and with how many arenas they sit in at once
— so every figure above is a per-arena floor.** Two attackers invert the ratio.

**The identity gate is the best structural result here and still fails on price.** It cuts the farm
8.5× while keeping the operator's gain — one actor holds one identity however finely it splits. But
the **break-even price of one X account is $116–$720 per wallet per day** (P = 20 to P = 100), against
a softreg account at **$0.07–$1.85**: 48 seats' worth of identities costs under $90 and restores the
full ungated farm. **There is no bonus large
enough for a real small player to feel and small enough for a farmer to ignore** (§4.5). Two
corrections follow: `TWITTER-CONNECT.md` is a **proposal, not built** (line 5), and it would prove
*one X account*, never *one human* — and house wallets are barred from linking, so this mechanic
favours real players and **not** the operator.

**The retention hypothesis is CONFIRMED, and then the mechanism turns out to be something else.**
Lifetime rake per acquired player does rise with the tilt — **$21.23 → $25.02** across `P = 0 → 100`,
18.1σ — **monotonically, no interior optimum**, so the revenue-maximising setting is the corner: the
v5 rule removed for being a $150.87/round farm. But it is not "a flatter loss curve" and it is not
even retention. It is **turnover**, checked as an identity at 100.0000 bps in every cell: deposits are
flat at $100 and withdrawals barely move; what moves is **turns per deposited dollar, 20.86 → 25.02.**

> **AND WITH THE $100 STAKE CAP LIFTED, THE BLEND LOSES MONEY (−$4.69, 3.0σ).** Its entire gain is a
> partial refund of a cost the cap imposes: the cap idles money above $100 outside the turnover the
> rake is charged on, and redistribution pushes it back under the ceiling. **The blend is a workaround
> for a parameter — and changing the parameter is worth 4.1× more: lifting the $100 cap is
> +$15.70/player (18.6σ) against the best blend's +$3.80, with NO farm rate, and it is an engine
> constant rather than a program change.** It also runs against the framing of the request, since it
> favours whales; it is reported because it is the largest revenue lever in the file (§4.3).

**Two further reversals worth reading before the tables.** The two objectives disagree and **the sign
flips**: `blend-10/20/40` raise revenue per acquired player while *lowering* revenue per day, because
lives lengthen faster than per-player value rises. And the **per-entry cap is not a benign
lifetime-extending device** — lowering it $100 → $5 stretches lives 60% and destroys **87%** of
lifetime revenue, because turnover is rounds *times* stake per round.

**The second request has a clean answer, and part of it is free.** The score is boring because the
board got bigger: **raising `MAX_FIGHTERS` 16 → 48 cut aggregate lead volatility by 1.69× at BANDS
stakes and 1.91× at equal stakes**, measured, fitted exponents −0.363 [−0.375, −0.351] and
−0.565 [−0.577, −0.553] against a predicted −0.500 (§5.1). **Seating 16 instead of 48 recovers that
for $0 and no redeploy.** If more is wanted, the candidate that clears all four bars is
**`retain`@stake + a mean-matched 1-in-32 spike**: each hit lands back in the attacker's *ring* up to
their original stake instead of into safe `banked` — which is where the shipped **ratchet** freezes
the score — and the die keeps its mean while growing a tail. **4.47× swing, 1.89× max excursion, split
farm $1.46 ±2.84 against a $1.83 ±1.10 shipped floor, and 1.8× FEWER on-screen exchanges**, which
answers the other half of the note: *"the visuals… maybe a little bit too erratic."* Fewer, larger,
more consequential hits.

**Two ideas fail loudly and both refute something I stated in advance.** **`surge`** — my own proposal,
argued from a martingale that *is* preserved marginally — opens a **+44.6%** band spread at 8 seats
and a **$4.33 ±1.58** split farm, because inside a run the attacker banks linearly while the defender
decays geometrically, and that convexity points at the smaller ring. **`comeback`** makes the score
**more** stable (0.89× swing, terminal dispersion 7.14 → 1.05) while paying **+370 points** for
joining the lighter side. And **any die that can exceed 100** wakes the `dmg > D.hp` clamp
asymmetrically: +31.1% spread and a **$15,841/day** farm (§5.3, §5.4).

**Two things the measurement found that nobody asked for.** The **stake-banded clamp (`capMult`) makes
the problem worse, not better** — tightening it from C = 1000 to C = 2 raises farm ÷ intended from
1.14× to 1.97×, because the splitter re-optimises `k` against the clamp while the honest player's stake
is fixed (§3.2). And **there IS one genuine small-player penalty in the shipped game**: the dust rule
costs a $0.01 wallet **~8.4% per round** against everyone else's 1.00% (§2.1). **Fixing that requires
no tilt and creates no farm** — a floor is not a gradient — and it is the one change in this document
that does what the request asked for without handing the same thing to a splitter.

**And the question the coordinator asked before closing this — answered, and it does not reopen it.**
Is there a tilt too weak to farm but strong enough to matter? **A window exists and it is worth
0.0047% per round to a $5 player.** Gas cancels out of the window's width, so it is **1.31× wide at
every gas price**; the attacker's break-even sits at **0.112 bps**, below the **1 bps** minimum the
u16 dial can represent; and the lifetime-revenue case needs **P ≥ 20** (§4.1: `blend-5` and `blend-10`
are both statistically zero). **The gap between "unfarmable" and "matters" is a factor of ~180×, and
raising the entry cost narrows the window rather than widening it** — the cost that would make a
meaningful tilt safe is **3.2× the entire rake per round**, which prices out the player it is for
(§3.7).

**Finally, the honest version of what was asked for.** The shipped fight is **already exactly
size-neutral** — `basis = min(attacker.hp, defender.hp)` gives a $5 fighter and a $100 fighter the
identical percentage risk, and every band sits at exactly minus the 1% fee. **That is a real and
unusual property, most arenas cannot claim it, and nobody is telling anyone.** It is worth more than a
subsidy that pays whoever opens the most wallets.

---

---

## 1. THE THEOREM: for any disclosed anonymous rule, the intended effect and the farm rate are THE SAME NUMBER

This is the load-bearing result and it is an identity, not a measurement, so it is stated and proved
before anything is measured. Everything after this section is an attempt to break it.

**Setup.** Let a disclosed mechanic grant a wallet of stake `s` an expected per-round return rate
`g(s)`, in fractions of that wallet's own stake, net of the fee. "Disclosed" and "anonymous" together
mean `g` is a function of the stake and nothing else — it cannot read who owns the wallet, because a
rule that could would not be a published rule.

**The intended effect.** A genuine small player with budget `s` receives `s · g(s)` per round.

**The farm.** An adversary with budget `B` splitting into `k` wallets of `B/k` receives
`k · (B/k) · g(B/k) = B · g(B/k)`. Their gain over entering as one fighter is `B · [g(B/k) − g(B)]`.

**The identity.** For the mechanic to favour small stakes at all, `g` must be decreasing. Then the
splitter's per-dollar rate at `k` wallets is `g(B/k)` — **exactly the rate the mechanic intends to pay
a genuine player of size `B/k`.** The farm rate per dollar of adversary budget and the intended effect
per dollar of honest stake are not merely similar; they are the same function evaluated at the same
point.

**Therefore there are exactly four things that can separate them, and only four.**

| separator | what it bounds | is it binding here? |
|---|---|---|
| the seat cap | `k ≤ 48` (`MAX_FIGHTERS`), less whatever seats others took | weakly — 48 is a lot of wallets |
| the minimum entry | `B/k ≥ $0.01`; below the dust floor the rule stops paying | only at absurd `k` |
| a per-wallet **cost** | must exceed the per-wallet **bonus**, every round | **measured below — it is not close** |
| a per-wallet **identity** | must cost more than the bonus's whole lifetime | **measured below — it is not close** |

**This is not a novel result and the outside literature agrees.** Humanode shipped an explicitly
square-root (small-favouring) retroactive airdrop, and it is defensible **only because biometric
proof-of-uniqueness sits underneath it**; against a cheap-identity attacker a concave payout curve is
strictly worse than a linear one, because it pays a bonus for splitting. PoolTogether V4 capped a
depositor at two prizes per draw specifically to bound whales, and its own governance forum records
the defeat in one line: whales split deposits across multiple wallets. Uniswap's flat 400 UNI per
address — the maximally small-favouring rule — was farmed openly. Sources and dates in §8.

### 1.1 The per-wallet cost is $0.00075 and the per-wallet bonus is $0.21 per round

The only cost a sybil pays per wallet per round is a Solana signature: **5,000 lamports = 0.000005 SOL
= $0.00075 at SOL $150**, and on the ephemeral rollup it is lower still. The keeper's 0.00981 SOL/round
(0.00041 post-reclaim) is paid by the OPERATOR and by nobody else — it is a cost of running the arena,
not of playing in it.

Against that, at the mildest blend setting that a genuine small player would notice (`P = 20 bps`,
§3.1) one $10 wallet earns **$0.21 per round** of bonus. **The cost-to-bonus ratio is 1 : 280.**

> **Gas cannot ration sybils in this game, and the reason is the cadence.** At ~110 s per round the
> arena runs **785 rounds/day**. Any per-round edge is multiplied by 785 before an attacker's fixed
> costs are amortised even once. A one-off cost — a keypair, an aged wallet, a locked bond, an
> identity — is divided by 785 on the first day and by 5,495 in the first week. **No one-off or
> carrying cost can price a per-round bonus at this velocity.** Only a per-round cost, or a hard cap
> on what one identity can collect per day, can — and §3.5 shows what that does to the bonus a real
> player would feel.

---

## 2. WHO PAYS FOR THE BONUS — and why the live board cannot pay it at all

`parity.ts` asserts value is conserved for all 98 (attacker, defender, basis) combinations, so **no
damage rule can create money.** A small-stake bonus is a transfer out of the large rings **in the same
lobby**. That has two consequences that bound the whole idea from above, and neither had been measured.

```
cd engine
HE_FEE_BPS=100 npx tsx ../sandbox/house-edge/small-stake-field.ts 1500
```
The subject always stakes **$5**. Only the field changes. 1,500 rounds × 8 seats, paired (one lobby
and one lazy hash table per round, scored by every column), conservation asserted in integers every
round. The blend `P` is the `{ blend: P }` damage basis: `(P·ring_d + (10000−P)·min)/10000`, `P = 0`
being the shipped size-neutral rule.

**The bonus only, in percentage points of the subject's ROI, over the shipped rule:**

| the other 7 seats | mean field | P=10 | P=20 | P=40 | P=100 |
|---|---|---|---|---|---|
| **all equal to the subject: 7 × $5** | $5.00 | **−0.00 ±1.49** | **−0.00 ±1.49** | **−0.00 ±1.49** | **−0.01 ±1.47** |
| small cohort: 7 × $3–8 | $5.54 | +0.07 ±1.43 | +0.14 ±1.43 | +0.28 ±1.42 | +0.67 ±1.41 |
| **live board: 7 house bots $5–20** | $12.62 | +0.55 ±1.61 | **+1.10 ±1.61** | +2.18 ±1.61 | +5.34 ±1.61 |
| the invented BANDS field | $40.86 | +3.11 ±1.64 | +6.20 ±1.65 | +12.33 ±1.68 | +30.20 ±1.80 |
| one whale $100 + 6 × $5 | $18.57 | +6.11 ±1.64 | **+12.12 ±1.68** | +23.84 ±1.77 | +56.67 ±2.07 |
| three whales $100 + 4 × $5 | $45.71 | +5.49 ±1.61 | +10.92 ±1.64 | +21.65 ±1.68 | +52.67 ±1.85 |
| all whales: 7 × $100 | $100.00 | +5.42 ±1.62 | +10.81 ±1.64 | +21.50 ±1.67 | +52.87 ±1.82 |

**Two readings, and the first is fatal to the framing.**

**(a) The bonus is EXACTLY ZERO in a field of equals — at every setting, including the v5 defect.**
`−0.00 ± 1.49` at `P = 10` and `−0.01 ± 1.47` at `P = 100`. There is nothing subtle here: `min(ring_a,
ring_d)` and `ring_d` are the same number when the rings are the same size, so the blend has nothing to
blend. **A small-stake bonus is not a bonus for being small. It is a bonus for being smaller than the
person you are hitting.**

**(b) The live board cannot pay it.** `er-demo/public/keeper-status.json` round #20 reports
`fighterCount: 1`, `houseFighterCount: 1`, **`realFighterCount: 0`**, and the deployed house ladder
stakes $5–$20 (`config.ts:644,645`). Against that field a $5 player's bonus at `P = 20` is
**+1.10 ± 1.61 percentage points — not distinguishable from zero.** The mechanic's entire value is
conditional on whales being in the room, and there are currently no players in the room at all.

**(c) It is self-extinguishing as a product.** The bonus is zero-sum inside the small cohort. The
better the mechanic works at attracting small players, the smaller the pool of large rings it is paid
out of, and the less it pays each of them. A mechanic whose value declines with its own success is a
promotion, not a rule.

**(d) And a prior of mine, refuted in the direction that matters.** I instructed the farm rig that a
**thin** lobby would be the adversary's best case — fewer honest seats to dilute the bonus. **It is
the adversary's WORST case.** An $80 budget at `P = 100`:

| seats | farm, $/day per dollar of budget |
|---|---|
| **48** | **$198.82** |
| 8 | $5.39 |
| **4** | **negative at `P ≥ 40`** |

**A split needs seats, and a thin lobby has neither seats nor victims.** That cuts both ways and both
matter: the live board cannot pay the bonus **and** cannot yet be farmed for it. **The exposure arrives
with the players** — which means this is a rule that would look harmless in testing and become
expensive at exactly the moment the product started working.

### 2.1 THE SHIPPED GAME DOES DISADVANTAGE THE SMALLEST PLAYERS — and it is the dust rule, not the basis

I expected the dust rule (`DUST = 1,000` units = $0.001) to act as a *bound on the farm* at tiny
stakes. It does not (§3.1d). What it actually is, measured under the **shipped** `P = 0` rule, is a
**regressive tax**:

> **A $0.01 wallet loses ~8.4% per round against the −1.00% fee everyone else pays.**

The mechanism is the one asymmetric line in the fight, `if (D.hp <= DUST) dmg = D.hp`
(`er-sim.ts:199`): a fighter at or below the floor loses its **entire** remaining ring when drawn as
defender but gains only `roll/100` (mean 15.24%) of it when drawn as attacker. `lifetime-core.ts`
already documents this as a flat ~$0.0008/fight drain; **−8.4% of $0.01 is $0.00084, so the two
measurements are the same number seen from two ends.**

**This is the one place where the request's premise is literally true: there IS a small-player penalty
in the shipped game.** It is worth stating precisely what it is and is not. It is **absolute, not
proportional** — bounded by one dust floor, invisible above ~$0.10, and a **player-to-player transfer,
never house revenue**. And **fixing it requires no tilt and creates no farm**: it is a floor, and
raising a floor gives nobody a percentage edge over anybody. §7 carries it as a recommendation.

### 2.2 And the tilt makes the small player's outcome MORE volatile, not less

The retention hypothesis in the brief is that a **flatter** loss curve keeps players alive. Measured on
the same runs — per-round ROI standard deviation for the same $5 subject:

| the other 7 seats | SHIPPED | P=10 | P=20 | P=40 | P=100 |
|---|---|---|---|---|---|
| all equal: 7 × $5 | 40.9% | 40.8% | 40.7% | 40.4% | 39.7% |
| live board: house bots $5–20 | 44.2% | 44.2% | 44.2% | 44.1% | 44.2% |
| the invented BANDS field | 44.8% | 45.2% | 45.7% | 47.1% | 53.7% |
| **one whale $100 + 6 × $5** | **43.8%** | 46.0% | **48.2%** | 52.9% | **67.1%** |
| all whales: 7 × $100 | 44.1% | 44.8% | 45.6% | 47.4% | 54.7% |

**Wherever the bonus is non-zero, the variance rises with it — and it rises faster.** At `P = 100`
against one whale the mean improves by 56.7 points and the standard deviation goes from 43.8% to
**67.1%**, a 53% increase. The two move together because they are the same event: the bonus is
delivered as an occasional whale-sized bite, not as a steady drip.

> **This is the first refutation of the retention hypothesis, and it is structural rather than
> parametric.** The mechanic does not flatten the loss curve. It raises the mean *and* fattens the
> tails of a player whose balance is already the thing at risk. §4 nets the two effects into lifetime
> revenue; this section says in advance which way the variance term will push.

---

## 3. THE FIVE CANDIDATES — intended effect against farm rate, measured

**Three of my own priors were refuted in this section and each is flagged where it fails: the clamp
(§3.2) makes the ratio worse rather than better; the dust rule (§3.1d) does not bound the farm; and
the identity gate's dilution (§3.5) is negligible rather than limiting.**

```
cd engine
HE_FEE_BPS=100 NODE_OPTIONS=--max-old-space-size=12288 \
  npx tsx ../sandbox/house-edge/small-stake-farm.ts 400 all
```

**Part 0 first, because everything else rests on it.** Four equivalences over 400 random lineups at
2–48 seats, stakes log-uniform on [$0.01, $100], full bell: `legacy + shift + {blend: 0}` is
**byte-identical** to `BASELINE` (`damage: "min"`); `capMult: 1` collapses the blend to the shipped
rule at **every** P; an unverified field under `gate: "attacker"` plays the shipped fight exactly.
**Zero differing lineups on all eight checks.** Conservation asserted in integers on 6,400 fights,
no failures. So the only thing varying downstream is the knob.

### 3.1 Stake-banded damage basis (the blend `P`) — the intended effect and the farm are the same curve, and the farm sits further along it

**(a) What a genuinely small player gains.** ONE honest wallet, whole budget, no split, 8 seats
against 7 BANDS opponents (mean ~$42), 400 rounds, bootstrap 95% CI:

| honest stake | P=0 (shipped) | P=10 | **P=20** | P=40 | P=100 |
|---|---|---|---|---|---|
| $1 | −2.61 ±4.33 | +10.20 ±4.35 | **+22.94 ±4.83** | +48.24 ±6.03 | +122.70 ±10.52 |
| $3 | −2.70 ±4.38 | +1.99 ±4.20 | **+6.66 ±4.16** | +15.90 ±4.58 | +43.00 ±5.57 |
| $5 | −2.90 ±4.15 | +0.05 ±4.22 | **+2.97 ±4.15** | +8.77 ±4.36 | +25.69 ±4.83 |
| $10 | −2.85 ±4.08 | −1.34 ±4.04 | **+0.16 ±3.98** | +3.12 ±3.97 | +11.70 ±4.17 |
| $50 | −2.42 ±3.41 | −2.43 ±3.35 | −2.45 ±3.30 | −2.48 ±3.40 | −2.58 ±3.18 |
| $100 | −2.06 ±2.58 | −2.48 ±2.58 | −2.90 ±2.56 | −3.72 ±2.48 | −6.08 ±2.43 |

*(ROI % per round. The P=0 column should read −1.00% everywhere; it reads −2.1 to −2.9 with ±4-point
CIs, which is the noise floor at n=400 — read it as the zero line, not as a result.)*

**The bonus is concentrated almost entirely below $3, and at 48 seats it barely reaches $5 at all**
($5 at P=20, 48 seats: **−0.57 ±4.37**, i.e. nothing). The curve is steep in exactly the region no
honest player stakes and every splitter does.

**(b) What a splitter extracts.** Budget $20, 48 seats, **all `k` wallets STACKED on one side** —
the layout an actual adversary uses, because alternating sides wastes half its exchanges on internal
washes. 400 rounds/cell.

| k | per wallet | P=0 (control) | P=10 | **P=20** | P=100 |
|---|---|---|---|---|---|
| 1 | $20.00 | −6.34 ±4.06 | −5.86 ±4.06 | −5.39 ±4.07 | −1.73 ±4.11 |
| 8 | $2.50 | −0.54 ±1.54 | +3.32 ±1.57 | +7.14 ±1.61 | +36.77 ±2.36 |
| 16 | $1.25 | −1.47 ±1.04 | +5.87 ±1.09 | +13.14 ±1.24 | +68.58 ±3.35 |
| 32 | $0.625 | −1.17 ±0.73 | +13.79 ±1.18 | +28.30 ±1.90 | +129.96 ±7.30 |
| **40** | **$0.50** | −0.04 ±0.65 | +15.99 ±1.26 | **+31.25 ±2.21** | **+130.28 ±8.47** |
| 48 | $0.4167 | **−1.00 ±0.00** | **−1.00 ±0.00** | **−1.00 ±0.00** | **−1.00 ±0.00** |

*(The `k = 48` row is a free correctness check: the splitter owns every seat, fights only itself, and
pays exactly the fee. It reads −1.00% ±0.00 at every P, as it must.)*

**In money, gain over entering as one fighter, on a $20 budget:**

| | P=0 (control) | P=10 | **P=20** | P=100 |
|---|---|---|---|---|
| best-k gain, $/round | $1.26 | $4.37 | **$7.33** | **$26.40** |
| **$/day at 785 rounds** | *(noise)* | $3,431 | **$5,752** | **$20,724** |
| **$/day per $1 of attacker capital** | — | $172 | **$288** | **$1,036** |

**(c) The ratio, per dollar of capital.** Intended = one honest $5 wallet at 48 seats; farm = the best
`(k, layout)` on an $80 budget at 48 seats. Both in $/day per dollar committed, so they are directly
comparable.

| P | honest $5 player, $/day per $ | best farm, $/day per $ | **farm ÷ intended** |
|---|---|---|---|
| 0 (shipped) | −$24.20 | −$3.35 | — |
| 5 | *still negative* | +$19.15 | **sign flips — the honest player loses while the farm profits** |
| 10 | *still negative* | +$21.84 | **sign flips** |
| **20** | +$8.70 | **+$36.55** | **4.20×** |
| 40 | +$41.29 | +$81.52 | 1.97× |
| 100 | +$137.27 | +$203.13 | 1.48× |

**The farm exceeds the intended effect at every `P > 0`.** And at `P = 5` and `P = 10` — the settings
mild enough that one might hope to sneak them past an adversary — **the honest small player is still
losing money while the splitter is already profiting.** There is no low-`P` regime where the mechanic
works as advertised.

*(A note on the `P = 0` column reading ~−3% rather than −1%: that is sampling noise at n = 800, not rig
bias. At 20,000 rounds the same subject sits at −1.02% to −1.21%, within **0.71σ** of the fee.)*

> **The theorem in §1 says the rates are equal at equal stake. The measurement shows why that is not
> reassurance but the opposite.** The splitter is not limited to the stake an honest player would
> choose — it walks down the curve to **$0.50, $0.42, and ultimately the $0.01 minimum entry**, where
> the bonus is steepest. **The intended effect is the farm rate evaluated at a stake no real player
> uses.** There is no setting at which the honest curve is high and the farm curve is low, because
> they are the same curve.

**(d) THE FLOOR — and the dust rule does not bound it, which refutes what I assumed.** I expected the
dust rule (`DUST = 1,000` units = $0.001) to cap the farm at tiny stakes. It does not. Sweeping the
per-wallet stake down at fixed `k`:

> **At `k = 40` wallets of $0.01 each — a total budget of $0.40 — `P = 100` extracts $20.53/round =
> $16,120/day. That is $40,290/day PER DOLLAR of budget, 293× the honest $5 player's rate.**

Extraction is **nearly flat** from $1.00/wallet down to $0.01/wallet ($21.39 → $20.53 at `k = 40`) and
actually **peaks at $0.20/wallet ($26.68/round)**. **99.8% of those wallets die, and it does not
matter — `banked` is never at risk again.** The attacker is not trying to survive; it is buying
lottery tickets that pay out into a pocket the fight cannot reach.

**The only real bound is the seat count**, and 48 seats × $0.01 is a **forty-cent** budget.

### 3.2 Bounded blend (`capMult`) — it makes the ratio WORSE, which is the opposite of what it was for

`basis ≤ C · min(ring_a, ring_d)`. `C = 1` is proved identical to the shipped rule at every P (Part 0),
so the axis is anchored at "no bonus at all".

**I expected the clamp to bound the farm while preserving some of the intended effect. It does the
opposite, and this is the clearest refutation in the study.** farm ÷ intended, by (P, C):

| P \ C | 2 | 3 | 5 | 10 | 1000 (≈unclamped) |
|---|---|---|---|---|---|
| 20 | **1.97×** | 1.72× | 1.54× | 1.39× | 1.14× |
| 40 | **1.55×** | 1.42× | 1.32× | 1.21× | 0.98× |
| 100 | **1.42×** | 1.32× | 1.22× | 1.13× | 0.91× |

**Tightening the clamp from C = 1000 to C = 2 RAISES the ratio, from 1.14× to 1.97×.** The reason is
asymmetric responsiveness: **the splitter re-optimises `k` against the clamp; the honest player's stake
is fixed.** A bound that both parties face is a bound only the one who cannot move is bound by.

**No (P, C) cell separates them.** The nine cells that nominally do all sit at `P ≥ 40` with
`C ≥ 1000` — i.e. effectively unclamped — or at absurd `P` (500, 10000) where the honest player earns
+44% to +731% per round and the farm still takes **$399–$4,483/day per dollar of budget**.

### 3.3 A per-entry cap relative to the pot — it is not a small-stake bonus at all

The shipped fight is **already exactly size-neutral** (§11.5), so a cap cannot improve a small
player's expected return by construction — there is no cross-size transfer for it to redirect.
Confirmed: with a ring-normalisation cap swept from `C = 1.0` upward, **every band stays at minus the
fee, worst 2.22σ, and the whale–minnow spread is constant at −0.61% to −0.66% across every `C`.**

**What it changes is variance — and the variance benefit lands on the wrong people, which refutes the
rationale the mechanic is usually given.** At `C = 1.0`:

| | shipped | capped at C = 1.0 |
|---|---|---|
| **whale** sd(ROI) | 34.46% | **18.21%** (−47%) |
| **minnow** sd(ROI) | 43.85% | **43.82%** (−0.03%) |

**The cap halves the whale's variance and does nothing whatsoever for the minnow's.** That is not an
accident: `min(ring_a, ring_d)` already scales every exchange to the smaller party, so a minnow's
swings are set by its own ring and are untouched by how large the biggest opponent is. §4.3 then
prices the revenue side — it extends life 27–60% and destroys 49–87% of lifetime revenue.

It is still the one candidate that is **reverse-farmed** — the adversary's optimum is `k = 1`, because
consolidating is what a cap punishes — but it is safe because it gives nothing away, and it gives
nothing away to precisely the people it was meant to help.

### 3.4 Diminishing returns per wallet — the cheapest of all to farm, and backwards as a retention rule

Two readings, and both die on arithmetic rather than simulation.

**Within a round it does not exist as a separate mechanic.** `enter` (`er-sim.ts:151`) finds-or-tops-up
by `(wallet, side)`, so a wallet holds exactly one entry per side. "Diminishing returns on your own
entry within a round" is therefore just a decreasing function of stake — §3.1 with a different curve.

**Across rounds it is the worst version of the idea.** A bonus that decays with a wallet's cumulative
volume is reset by **creating a new wallet, which costs one keypair and one signature — $0.00075.**
Against a per-wallet bonus of $0.21–$1.85/round (§1.1) the cost-to-bonus ratio is **1 : 280 to
1 : 2,470.** And note what it does to the customer it is nominally for: **the bonus decays to zero
exactly as a player becomes retained.** It pays newcomers and taxes loyalty, which is the opposite of
the retention case the mechanic is supposed to serve.

### 3.5 The identity-gated bonus — the one candidate with an asymmetric farm, and it still loses on price by 60× to 10,000×

**First, a correction to the brief's premise, and it matters.** `TWITTER-CONNECT.md` line 5 reads
*"Status: **proposal**. Nothing here is built."* Stage 3 — the actual X ceremony — is explicitly last
and blocked on an X developer account. **The identity layer is designed, not committed.**

**What the design would prove, if built.** OAuth 2.0 + PKCE proves control of an X account; an ed25519
`signMessage` over a canonical message containing the `x_id` proves control of the wallet; the two are
bound cryptographically. `x_id PRIMARY KEY`, `wallet UNIQUE`, relink atomic — a strict 1:1. **Account
age, follower count and X Premium status are NOT checked; `verified_type` is fetched from
`/2/users/me` and then discarded (§4.3, "Nothing else is stored").** And §4.4 concedes the rest:
*"Two wallets, one person — link one wallet, play from another. By design."*

> **So the gate proves "one X account", not "one human". The farmer's yield is capped at
> (bonus × accounts they can buy), and that is the entirety of the sybil resistance.**

**The measurement, from two independent designs, and they agree on the verdict.** The farm rig prices
the gate directly as a **break-even account price**: what one X account is worth per day to a farmer,
which any market price must exceed for the gate to work.

| P | **break-even price of one X account, per wallet per day** |
|---|---|
| 20 | **$116–$134** |
| 40 | **$268–$272** |
| **100** | **$686–$720** |

The closed-population run agrees on the order of magnitude from a different design: one verified wallet
in eight extracts **$1,274/day ±825** (§4.5). **A softreg X account costs $0.07–$1.85** (§8.1). **The
gate is out by a factor of roughly 60 to 10,000 depending on the setting, and it is never close.**

**A prior of mine, refuted.** I expected the bonus to decay sharply as the verified fraction rose,
since it is zero-sum inside the verified set, and called that "the mechanic's real limit". **It is
negligible: a $5 player at `P = 100` goes +20.07% → +19.58% as `v` goes 0 → 1, a paired
−0.486% ±0.034.** The reason is structural and I should have seen it: **the blend differs from `min`
only when the attacker is SMALLER than the defender, so verifying the whales gives the whales
nothing.** The gate does not dilute. It just does not price.

**And the bonus pool does not reach the people it is for.** At `v = 0.50`, the share flowing to genuine
single-wallet small players against the share flowing to one splitter:

| splitter's k | to genuine minnow/small players | **to the splitter** |
|---|---|---|
| 4 | 47% | 18% |
| **32** | **7%** | **84%** |

**Two structural facts finish it.**
- **The house can never wear a face.** `/api/x/link` rejects any wallet in
  `keeperStatus.house.wallets` (§6.3). **So this mechanic — the only one whose farm is asymmetric —
  is asymmetric in favour of real players and against the operator.** It does not serve the framing
  the request was made in, and it is reported anyway because the brief asked for it either way.
- **The literature has the general result.** Pairwise-bounded quadratic funding bounds collusive
  extraction at `k(k−1)M` **independent of capital** — it solves the capital problem completely and
  the identity problem not at all, profiting whenever `k > 1 + c/M` for identity cost `c`. Humanode's
  square-root airdrop is defensible only on top of **biometric** uniqueness. Human Passport has
  **retired the X stamp entirely**; when live it was worth 3.2 points against a threshold of 20.

**The one upgrade worth taking on its own merits:** persisting `verified_type` and requiring **X
Premium** moves the farmer's cost from ~$1 to **~$96/yr per identity** — 20–100×, one schema column,
zero extra API cost. **It still loses to $1,274/day, so it does not rescue this mechanic.** It should
be judged as sybil-resistance infrastructure, not as a reason to ship a tilt.

### 3.6 Fee or penalty banded by stake — `HOUSE-LIFETIME.md` §8.1 generalises, and smoothness does not help

The tiered rate card was already measured at **75% of honest rake drained in one round**, with the
note that "the disclosure IS the exploit". The obvious repair is to make the schedule **smooth**
rather than banded, so there is no cliff to sit under. **It does not work, and the smoothest schedule
is the WORST one measured:**

| schedule, revenue-matched to flat 100 bps | % of honest rake an $80 adversary drains |
|---|---|
| flat 100 bps (deployed) | **0.0% — split-neutral** |
| tiered cliff (§8.1's control, reproduced) | 75.8% |
| **smooth power, b = 0.5** | **85.6% — worse than the cliff** |
| smooth log schedules | 20.4–35.2% |
| floor at 90 bps | 13.2% |

**Smoothness removes the *cliff*, not the *gradient*, and the gradient is the exploit.** The drain is
`1 − bps(B/k*) / bps(B)` — it reads the published card at two points and never asks whether the curve
between them has a corner. **No schedule escapes** (best farm ÷ intended ratio: 1.05×). The only
split-neutral rate card is a **flat proportional** one, which is what is deployed. Fight neutrality was
re-confirmed alongside it at zero fee across `k = 1…16`, worst **0.68σ** — the farm is entirely in the
card, never in the game.



### 3.7 P* — IS THERE A TILT TOO WEAK TO FARM BUT STRONG ENOUGH TO MATTER?

The one question the study had not asked, and the one that decides whether any of this ships. Define
**P*** as the largest tilt at which an optimally-splitting attacker's net is **at or below zero after
their own per-wallet-per-round transaction cost**. Then ask what an honest small player gets at P*.

> **PROVENANCE, BECAUSE THIS SECTION MIXES TWO KINDS OF EVIDENCE AND THEY SHOULD NOT BE READ ALIKE.**
> * **MEASURED** — the `P = 1` encoding fact, the band table, the whole-field −1.0000% identity and the
>   conservation counts below. Direct, paired, 600 rounds/cell, `P = 0` asserted at the fee.
> * **DERIVED** — the P* / window arithmetic further down, evaluated on two per-wallet numbers measured
>   in §3.1 ($0.874 honest $5, $0.667 attacker best, P=100/48 seats/400 rounds). **The low-`P` farm
>   sweep and the direct `b(s)` curve had not returned when this was written.**
>
> The two agree, and the measured half is the stronger of them: it needs no assumption about the shape
> of `b(s)` at all. The falsifier named at the end applies only to the derived half.

#### The question is settled by exact arithmetic before any simulation runs

`P` is a **u16 in basis points**, so the smallest representable non-zero tilt is `P = 1 bps`. That
sounds negligible. It is not, and the reason is a coincidence in the constants that nobody had noticed:

```
basis = a · (1 + (P/10000)·(d/a − 1))        so the attacker's damage is multiplied by ≈ 1 + P·(d/a)/10000
```

**The legal stake range is [$0.01, $100] — a span of exactly 10,000×, which is exactly the basis-point
denominator.** So at `P = 1`, the smallest legal wallet hitting the largest legal wallet has its damage
basis multiplied by `1 + 1×10,000/10,000` = **2.00×. It doubles.**

> **THE SMALLEST REPRESENTABLE TILT IS NOT A SMALL TILT WHERE IT MATTERS.** The u16-in-bps encoding
> **cannot express a setting mild enough to leave the $0.01 wallet alone**, because one bps is already
> a **2× multiplier** there — and $0.01–$0.20 wallets are exactly where the farm operates (§3.1d).
> The dial's granularity is coarser than the phenomenon it is trying to tune.

**Confirmed against a non-splitting field**, 8 seats, 600 rounds, paired on one lobby per round. The
`P = 0` row is *asserted* to sit at −1.00% in every band (it does, within 3 SE) and the whole-field
column is the conservation identity in percentage form:

| P (bps) | whale $80–100 | medium $20–50 | small $8–20 | minnow $3–8 | **whole field** |
|---|---|---|---|---|---|
| **0** (shipped) | −1.48 ±0.84 | −0.02 ±1.23 | −0.45 ±1.51 | −1.00 ±1.71 | **−1.0000%** |
| **1** | −1.52 ±0.84 | +0.00 ±1.23 | −0.34 ±1.51 | **−0.70 ±1.72** | **−1.0000%** |
| 2 | −1.55 | +0.02 | −0.22 | −0.39 | **−1.0000%** |
| 5 | −1.66 | +0.09 | +0.13 | +0.53 | **−1.0000%** |
| 20 | −2.17 | +0.43 | +1.85 | +5.10 | **−1.0000%** |
| 100 | −4.78 ±0.80 | +2.14 ±1.22 | +10.62 ±1.61 | +28.63 ±2.13 | **−1.0000%** |

**The whole-field column reads exactly −1.0000% at every `P`, to four decimals.** That is the
coordinator's standing constraint met exactly: **the tilt only rearranges what is left after the rake,
and never becomes a second house edge.** Conservation asserted in integers on every fight, 6,200 in the
self-check block alone, zero failures.

**And the honest minnow's whole story at the smallest shippable setting is one line: `P = 1` moves the
$3–8 band from −1.00% to −0.70%, a gain of +0.30 points per round** — against a band standard
deviation of ~44%, and against a farm that is still profitable there.

#### And the farm economics say the same thing from the other side

**The closed form, derived from quantities already measured in §3.1.** Gas is charged **per wallet per
round**, so a party breaks even at the `P` where their **per-wallet bonus in dollars** equals `g`.
Writing `b_h` for an honest $5 wallet's bonus and `b_a` for the attacker's best per-wallet bonus:

```
P*_honest = 100·g / b_h        P*_attacker = 100·g / b_a
window     = P*_attacker / P*_honest = b_h / b_a        <-- g CANCELS
edge at P* = b_h·P*_attacker/100 − g = g·(b_h/b_a − 1)
```

> **The window's WIDTH is a property of the bonus curve alone and is identical at every gas price. And
> the honest player's net gain at P* is exactly `(window − 1) × their own gas cost` — always.**

**So a window does exist**, and it exists for a reason worth stating: the attacker splits to wallets
*smaller* than any honest player would use, and at P=100, 48 seats, the measured per-wallet bonus is
**$0.874 for an honest $5 wallet against $0.667 for the attacker's best cell** ($26.68 over 40 wallets
of $0.20). The honest wallet earns **more per wallet**, so it breaks even at a **lower** `P`. **Window
= 1.31×.**

**And it is worth 0.31 × the gas, which is nothing.** At a Solana signature ($0.00075):

| attacker gas per wallet-round | P*_honest | **P*_attacker** | honest $5 net at P* |
|---|---|---|---|
| **$0.00075** (one signature) | 0.086 bps | **0.112 bps** | **+0.0047%/round** |
| $0.0075 | 0.858 | 1.124 | +0.047% |
| $0.029 | 3.32 | 4.35 | +0.180% |
| $0.161 | 18.4 | 24.2 | +1.00% |

**Three readings, and each closes the question from a different direction.**

**(1) P* is not representable.** At the real transaction cost, P*_attacker = **0.112 bps** — below the
**1 bps** minimum the u16 dial can express. **At the smallest setting that can actually be shipped,
`P = 1`, the attacker still nets roughly $146/day on $80 — a 183%/day return on capital — while the
honest $5 player gets about +0.21%/round.** There is no safe setting to choose.

**(2) The lifetime-revenue case needs P ≥ 20, and that is already measured.** §4.1: `blend-5` is
**−$0.08 ±0.42 (0.4σ, not significant)** and `blend-10` is **+$0.34 ±0.45 (1.5σ, not significant)**.
Only `P ≥ 20` moves lifetime rake at all. **So the window between "unfarmable" (P ≤ 0.11) and "moves
revenue" (P ≥ 20) is empty by a factor of ~180×**, and both ends were measured independently.

**(3) Raising the entry cost does not open the window — it closes it.** To make P* worth 1% of a $5
stake, entry would have to cost **$0.161 per wallet per round: 215× a Solana signature, and 3.2× the
entire 1% rake.** A $1 player would pay **16% per round** to enter. **The cost that makes the tilt safe
prices out the player the tilt is for.** Worse, a per-wallet cost makes the attacker re-optimise toward
**fewer, larger** wallets, which pushes `b_a` up toward `b_h` and **narrows** the window. It is widest
at zero gas, where it is worth exactly nothing.

> **THE ANSWER, PLAINLY: no positive representable `P` survives its own farm after costs.** The window
> is real, it is 1.31× wide, it sits two orders of magnitude below the smallest number the dial can
> hold, and inside it an honest small player gains **0.0047% per round — one two-hundredth of the rake
> they already pay.** This is not a tuning failure. `g` cancels, so **no cost structure, cadence or
> board size moves it** — only a change to the shape of the bonus curve itself would, and that is the
> thing §1 proves cannot be made asymmetric without an identity, and §3.5 prices identities out.

**What would falsify this — one curve, and it is the section's only load-bearing input.** `b(s)`, the
bonus in DOLLARS per wallet per round as a function of that wallet's stake. The argument needs
`b($5) > b(attacker's optimal wallet)`, i.e. the honest player sits on the **high** side of the peak
and the attacker on the low side. The two measured points say `b($5) = $0.874` against `b($0.20) =
$0.667`, which is that ordering. **If a direct sweep finds the peak BELOW the attacker's optimal wallet
size, the window inverts, the attacker breaks even first, and the question reopens.** It is a property
of the bonus curve, not of any parameter the operator controls — which is why no amount of tuning
changes the answer, and why this one measurement decides it.

**Also still open, and smaller:** the attacker's re-optimisation under gas is argued (fewer, larger
wallets ⇒ `b_a → b_h` ⇒ the window narrows) rather than solved. Solving `max_k k·(b(B/k) − g)` subject
to `k·s ≤ B`, `k ≤ seats − 1` would settle the direction. `k = seats` is degenerate — the splitter owns
every seat, fights only itself and books exactly the fee — and must be excluded.

---

## 4. THE LIFETIME TEST — the retention hypothesis is CONFIRMED, and it does not survive contact with the adversary

This is the number the brief asked for and nobody had computed. It required new machinery, and the
reason is worth stating because it is the difference between a real answer and an arithmetic error.

> **`lifetime-core.ts`'s R-pool cannot answer this question, and using it would have manufactured
> money.** The pool resamples one player's fight multiplier i.i.d. against a FIXED invented field. Under
> a redistribution mechanic the bonus a shrunken player receives has to be **paid by the whales in the
> same lobby** — and if the field is invented, nobody pays it. So this study runs a **closed
> population**: 800 player slots, 100 lobbies of 8 per round, every dollar one player wins is a dollar
> another simulated player lost, real `runFight` on every lobby, and the identity
> `houseRake + Σ(balances) + Σ(withdrawn) == Σ(deposited)` asserted **in integers every round**. Max
> absolute residual across every cell: **0 micro-units.**

```
cd engine
HE_FEE_BPS=100 npx tsx ../sandbox/house-edge/small-stake-lifetime.ts 3000 all
HE_FEE_BPS=100 npx tsx ../sandbox/house-edge/small-stake-lifetime.ts 3000 report
```
`BASE_PLAYER` (`lifetime-core.ts:298`), $100 bankroll, full redeployment, hold to the bell, 3,000
completed lives per cell (800 censored, Kaplan–Meier correction reported alongside). **Every
behavioural parameter is assumed; nothing in this repository measures any of it.**

### 4.1 The headline: lifetime rake rises with the tilt, monotonically, with no interior optimum

**Error bars are over independent REPLICATE POPULATIONS, not over lives.** A cell's 3,000 lives share
lobbies and are not 3,000 independent observations; every headline cell was run **8 times** with a
different population. The reported figure is the **Kaplan–Meier** estimate, because the completed-only
mean drops the longest lives and the mechanics under test *change life length* — the very axis being
measured. The hard lower bound (censored lives assumed to pay nothing more) is shown beside it: **both
columns move the same way, so the correction did not manufacture the result.**

| cell | KM rake/player | hard lower bnd | rounds lived | P(ruin) | turnover/player | **Δ vs base** |
|---|---|---|---|---|---|---|
| **`base` — SHIPPED `min`** | **$21.23 ±0.35** | $17.55 | 35.6 ±0.57 | 4.5% | $2,123 | — |
| `blend-5` | $21.15 ±0.24 | $17.78 | 37.8 | **0.0%** | $2,115 | −$0.08 (0.4σ) n.s. |
| `blend-10` | $21.56 ±0.28 | $18.18 | 38.7 | 0.0% | $2,156 | +$0.34 (1.5σ) n.s. |
| `blend-20` | $22.36 ±0.37 | $18.72 | 39.3 | 0.0% | $2,236 | **+$1.14 (4.4σ)** |
| `blend-40` | $23.07 ±0.36 | $19.24 | 39.6 | 0.0% | $2,307 | **+$1.85 (7.2σ)** |
| **`blend-100`** | **$25.02 ±0.22** | $20.67 | 40.4 | 0.0% | $2,502 | **+$3.80 (18.1σ)** |

**The null control passes.** `cap-100` is `base` under a different cell tag; its difference from base
must be zero and measures **−$0.015 ±0.481 (0.1σ)**. The machinery is calibrated.

**Read the shape, because the shape is the finding.** Lifetime rake is **monotone increasing in the
tilt over the entire range tested**, with no interior optimum. Same structure `HOUSE-LIFETIME.md` §2
found for the fee, same uncomfortable consequence: **the revenue-maximising setting is the corner,
`P = 10000` — which is exactly the v5 rule removed for being a $150.87/round sybil farm.** A
recommendation for a tilt on lifetime-revenue grounds is a recommendation to reinstate the defect by
degrees.

**And the two objectives disagree — the sign flips.** In steady state
`rake/round = (population / mean life) × rake per acquired player`, so a mechanic that lengthens lives
faster than it raises per-player value **lowers revenue per unit time**:

| cell | rake/player vs base | mean life vs base | **rake/round vs base** | which objective wins |
|---|---|---|---|---|
| `blend-10` | +$0.34 | +8.7% | **−$0.20** | per player only — **per day FALLS** |
| `blend-20` | +$1.14 | +10.4% | **−$0.14** | per player only — **per day FALLS** |
| `blend-40` | +$1.85 | +11.2% | **−$0.04** | per player only — **per day FALLS** |
| `blend-100` | +$3.80 | +13.5% | +$0.22 | both |

**If acquisition is the binding constraint, revenue per acquired player is the objective and the blend
helps. If seats are the binding constraint — the arena fills whatever you do — every setting below
`P = 100` makes the operator worse off.** Nothing in this repository measures cost per acquisition, so
this study cannot pick between them; it can only refuse to hide that the choice exists.

### 4.2 The mechanism is TURNOVER, not retention — and the accounting says so

Deposits are pinned at **exactly $100.00** in every blend cell (no busts, therefore no redeposits), and
withdrawals barely move ($75.40 → $74.78). Neither can fund a rake increase. The reconciliation is that **the rake is charged on turnover, and the tilt raises
turnover per deposited dollar.**

Only three channels can carry it, because the fight is zero-sum under every damage rule: **(1)** the
ruin / minimum-entry barrier, **(2)** variance-driven churn, **(3)** the $100 stake cap. The rig
switches them on one at a time — and the result inverts the story.

| channels active | P=0 | P=100 | difference |
|---|---|---|---|
| **(1) barrier only** — flat hazard, **no cap** | $84.48 ±2.66 | $79.79 ±1.44 | **−$4.69 (3.0σ) — NEGATIVE** |
| (1)+(2) barrier + variance churn, no cap | $36.92 ±1.62 | $35.56 ±0.65 | −$1.36 (1.5σ) n.s. |
| **(1)+(3) barrier + $100 cap**, flat hazard | $49.57 ±1.24 | $76.56 ±0.80 | **+$26.99 (35.8σ)** |
| all three (`base` vs `blend-100`) | $21.23 | $25.02 | +$3.80 (18.1σ) |

> **WITH THE STAKE CAP OFF, THE BLEND LOSES MONEY.** Its entire gain appears in the cap-ON row and is
> **negative** in the cap-OFF row. **The blend is not a revenue mechanic. It is a partial refund of a
> cost the $100 per-entry cap imposes** — the cap idles money above $100 outside the turnover the rake
> is charged on, and redistribution pushes that money back down under the ceiling. It is a workaround
> for a parameter, and §4.3 shows the parameter is worth 4.1× more on its own.

**The ruin channel, and the arithmetic behind a discontinuity at `P = 5`.** `base` ruins 4.5%; every
blend cell down to `blend-5` — a 0.05% tilt — ruins **0.0%**. That is not the sign of `P` doing the
work, as I first assumed. It is the **ratio**:

```
basis / min  =  1 + (P/10000) · (ring_d/min − 1)
```

and `ring_d/min` is **unbounded** as `min` falls to the dust floor. A $0.01 fighter beside a $50
opponent has a ratio of ~5,000, so **at `P = 5` its bite is already ~3.5× its own entire ring.** The
same knob is a rounding error at $8 and a multiple at $0.01. Evidence: lives that ever visit sub-$0.10
fall **10.83% → 0.90%**, and the dust bins' mean R goes **0.912 (a drain) → 2.466 (a prop-up)**. The
drain being reversed is `er-sim.ts:199`, the one asymmetric line in the shipped fight. **This is also
exactly why `capMult` exists — it is the only setting that bounds that ratio structurally.**

**The variance channel pushes the other way, and my prior was right about its direction.** `base` →
`blend-100`, sd(ROI) by band: micro ($0.10–1) **43.1% → 144.7%**, small **44.0% → 58.1%**, mid 43.2%
→ 45.0% — **raised**; large 39.0% → 38.2% and whale 35.0% → 32.7% — lowered. The tilt makes small
players' outcomes far more volatile. It did not kill the gain, but it is the opposite of the "flatter
loss curve" the retention hypothesis assumed.

**And the gain does not survive every assumption.** At `stakeFraction = 0.25` the `P = 100` effect
**reverses** (−$0.11, 2.1σ) — consistent with the cap being the true channel, since at quarter stakes
the ceiling rarely binds.

### 4.3 The per-entry cap: it extends life and destroys revenue, and the outside view already knew

`STAKE_CAP_USD` is an engine constant (`engine/src/arenas.ts:40`), not an on-chain rule — **this row
needs no redeploy at all.**

| per-entry cap | KM rake/player | rounds lived | turnover/player | turns per $ | house $/round |
|---|---|---|---|---|---|
| **$100 (today)** | **$21.21 ±0.33** | 35.9 | $2,121 | 20.85 | **$4.78** |
| $25 | $10.83 ±0.52 (**−49%**) | 45.7 (+27%) | $1,083 | 10.79 | $1.91 |
| $10 | $5.40 ±0.12 (**−75%**) | 54.0 (+50%) | $540 | 5.40 | $0.80 |
| $5 | $2.86 ±0.15 (**−87%**) | 57.3 (+60%) | $287 | 2.86 | $0.40 |

**Longer lives, far less money — and the reason is that turnover is rounds TIMES stake per round.**
Lives stretch 60%; stake per round falls faster; the product collapses 87%. `lifetime-core.ts:294`
describes the cap as "a lifetime-extending device already in the product". **It is — and extending
lifetimes this way destroys revenue.** The per-entry cap is the single most destructive lever measured
anywhere in this study. It still has no farm rate; but neither does doing nothing.

> **THE LARGEST EFFECT IN THE WHOLE STUDY RUNS THE OTHER WAY, AND IT IS FREE.** `chan-hz-P0` is
> *exactly* the control — same `BASE_PLAYER`, same shipped `min` damage — with the **$100 cap lifted**:
>
> | | KM rake/player | turnover/player | mean life |
> |---|---|---|---|
> | `base` ($100 cap, shipped) | $21.23 ±0.35 | $2,123 | 35.6 |
> | **`chan-hz-P0` (cap lifted, else identical)** | **$36.92 ±1.62** | $3,692 | 33.0 |
> | **difference** | **+$15.70 ±1.66 (18.6σ)** | | |
>
> **That is 4.1× the best blend cell, and it has NO FARM RATE** — a stake ceiling creates no cross-size
> transfer for a splitter to capture. It is a parameter already in the product
> (`engine/src/arenas.ts:40`), not a program change.
>
> **Two honest caveats, and they are not small.** (a) The cap exists for reasons this simulator does
> not model — bounding one wallet's exposure and the operator's tail risk — and `arenas.ts:40` records
> it as *"locked by Max"*. This measures its **revenue cost**; it does not price what it buys. (b) It
> **runs against the framing of the request**: raising the ceiling favours whales, not small players.
> It is reported because it is the largest measured revenue lever in the file and the owner should see
> it, not because it answers the question that was asked.

**And it has been run as a natural experiment on a real market.** The UK cut the maximum FOBT stake
from £100 to £2 on 1 April 2019. Bookmaker machine gross gambling yield fell from **£3.3bn to £2.4bn**
and one operator reported a **~40% fall**. **The capped whale did not convert into offsetting
small-stake revenue.** Sources in §8.

### 4.4 The identity gate buys a real product effect only where the farm is already enormous

`gate: "attacker"` — the blend applies only when the attacker's wallet carries a verified X link.
Because the bonus is zero-sum inside the verified set, its value to a verified player **decays as the
verified fraction rises**, and that had never been computed.

| setting | verified rake/player | unverified | **gap** | rounds v/u |
|---|---|---|---|---|
| `gated-P20-v0.25` | $17.49 ±1.34 | $16.13 ±0.71 | +$1.36 | 29.4 / 28.2 |
| `gated-P20-v0.5` | $18.02 ±0.96 | $16.47 ±0.93 | **+$1.56** * | 30.5 / 29.5 |
| `gated-P100-v0.25` | $20.91 ±1.42 | $16.13 ±0.72 | **+$4.78** * | 31.2 / 28.6 |
| **`gated-P100-v0.5`** | $22.09 ±1.11 | $15.49 ±0.83 | **+$6.60** * | 32.8 / 28.9 |

*(\* = the two groups' 95% CIs do not overlap. Intervals here are over lives within one run, not over
replicate populations — a weaker claim than the headline table's, and marked as such.)*

**The gate's effect is real at `P = 100` and marginal at `P = 20`** — which is the same trade as
everywhere else in this document: the mechanic is only visible to a real player at the setting whose
farm rate is measured at four to five figures a day (§4.5).

### 4.5 THE ADVERSARY, IN THE SAME CLOSED POPULATION — this is the row that decides everything

One adversary. **$80 of working capital**, eight wallets of $10, seated among the 800 honest players,
never churning, stripping profit every round so its stake stays constant. Everything else identical.

**A correction to an earlier draft of this section, made loudly because it was mine.** I first
compared the adversary's take against `rake per LOBBY-round × 785` and called it "82% of the house's
entire daily gross". That is wrong by a factor of 100: the cohort runs **100 lobbies per round**, so
the population's gross is 100× larger. **The true ratio is 0.78 : 1, not 50 : 1.** The farm is still
unacceptable — but for the right reason, and the right reason is weaker than the one I published.

| world | adversary $/round | σ | **adversary $/day** | verdict |
|---|---|---|---|---|
| `adversary-base` — SHIPPED | −$0.363 ±1.91 | 0.4 | −$285 ±1,497 | **indistinguishable from zero** |
| `adversary-blend-20` | +$2.505 ±0.96 | 5.1 | **$1,966 ±753** | REAL FARM |
| `adversary-blend-100` | +$16.550 ±0.79 | 41.1 | **$12,991 ±620** | REAL FARM |
| `adversary-gated-P100-v1`¹ | +$1.623 ±1.05 | 3.0 | **$1,274 ±825** | REAL FARM, 8.5× smaller |

¹ The adversary holds **one** verified wallet out of eight, because an identity is the one thing
splitting cannot manufacture. Read it as **$1,274/day per verified X account.**

**The comparison that decides the recommendation** — what the mechanic pays the OPERATOR against what
it pays a single $80 attacker, both as differences against the same P=0 control, over the same
800-player population:

| mechanic | house gain $/day | adversary extraction $/day | attacker : operator |
|---|---|---|---|
| **`blend-20`** | **−$10,826** | +$2,251 | **the operator LOSES and the attacker gains** |
| `blend-100` | +$17,003 | +$13,276 | **0.78 : 1** |
| `gated-P100-v1` | +$17,250 | +$1,559 | **0.09 : 1** |

**Four readings, and the second is the one that kills it.**

1. **The shipped rule's null is confirmed.** −$0.363 ±1.91 (0.4σ). Splitting pays nothing today, as
   §11.2 measured from the other side. A single run had shown +$42 over 139 rounds, which looked like
   $239/day; across replicates it is noise. **This is why the interval is not optional.**
2. **At every setting below `P = 100` the operator LOSES money and the attacker still profits.** At
   `blend-20` the population's rake falls $10,826/day while the attacker gains $2,251/day. The
   per-player gain of +$1.14 in §4.1 is real and it is **not** the operator's objective if seats rather
   than acquisitions are the binding constraint.
3. **At `P = 100` the attacker captures 78 cents for every dollar of incremental house revenue** — on
   **$80** of capital, at **16,239% per day** on that capital, against a population holding 800
   players' worth of deposits. **The house's gain is bounded by the population; the attacker's take
   scales with their capital, with the number of attackers, and with the number of arenas they sit in
   at once — which this simulation does not model, so every adversary figure is a per-arena FLOOR.**
   Two such attackers invert the ratio; there is nothing to stop a second one.
4. **The gate is the best structural result in the study and still fails on price.** It cuts the farm
   8.5× while *keeping* the operator's gain, taking the ratio to **0.09 : 1**, because one actor holds
   one identity however finely it splits. But **$1,274/day per X account against a $0.07–$1.85 account
   price** means a farmer simply buys more identities: 48 seats' worth costs under $90 and restores the
   full ungated farm. **The gate multiplies the attacker's cost by ~$90 and their revenue by nothing.**

> **The four-line proof, restated with the corrected numbers.** For an identity to ration a per-round
> bonus, the account price must exceed the bonus's whole lifetime value. One verified $10 wallet earns
> **$1,274/day**. To make even a $1 account uneconomic over a single day, the per-wallet bonus would
> have to fall below **$0.00127/round** — on a $10 stake, **0.0127%**, which is **79× smaller than the
> rake the player already pays** and therefore invisible to the person it is meant to help. **There is
> no setting large enough for a real small player to feel and small enough for a farmer to ignore.**
> The gap is 785 rounds a day wide.

### 4.6 Two mechanics that are safe, and neither is a revenue mechanic

**Matchmaking by stake band** — free, keeper-side, no program change, and **structurally unfarmable**,
because seating similar sizes together creates no cross-size transfer for a splitter to capture.

| cell | KM rake/player | rounds | P(ruin) | sd(ROI) micro / small / large |
|---|---|---|---|---|
| `base` | $21.23 ±0.35 | 35.6 | 4.5% | 43.1% / 44.0% / 39.0% |
| `banded-full` | $19.47 ±1.12 | 35.0 | 3.8% | **40.2% / 40.0% / 39.8%** |
| `banded-tier3` | $20.02 ±1.23 | 35.3 | 4.2% | 43.9% / 40.4% / 38.8% |

**It costs $1.76/player (2.9σ) — a real loss, not a free win.** My prior was that banding changes
neither mean nor variance. **Half right:** mean ROI sits at exactly **−1.00% in every band** (the fee,
size gradient gone), but sd(ROI) **flattens to ~40% across all six bands** where the control runs 45%
at the bottom to 35% at the top. It also removes the sub-$0.10 dust drain as a side effect (mean R
0.912 → ~0.995), because a dust player now meets other dust players instead of whales. **Banding
equalises variance. It is a fairness and experience instrument, and it is not a revenue one.**

**A bounded, identity-gated treasury rebate** — "a verified wallet staking under $10 gets `r` bps
rebated, capped per identity per day". Does not touch the fight, needs no program change, and **its
farm rate is bounded by construction at the daily cap**, which no damage-basis rule can claim.
Measured **revenue-neutral at every setting tested** (25/50/100/200 bps, caps $0.50/$2.00/uncapped;
all within **0.8σ** of the control). **It is a priced marketing spend with a known worst case — cap ×
identities — and not a revenue mechanic.** That makes it the right shape for a small-player benefit,
and its safety is then a business decision about the price of an identity rather than a simulation
output.

> **This is the four-line proof that the identity gate cannot work here, and it is arithmetic, not
> opinion.** For an identity to ration a per-round bonus, the account price must exceed the bonus's
> whole lifetime value. At 785 rounds/day, one $10 wallet earning even the mild `P = 20` bonus is worth
> **$369/day**. To make a $1 X account uneconomic over even a single day, the per-wallet bonus would
> have to be under **$0.00127 per round** — on a $10 stake that is **0.0127%**, which is **79× smaller
> than the rake the player is already paying** and therefore invisible to the person it is meant to
> help. **There is no setting that is large enough for a real small player to feel and small enough for
> a farmer to ignore.** The gap is not a tuning problem; it is 785 rounds a day wide.

## 5. THE SECOND REQUEST — the score is boring, and the 48-seat migration is why

> *"the total sum of who is winning is relatively very stable and that's a bit boring… I want stronger
> fluctuations in the progress that is happening, specifically who is winning."*

```
cd engine
HE_FEE_BPS=100 npx tsx ../sandbox/house-edge/fight-volatility.ts 1000 all
```

**Statistics, and why these ones.** The complaint is about **amplitude**, not about crossing rate — a
small-step random walk already crosses 50% constantly with a tiny envelope, which is exactly the
"erratic visuals, flat score" being described. So the headline is **`swing`** (the time-weighted
standard deviation of side 0's share of the pot through the fight, in points) and **`maxExc`** (the
largest excursion of that share from 50%). Lead changes are reported as secondary.

### 5.1 CONFIRMED — the seat cap flattened the score, and the exponent is close to the prediction

Shipped rule only. The prediction, derived before measuring: early in a fight each ring is ~pot/n, so
one exchange moves ~`0.1524·pot/n` — a share falling like `1/n` — while the bell is `180·2·n` steps,
so the exchange count rises like `n`. A driftless independent walk then has `sd ~ n^(−1/2)`.

| n (BANDS stakes) | swing ×100 | maxExc ×100 | lead changes | ends at the bell | exchanges |
|---|---|---|---|---|---|
| 4 | 2.13 ±0.06 | 25.35 ±0.49 | 1.4 | 0% | 270 |
| 8 | 1.90 ±0.05 | 19.40 ±0.41 | 2.2 | 13% | 576 |
| **16 (the old cap)** | **1.49 ±0.03** | 14.30 ±0.32 | 2.9 | 19% | 1,203 |
| 32 | 1.07 ±0.02 | 10.32 ±0.23 | 4.6 | 33% | 2,500 |
| **48 (today)** | **0.88 ±0.02** | 8.54 ±0.20 | 5.5 | **42%** | 3,833 |

**Fitted exponent `d log(swing) / d log(n)` = −0.363, 95% CI [−0.375, −0.351]** against the predicted
−0.500; at equal stakes it is **−0.565 [−0.577, −0.553]**. **Measured 16 → 48: the swing fell by a
factor of 1.69×**, against `1/√3 = 1.73×` predicted.

> **The owner's hypothesis is confirmed. Raising `MAX_FIGHTERS` from 16 to 48 cut aggregate lead
> volatility by ~1.7×, and it also took the fraction of fights that run to the bell from 19% to 42%.**
> `HOUSE-LIFETIME.md` §10.4 concluded the bigger board "neither helps nor hurts the house" on revenue
> grounds and called it a product decision with no revenue payback. **That was right about revenue and
> incomplete about product: the migration had an unpriced cost, and this is it.**

**Which means the cheapest fix is free.** Seating fewer fighters is a keeper parameter, not a program
change. **Going back to 16-seat lobbies recovers 1.69× of swing for $0 and no redeploy** — and the
same table says 8 seats recovers 2.16× and 4 seats 2.42×. That option should be priced against every
candidate below, all of which cost a new program id.

### 5.2 The efficient lever is CORRELATION, and the shipped ratchet is where it is hiding

Over `N` exchanges, aggregate volatility is `~√N·σ` if they are independent and `~√(N·L)·σ` if they
come in correlated blocks of length `L`. **Quadrupling per-exchange variance buys 2× of swing and
costs extra dust deaths; introducing correlation of length `L` buys `√L` at no change in per-exchange
size.** Both were tested. But the best candidate turned out to be neither — it is a structural feature
of the shipped settlement nobody had identified as a volatility term:

> **THE RATCHET. `A.banked += dmg` moves won value permanently OUT of the at-risk pool.** As a fight
> progresses, more and more of the pot sits in `banked` where no later exchange can move it, so the
> aggregate score **freezes by construction** — the swing decays as the fight proceeds even before the
> law of large numbers gets to work. `retainBps` credits a share of each hit back into the attacker's
> **ring** instead, where it is still at risk. Conservation is exact in integers by construction:
> `toRing = dmg·retainBps/BPS`, the remainder to `banked`.

### 5.3 The candidate table — 48 seats, BANDS stakes, paired on shared lobbies and shared hash chains

Four bars per candidate: **1** conservation in integers, **2** still a fair game (whale–minnow band
spread, at **both** 8 and 48 seats), **3** does not reopen the $80 split farm, **4** what it costs in
per-round σ. Bar 3 is measured at **800 rounds/cell** on a **pre-registered `k = 8`** rather than on
an argmax — see §5.4 for why that distinction is load-bearing.

| candidate | swing ×base | maxExc ×base | lead chg | **bar 2** 8 / 48 seats | **bar 3** $/rd at k=8 | **bar 4** σ small | side-pick | verdict |
|---|---|---|---|---|---|---|---|---|
| **SHIPPED** | 1.00 | 1.00 | 6.0 | +1.7% / +0.4% | $1.83 ±1.10 *(the floor)* | 0.442 | −0.9 ±0.9 | — |
| `roll` uniform 0..31, matched | 1.06 | 1.03 | 5.9 | +2.2% / — | $1.30 ±1.17 | — | — | pass, buys little |
| **`roll` spike 1/16 @100, matched** | **2.15** | 1.42 | 4.7 | **+1.1% / +0.9%** | **−$0.80 ±1.91** | 0.769 | +1.5 ±1.6 | **PASS** |
| `roll` spike 1/32 @100, matched | 1.51 | 1.21 | 5.1 | +1.5% / — | $1.59 ±1.53 | 0.644 | — | PASS |
| `roll` uniform 1..100 *(mean +231%)* | 2.30 | 1.56 | 4.6 | +1.8% / — | $0.61 ±2.31 | 0.992 | — | pass, wrecks pacing |
| **`roll` uniform 1..200 — EXCEEDS 100** | 3.61 | 1.87 | 3.8 | **+31.1% / +33.0%** | **$18.25 ±2.99** | — | **+39.7 ±6.2** | **FAIL ×3** |
| **`roll` spike @400 — EXCEEDS 100** | 1.91 | 1.29 | 5.5 | **+53.5% / —** | — | — | — | **FAIL** |
| `surge` L=4 | 1.19 | 1.13 | 5.3 | +1.9% / — | — | — | — | pass, buys little |
| **`surge` L=8 / 16 / 64 / 128** | 1.40 / 1.77 / 3.12 / 4.21 | 1.26 / 1.48 / 2.27 / 2.91 | 5.1 / 4.4 / 3.1 / 2.2 | **+5.5% / +11.6% / +44.6% / +73.6%**; at 48 seats L=64 is **+8.9%** | **$4.33 ±1.58** (L=64) | — | **+12.9 ±2.6** | **FAIL** |
| **`comeback` k=0.5 / 1.0 / 2.0** | **0.97 / 0.99 / 0.89** | **0.82 / 0.75 / 0.68** | 12.8 / 16.1 / 21.9 | **+18.8% / +33.2% / +45.0%**; +5.0% at 48 | ok | — | **+370 pp** | **FAIL, twice** |
| fewer/bigger m=2 (roll ×2, steps ÷2) | 1.54 | 1.23 | 5.8 | +1.7% / — | $1.60 ±1.60 | 0.667 | — | PASS |
| **fewer/bigger m=3** | **2.10** | 1.43 | 4.9 | **+1.2% / +0.5%** | **$0.57 ±2.03** | 0.877 | −2.5 ±1.7 | **PASS** |
| `retain` 25% / 50% / 75% | 1.26 / **1.87** / **3.41** | 1.08 / 1.23 / 1.58 | **7.6 / 9.6 / 14.2** | +2.0% / +2.3% / +2.4% | $2.65 ±1.58 (50%) | 0.663 | — | PASS |
| `retain` 100% | 9.02 | 3.13 | 24.2 | +11.0% *(±7.1)* | — | 3.347 | — | unusable |
| `retain` 100% capped at stake | 3.99 | 1.70 | 18.7 | +3.1% / — | $0.25 ±2.47 | 0.930 | — | PASS |
| **`retain`@stake + spike 1/32** | **4.47** | **1.89** | 10.9 | **+3.7% / +0.5%** | **$1.46 ±2.84** | 1.049 | +4.6 ±4.5 | **PASS — best** |
| `retain`@stake + fewer m=2 | 4.32 | 1.85 | 11.2 | +2.6% / +1.1% | $2.07 ±2.77 | 1.119 | −1.3 ±2.3 | PASS |
| `retain` 75% + fewer m=2 | 5.32 | 2.11 | 10.6 | +3.1% / — | $5.12 ±3.54 | 1.874 | — | elevated, wide CI |

**Three results, and two of them refute things stated in advance.**

**(1) `surge` fails, and I predicted it would pass.** The martingale argument — that a uniformly-drawn
surge side keeps `P(a=i,d=j) = P(a=j,d=i)` marginally — is **provably correct about the ordered-pair
marginal** (½(u+u) = u) and **wrong about the outcome**. Once a window has begun, its surge side is in
the filtration, and inside a run the attacker **banks** — ring unchanged, gain **linear in L** — while
the defender **decays** — loss **geometric, `1 − 0.8475^L`**. That convexity points at the smaller
ring, so **the surge reintroduces exactly the tilt §3 is arguing against, and the sybil farm with it**:
`$4.33 ±1.58/round` on the split bar against a shipped floor of `$1.83 ±1.10`, a `+44.6%` band spread
at 8 seats, and **+12.9 ±2.6 points for picking the lighter side**. The effect scales as **`L/n`**
exactly as predicted — `+44.6%` at 8 seats, `+8.9%` at 48. **A candidate has to pass at both, and
testing only the big lobby would have shipped it.** Only `L = 4` is clean, and it buys 1.19×.
**Correlation is the efficient lever in theory and unusable in practice.**

**(2) `comeback` fails twice, and the first failure is the interesting one.** Paying the trailing side
more is *mean-reverting*: it **pins the score near 50%.** It multiplies lead changes by 2–3.6× while
**reducing** swing to 0.89× and maxExc to 0.68×, and it collapses terminal money dispersion from 7.14
to **1.05** — it makes outcomes *more uniform*, which is the exact opposite of the ask. Then the
side-selection test finishes it: joining the **lighter** side is worth **+370 percentage points**.
§11.3 removed an entry-order bias worth ±15%; this would reinstate one twenty-five times larger. It is
the wrong lever twice over, and the crossings-vs-amplitude distinction is what separates the two.

**(3) The obvious idea — a wider die — is a trap, exactly where predicted.** `dmg = basis·roll/100`
with `if (dmg > D.hp) dmg = D.hp`. Once `roll` can exceed 100 the clamp fires when `min == D.hp` and
does **not** fire when `min == A.hp < D.hp`, so a small attacker takes more than its own ring from a
big defender while a big attacker cannot. Measured: **+31.1% and +53.5% band spreads**, and the split
table shows a monotone farm across *every* `k` for those two rows and no other. **The rule "the die
must never exceed 100" is the whole of the fairness constraint on the roll**, and a mean-matched
**spike** gets 1.5–2.2× of swing while obeying it.

### 5.4 The costs — bar 3 (the farm) and bar 4 (retention)

**Bar 3, the split farm, at 800 rounds/cell — and the statistic matters more than the sample.** A
"best `k`" is a **maximum over seven noisy cells**, so it is biased upward and comes out positive for
a rule with no farm in it at all: the SHIPPED control's own argmax reads $1.83/round. The honest
statistic is a **pre-registered `k = 8`**, whose standard error means what it says. Read the shipped
row as zero and everything within it as zero:

| candidate | gain at k=8, $/round | vs the shipped floor |
|---|---|---|
| **SHIPPED** | **$1.83 ±1.10** | — *(this is the floor, not a farm)* |
| `roll` spike 1/16 matched | **−$0.80 ±1.91** | clean |
| fewer/bigger m=3 | $0.57 ±2.03 | clean |
| `retain` 100% capped at stake | $0.25 ±2.47 | clean |
| **`retain`@stake + spike 1/32** | **$1.46 ±2.84** | clean |
| `retain` 50% | $2.65 ±1.58 | +$0.82 over the floor — not significant |
| **`surge` L=64** | **$4.33 ±1.58** | **FAIL** |
| **`roll` uniform 1..200 (>100)** | **$18.25 ±2.99** *(argmax $24.22 = $15,841/day)* | **FAIL** |

**And a correction to my own instruction to the rig.** I told it that **side-stacking** would be the
stronger adversary layout, because alternating sides wastes half the splitter's exchanges on internal
washes. **That is wrong for these mechanics.** Under `surge L=64` the splitter earns $4.33 ±1.58
stacked against **$6.94 ±1.29 alternating**. The reason is that these are **size** tilts, not **side**
tilts: stacking crowds the small wallets onto one side facing a thinner opposing field, and that costs
more than the washes save. **The bar has to be the worse of the two layouts, and the rig now reports
both.**

**Bar 4, retention, is where the volatility candidates actually cost something.** Per-round ROI
standard deviation for a focal fighter:

| candidate | σ whale $90 | σ small $12 | σ minnow $5 |
|---|---|---|---|
| **SHIPPED** | 0.342 | **0.442** | 0.420 |
| `retain` 50% | 0.476 | 0.663 | 0.605 |
| `roll` spike 1/16 matched | 0.581 | 0.769 | 0.806 |
| fewer/bigger m=3 | 0.625 | 0.877 | 0.872 |
| **`retain`@stake + spike 1/32** | 0.844 | **1.049** | 1.194 |

**Mean R stays at 0.9900 = 1 − fee for every passing candidate**, which is bar 2 confirmed from the
other side. **P(ruin over 200 rounds) turned out not to discriminate at all** — it saturates at
95–100% for every candidate **including the shipped rule**, because a full-bankroll re-staker is
already ruined by the game as it stands. Per-round σ is the usable statistic, and every candidate
raises it by 50–140%.

> **That is the trade, and it should be made consciously rather than discovered later: at full
> redeployment this game already ruins ~95% of players inside 200 rounds, so "more tension" is being
> bought out of a lifetime budget that is nearly spent.** More excitement and longer retention pull
> against each other.

### 5.5 Compute and the redeploy

Against the measured profile in `lib.rs` (~3,000 CU fixed + ~214 CU/step, `MAX_STEPS_PER_CALL = 3,000`,
1.4M CU ceiling, `tick` measured at 645,685 CU = 46.1%), the ceiling arrives at ~6,500 steps, so there
is ~2.2× headroom.

| knob | O(1)/step? | extra hash bytes | touches the bell / `PENALTY_HORIZON_STEPS`? |
|---|---|---|---|
| `roll` spike | **yes**, ≈free | `h[20..28]`, unused by both layouts | no — mean-matched, pacing unchanged |
| `surge` | yes | none, one extra sha256 per window | no |
| **`retain`** | **yes** — one multiply, one divide, one compare | **none** | uncapped `retain` stops fights ending (deaths 65% → 27% at 75%). **`retain`@stake does not: deaths 71%, better than the shipped 65%.** That ceiling is what makes it shippable rather than merely interesting |
| fewer/bigger `m` | yes, and it **reduces** CU by 1/m | none | **yes — it IS a step-budget change, and the only survivor that moves `STEPS_PER_FIGHTER_PER_SECOND` and so needs `PENALTY_HORIZON_STEPS` refitted** |

**All of them are O(1) and all of them could ship inside the same instruction change**, which matters
because the redeploy is the expensive part: a new program id at **~2.55 SOL = $382.50 at SOL $150**,
**every PDA resets** (arenas, rounds, `Treasury.fees_accrued`, all round history), `fee_bps` must be
re-set to 100, and both TypeScript mirrors plus `parity.ts` must be re-run. **The SOL is not the cost;
the reset and the migration are.**



---

## 6. THE OPERATOR IS THE WORST-PLACED FARMER IN THE GAME, AND NO CANDIDATE CHANGES THAT

The request was for a mechanic that gives the operator's small wallets an advantage. Every published
mechanic gives that advantage to **everyone**, and the operator is structurally the worst participant
to be handed it. Four reasons, none of which any candidate escapes.

| | why it binds the operator and nobody else |
|---|---|
| **it pays keeper gas** | 0.00981 SOL/round pre-reclaim = **$1.4715**; **$0.0615** post-reclaim (`HOUSE-LIFETIME.md` §1). A private adversary pays **one Solana signature, $0.00075**. The operator's per-round cost of being in the game is 1,962× the attacker's pre-reclaim and 82× post. |
| **it must seat every round** | `houseSizing.ts` seats the ladder to fill the board. An adversary picks its spots — and §2 shows the bonus is **zero** in a lobby of equals, so the attacker simply skips those rounds and the operator cannot. |
| **its wallets are published** | `keeperStatus.ts` publishes `house.wallets` to every browser and `LeaderboardView.tsx` renders `FighterView.house` on the row, deliberately, as a disclosure obligation. A farm run from published wallets is a farm run in public. |
| **it can never wear a face** | `TWITTER-CONNECT.md` §6.3: `/api/x/link` **rejects any wallet in `keeperStatus.house.wallets`** — "a house wallet wearing a person's face would be an actual misrepresentation." **So the one candidate whose farm is asymmetric is asymmetric in the players' favour and not the operator's, by a standing rule this study does not propose changing.** |

**Measured, not argued: the private adversary is ahead of the operator by EXACTLY the gas, in every
row.** The farm rig ran the operator and a private attacker through identical mechanics and identical
lobbies. The gap is **$48.31/day post-reclaim and $1,155.80/day pre-reclaim** — the keeper's own cost
and nothing else — because *always-seating turns out to be available to the attacker too*, so
selectivity is not where the operator's disadvantage lives. **The disadvantage is simply that the
operator pays to run the room.**

**And the money the house would farm comes out of real players.** The fight is zero-sum, so a house
wallet's winnings are some real player's losses; `HOUSE-STRATEGY.md` §3 asserts
`net_house == −(real players' net)` in integers every round. Quantified here: **at `P = 40`, real
players lose $1.87 for every $1 the house farms** — the excess being the fees those players also paid
on the stakes they lost. §4.5 measures the end of that chain: the tilt that pays the attacker
**reduces the house's own population rake by $10,826/day at `P = 20`**, because players who have been
farmed have less left to be raked.

> **The plain sentence the brief asked for.** **No disclosed mechanic gives the operator an edge a
> private adversary cannot take faster, larger, and more cheaply. Not one of the five candidates comes
> close, and the ranking is not sensitive to any parameter — it follows from the operator paying a
> per-round cost the attacker does not, and from the attacker being able to choose its rounds.**

---

## 7. RECOMMENDATION

### 7.1 The one-line answers

| request | answer |
|---|---|
| **favour small players** | **Do not ship any of it.** Every version's farm rate equals or exceeds its intended effect, by an identity. |
| **is there a tilt too weak to farm but strong enough to matter?** | **No — and it is not a tuning failure.** The window is **1.31× wide at every gas price** (gas cancels), the attacker breaks even at **0.112 bps** against a **1 bps** minimum representable setting, and inside the window an honest $5 player gains **0.0047%/round**. Meanwhile the lifetime case needs **P ≥ 20**. Gap: **~180×**. §3.7 |
| **make the score swing** | **Ship it — but start with the free version.** Seat 16 instead of 48 and get 1.69–1.91× for $0. If that is not enough, **`retain`@stake + a mean-matched 1-in-32 spike** is the one program change worth the redeploy: **4.47× swing on 1.8× fewer exchanges**, clean on all four bars. |

### 7.2 What to do, ranked, with the price of each

| # | action | costs | buys | needs a redeploy? |
|---|---|---|---|---|
| **1** | **Reconsider `STAKE_CAP_USD = 100`** (`engine/src/arenas.ts:40`, "locked by Max") | **$0** — a parameter, not a program change | **+$15.70/acquired player (18.6σ), 4.1× the best blend, and NO farm rate.** The largest revenue lever measured anywhere in this study. **Caveat: it favours whales, so it answers a different question than the one asked, and the simulator prices its revenue cost without pricing the exposure it buys** | **no** |
| **2** | **Seat 16, not 48** (keeper lobby sizing) | **$0** | **1.69–1.91× lead swing**, 42% → 19% of fights ending at the bell | **no** |
| **2b** | **Tell small players the truth: the fight is already exactly size-neutral** | $0 | the thing the request was actually after — §11.5 measures every band at exactly minus the fee, and nobody is saying so | no |
| **2c** | **Matchmaking by stake band**, if the goal is a better experience for small players | −$1.76/player (2.9σ) | **equalises variance across sizes** (sd flat ~40% vs a 45%→35% gradient) and removes the sub-$0.10 dust drain. **Structurally unfarmable.** A fairness instrument, priced as one | no |
| **2d** | **A bounded, identity-gated rebate**, if a small-player benefit must be *given* rather than *disclosed as a rule* | revenue-neutral at every setting tested (≤0.8σ) | the only small-player benefit whose **worst case is bounded by construction** — cap × identities — rather than by the seat count | no |
| **3** | **`retain`@stake + mean-matched spike 1/32** — each hit lands back in the attacker's ring up to their original stake, and the die keeps its mean but grows a 1-in-32 tail to 100 | ~$382.50 + PDA reset + mirror parity | **4.47× swing, 1.89× max excursion, 1.8× lead changes; band spread +3.7%/8 seats and +0.5%/48; split farm $1.46 ±2.84 against a $1.83 ±1.10 floor; deaths 71% vs the shipped 65%; and 1.8× FEWER on-screen exchanges** | **yes** |
| 3b | *if only one line is affordable:* **mean-matched spike 1/16 alone** | same redeploy | 2.15× swing, clean on all four bars, **no constant moved** | yes |
| **3c** | **Raise the dust floor, or make the dust finish symmetric** (`er-sim.ts:199`) | needs a program change — bundle it with #3 | **removes the one genuine small-player penalty in the shipped game: a $0.01 wallet currently loses ~8.4%/round against everyone else's 1.00%.** A floor is not a tilt: raising it gives nobody a percentage edge, so it has **no farm rate** (§2.1) | **yes — same instruction change** |
| 4 | Persist `verified_type`; require X Premium for any future bonus | one schema column, $0 API | farmer cost per identity ~$1 → **~$96/yr**, against a break-even of **$116–$720 per wallet per day** | no |
| 5 | Leave `STAKE_CAP_USD` at $100 | $0 | lowering it costs **47–86% of lifetime revenue** for 27–55% more rounds | no |
| ✗ | **any stake-banded damage tilt** | — | **at P=20 the operator LOSES $10,826/day while a single $80 attacker gains $2,251/day; at P=100 the attacker takes 78c of every dollar the operator gains** | — |
| ✗ | **`surge`, `comeback`, any die that can exceed 100** | — | all three open an 5.5%–73.6% band spread | — |
| ✗ | **fee/penalty banded by stake** | — | 75% drained in one round, and smoothing removes the cliff not the gradient | — |

### 7.3 Expected revenue, per player and per day

Everything below is **conditional on there being players**, which today there are not
(`keeper-status.json` #20: `realFighterCount: 0`).

*(the middle column is `retain`@stake + spike 1/32)*

| | shipped | volatility fix | `blend P=20` |
|---|---|---|---|
| lifetime rake per acquired player | **$21.23 ±0.35** (KM, 8 replicates) | not separately measured — σ rises 137%, so **expect a fall**, not a rise | $17.63 ±0.68 (+$1.12) |
| rounds lived | 29.08 ±0.84 | expected lower | 30.47 ±0.93 |
| house rake, $/lobby-round at 8 seats | **$4.82** | ~unchanged — mean R stays 0.9900 = 1 − fee | $4.68 |
| house gross, $/day, 800 players | $375,668 | ~unchanged | **−$10,826** |
| **a single $80 adversary, $/day** | **−$285 ±1,497 — zero** | **$1.46 ±2.84/round — inside the $1.83 ±1.10 shipped floor, i.e. zero** | **+$2,251** |

**Per-round economics against gas** (`HOUSE-LIFETIME.md` §1): at four real players the entry rake is
$5.03/round against **$0.0615/round post-reclaim** — it covers gas **82×**. **The gas fix is still
worth more than every mechanic in this document combined**, and it is still pointed at a v6 program id
in `keeper-status.json`.

### 7.4 Is the redeploy worth it?

**For the small-stake tilt: no, and not marginally.** $382.50 plus a full PDA reset to install a rule
that, at every setting below `P = 100`, **loses the operator money outright** while paying a single
$80 attacker thousands a day — and at `P = 100` gives that attacker 78 cents for every dollar it gives
the operator. It is paying to reopen the defect §11 was written to close. **And the one thing it does
buy — a partial refund of the $100 stake cap's cost — is available for free and four times over by
reconsidering the cap itself (§4.3).**

**For `retain`@stake + spike 1/32: yes.** $382.50 is **7.3 hours of revenue** at the four-real-player
run rate — trivial *if the players exist*. The real price is the PDA reset and the migration. It
clears all four bars at 800 rounds/cell, and it happens to answer the half of the request I nearly
missed: the owner also said the visuals are *"maybe a little bit too erratic"*, and this candidate
produces **1.8× fewer on-screen exchanges** while moving the score 4.47× more. Fewer, larger, more
consequential hits. **The one genuine cost is bar 4** — per-round σ goes 0.442 → 1.049 for a small
player, and this game already ruins ~95% of full-redeployment players inside 200 rounds.

**Do option 2 first regardless.** Sixteen seats is free, recovers 1.69–1.91× on its own, and is
reversible in a config change. If it satisfies the brief, the redeploy is not needed at all — and if
it does not, it stacks with the program change rather than competing with it.

**And if a redeploy happens for any reason, both requests should ride in the same instruction change.**
Every passing volatility knob is O(1) per step with 2.2× CU headroom. The tilt should not be among
them.

### 7.5 What the owner actually asked for, and the honest version of it

> *"so that on avg by using many small players you have an advantage"*

**There is no disclosed rule that gives the operator that advantage. There is a disclosed rule that
gives it to everyone, and the operator is last in the queue** — it pays $1.4715/round of gas nobody
else pays, it must seat every round, its wallets are published, and it may never wear a face. Every
candidate measured either loses the operator money outright or hands a single $80 attacker 78 cents
for every dollar it hands the operator — and the attacker's take scales with capital, with the number
of attackers, and with the number of arenas, while the operator's gain does not.

**But the request underneath it — "small players should have a better time" — is already true and is
not being told.** The shipped fight is *exactly* size-neutral: `basis = min(attacker.hp, defender.hp)`
means a $5 fighter and a $100 fighter face the identical percentage risk, every band sits at exactly
minus the 1% fee, and `demo-equalizer.ts` shows a $200 whale collecting $198.03 while seven $5 minnows
collect $4.88–$5.01. **Most arenas cannot say that. This one can, and it is a marketing asset sitting
unused while the alternative on the table is a published subsidy to whoever opens the most wallets.**

---

## 8. THE OUTSIDE VIEW — every number here is an external prior, graded and dated

Sourced 2026-08-11. **[A]** peer-reviewed/regulatory, **[B]** operator or primary disclosure,
**[C]** industry analysis, **[D]** vendor marketing or anecdote. Grey-market prices are **ask prices
scraped from storefronts**, not audited transactions, and they decay fast — re-check quarterly.

### 8.1 What an identity costs the farmer

| gate | cost per identity | grade |
|---|---|---|
| X account, softreg (email only) | **$0.065–$0.093** | [D] accsmarket.com listing, 4,852+ in stock, 2026-08-11 |
| X account, SMS+email verified | $0.185–$0.555 | [D] same |
| X account, phone-verified [PVA] | from $1.39 | [D] same |
| aged US/CA X account, 2011–2022 | $3.60 | [D] vendor blog |
| virtual SMS number | **$0.008–$0.10** | [D] 5sim.net pricing |
| **X Premium (the paywall variant)** | **~$96/yr web** ($8/mo), requires a verified phone, 30-day activity, no recent profile edits | [B] help.x.com |
| Worldcoin Orb credential, grey market | $30 (2023, China); Taobao $1.40–$70 | [C] CoinDesk / The Block |

**Human Passport — the leading web3 sybil-defence scorer — has RETIRED the X stamp entirely** (January
2026 reweight). When it was live it carried **3.2 points against a passing threshold of 20**: the
vendor priced one X account at **16% of one human**, and now prices it at zero. Gitcoin's own fraud
team: *"social-media only is not a very effective trust-booster."* [B]/[C]

**Measured sybil rates where the gate was tried:** Hop **23.8%** of eligible addresses flagged (2022);
Optimism **+17,000** addresses clawed back post-hoc (2022); Arbitrum **21.8% high-confidence, ~48%**
in same-entity clusters (2023); LayerZero **13%** of ~6M (2024); Gitcoin GR13 **14.1% ±1.3%** with
flagging efficiency only **84%** — the system *under*-flagged relative to human judgment. [A]/[B]

### 8.2 The literature already contains this study's central result

- **Quadratic funding, pairwise-bounded** (Buterin, ethresear.ch, 2019). The bound is exact: `k`
  colluding agents extract at most **`k(k−1)M`, independent of how much capital they commit.** It
  solves the *capital* problem completely and the *identity* problem **not at all** — an attacker
  profits whenever `k > 1 + c/M` for identity cost `c`. **Pairwise bounding presupposes expensive
  identities. Ours cost a dollar.** [A]
- **Humanode** shipped an explicitly square-root (small-favouring) airdrop — and only on top of
  **biometric** proof-of-uniqueness. Against a cheap-identity attacker a concave payout curve is
  **strictly worse than linear**, because it pays a bonus for splitting. [B]
- **PoolTogether V4** capped a depositor at two prizes per draw to bound whales. Its own governance
  forum records the defeat in one line: whales **split deposits across multiple wallets.** [B]
- **Uniswap's flat 400 UNI per address** — the maximally small-favouring rule — was farmed openly. [C]

### 8.3 Nobody has ever shipped this, and the one adjacent case ended badly

**A direct search found no casino, sportsbook, poker room or exchange with a disclosed rule paying
small stakes better than large ones.** Every documented VIP/rakeback ladder is **progressive**. The
closest disclosed prior art is **Betfair's Premium Charge** — regressive in *profit*, not in stake:
20% on net profits from 2008, raised to **up to 60%** in 2011 and aimed explicitly at syndicates and
bots. The affected cohort **left**, with documented migration to competing exchanges. [C]/[D]

The nearest true analogue is the **welcome bonus**, which is economically identical to a per-account
subsidy and which the iGaming industry has run continuously for 25 years, disclosed, in every regulated
market. **Bonus abuse is now cited by 78% of 993 surveyed operators as their top fraud threat** [D —
vendor-sponsored survey, and the vendor sells the countermeasure]. **Operators did not respond by
making the curve cleverer. They responded with identity dedup at the payment-instrument, device,
household and IP level, mandatory KYC, and T&Cs that void winnings.** An industry with payment rails,
legal recourse and mandatory KYC still rates this as fraud problem number one. A crypto arena with an
X-OAuth gate has strictly weaker tools.

### 8.4 The retention premise: the best-identified evidence points the other way

- **Lucas & Spilde**, four papers 2019–2021, *Cornell Hospitality Quarterly* and *IJHM*: physically
  identical slot machines placed side by side differing **only** in house advantage, across five
  pairings, three casinos, three markets, samples to 365 days. **The higher-par — worse-for-the-player
  — machines produced HIGHER revenue, with no compelling evidence of play migration.** Frequent
  players could not detect the price even over long periods, and the 2021 paper found no
  hypersensitivity even to egregious par increases. [A] *Caveat: reel slots; per-machine revenue, not
  per-player LTV; cannot observe players who left the property.*
- **FOBT £100 → £2, 1 April 2019.** Bookmaker machine GGY **£3.3bn → £2.4bn**; one operator −40%. **The
  capped whale did not convert into small-stake revenue.** [A]/[C] — this is §4.3's result, measured on
  a real market.
- **Auer, Hopfgartner & Griffiths (2021)**, n = 175,818 Kindred customers: voluntary limit-setters were
  **2.96× more likely to still be active a year later.** [A] *But: only 8.3% set limits, the cohort is
  self-selected, and **the paper reports no revenue or LTV figure at all**. Kindred, who supplied the
  data, promoted the result.* Auer & Griffiths (2013), n = 100,000: deposit limits **reduced subsequent
  expenditure**.
- **No published study nets the spend reduction against the retention gain into a lifetime-revenue
  figure.** Anyone claiming "reducing losses raises LTV" is multiplying a measured correlation by an
  unmeasured effect. And the "low volatility → longer sessions → higher LTV" chain, specifically, is
  asserted **only** by vendor marketing pages with no citations. **State it as: no good evidence.**

---

## 9. WHAT WOULD FALSIFY THIS — stated in advance, as kill criteria

- **A per-wallet cost above ~$1/round appears.** Every conclusion here rests on a sybil paying one
  Solana signature ($0.00075) against a bonus of $0.21–$1.85/wallet/round. If entry became genuinely
  expensive — a burned fee, a non-refundable per-entry ticket — the arithmetic in §1.1 inverts and the
  blend becomes worth re-examining. Nothing in the roadmap does this.
- **The cadence collapses.** The 785 rounds/day figure is what makes one-off costs unrationing. At one
  round per day an X account at $1 would price a $0.21 bonus correctly. This is the only parameter that
  could change the identity-gate verdict, and it would have to move by three orders of magnitude.
- **`realFighterCount` stops being 0.** Every dollar figure here is conditional on there being players.
  §2 shows the bonus is **statistically zero** against the current house-bot-only board, so today the
  mechanic would ship a farm and no benefit.
- **A verified-identity gate with a real price ships.** X **Premium** at ~$96/yr per identity is the
  one available lever that moves the farmer's cost by 20–100×, and `TWITTER-CONNECT.md` §2.2 already
  requests `verified_type` from `/2/users/me` and §4.3 **throws it away**. Persisting one column would
  raise the cost floor from ~$1 to ~$96. **It still loses to $1,274/day, so it does not rescue the
  blend — but it is the cheapest sybil-resistance upgrade available and it should be judged on its own
  merits, not on this one.**
- **Acquisition is exogenous in the cohort, and that is the one channel left open.** A busted slot is
  refilled instantly by a fresh $100 player, so the simulator cannot see a mechanic that changes the
  RATE or COST of acquisition. **That is the only remaining route by which an anonymous small-stake
  bonus could pay** — if publishing it brought in enough new small players to outweigh a farm that
  takes 78 cents on the dollar. Nothing here measures it, and §8.3 finds no operator has ever tried it.
- **`STAKE_CAP_USD` turns out to matter more than any mechanic, and it was never the subject.** If the
  cap is there for exposure or tail-risk reasons this simulator does not model, then the +$15.70/player
  it costs is a price knowingly paid and §4.3's headline is a cost accounting, not a recommendation.
  **Ask what the cap buys before changing it.**
- **Real retention is ~1 round.** The only observed data (`engine/data/ledger.db`, 11 human wallets,
  median **1** round, `HOUSE-LIFETIME.md` §5) is two orders of magnitude below the ~30-round lives
  modelled here. If it is right, **every lifetime-revenue difference in §4 is worth cents**, the
  retention case evaporates for all mechanics equally, and only acquisition matters.
- **The behavioural model is wrong in the ruin channel.** §4.2 attributes most of the measured gain to
  the dust-rule ruin barrier and the $100 stake cap. Both are model artefacts of `BASE_PLAYER`'s full
  redeployment. Under partial redeployment the ruin channel shrinks and the gain with it.

---

## 10. REPRODUCING THIS

```
cd engine
npx tsx ../sandbox/house-edge/parity.ts                                   # RUN FIRST — PARITY OK
HE_FEE_BPS=100 npx tsx ../sandbox/house-edge/parity.ts                    # and at the live rate

HE_FEE_BPS=100 npx tsx ../sandbox/house-edge/small-stake-field.ts 1500    # §2  — who pays for the bonus
HE_FEE_BPS=100 NODE_OPTIONS=--max-old-space-size=12288 \
  npx tsx ../sandbox/house-edge/small-stake-farm.ts 800 all               # §1, §3 — intended effect vs farm
HE_FEE_BPS=100 npx tsx ../sandbox/house-edge/small-stake-lifetime.ts 3000 all     # §4 — the cohort
HE_FEE_BPS=100 npx tsx ../sandbox/house-edge/small-stake-lifetime.ts 3000 report  # §4 — cross-cell tables
HE_FEE_BPS=100 npx tsx ../sandbox/house-edge/fight-volatility.ts 800 all  # §5 — the lead-swing study
HE_FEE_BPS=100 NODE_OPTIONS=--max-old-space-size=12288 \
  npx tsx ../sandbox/house-edge/small-stake-pstar.ts 800 all             # §3.7 — P*, the unfarmable-tilt window

HE_FEE_BPS=100 npx tsx ../sandbox/house-edge/study-damage.ts 4000 4       # the blend band table
HE_FEE_BPS=100 NODE_OPTIONS=--max-old-space-size=12288 \
  npx tsx ../sandbox/house-edge/study-split.ts 800                        # the 48-seat split sweep
```

Every script is seeded and reproduces exactly; each prints its own reproducing command and every seed
in its header. Files added by this study, all in `sandbox/house-edge/`, none imported by anything
shipped:

| file | what it is |
|---|---|
| `small-stake-field.ts` | who pays for the bonus: the same $5 subject against seven different fields |
| `small-stake-farm.ts` | intended effect vs farm rate for every candidate; the identity-gate break-even |
| `small-stake-lifetime.ts` | the **closed-population** cohort simulator; conservation asserted in integers every round |
| `fight-volatility.ts` | aggregate lead volatility vs seat count, and the candidates that restore it |
| `small-stake-pstar.ts` | the low-`P` paired sweep behind §3.7: the attacker's net after their own per-wallet gas, the honest player's edge at the same `P`, and the bonus-per-wallet curve `b(s)` the whole argument rests on |

**The one change to an existing file** is `fight-variant.ts`, extended **additively**: an optional
`Fighter.verified` bit, and `{ blend, gate?, capMult? }` on the object damage rule, plus the roll and
surge knobs §5 needs. Every default reproduces the prior behaviour exactly and `parity.ts` asserts
`BASELINE` is still byte-identical to `engine/src/er-sim.ts`, at both rates.

**What the rig asserts about itself, so a reader knows what is load-bearing:**
- `parity.ts` — `BASELINE` byte-identical to `er-sim.ts` over 300 random lineups, at 20 and 100 bps.
- `small-stake-lifetime.ts` — `houseRake + Σbalances + Σwithdrawn == Σdeposited` **in integers, every
  round, every cell. Max absolute residual: 0 micro-units.** Exits non-zero if it ever fails.
- `small-stake-lifetime.ts` Validation 1 — E[R] = 1 in every stake bin above $0.10 at `P = 0`, worst
  **1.73σ**, harvested from the cohort's own lobbies rather than an invented field.
- `small-stake-lifetime.ts` Validation 2 — the cohort **disagrees with `lifetime-core.ts`'s pool by
  −10.3% on withdrawals per player**, and that gap is a finding rather than a failure: the pool's field
  does not decay and the cohort's does. It is the same self-referential effect the mechanic depends on,
  which is exactly why the study is run on a closed population.
- `small-stake-field.ts` — conservation asserted in integers on every one of its fights.
