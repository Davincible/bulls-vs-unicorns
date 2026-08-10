# The house's own book — does the operator have an edge, how big, and can it blow up?

Measured 2026-08-10 against the deployed algorithm (`engine/src/er-sim.ts`, asserted byte-identical to
`advance_fight` by `sandbox/house-edge/parity.ts`) and against the deployed house policy
(`er-demo/scripts/keeper/houseSizing.ts`, reimplemented constant-for-constant in
`sandbox/house-edge/strategy-live-policy.ts`).

**Nothing was deployed. No Rust was touched. No TypeScript mirror was modified.** All work is in
`sandbox/house-edge/`, which nothing in `engine/`, `er-demo/` or `programs/` imports. Every number
below carries the command and seed that reproduces it.

**Companion document:** `HOUSE-EDGE-STUDY.md` measures the GAME (is the fight fair, is it farmable,
what does the rake do to players). This document measures the OPERATOR (what does the house actually
make, what does it risk, and which dial moves it). §11 of that study is the current-state measurement
of the game at the live 100 bps rate and is the input to everything here.

---

## 0. The five findings, in the order they matter

1. **The house's realised cash flow today is −0.00981 SOL per round, and the 1% is not money.** The
   deployed program moves no tokens. §1.
2. **The house's own wallets have exactly zero expected profit.** The "army of small wallets farming
   the game" strategy was worth +$152/round under the v5 defect and is worth $0.00 ± noise now,
   because closing the farm and removing the small-stake edge were the same act. §3.
3. **The treasury figure overstates net revenue by up to 4×, and the keeper policy changed
   mid-session in the direction that makes this worse.** At one real player, 75.6% of treasury intake
   is the house paying itself. House seats also displace paying seats: net revenue falls from $8.60 to
   $2.75 per round as the house takes 0 → 6 of 8 seats. §2, §2.1.
4. **Under an assumed 30% early-extraction rate, the extract penalty is ~60% of modelled revenue —
   and it is destroyed by one sentence of public knowledge.** Extracting after the penalty horizon is
   free and EV-neutral, measured. §4.
5. **Retention and the rake are in direct conflict.** A player who redeploys their whole balance each
   round has a median terminal balance of **$0.01 after 200 rounds** from a $100 start. §5.

---

## 1. REGIME A — today. The 1% is exact arithmetic over money that has not moved.

**This is the finding that reorders the others, and it is not an economic one.**

`programs/bulls-arena/src/lib.rs` moves zero tokens. Verified rather than assumed:

```
grep -c "anchor_spl\|token::transfer\|TokenAccount" programs/bulls-arena/src/lib.rs   # 0
grep -A12 "^\[dependencies\]" programs/bulls-arena/Cargo.toml    # anchor-lang, ephemeral-rollups-sdk,
                                                                 # solana-sha256-hasher, session-keys
grep -n "members" Cargo.toml    # ["programs/bulls-arena", "programs/bulls-arena-session-spike"]
```

`Enter<'info>` (lib.rs:2413–2425) carries five accounts — `arena`, `round`, `player`, `session_token`,
`signer` — and not one is a token account. `programs/vault/` is the only place in the repo with
`anchor_spl`, it is excluded from the workspace `members` list, and it still declares the placeholder
id `VauLt1111111111111111111111111111111111111`. The program says so itself at lib.rs:9–12 and
lib.rs:1942–1944 ("a RECORD, not custody… the treasury is paid off-chain from the ledger").

So `Round.fees_collected`, `Round.penalties_collected` and `Treasury.fees_accrued` are `u64`
**counters**. The treasury taking "exactly 680,000 units on round #27's gross of 68,000,000" is a
correct observation about a number in an account. On the live site every balance the player sees is
browser `localStorage` — `er-demo/src/v2/data/simLedger.ts`, key `v2.sim.ledger.1`, and the file's own
header says "The ER program custodies NOTHING… no deposits, no withdrawals, no house treasury".

**The only real cash flow in the system is the keeper's, and it is outbound.**
`er-demo/scripts/keeper/config.ts:114` and `keeper/README.md:145,595`, reconciled across 28 real
rounds: **0.00981 SOL per round, all-in** — of which 0.008503160 is round-PDA rent that is never
reclaimed (no instruction closes a `Round` account) and 0.003220520 is delegation rent that is
refunded.

```
cd engine
npx tsx ../sandbox/house-edge/strategy-live-policy.ts 3000 200
POLICY=old npx tsx ../sandbox/house-edge/strategy-live-policy.ts 3000 200   # the session-start ladder
```

| real players | mean house fighters | real gross/round | **ledger** net house revenue | **circular share of treasury** | **REAL cash flow** |
|---|---|---|---|---|---|
| 0 | 1.00 | $0.00 | $0.000 | n/a | **−$1.471** |
| 1 | 9.00 | $41.72 | $1.489 | **75.6%** | **−$1.471** |
| 2 | 8.00 | $84.71 | $2.655 | **37.7%** | **−$1.471** |
| 3 | 7.00 | $126.90 | $3.884 | 22.6% | **−$1.471** |
| 4 | 6.00 | $165.87 | $5.028 | 14.9% | **−$1.471** |
| 6 | 4.00 | $250.97 | $7.503 | 6.6% | **−$1.471** |

(3,000 rounds per row, seeds `sha256("live-policy-v1|<round>|<realCount>|0.3")`, SOL at $150 — an
assumption; set `SOL_USD` to change it. The accounting identity `net_house == −(real players' net)`
was asserted in integers in every round of every row.)

**The circular-share column is the direct answer to the trap in the brief, and it is worse than the
2-house-to-2-real guess.** At one real player, **75.6% of treasury intake is the house paying itself**;
at two it is 37.7%. The treasury number is not net revenue and should never be quoted as such.

**The right-hand column is the headline and it is negative in every row.** At the ~110s cadence the
arena burns ~0.32 SOL/hour whether anyone plays or not. A 3.66 SOL balance funds **373 rounds ≈ 11.4
hours**; 20 SOL funds ~62 hours.

> The "3.66 SOL operating balance" in the brief **appears nowhere in this repository.** The only
> figure I could corroborate is the 0.00981 SOL/round cost above. 3.66 is carried as given and every
> number derived from it is flagged.

Note the `0` row: with no real players, ledger net house revenue is **exactly $0.000**. That is the
circularity result in its purest form — the house pays itself a fee, its wallets lose exactly that fee
to the pot, and the two cancel to the cent. It is also why a house-only room cannot generate revenue
no matter how many wallets are in it, and why the new `HOUSE_MAX_WITHOUT_REAL_PLAYER = 1` early return
(which stops such a room from fighting at all) costs nothing.

---

## 2. REGIME B — if custody ships. The take rate, and the volume that pays for the gas.

Everything in this section is an **EXTRAPOLATION**: it assumes a custody path that does not exist
behaves exactly as the counters do. Same command, same 3,000 rounds, same seeds.

| real players | real gross/round | net house revenue | 95% CI | take rate on real gross | minus gas | **break-even real gross** |
|---|---|---|---|---|---|---|
| 1 | $41.72 | $1.489 | [1.252, 1.725] | 3.57% | +$0.018 | $41 |
| 2 | $84.71 | $2.655 | [2.338, 2.996] | 3.13% | +$1.183 | $47 |
| 3 | $126.90 | $3.884 | [3.540, 4.242] | 3.06% | +$2.413 | $48 |
| 4 | $165.87 | $5.028 | [4.623, 5.417] | 3.03% | +$3.557 | $49 |
| 6 | $250.97 | $7.503 | [7.089, 7.927] | 2.99% | +$6.031 | $49 |

**The arena needs roughly $41–$49 of real player volume per round just to pay its own gas.** Below
that it loses money however good the edge is — one real player is almost exactly break-even
(+$0.018/round), and everything above that is profit. This figure is robust to the policy change: it
moved by under $2 between the two ladders, because it depends on the take rate and the gas, neither of
which the house's own seat count affects.

The take rate is ~3% rather than the 1% fee because of the extract penalty — see §4, and note that the
3% depends entirely on an assumption nobody has measured.

### 2.1 The circular-fee trap — and a policy change that made it four times larger

House wallets pay the entry fee through the same `enter` instruction with no exemption (lib.rs:1253,
1268 — no caller check). So a share of `fees_collected` is the house paying itself. The honest
accounting is consolidated:

```
net_house = (fees_collected + penalties_collected) + SUM over HOUSE fighters (payout − gross)
```

which by conservation equals `−(SUM over REAL fighters (payout − gross))`. **The house's net revenue
is exactly what real players lose; nothing else is revenue.** `strategy-house-book.ts` asserts both
forms agree, in integers, every round.

```
cd engine
npx tsx ../sandbox/house-edge/strategy-house-book.ts 4000 200
```
8 seats, house at $10/seat, P(real extracts) = 0.30, 4,000 rounds/row:

| house seats | treasury intake | of which circular | fee (real) | penalty (real) | house P&L | net house | % of REAL gross | % of TOTAL gross |
|---|---|---|---|---|---|---|---|---|
| 0 | $8.56 | $0.00 (0%) | $3.300 | $5.263 | $0.000 | **$8.56** | 2.60% | 2.60% |
| 1 | $7.96 | $0.10 (1%) | $2.915 | $4.948 | −$0.170 | $7.79 | 2.67% | 2.58% |
| 2 | $6.96 | $0.20 (3%) | $2.526 | $4.238 | −$0.314 | $6.65 | 2.63% | 2.44% |
| 4 | $5.09 | $0.40 (8%) | $1.702 | $2.988 | −$0.275 | $4.81 | 2.83% | 2.29% |
| 6 | $3.44 | $0.60 (17%) | $0.865 | $1.970 | −$0.345 | $3.09 | 3.57% | 2.11% |

Two things to read off it:

* **"% of REAL gross" is flat.** House wallets contribute nothing per unit of real volume — they are
  a liquidity cost with zero expected return.
* **The absolute number collapses, and that is the real cost.** $8.56 → $3.09 as the house takes 0 →
  6 of 8 seats. Not because of circular fees (17% at worst) but because **six house seats mean two
  paying seats.** The gap between the last two columns (2.60% vs 2.11% at the extremes) is the size
  of the illusion a naive treasury/volume ratio would report.

**The deployed keeper already solves this**, and it is worth recording that it does.
`houseSizing.ts:116–121`:

```ts
const throttled = Math.max(HOUSE_FLOOR - realTotal, HOUSE_TARGET - DISPLACEMENT * realTotal);
const cover = (real.side0 === 0 ? 1 : 0) + (real.side1 === 0 ? 1 : 0);
return Math.max(0, Math.min(HOUSE_MAX, Math.max(throttled, cover)));
```

> **THE POLICY CHANGED WHILE THIS WAS BEING MEASURED.** The tree was clean at commit `8ccf1ea` when
> this session began; `er-demo/scripts/keeper/` was then modified by another writer mid-session. The
> constants are now env-tunable in `config.ts` and the defaults are far more aggressive. I did not
> make these edits and did not revert them; the model was re-run against the current values, and both
> ladders are reported because **the direction of the change is itself the finding.**

| constant | at session start | now | source |
|---|---|---|---|
| `HOUSE_WALLET_COUNT` | 6 | **10** | `config.ts:524` |
| `HOUSE_BOARD_TARGET` | 4 | **10** | `config.ts:539` |
| `HOUSE_DISPLACEMENT` | 2 | **1** | `config.ts:551` |
| `HOUSE_STAKE_MAX_USD` | 50 | **20** | `config.ts:570` |
| `HOUSE_MAX_WITHOUT_REAL_PLAYER` | (none) | **1** | `houseSizing.ts:114` |

`config.ts:538` says so itself: "`KEEPER_HOUSE_BOARD_TARGET=4` with `KEEPER_HOUSE_DISPLACEMENT=2`
restores the old ladder exactly." Run `POLICY=old npx tsx ../sandbox/house-edge/strategy-live-policy.ts`
to measure the old one.

| real players | OLD ladder | **CURRENT ladder** |
|---|---|---|
| 0 | 4 | **1** (new early return: an empty room must not be able to fight) |
| 1 | 2 | **9** |
| 2 | 0 (+cover) | **8** |
| 4 | 0 (+cover) | **6** |
| 6 | 0 (+cover) | **4** |
| 10 | 0 (+cover) | **0** (+cover) |

**Under the old ladder house volume collapsed to zero the moment two real players arrived, so circular
fees could never be more than a rounding note. Under the current one the house withdraws one seat per
real player from a target of ten, so it is still fielding eight fighters at two real players.** That is
a much larger circular share for much longer — 75.6% of treasury intake at one real player, against
40.3% under the old ladder.

**What does not change is the conclusion.** The take rate on REAL gross is 2.99–3.57% under both
ladders, because house wallets contribute nothing per unit of real volume either way. What the new
ladder buys is fuller-looking lobbies; what it costs is a treasury figure that overstates net revenue
by up to 4×, and the risk in §6.

---

## 3. The small-wallet army: it has exactly zero expectancy

> "we use an army of small wallets to market make / farm the game… we should always have a slight edge
> with our strategy across all revenue streams"

**There is nothing to farm, and this is the most important correction in this document.**

The shipped damage rule is `basis = min(attacker.hp, defender.hp)`. Both directions of an exchange
read the same `min`, so the expected transfer between any two fighters is zero whatever their sizes.
**The fight is a martingale in `hp + banked` for every fighter** (`check-dice.ts` §3, and
HOUSE-EDGE-STUDY.md §11.5). A house wallet's expected P&L is therefore exactly minus the fee it paid —
and that fee returns to the treasury, so the consolidated contribution is zero.

```
cd engine
npx tsx ../sandbox/house-edge/strategy-house-book.ts 4000 200      # section B
```
$40 house budget split k ways against an 8-seat lobby:

| k | stake each | house-wallet P&L alone | 95% CI | net house revenue | vs k=1 |
|---|---|---|---|---|---|
| 1 | $40.00 | −$0.488 | [−1.775, 0.680] | $6.951 | — |
| 2 | $20.00 | −$0.298 | [−1.072, 0.460] | $6.871 | −$0.080 |
| 4 | $10.00 | −$0.184 | [−0.702, 0.327] | $4.737 | −$2.213 |
| 6 | $6.67 | −$0.378 | [−0.669, −0.093] | $2.892 | −$4.059 |

Every house-wallet P&L cell straddles zero or sits at minus the fee. **Splitting does not help, and it
actively hurts the consolidated number** by displacing paying seats.

For contrast, the same experiment against the v5 rule (`study-split.ts`, `HE_FEE_BPS=100`, $80 budget,
16 seats) still prints **+$150.87/round at k = 8**. That is what the strategy in the brief was
describing, and it was a defect that was deliberately removed:

| wallets | v5 (the defect) | SHIPPED, at 100 bps |
|---|---|---|
| 2 | +$36.73 | −$0.32 |
| 4 | +$94.89 | −$0.48 |
| 8 | **+$150.87** | **−$0.31** |
| 12 | +$134.78 | −$0.18 |

> **A small-stake edge and a sybil farm are the same object viewed from two sides.** HOUSE-EDGE-STUDY
> §10.5 records the decision: "every `P > 0` sells back the exploit being closed, in proportion to
> `P`". The house cannot be given a small-wallet edge without handing the identical edge to every
> player who opens sixteen wallets, and seats — `MAX_FIGHTERS = 16` — are the only thing rationing
> them. Reintroducing a tilt to benefit the house army is reintroducing the $152/round farm.

### 3.1 Sizing the house book is a pure risk dial with no return attached

```
cd engine
npx tsx ../sandbox/house-edge/strategy-house-book.ts 4000 200      # section D
```

Net house revenue is flat in house stake per seat while the standard deviation is not. There is no
level of house stake at which the book starts earning; there is only a level at which it starts
hurting. The only reason to turn it up is to make lobbies look full — which is a product decision,
and a legitimate one, but it should be budgeted as marketing spend and not as trading capital.

---

## 4. Which dial actually controls the edge — ranked

```
cd engine
npx tsx ../sandbox/house-edge/strategy-sensitivity.ts 4000
```
8 seats, 4,000 rounds/cell, baseline: fee 100 bps, P(extract) 0.30, 2 house seats @ $10, penalty
2,000 bps, horizon ×1. Reported as net house revenue per round and as a percentage of real gross.

| rank | dial | range swept | net revenue, end to end | changeable how? |
|---|---|---|---|---|
| **1** | `Arena.fee_bps` | 0 → 1000 bps | **$4.25 → $29.30** (1.70% → 11.60%) | **live, `set_fee_bps`, no deploy** |
| **2** | *(not a dial)* P(real player extracts) | 0.0 → 1.0 | **$2.57 → $17.52** (1.03% → 6.95%) | **not controllable — this is the market** |
| 3 | `EXTRACT_PENALTY_START_BPS` | 0 → 4000 | $2.68 → $11.05 (1.06% → 4.36%) | compile-time const, needs a deploy |
| 4 | `PENALTY_HORIZON_STEPS` | ×0.5 → ×2.0 | $5.17 → $8.27 (2.06% → 3.28%) | compile-time table, needs a deploy |
| 5 | house wallet **count** | 0 → 6 | $8.60 → **$2.75** (revenue *falls*) | free, keeper config |
| 6 | house wallet **stake** | $1 → $1000 | $7.03 → $6.52, CI [5.21, 7.76] — **noise** | free, keeper config |

Dials 3 and 4 are swept **exactly, not approximately**: the penalty rate does not affect the fight at
all (`extract` sets `hp = 0` and splits `taken`; no later draw can tell which split was applied), so
re-pricing recorded `(taken, cursor, n)` triples under a different constant is arithmetic, not
simulation. It required no edit to `er-sim.ts`. **Caveat, stated in the script:** behaviour is held
fixed, so any penalty setting *above* 2,000 bps is an **upper bound** on revenue — a higher penalty
would deter the extraction it taxes.

**The ranking says three things.**

* **`fee_bps` is the only real dial, and it is already the one being used.** It is live, O(1), immune
  to splitting, identical for everyone, and bounded at `MAX_FEE_BPS = 1_000`.
* **The second-largest term is not a dial at all.** Whether players bail early swings revenue from
  1.03% to 6.95% of real gross. Nothing in this repo measures it, and that single unmeasured number
  dominates every design choice below it.
* **House wallet count has a negative coefficient.** More house presence, less revenue. It is a
  liquidity decision, not a revenue one.

### 4.1 The penalty stream is one sentence of public knowledge away from zero

`extract_penalty_bps` decays linearly to zero across `PENALTY_HORIZON_STEPS` and is **zero from there
on** — by design (er-sim.ts:70–78: "the option decays because what you give up by leaving is the rest
of the fight"). So a player who waits for the horizon extracts for free.

Is waiting costly? **No — measured.**

```
cd engine
HE_FEE_BPS=100 npx tsx ../sandbox/house-edge/check-house-accrual.ts 20000 4
```
One designated fighter either holds to the bell or extracts the instant the penalty reaches zero;
everyone else holds; same lobbies, same seeds, paired, 20,000 rounds:

| band | ROI holding | ROI extracting at horizon | difference |
|---|---|---|---|
| whale ($80–100) | −1.18% | −1.16% | +0.02% ± 0.03 |
| big ($50–80) | −1.63% | −1.66% | −0.03% ± 0.03 |
| medium ($20–50) | +0.17% | +0.17% | +0.01% ± 0.03 |
| small ($8–20) | −0.12% | −0.11% | +0.01% ± 0.02 |
| minnow ($3–8) | −0.93% | −0.93% | +0.01% ± 0.01 |

Every difference is inside noise. **Extracting at the horizon is a free variance reduction with no
cost.** In the accrual table, the "everyone extracts at the horizon" regime yields the house exactly
**1.0000%** — the fee and nothing else — against 2.54% when players extract at random times.

**So the extract penalty is a tax on not knowing when it expires.** It is currently ~60% of modelled
revenue. It is not robust: it survives only while players do not optimise, and one popular guide
removes it. Any plan that depends on it should be stress-tested at P(extract) = 0, where the take rate
is **1.03% of real gross** — i.e. the entry fee, which is the only stream that is actually structural.

---

## 5. Retention: the rake and the stated business model are in direct conflict

```
cd engine
npx tsx ../sandbox/house-edge/strategy-retention.ts 600 200
```
600 independent players, $100 start, 8-seat lobbies, fee 100 bps, **player holds to the bell so pays
no extract penalty** — the house's worst case and the player's best.

| stake fraction | rounds | mean balance | median | 10th pct | P(down) | P(below $10) | house take/player |
|---|---|---|---|---|---|---|---|
| 25% | 10 | $98.35 | $93.13 | $62.46 | 57.8% | 0.0% | $1.65 |
| 25% | 50 | $91.65 | $70.22 | $30.75 | 69.3% | 0.3% | $8.35 |
| 25% | 200 | $63.62 | $21.86 | $3.30 | 82.3% | 30.0% | $36.38 |
| 50% | 200 | $35.69 | $0.41 | $0.02 | 91.2% | 79.7% | $64.31 |
| **100%** | **10** | $89.77 | $66.61 | $8.31 | 62.3% | 11.5% | $10.23 |
| **100%** | **50** | $58.47 | $2.14 | $0.01 | 79.2% | 62.8% | $41.53 |
| **100%** | **200** | **$10.83** | **$0.01** | $0.00 | **97.0%** | **95.2%** | **$89.17** |

The mean tracks the closed form `(1 − 0.01)^N` closely (10 rounds: measured $89.77 vs theory $90.44;
200 rounds: $10.83 vs $13.40, the gap being dust deaths and the minimum-entry floor).

**Read the median column, not the mean.** The distribution is so right-skewed that after 200 rounds of
full redeployment the *typical* player has **one cent** left while the *average* has $10.83. 97% are
down. **A rake charged on entry, against a player who re-enters every ~110 seconds, is not a 1% cost —
it halves a bankroll in about 69 rounds, a little over two hours.**

> **"People leave their tokens in there for a long time" and "the house takes 1% of every entry" are
> the same sentence read from two ends.** The rake is charged on ENTRY, not on time held, so retention
> earns the house money *only* to the extent that retained players keep re-entering — and every
> re-entry is another 1%. Whether they keep re-entering after watching that curve is the thing nobody
> has measured, and it is the largest commercial risk in the design. Staking a fraction `f` slows the
> decay to `(1 − 0.01f)^N`, which is the one lever that helps the player without touching the fee.

---

## 6. Risk and ruin

```
cd engine
npx tsx ../sandbox/house-edge/strategy-live-policy.ts 5000 300
```
At two real players under the **current** policy (mean 8.00 house fighters, **mean house stake at risk
$100.08 per round**), per round, **Regime B**:

| | current ladder | old ladder, for contrast |
|---|---|---|
| mean ledger net house revenue | $2.6547 | $2.8392 |
| standard deviation | $8.9191 (3.4× the mean) | $9.1779 |
| **P(a round is a ledger loss)** | **38.83%** | 21.08% |
| 5th / 50th / 95th percentile | −$11.093 / $2.081 / $18.802 | −$10.090 / $1.064 / $18.950 |
| worst round observed | −$27.774 | −$35.744 |
| mean house stake at risk | **$100.08** | $13.42 |

**The new ladder nearly doubles the frequency of losing rounds (21% → 39%) and puts 7.5× as much house
capital at risk per round, for no change in expected revenue.** That is the trade being made: lobbies
look fuller, and the house's book is larger and noisier without being more profitable.

**Ruin (Regime B, net of gas), 5,000-round horizon, 300 resampled paths:**

| bankroll | USD at $150/SOL | P(ruin) |
|---|---|---|
| 0.5 SOL | $75 | **8.00%** |
| 3.66 SOL | $549 | 0.00% |
| 20 SOL | $3,000 | 0.00% |

**Ruin (Regime A, today) is not probabilistic — it is a countdown.** With no token revenue, the gas
burn is deterministic: a bankroll of B SOL funds `B / 0.00981` rounds and then stops.

| bankroll | rounds | hours at the ~110s cadence |
|---|---|---|
| 0.5 SOL | 51 | 1.6 |
| 3.66 SOL | 373 | **11.4** |
| 20 SOL | 2,039 | 62.3 |

**How long before the rake reliably dominates the bot book?**

```
cd engine
npx tsx ../sandbox/house-edge/check-house-bankroll.ts 300 40
```
Per round the rake is a constant `r` and the bot book is ~zero-mean with standard deviation `s`. Over
`n` rounds drift is `n·r` and noise is `s·√n`, so the house is ahead with ~97.5% confidence once
`n > (2s/r)²`. 16-seat lobbies, house bots at $25:

| house bot seats | rake/round | bot stdev/round | rounds to 97.5% confidence | at ~1 round/2 min |
|---|---|---|---|---|
| 2 | $1.275 | $13.54 | 452 | 0.6 days |
| 4 | $1.206 | $17.47 | 840 | 1.2 days |
| 8 | $1.071 | $20.24 | 1,430 | 2.0 days |

With **zero** bot seats the rake has no variance at all and accumulation is arithmetic from round one.
Each seat added buys lobby liquidity and pays for it in days-to-confidence.

The house's per-round loss exposure is **bounded by its own stake** — the cover fighter can lose at
most the $5–$50 it staked (`houseStake` is a deterministic avalanche hash of `(roundNo, walletIndex)`,
`houseSizing.ts:174–183`). There is no leverage and no path to losing more than is staked. But note
what is *not* in the code: **no stop-loss, no exposure limit, no drawdown cap, nothing that reduces
house participation as a function of money.** Sizing reads crowd count only. The one money-based
control is a liveness floor on the gas payer (`MIN_BALANCE_SOL = 0.05`, `config.ts:299`), and a
drained house wallet fails `enter` silently (`houseBank.ts:537–540`).

---

## 7. What I could not measure, and why

| | |
|---|---|
| **Real player behaviour** | Nothing in the repo records it. P(extract), when they extract, how many rounds they retain, and what they stake are all invented. P(extract) alone swings the take rate from 1.03% to 6.95% of real gross. **This is the largest uncertainty in the document and it is not close.** |
| **The real-player stake distribution** | The five bands ($3–$100) are HOUSE-EDGE-STUDY.md's invention (§8 uncertainty 3), carried forward for comparability. |
| **The SOL price** | Assumed $150. Every dollar figure derived from gas scales with it; set `SOL_USD`. |
| **The 3.66 SOL bankroll** | Not in the repo. Carried as given. |
| **Whether custody will behave like the counters** | Regime B assumes an unwritten code path is exact. It is the largest structural assumption here. |
| **Live volume** | I did not query the chain. The break-even of $43–$50 real gross per round is not compared against any observed figure. |
| **Multi-round correlation** | Rounds are treated as independent. Real players persist between rounds, so a bad run is more correlated than modelled and the ruin figures are optimistic. |
| **A moving target** | `er-demo/scripts/keeper/` and parts of `er-demo/src/v2/` were modified by another writer DURING this session (tree was clean at `8ccf1ea`). I did not make those edits and did not revert them. The house-policy numbers were re-run against the constants as they stood at the end of the session; anything committed after that invalidates §1, §2 and §6 and should be re-measured with `strategy-live-policy.ts`. §11 of HOUSE-EDGE-STUDY.md is unaffected — it measures the fight, which did not change. |

---

## 8. NEW FINDING — flagged, not fixed

**A round that never happened still sweeps its entry fee to the house.**

`apply_sweep` accepts `Phase::Abandoned` (lib.rs:1015–1018). `abandon_round` requires
`lobby_is_dead`, which is `!lobby_is_open && !enough_to_fight`, and `enough_to_fight(n) = n >= 2`
(lib.rs:435–437). So a lobby that closed with **exactly one entrant** is abandonable, and that lone
entrant's `fees_collected` is swept into `Treasury.fees_accrued` — for a fight that never ran.

The program's own comment on `abandon_round` (lib.rs:1659–1663) says the opposite is intended:

> NOTHING IS REFUNDED, BECAUSE NOTHING WAS TAKEN. This program custodies no balances at all… an
> abandoned round owes nobody anything on-chain. Any single fighter who entered is recorded in
> `fighters` exactly as they were, **for the off-chain ledger to settle to zero against**.

Both cannot be true under custody. If the off-chain ledger settles the lone entrant to zero — i.e.
refunds them gross — then `Treasury.fees_accrued` has recorded revenue that was never earned and the
treasury counter and the ledger disagree by that fee. If it refunds them net, the player paid 1% for a
round that did not happen, with no on-chain refund path.

**Severity: low today, latent.** The magnitude is one entrant's fee on a lobby that failed to fill —
1% of a single stake — and today it is harmless because no tokens move at all. It becomes real at
exactly the moment custody ships, which is the same moment every other number in these two documents
becomes real. **It is flagged and deliberately not fixed**, per the standing instruction that
economic defects get reported with a reproduction before anyone touches code.

Reproduction is by inspection rather than simulation, because the sandbox rig models the fight and
this is a phase-transition bug: open a round, have exactly one wallet `enter` with a non-zero stake,
let `lobby_closes_at` pass, call `abandon_round`, then `sweep_house_take`, and read
`Treasury.fees_accrued` — it will have increased by `floor(stake × fee_bps / 10_000)`.

### Previously-known holes, re-confirmed and NOT new

Recorded here only so a reader does not mistake them for findings: a `Phase::Drawing` orphan
permanently forfeits `fees_collected` and can never be swept (documented at lib.rs:1644–1657);
`fee_bps` is read live at `enter` and is not stamped per round, so a mid-lobby re-price charges two
rates inside one round (lib.rs:1123–1139); `stake > 0` is the only entry floor (lib.rs:1258). All
three are already documented in the program.

**And one non-defect worth stating so it is not re-litigated:** the fee floors, so the house rounds
down. Measured over 20,000 rounds that gives away 3.46 micro-units per round — $0.069 total. It is
bounded by one unit per entry and therefore by `MAX_FIGHTERS = 16`, so it is $0.000016/round at worst
and cannot be farmed at any stake.

---

## 9. Recommendation

1. **Do not reintroduce a small-stake tilt to benefit the house army.** It is the $152/round sybil
   farm wearing a different hat (§3). The army has no edge and needs none — it is a liquidity cost.
2. **Budget house fighters as marketing, not as trading, and re-examine the new ladder.** Zero
   expectancy, real variance, and a negative coefficient on revenue (§2, §3.1). The ladder was made
   much more aggressive mid-session (`HOUSE_BOARD_TARGET` 4 → 10, `HOUSE_DISPLACEMENT` 2 → 1): that
   buys fuller-looking lobbies and costs a 21% → 39% rise in losing rounds, 7.5× the capital at risk
   per round, and a treasury figure that overstates net revenue by up to 4×. **None of it changes
   expected revenue.** If the goal was revenue, this is the wrong dial; if the goal was liquidity
   optics, it should be budgeted and reported as such (§2.1, §6).
3. **Treat `fee_bps` as the only edge.** It is the only structural, live, sybil-immune,
   size-neutral stream (§4). At 100 bps it is exactly 1.0000% of gross with zero variance.
4. **Stress every revenue plan at P(extract) = 0.** The penalty stream is ~60% of modelled revenue and
   is one popular guide away from zero (§4.1). Planning on 3% when the robust number is 1% is the
   single easiest way to be wrong here.
5. **The binding constraint is not the rate — it is that there is no custody path.** Today the house's
   realised P&L is minus the gas, at every fee setting (§1). Until tokens move, "the house edge" is a
   correctly-computed number about money that has not changed hands, and no value of `fee_bps`
   changes that.
6. **Watch the retention/rake conflict before scaling volume.** 97% of full-redeployment players are
   down after 200 rounds and the median holds one cent (§5). That is what the 1% looks like from the
   other side of the table, and it is a churn forecast.

---

## 10. Reproducing this

```
cd engine
npx tsx ../sandbox/house-edge/parity.ts                            # validates the rig FIRST
HE_FEE_BPS=100 npx tsx ../sandbox/house-edge/parity.ts             # and at the live rate
npx tsx ../sandbox/house-edge/strategy-live-policy.ts 5000 300     # §1, §2, §6
npx tsx ../sandbox/house-edge/strategy-house-book.ts 4000 200      # §2.1, §3, §3.1
npx tsx ../sandbox/house-edge/strategy-sensitivity.ts 4000         # §4
npx tsx ../sandbox/house-edge/strategy-retention.ts 600 200        # §5
HE_FEE_BPS=100 npx tsx ../sandbox/house-edge/check-house-accrual.ts 20000 4   # §4.1
HE_FEE_BPS=100 npx tsx ../sandbox/house-edge/study-split.ts 2500   # §3, the v5 contrast
```

Every script is seeded and reproduces exactly. `strategy-house-book.ts` and `strategy-live-policy.ts`
assert the accounting identity `net_house == −(real players' net)` **in integers** on every round and
print a loud failure line if it ever breaks; if you see that line, discard the row it belongs to.
