// SANDBOX — NOT SHIPPED, NOT ON CHAIN, NOT IMPORTED BY THE ENGINE OR THE DEMO.
//
// ================================================================================================
// THE GAP THIS FILLS
// ================================================================================================
// `fight-volatility.ts` ranked eighteen candidates on how much the scoreboard swings and scored each
// against four bars: conservation, band fairness, the sybil farm, and per-round sigma. It did not
// score any of them against the bar that actually binds the shipped game:
//
//     `MAX_FIGHTERS` in lib.rs publishes a measured table — at n = 48 the median fight is 124s and
//     76.2% of fights conclude before the 180s bell — and 48 seats was CHOSEN because 76.2% clears
//     the 74.2% the deployed sixteen-fighter round already met. A volatility change that pushes
//     fights past the bell trades a measured product property for an unmeasured one.
//
// HOUSE-SMALL-STAKE.md §5.5 reports `deaths` per candidate and reads it as termination. It is not
// the same statistic. `deaths` counts fighters who reached zero; the bell bar counts FIGHTS in which
// one whole side reached zero. `retain`@stake scores 71% deaths — better than the shipped 65% — and
// still runs the median fight into the bell, because repaired rings mean the LAST survivor on a side
// takes far longer to fall. That is the discrepancy this script exists to expose.
//
// ================================================================================================
// METHODOLOGY — deliberately the same as the published table, so the "before" row can be checked
// ================================================================================================
// `programs/bulls-arena/tests/fight_length.rs` produced the table in `MAX_FIGHTERS`. This reproduces
// its lineup and its seeds exactly:
//   * equal stakes of $10 (10,000,000 units), NO fee deducted — the Rust test stakes gross;
//   * sides alternating 0,1,0,1 — the `alternating: true` row;
//   * seed = sha256("penalty-horizon" || u64_le(s)) for s in 0..seeds, which is `seed_of` in the
//     Rust byte for byte (`hashv` is sha256 over the concatenated slices);
//   * 400 seeds per lineup.
// The SHIPPED row therefore has a published number to land on. If it does not print ~124s / ~76.2%
// at n = 48, this script is wrong and nothing below it is worth reading.
//
// ================================================================================================
// THE DELIVERABLE STATISTIC
// ================================================================================================
// The complaint is about the AGGREGATE, so the headline is the dispersion of the FINAL side-vs-side
// split `s = (sum of hp + banked over side 0) / pot`, across seeds — reported as both a standard
// deviation and an interquartile range, in points of the pot. Every lineup here starts at exactly
// s = 50.0, so the spread of s at the end is the whole distribution of "how lopsided did it get",
// with no lobby noise mixed in. `swing` (the path statistic that leads fight-volatility.ts) is a
// different question — how much it moved DURING — and that file already answers it.
//
//   cd engine && npx tsx ../sandbox/house-edge/check-variance-bell.ts [seeds] [n,n,...]

import {
  runFight, BASELINE, DEPLOYED_V6, DUST_ABSOLUTE, stepBudget, rollMean, rollSd, MAX_FIGHTERS,
  FIGHT_TIMEOUT_SECONDS, STEPS_PER_FIGHTER_PER_SECOND,
} from "./fight-variant.ts";
import type { FightConfig, RollSpec, Fighter } from "./fight-variant.ts";
import { createHash } from "node:crypto";

const SEEDS = Number(process.argv[2] ?? 400);
const SIZES = (process.argv[3] ?? "48").split(",").map(Number);
const STAKE = 10_000_000n;   // $10, gross — what fight_length.rs stakes

/** `seed_of` from tests/fight_length.rs, in TypeScript. */
function seedOf(s: number): Buffer {
  const pre = Buffer.alloc(8);
  pre.writeBigUInt64LE(BigInt(s));
  return createHash("sha256").update(Buffer.concat([Buffer.from("penalty-horizon"), pre])).digest();
}

/** `lineup(n, seed, alternating = true, stake)` from tests/fight_length.rs. */
function lineup(n: number): Fighter[] {
  const f: Fighter[] = [];
  for (let i = 0; i < n; i++)
    f.push({ wallet: `w${i}`, side: (i % 2) as 0 | 1, dead: 0, stake: STAKE, hp: STAKE, banked: 0n });
  return f;
}

// ------------------------------------------------------------------------------------------------
// THE CANDIDATES
// ------------------------------------------------------------------------------------------------

const base = (extra: Partial<FightConfig>): FightConfig => ({ ...BASELINE, ...extra });
const LEGACY_MEAN = rollMean("legacy");

/** The mean-matched spike search from fight-volatility.ts, reproduced so this file stands alone.
 *  `hi` must be an integer and the closed form is not, so it is searched; ties break toward the
 *  wider base range, which is the direction that buys variance. */
function matchedSpike(pDen: number, spike: number): RollSpec {
  let best: RollSpec = { kind: "spike", pDen, spike, lo: 0, hi: 1 };
  let bestErr = Infinity;
  for (let lo = 0; lo <= 2; lo++)
    for (let hi = lo; hi <= 99; hi++) {
      const s: RollSpec = { kind: "spike", pDen, spike, lo, hi };
      const err = Math.abs(rollMean(s) - LEGACY_MEAN);
      if (err < bestErr - 1e-12 || (Math.abs(err - bestErr) < 1e-12 && hi - lo > (best as any).hi - (best as any).lo)) {
        best = s; bestErr = err;
      }
    }
  return best;
}

interface Cand { name: string; cfg: FightConfig; stepDiv: number; }

/** A heavy-tail die written the way the shipped one is: a body that never rolls zero, plus a rare
 *  spike. `lo = 1` is deliberate and is the one place this departs from the search grid in Part 4,
 *  which swept `lo = 0` — a zero roll makes `dmg == 0` and the exchange is skipped entirely, so a
 *  body starting at 0 silently deletes `1/(hi+1)` of the on-screen action for no statistical gain.
 *  The shipped die starts at 4 for the same reason. Shifting the body up by one leaves the variance
 *  untouched and moves the mean by exactly 1. */
const die = (pDen: number, spike: number, lo: number, hi: number): RollSpec =>
  ({ kind: "spike", pDen, spike, lo, hi });

const CANDS: Cand[] = [
  // `BASELINE` tracks the SHIPPED rule and now carries the new die, so the "before" row has to come
  // from `DEPLOYED_V6` — the frozen copy of the flat 4..27 rule that every house study was measured
  // against. Both rows are run on the SAME seeds and the same lineups, so the comparison is paired.
  { name: "V6: flat 4..27 (was shipped)", cfg: DEPLOYED_V6, stepDiv: 1 },
  { name: "SHIPPED (baseline)", cfg: BASELINE, stepDiv: 1 },

  // THE SHORTLIST — the feasible frontier found by Part 4, re-run here at full resolution and with
  // the body shifted off zero. Part 4's grid is what produced these (pDen, spike, width) triples;
  // this table is what decides between them.
  { name: "F: 1/8 @50 body 1..19", cfg: base({ roll: die(8, 50, 1, 19) }), stepDiv: 1 },
  { name: "F: 1/8 @55 body 1..17", cfg: base({ roll: die(8, 55, 1, 17) }), stepDiv: 1 },
  { name: "F: 1/16 @60 body 1..23", cfg: base({ roll: die(16, 60, 1, 23) }), stepDiv: 1 },
  { name: "F: 1/16 @70 body 1..19", cfg: base({ roll: die(16, 70, 1, 19) }), stepDiv: 1 },
  { name: "F: 1/32 @80 body 1..24", cfg: base({ roll: die(32, 80, 1, 24) }), stepDiv: 1 },
  { name: "F: 1/32 @90 body 1..22", cfg: base({ roll: die(32, 90, 1, 22) }), stepDiv: 1 },
  { name: "F: 1/32 @95 body 1..21", cfg: base({ roll: die(32, 95, 1, 21) }), stepDiv: 1 },
  { name: "F: 1/64 @95 body 1..25", cfg: base({ roll: die(64, 95, 1, 25) }), stepDiv: 1 },

  // THE TWO DISQUALIFIED REFERENCES, kept in the same table as the shortlist so the whole argument
  // is legible in one place rather than across four runs:
  //   * `spike 1/16 @100 matched` — the arithmetic-mean-matched crit, HOUSE-SMALL-STAKE.md §7.2's
  //     fallback (3b). It is the best row in this table on the deliverable AND it improves the bell,
  //     and Part 2 disqualifies it anyway: 0.23x of the penalty horizon at a duel.
  //   * `retain@stake + spike 1/32` — HOUSE-SMALL-STAKE.md §7.2's headline recommendation (3), which
  //     concludes 8.3% of n=48 fights before the bell against the shipped 76.3%.
  { name: "REJ spike 1/16 @100 matched", cfg: base({ roll: matchedSpike(16, 100) }), stepDiv: 1 },
  { name: "REJ retain@stake + spike 1/32", cfg: base({ retainBps: 10000n, retainCap: "stake", roll: matchedSpike(32, 100) }), stepDiv: 1 },
];

/** `HE_ONLY` keeps only the candidates whose name contains one of the comma-separated fragments, so
 *  the two-row before/after sweep that produces the published `MAX_FIGHTERS` table can be run across
 *  seven lineup sizes without paying for the whole shortlist at each one. */
const ONLY = process.env.HE_ONLY;
const ROWS = ONLY ? CANDS.filter(c => ONLY.split(",").some(t => c.name.includes(t.trim()))) : CANDS;

// ------------------------------------------------------------------------------------------------
// STATISTICS. Floats live here and only here.
// ------------------------------------------------------------------------------------------------

const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);
const quantile = (s: number[], q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
const mean = (xs: number[]) => xs.reduce((a, x) => a + x, 0) / xs.length;
const sd = (xs: number[]) => { const m = mean(xs); return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(1, xs.length - 1)); };

interface Row {
  medianSec: number; p90Sec: number; beforeBell: number;
  sdFinal: number; iqrFinal: number; p95Exc: number;
  exchanges: number; deaths: number; conserved: boolean;
}

function measure(c: Cand, n: number, hashes: (Buffer | undefined)[][]): Row {
  const budget = Math.max(1, Math.floor(stepBudget(n) / c.stepDiv));
  const secsPerStep = c.stepDiv / (STEPS_PER_FIGHTER_PER_SECOND * n);
  const ends: number[] = [], finals: number[] = [], excs: number[] = [];
  let concluded = 0, deaths = 0, conserved = true, exchanges = 0;

  for (let t = 0; t < SEEDS; t++) {
    const f = lineup(n);
    const pot = BigInt(n) * STAKE;
    const st = runFight(f, seedOf(t), budget, c.cfg, hashes[t], true);
    // CONSERVATION, in integers, on every fight of every candidate — the on-chain `apply_sweep`
    // gate. Nothing here extracts, so `penalties_collected` is zero and the identity is the sum.
    let after = 0n, v0 = 0n;
    for (const g of f) { after += g.hp + g.banked; if (g.side === 0) v0 += g.hp + g.banked; if (g.dead === 1) deaths++; }
    if (after !== pot) conserved = false;
    if (st.endedAt < budget) concluded++;
    exchanges += st.exchanges;
    ends.push(st.endedAt * secsPerStep);
    finals.push(100 * Number(v0) / Number(pot));
    excs.push(Math.abs(100 * Number(v0) / Number(pot) - 50));
  }

  const se = sorted(ends), sf = sorted(finals), sx = sorted(excs);
  return {
    medianSec: quantile(se, 0.5), p90Sec: quantile(se, 0.9),
    beforeBell: 100 * concluded / SEEDS,
    sdFinal: sd(finals), iqrFinal: quantile(sf, 0.75) - quantile(sf, 0.25),
    p95Exc: quantile(sx, 0.95),
    exchanges: exchanges / SEEDS, deaths: 100 * deaths / (SEEDS * n), conserved,
  };
}

// ------------------------------------------------------------------------------------------------

console.log(`
================================================================================================
 THE BELL BAR — does a variance change still let the fight finish?
================================================================================================
 reproduce : cd engine && npx tsx ../sandbox/house-edge/check-variance-bell.ts ${SEEDS} ${SIZES.join(",")}
 lineup    : equal $10 gross, sides alternating, seed = sha256("penalty-horizon" || u64le(s))
             — tests/fight_length.rs byte for byte, so the SHIPPED row has a published target
 target    : n=48 -> median 124s, 76.2% before the bell   (lib.rs, MAX_FIGHTERS)
 bell      : ${FIGHT_TIMEOUT_SECONDS}s = ${STEPS_PER_FIGHTER_PER_SECOND}n steps/s   dust ${DUST_ABSOLUTE}   cap ${MAX_FIGHTERS}
 seeds     : ${SEEDS} per cell
================================================================================================`);

console.log(`\nTHE DICE, in closed form. A die is "matched" when its mean equals the deployed ${LEGACY_MEAN.toFixed(4)}.\n`);
console.log("  die                        mean      sd    x base sd   support");
console.log("  " + "-".repeat(72));
for (const c of ROWS) {
  const r = c.cfg.roll ?? "legacy";
  if (r === "legacy" && c.name !== "SHIPPED (baseline)") continue;
  const supp = r === "legacy" ? "4..27 (h[8] % 24 + 4)"
    : r.kind === "uniform" ? `${r.lo}..${r.hi}`
    : `${r.lo}..${r.hi}, and ${r.spike} one time in ${r.pDen}`;
  console.log(`  ${c.name.padEnd(26)} ${rollMean(r).toFixed(3).padStart(6)}  ${rollSd(r).toFixed(2).padStart(6)}   ${(rollSd(r) / rollSd("legacy")).toFixed(2).padStart(6)}x   ${supp}`);
}

for (const n of SIZES) {
  // The hash chain depends only on (seed, step), never on the config, so it is built once per seed
  // and handed to every candidate: paired comparison, and the sha256 is paid for once.
  const hashes: (Buffer | undefined)[][] = Array.from({ length: SEEDS }, () => new Array(stepBudget(n)));

  console.log(`\n\n=== n = ${n}, equal $10, alternating sides, ${SEEDS} seeds ===\n`);
  const head =
    "candidate                        median   p90    before  |  sd(final)  IQR(final)  p95 |s-50|  |  exch  deaths  cons";
  console.log(head);
  console.log("-".repeat(head.length));
  let baseSd = 0;
  for (const c of ROWS) {
    const r = measure(c, n, hashes);
    if (baseSd === 0) baseSd = r.sdFinal;   // the first row is the reference, whichever it is
    console.log(
      `${c.name.padEnd(30)} ${r.medianSec.toFixed(0).padStart(5)}s ${r.p90Sec.toFixed(0).padStart(5)}s ` +
      `${r.beforeBell.toFixed(1).padStart(7)}%  | ` +
      `${r.sdFinal.toFixed(2).padStart(8)} ${("(" + (r.sdFinal / baseSd).toFixed(2) + "x)").padStart(8)} ` +
      `${r.iqrFinal.toFixed(2).padStart(8)} ${r.p95Exc.toFixed(2).padStart(10)}  | ` +
      `${r.exchanges.toFixed(0).padStart(5)} ${r.deaths.toFixed(0).padStart(6)}%  ${r.conserved ? "ok" : "FAIL"}`,
    );
  }
}

console.log(`
Read the "before" column against 76.2% and the "median" column against 124s at n = 48. sd(final) and
IQR(final) are the deliverable: the spread of the final side-vs-side split, in points of the pot,
across ${SEEDS} seeds that all start at exactly 50.0.
`);

// ================================================================================================
// PART 2 — THE OTHER CEILING, AND IT BINDS FROM BELOW
// ================================================================================================
// `PENALTY_HORIZON_STEPS` is the cursor at which extracting becomes free. `lib.rs` fits it to
// `round(25 * n^1.5)` and `tests/fight_length.rs` asserts the PROPERTY it was fitted for:
//
//     horizon < median fight, for every lineup 2..48 and every stake in {$5, $10, $20}
//
// — i.e. the penalty must reach zero INSIDE a real round, or a player who wants out is charged for
// the whole of it. Every candidate above buys its variance by making the fight SHORTER, so every
// candidate spends this margin, and the margin is thinnest at the SMALL lineups: a duel already runs
// at only ~1.4x its horizon under the shipped die.
//
// THE ALTERNATIVE IS TO REFIT THE HORIZON, AND IT IS REJECTED. The table is mirrored in
// `engine/src/er-sim.ts` and pinned by a parity test, so refitting is three edits rather than one —
// but that is the small objection. The real one is that the horizon IS the extraction penalty
// schedule, and the penalty is one of the house's two revenue lines (`fee_bps` is the other). Moving
// it moves the house take, and the brief for this change is that the house edge must not move. So
// the horizon is treated as fixed and the die has to fit under it.
//
// The statistic is `median / horizon`, and the candidate is disqualified if it goes under 1.00
// anywhere. The shipped rule's own worst cell is printed as the reference.

const HORIZON_SWEEP = process.env.HE_HORIZON_ONLY ? process.env.HE_HORIZON_ONLY.split(",")
  : process.env.HE_SKIP_HORIZON ? [] : ROWS.map(c => c.name);
const HORIZON_SEEDS = Math.min(SEEDS, 120);
const STAKE_BAND = [5_000_000n, 10_000_000n, 20_000_000n];
/** `tests/fight_length.rs`: every small lineup, a sample of the large ones. */
const HORIZON_N = [...Array.from({ length: 15 }, (_, i) => i + 2), 20, 24, 28, 32, 36, 40, 44, 48];

/** Mirrors `PENALTY_HORIZON_STEPS` — `round(25 * n^1.5)`, the published closed form. Re-derived
 *  rather than imported so this file does not depend on the mirror it is trying to protect. */
const horizonOf = (n: number) => Math.round(25 * Math.pow(n, 1.5));

if (HORIZON_SWEEP.length > 0) {
  console.log(`
================================================================================================
 PART 2 — DOES THE PENALTY STILL REACH ZERO INSIDE THE FIGHT?
================================================================================================
 the assertion : horizon < median fight, over n in {2..16, 20..48 by 4} x stake in {$5, $10, $20}
                 — tests/fight_length.rs::the_penalty_table_still_errs_short_of_the_measured_fight
 the statistic : min over all cells of (median fight / horizon). Under 1.00 is a red cargo test.
 seeds         : ${HORIZON_SEEDS} per cell
================================================================================================
`);
  console.log("candidate                        worst cell            margin   |  n=2 $5   n=8 $5   n=48 $5   n=48 $20");
  console.log("-".repeat(108));

  for (const name of HORIZON_SWEEP) {
    const c = CANDS.find(x => x.name === name)!;
    let worst = Infinity, worstAt = "";
    const probe: Record<string, number> = {};
    for (const n of HORIZON_N) {
      const hz = horizonOf(n);
      const hashes: (Buffer | undefined)[][] = Array.from({ length: HORIZON_SEEDS }, () => new Array(stepBudget(n)));
      for (const stake of STAKE_BAND) {
        const lens: number[] = [];
        for (let t = 0; t < HORIZON_SEEDS; t++) {
          const f: Fighter[] = [];
          for (let i = 0; i < n; i++)
            f.push({ wallet: `w${i}`, side: (i % 2) as 0 | 1, dead: 0, stake, hp: stake, banked: 0n });
          lens.push(runFight(f, seedOf(t), stepBudget(n), c.cfg, hashes[t], true).endedAt);
        }
        const med = quantile(sorted(lens), 0.5);
        const ratio = med / hz;
        const cell = `n=${n} $${Number(stake) / 1e6}`;
        probe[cell] = ratio;
        if (ratio < worst) { worst = ratio; worstAt = cell; }
      }
    }
    console.log(
      `${c.name.padEnd(30)} ${worstAt.padEnd(12)} ${(worst >= 1 ? "" : "VIOLATED ")}${worst.toFixed(2).padStart(9)}x   | ` +
      `${probe["n=2 $5"].toFixed(2).padStart(6)}x ${probe["n=8 $5"].toFixed(2).padStart(8)}x ` +
      `${probe["n=48 $5"].toFixed(2).padStart(9)}x ${probe["n=48 $20"].toFixed(2).padStart(10)}x`,
    );
  }
  console.log(`
A candidate under 1.00x anywhere is not shippable without refitting PENALTY_HORIZON_STEPS, and
refitting it moves the extraction-penalty revenue — i.e. it moves the house edge, which this change
is not allowed to do.
`);
}

// ================================================================================================
// PART 3 — THE RIGHT INVARIANT TO MATCH IS THE LOG, NOT THE MEAN
// ================================================================================================
// Part 2 disqualified every mean-matched spike-at-100 die, and the failure is structural rather than
// a matter of tuning the density down:
//
//   `roll = 100` gives `dmg = min(ring_a, ring_d)`, which is the DEFENDER'S WHOLE RING whenever the
//   defender is the smaller. That is not a big hit, it is a guaranteed kill — and a kill costs a
//   lineup one fighter regardless of how many it started with. So a crit die needs ~`n * pDen` steps
//   to empty a side while `PENALTY_HORIZON_STEPS` grows as `n^1.5`. The two curves cross, and below
//   the crossing the horizon is longer than the fight. Measured: a duel ends at 0.14x of its horizon
//   under a 1-in-8 crit, against 1.42x shipped. Lowering the density moves the crossing (1-in-32
//   reaches 0.59x) but never removes it, because the exponents differ.
//
// WHICH MEANS "MATCH THE MEAN" WAS THE WRONG CONSERVED QUANTITY ALL ALONG. hp decays MULTIPLICATIVELY
// — `hp_d *= (1 - roll/100)` whenever the defender is the smaller ring — so the number of blows a
// fighter survives is `log(stake / DUST) / E[-log(1 - roll/100)]`, which `MAX_FIGHTERS` and
// `PENALTY_HORIZON_STEPS` both already say in prose ("geometric decay", "log(stake / DUST)"). Fight
// length is set by the mean of the LOG of the survival factor, and the arithmetic mean of the roll
// does not appear in it. A die matched on the arithmetic mean is matched on the wrong statistic, and
// `roll = 100` is the extreme case: `log(1 - 1) = -infinity`, one blow, any lineup.
//
// AND THE ARITHMETIC MEAN TURNS OUT NOT TO NEED MATCHING AT ALL, which is what makes this a real
// degree of freedom rather than a trade. The house takes `fee_bps` at entry plus
// `extract_penalty_bps(cursor)` on whatever a leaver is holding. The fight is an exact martingale in
// each fighter's `hp + banked` — the ordered pair is uniform (`draw_pair`) and the basis
// `min(ring_a, ring_d)` is symmetric in the pair — so `E[hp + banked] = stake` at every cursor, for
// every fighter, under ANY die. The expected penalty is therefore `penalty_bps(cursor) * stake` with
// no die term in it, and the house edge is invariant to this whole family by construction.
// `check-house-accrual.ts` is run before and after to confirm that in integers rather than in prose.
//
// SO: MAXIMISE Var(roll) SUBJECT TO E[log(1 - roll/100)] BEING THE DEPLOYED VALUE. Because `log` is
// concave, holding E[log] fixed while widening the die forces the arithmetic mean DOWN — the die
// gets a heavy tail and a quiet body. That is the whole shape of what follows.

/** `E[log(1 - roll/100)]` — the per-blow log survival factor, which is what sets fight length. */
function decayOf(spec: RollSpec): number {
  const lg = (r: number) => Math.log(Math.max(1e-12, 1 - r / 100));
  if (spec === "legacy") {
    // The deployed die INCLUDING its modulo bias: `h[8] % 24 + 4` over all 256 byte values.
    let s = 0; for (let b = 0; b < 256; b++) s += lg((b % 24) + 4); return s / 256;
  }
  const uni = (lo: number, hi: number) => { let s = 0; for (let k = lo; k <= hi; k++) s += lg(k); return s / (hi - lo + 1); };
  if (spec.kind === "uniform") return uni(spec.lo, spec.hi);
  const p = 1 / spec.pDen;
  return p * lg(spec.spike) + (1 - p) * uni(spec.lo, spec.hi);
}

const L0 = decayOf("legacy");

/** The base range `0..hi` that puts a `1/pDen` spike of `spike` on the deployed log-decay. Searched
 *  because `hi` is an integer; ties break toward the wider range, which buys variance. */
function matchedDecay(pDen: number, spike: number): RollSpec {
  let best: RollSpec = { kind: "spike", pDen, spike, lo: 0, hi: 0 };
  let bestErr = Infinity;
  for (let hi = 0; hi <= 90; hi++) {
    const s: RollSpec = { kind: "spike", pDen, spike, lo: 0, hi };
    const err = Math.abs(decayOf(s) - L0);
    if (err < bestErr - 1e-15) { best = s; bestErr = err; }
  }
  return best;
}

if (process.env.HE_PART3) {
  console.log(`
================================================================================================
 PART 3 — DECAY-MATCHED DICE. Maximise Var(roll) at fixed E[log(1 - roll/100)].
================================================================================================
 deployed E[log(1 - roll/100)] = ${L0.toFixed(6)}   (h[8] % 24 + 4, modulo bias included)
 every die below is searched to land on that number, so every die below should hold fight length
================================================================================================
`);
  const grid: Cand[] = [{ name: "SHIPPED (baseline)", cfg: BASELINE, stepDiv: 1 }];
  for (const pDen of [8, 16, 32]) {
    for (const v of [50, 60, 70, 75, 80, 85, 90, 95]) {
      const r = matchedDecay(pDen, v);
      if (r !== "legacy" && r.kind === "spike" && r.hi === 0 && pDen * 1 > 0) {
        // A base range that collapsed to {0} means the spike alone already overshoots the decay
        // budget at this density — the die cannot be matched and is dropped rather than reported.
        if (Math.abs(decayOf(r) - L0) > 0.01) continue;
      }
      grid.push({ name: `1/${pDen} @${v}`, cfg: base({ roll: r }), stepDiv: 1 });
    }
  }

  console.log("die                mean      sd   x base  E[log]     |  median  before  |  sd(final)  IQR   | worst horizon cell");
  console.log("-".repeat(118));
  let baseSd = 0;
  for (const c of grid) {
    const r = c.cfg.roll ?? "legacy";
    const hashes48: (Buffer | undefined)[][] = Array.from({ length: SEEDS }, () => new Array(stepBudget(48)));
    const m = measure(c, 48, hashes48);
    if (c.name === "SHIPPED (baseline)") baseSd = m.sdFinal;

    // The horizon bar, at the two lineups Part 2 showed to be the binding ones plus the top of the
    // range. Cheap enough to run inside the sweep; the winner gets the full sweep afterwards.
    let worst = Infinity, worstAt = "";
    for (const n of [2, 3, 4, 6, 8, 12, 16, 32, 48]) {
      const hz = horizonOf(n);
      const hs: (Buffer | undefined)[][] = Array.from({ length: 100 }, () => new Array(stepBudget(n)));
      for (const stake of STAKE_BAND) {
        const lens: number[] = [];
        for (let t = 0; t < 100; t++) {
          const f: Fighter[] = [];
          for (let i = 0; i < n; i++)
            f.push({ wallet: `w${i}`, side: (i % 2) as 0 | 1, dead: 0, stake, hp: stake, banked: 0n });
          lens.push(runFight(f, seedOf(t), stepBudget(n), c.cfg, hs[t], true).endedAt);
        }
        const ratio = quantile(sorted(lens), 0.5) / hz;
        if (ratio < worst) { worst = ratio; worstAt = `n=${n} $${Number(stake) / 1e6}`; }
      }
    }
    const supp = r === "legacy" ? "4..27" : r.kind === "spike" ? `0..${r.hi} + ${r.spike}@1/${r.pDen}` : `${r.lo}..${r.hi}`;
    console.log(
      `${(c.name + "  " + supp).padEnd(30)} ${rollMean(r).toFixed(2).padStart(5)} ${rollSd(r).toFixed(1).padStart(6)} ` +
      `${(rollSd(r) / rollSd("legacy")).toFixed(2).padStart(6)}x ${decayOf(r).toFixed(4).padStart(8)}  | ` +
      `${m.medianSec.toFixed(0).padStart(5)}s ${m.beforeBell.toFixed(1).padStart(6)}%  | ` +
      `${m.sdFinal.toFixed(2).padStart(8)} ${("(" + (m.sdFinal / baseSd).toFixed(2) + "x)").padStart(7)} ${m.iqrFinal.toFixed(1).padStart(5)} | ` +
      `${worst.toFixed(2)}x at ${worstAt}${worst < 1.22 ? "   <- under the shipped 1.22x" : ""}`,
    );
  }
}

// ================================================================================================
// PART 4 — THE FEASIBLE FRONTIER, AND THE BASE RANGE IS THE KNOB THAT FINDS IT
// ================================================================================================
// Parts 2 and 3 bracket the answer. A die matched on the ARITHMETIC mean ends fights too fast and
// breaks the horizon at small `n`; a die matched on the LOG ends them too slowly and breaks the bell
// at large `n`. Both constraints are about fight length and they bind at OPPOSITE ENDS of the lineup
// range, which is what makes this a search rather than a choice:
//
//     horizon (small n)  <——  fight length  ——>  bell (large n)
//
// For a die `uniform(0..hi)` with a `1/pDen` spike of `v`, the three parameters do separable things:
//   * `v` and `pDen` set Var(roll), which is what the deliverable is made of;
//   * `hi` sets the BODY of the die, and therefore the pace, and therefore where fight length lands
//     between the two constraints. It is monotone: a wider body is a faster fight, a better bell and
//     a thinner horizon margin.
// So `hi` is scanned for each `(pDen, v)` to find the feasible window, and the frontier is the
// largest Var(roll) whose window is non-empty. Both bars are held at the SHIPPED rule's own measured
// values rather than at round numbers — 1.22x on the horizon, 76.2% on the bell — because a change
// that merely matches what is deployed is not a regression, and nothing here is being graded against
// an ideal the live game does not itself meet.

if (process.env.HE_PART4) {
  console.log(`
================================================================================================
 PART 4 — THE FEASIBLE FRONTIER
================================================================================================
 bar A, horizon : median fight / PENALTY_HORIZON_STEPS >= 1.22x at EVERY (n, stake) cell
                  swept over n in {2,3,4,6,8} x {$5,$10,$20} — Part 2 showed the small end binds
 bar B, bell    : >= 76.2% of n=48 fights conclude before the 180s bell
 objective      : sd of the final side-vs-side split at n=48, in points of the pot
================================================================================================
`);
  const HZ_SEEDS = 200, HZ_N = [2, 3, 4, 6, 8];
  /** Bar A for one die, over the small lineups where Part 2 showed the margin is thinnest. */
  function horizonMargin(cfg: FightConfig): number {
    let worst = Infinity;
    for (const n of HZ_N) {
      const hz = horizonOf(n);
      const hs: (Buffer | undefined)[][] = Array.from({ length: HZ_SEEDS }, () => new Array(stepBudget(n)));
      for (const stake of STAKE_BAND) {
        const lens: number[] = [];
        for (let t = 0; t < HZ_SEEDS; t++) {
          const f: Fighter[] = [];
          for (let i = 0; i < n; i++)
            f.push({ wallet: `w${i}`, side: (i % 2) as 0 | 1, dead: 0, stake, hp: stake, banked: 0n });
          lens.push(runFight(f, seedOf(t), stepBudget(n), cfg, hs[t], true).endedAt);
        }
        worst = Math.min(worst, quantile(sorted(lens), 0.5) / hz);
      }
    }
    return worst;
  }

  const hashes48: (Buffer | undefined)[][] = Array.from({ length: SEEDS }, () => new Array(stepBudget(48)));
  const shipped = measure({ name: "s", cfg: BASELINE, stepDiv: 1 }, 48, hashes48);
  const shippedHz = horizonMargin(BASELINE);
  console.log(`SHIPPED reference: horizon ${shippedHz.toFixed(2)}x, bell ${shipped.beforeBell.toFixed(1)}%, sd(final) ${shipped.sdFinal.toFixed(2)}, median ${shipped.medianSec.toFixed(0)}s\n`);

  // THE CHASSIS. `retain` is swept alongside the die rather than after it, because the two are not
  // independent: `retain` LENGTHENS every fight (it repairs the attacker's ring, so rings drain
  // slower) and a heavy die SHORTENS them, so a pairing can sit inside both bars that neither knob
  // reaches alone. `retain` alone measures 2.08x on the horizon against the shipped 1.22x — that
  // slack is the budget a faster die gets to spend.
  //
  // MEASURED, AND IT KILLS `retain` OUTRIGHT — the study's own recommendation. Swept against bodies
  // up to `0..59` (an arithmetic mean of 31, TWICE the deployed pace, and far faster than anything
  // the horizon bar would otherwise allow) `retain`@stake still concludes only 11-26% of n=48 fights
  // before the bell, against the shipped 76%. The mechanism is not pace and cannot be bought back
  // with one: a repaired ring means the LAST fighter standing on a side is topped back up every time
  // it wins an exchange, and emptying a side is what ends a round. Rows kept below, run once, so the
  // conclusion is reproducible rather than quoted.
  const CHASSIS: { tag: string; cfg: Partial<FightConfig> }[] = process.env.HE_RETAIN
    ? [{ tag: " + retain@stake", cfg: { retainBps: 10000n, retainCap: "stake" } },
       { tag: " + retain50@stake", cfg: { retainBps: 5000n, retainCap: "stake" } }]
    : [{ tag: "", cfg: {} }];

  console.log("die                                   sd(roll)  mean   |  horizon   bell   |  sd(final)   IQR   median   exch");
  console.log("-".repeat(118));

  for (const ch of CHASSIS) {
    // The objective goes as `v / sqrt(pDen)` (a rare spike of `v` contributes `v*sqrt(p)` to the
    // roll's sd), so it wants a big rare spike; the bell bar wants the opposite, because a big rare
    // spike is exactly what makes the LAST fighter on a side take a long time to fall. The grid is
    // densest where those two curves cross.
    for (const pDen of [8, 12, 16, 24, 32]) {
      for (const v of [50, 55, 60, 70, 80, 85, 90, 95]) {
        // The largest body the horizon bar will bear. Monotone in `hi` — a wider body is a faster
        // fight and a thinner margin — so scanning downward and stopping at the first pass finds the
        // FASTEST feasible die at this (chassis, pDen, v), which is the one with the best shot at
        // the bell. The body never reaches the spike: a body at or above `v` is not a heavy tail.
        let chosen: RollSpec | null = null, hzm = 0;
        for (let hi = Math.min(60, v - 1); hi >= 0; hi--) {
          const spec: RollSpec = { kind: "spike", pDen, spike: v, lo: 0, hi };
          const m = horizonMargin({ ...base({ roll: spec }), ...ch.cfg });
          if (m >= 1.22) { chosen = spec; hzm = m; break; }
        }
        const label = `1/${pDen} @${v}${ch.tag}`;
        if (!chosen) { console.log(label.padEnd(38) + "  — no body satisfies the horizon bar"); continue; }
        const cfg = { ...base({ roll: chosen }), ...ch.cfg };
        const r = measure({ name: "c", cfg, stepDiv: 1 }, 48, hashes48);
        console.log(
          `${(label + `, body 0..${(chosen as any).hi}`).padEnd(38)} ${rollSd(chosen).toFixed(1).padStart(6)} ${rollMean(chosen).toFixed(2).padStart(6)}   | ` +
          `${hzm.toFixed(2).padStart(6)}x ${r.beforeBell.toFixed(1).padStart(6)}%  | ` +
          `${r.sdFinal.toFixed(2).padStart(8)} ${("(" + (r.sdFinal / shipped.sdFinal).toFixed(2) + "x)").padStart(7)} ` +
          `${r.iqrFinal.toFixed(1).padStart(5)} ${r.medianSec.toFixed(0).padStart(5)}s ${r.exchanges.toFixed(0).padStart(6)}` +
          `${r.beforeBell < shipped.beforeBell ? "   <- bell regression" : ""}`,
        );
      }
    }
  }
}
