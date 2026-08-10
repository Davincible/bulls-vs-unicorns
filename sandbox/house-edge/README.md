# sandbox/house-edge

**Nothing in this directory is shipped, deployed, or imported by `engine/`, `er-demo/`, or
`programs/`.** It is a measurement rig for HOUSE-EDGE-STUDY.md at the repo root. It reads
`engine/src/er-sim.ts`; it never writes it.

The `strategy-*.ts` scripts model the OPERATOR'S position and are documented in
`HOUSE-STRATEGY.md`; the `study-*.ts` and `check-*.ts` scripts measure the GAME and are
documented in `HOUSE-EDGE-STUDY.md`.

The rig's `FEE_BPS` used to be hardcoded to `20n`. It is now
`BigInt(process.env.HE_FEE_BPS ?? 20)` in `fight-variant.ts`. **The default is still 20**, so
every command below reproduces the number it always printed and HOUSE-EDGE-STUDY.md §1-§10 stay
reproducible. Set `HE_FEE_BPS=100` to measure the rate the arena actually charges today.
`check-seat-law.ts` also had a hardcoded `* 0.998` net-of-fee factor; that is now derived from
`FEE_BPS`.

Run everything from `engine/` (that is where `tsx` lives):

```
cd engine
npx tsx ../sandbox/house-edge/parity.ts                  # RUN THIS FIRST — validates the rig
npx tsx ../sandbox/house-edge/demo-equalizer.ts          # what the deployed fight actually pays
npx tsx ../sandbox/house-edge/check-seat-law.ts          # payout = opposing stake / my side's seats
npx tsx ../sandbox/house-edge/check-positional-bias.ts   # entry order WAS worth +-15%; now flat
npx tsx ../sandbox/house-edge/check-fight-length.ts 200  # what the fix did to fight length
npx tsx ../sandbox/house-edge/study-weights.ts  4000 4   # exp 1: what moves ROI by band
npx tsx ../sandbox/house-edge/study-dial.ts     2000 4   # exp 2: the O(n) selection-weight dial
npx tsx ../sandbox/house-edge/study-damage.ts   4000 4   # exp 5: the O(1) damage-basis dial
NODE_OPTIONS=--max-old-space-size=12288 npx tsx ../sandbox/house-edge/study-house.ts 2500  # exp 3
NODE_OPTIONS=--max-old-space-size=12288 npx tsx ../sandbox/house-edge/study-split.ts 2500  # exp 4
HE_FEE_BPS=100 npx tsx ../sandbox/house-edge/check-house-accrual.ts 20000 4   # the headline: 1.0000%
npx tsx ../sandbox/house-edge/check-dice.ts 2000000                          # what the dice actually do
npx tsx ../sandbox/house-edge/check-fee-rate.ts 15000 4                      # 20 vs 100 bps, paired
npx tsx ../sandbox/house-edge/strategy-live-policy.ts 5000 300               # the DEPLOYED house policy
npx tsx ../sandbox/house-edge/strategy-house-book.ts 4000 200                # circular fees netted out
npx tsx ../sandbox/house-edge/strategy-sensitivity.ts 6000                   # which dial controls the edge
npx tsx ../sandbox/house-edge/strategy-retention.ts 600 200                  # player lifetime
npx tsx ../sandbox/house-edge/check-house-bankroll.ts 2000 300               # house bot variance
```

Every run is seeded (`STUDY_SEED = "house-edge-v1"`, fight seed `sha256("he|<study>|<round>")`) and
reproduces exactly. The heap flag is needed only for the two 16-fighter studies, which retain a lazy
hash table per lobby so that every configuration is scored against identical draws.

## Files

| file | what it is |
|---|---|
| `fight-variant.ts` | the knobbed fight loop. Integer arithmetic only on the hash-to-damage path. `BASELINE` is the SHIPPED rule; `DEPLOYED_V5` is the rule the study measured before the fix, kept so the "before" columns stay reproducible rather than quoted. |
| `parity.ts` | asserts config `BASELINE` is byte-identical to `engine/src/er-sim.ts`, and that `DEPLOYED_V5` still reproduces the pre-fix on-chain fixture. If this fails, ignore every number the rig produces. |
| `check-fight-length.ts` | fight length before vs after, because `PENALTY_HORIZON_STEPS` is fitted to it. |
| `lobby.ts` | lobby generation, bootstrap standard errors, USD/micro-unit conversion. |
| `rng.ts` | mulberry32 — seeds lobbies only, never the fight. |
| `demo-equalizer.ts`, `check-seat-law.ts`, `check-positional-bias.ts` | run against `er-sim.ts` **directly**, not against the variant, so they cannot be accused of measuring the sandbox instead of the game. |
| `check-house-accrual.ts` | does the house take 1% of gross? Runs against `er-sim.ts` directly. Four extraction regimes; asserts conservation every round. |
| `check-dice.ts` | the three things called "the dice": who is drawn, how hard, and percent of what. Documents the `h[8] % 24` modulo bias. |
| `check-fee-rate.ts` | 0/20/100/200 bps on identical paired draws; ROI by band plus variance and risk stats. |
| `check-house-bankroll.ts` | house rake vs house bot-book variance; rounds-to-dominance. |
| `strategy-live-policy.ts` | reimplements `er-demo/scripts/keeper/houseSizing.ts` exactly; the house as actually deployed. Reports Regime A (today, non-custodial) and Regime B (if custody ships) separately. |
| `strategy-house-book.ts` | the house's consolidated position with circular fees netted out; the identity `net_house == -(real players' net)` asserted in integers every round. |
| `strategy-sensitivity.ts` | ranks the five dials (fee bps, penalty start, penalty horizon, house count, house stake). |
| `strategy-retention.ts` | a retained player's balance over N rounds at various stake fractions. |
| `study-*.ts` | the five experiments. |
| `small-stake-farm.ts` | for a mechanic that favours small stakes, the INTENDED EFFECT (what a genuinely small player gains) measured against the FARM RATE (what an adversary splitting a budget extracts), on the same lobbies and the same hash tables. Seven parts, selectable so they can run in parallel: `0` harness self-checks, `1` the blend dial P, `2` the bounded blend `capMult`, `3` the identity gate, `4` fee schedules banded by stake, `5` a per-entry ring cap, `6` whether the operator can farm any of it. Asserts integer conservation on every fight and exits non-zero if it ever fails. |

```
cd engine
HE_FEE_BPS=100 NODE_OPTIONS=--max-old-space-size=12288 \
  npx tsx ../sandbox/house-edge/small-stake-farm.ts 800 all    # or 0|1|2|3|4|5|6 for one part
```
