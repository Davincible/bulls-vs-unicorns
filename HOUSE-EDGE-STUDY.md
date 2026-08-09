# House-edge study — the on-chain fight

Measured 2026-08-09 against the deployed algorithm (`advance_fight` in
`programs/bulls-arena/src/lib.rs`, via its checked-in mirror `engine/src/er-sim.ts`).

**Nothing was deployed. No Rust was touched. `engine/src/er-sim.ts` was not modified.** All work is
in `sandbox/house-edge/`, which nothing in `engine/`, `er-demo/` or `programs/` imports. Every number
below is reproducible: see `sandbox/house-edge/README.md` for the exact commands and seeds.

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
