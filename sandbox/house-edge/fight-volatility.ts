// SANDBOX — NOT SHIPPED, NOT ON CHAIN, NOT IMPORTED BY THE ENGINE OR THE DEMO.
//
// ================================================================================================
// THE QUESTION
// ================================================================================================
// "The on-screen effects look a lot more erratic right now. I want stronger fluctuations in the
//  progress that is happening, specifically who is winning. It needs to be more exciting and more
//  tense, not just in the visuals... The outcome and the result of the money that is being won and
//  lost should be more varied. The total sum of who is winning is relatively very stable and that's
//  a bit boring."
//
// That is a complaint about the MONEY CURVE, not the animation. The money curve is
// `s(t) = (sum of hp + banked over side 0) / pot` — literally what `settle_sides` computes, sampled
// through the fight instead of once at the end. Every statistic here is a functional of s(t).
//
// AMPLITUDE IS THE HEADLINE, CROSSINGS ARE SECONDARY. A small-step random walk has many lead
// changes and tiny amplitude, which is exactly the "erratic visuals, boring score" being described.
// So `swing` (the time-weighted standard deviation of s through the fight, in points of the pot) and
// `maxExc` (the largest excursion of s from 50%) lead every table; `cross` (lead changes) follows.
//
// ================================================================================================
// REPRODUCING IT
// ================================================================================================
//   cd engine
//   HE_FEE_BPS=100 npx tsx ../sandbox/house-edge/fight-volatility.ts [rounds] [part]
//     part in 0 | 1 | 2 | 3 | 4 | all      (parts are independent; run them in parallel)
//     0  the n-sweep      — does aggregate volatility fall as seats rise?
//     1  the candidates   — how much swing does each knob buy, paired on shared lobbies
//     2  bar 2, fairness  — band ROI, and the roll>100 negative result
//     3  bar 3, sybil     — the $80 split farm, side-stacked and alternating
//     4  bar 4, retention — per-round sigma, ruin over 200 rounds, and the side-selection edge
//
// SEEDS, all of them, so nothing here is reproducible only by accident:
//   lobbies (parts 0,1,2): "vol-v1"        -> sha256("he|vol-v1|<round>") is the fight seed
//   lobbies (part 3):      "vol-v1|split|<k>|<stack|alt>"
//   lobbies (part 4):      "vol-v1|life", "vol-v1|side"
//   bootstrap resampling:  mulberry32 with the literal seeds printed beside each table
//
// COMMON RANDOM NUMBERS. Every candidate is scored against the SAME lobby and the SAME lazily-built
// sha256 table (`Lobby.hashes`), exactly as `study-damage.ts` does. The lobby is built once per
// round and every configuration is run against it, so differences are PAIRED and the sha256 chain —
// which dominates the runtime at 48 seats — is paid for once rather than once per candidate.
//
// ================================================================================================
// CONSERVATION, ASSERTED IN INTEGERS, EVERY ROUND
// ================================================================================================
// The identity: `sum_i (hp_i + banked_i) == sum_i stake_i`. On chain `apply_sweep` enforces
// `sum(hp + banked) + penalties == pot`; nothing in this rig extracts, so `penalties == 0` and the
// two statements are the same one. It is checked in BigInt after every fight of every candidate,
// alongside a second identity that validates the incremental side accounting the path statistics
// are built from: the traced `v0` at the end of the fight must equal a fresh O(n) sum over side 0.
// Either failing calls `process.exit(1)`.

import {
  runFight, payout, BASELINE, FEE_BPS, DUST_ABSOLUTE, W_UNIFORM, stepBudget,
  rollMean, rollSd, rollMax, ROLL_CLAMP_FREE_MAX, MAX_FIGHTERS, BPS, UNITS_PER_USD,
} from "./fight-variant.ts";
import type { FightConfig, FightTrace, RollSpec, Fighter } from "./fight-variant.ts";
import { BANDS, makeLobby, finish, fightersOf, roiWithSE, usd, pct, toUsd } from "./lobby.ts";
import type { Lobby, Entry } from "./lobby.ts";
import { mulberry32 } from "./rng.ts";

const ROUNDS = Number(process.argv[2] ?? 400);
const PART = String(process.argv[3] ?? "all");
const STUDY_SEED = "vol-v1";
const runPart = (p: number) => PART === "all" || PART === String(p);

/** Cadence from HOUSE-STRATEGY.md §1, reproduced here so `$/day` is not a number without a source. */
const ROUNDS_PER_DAY = 785;

// ------------------------------------------------------------------------------------------------
// CONSERVATION
// ------------------------------------------------------------------------------------------------

let consChecked = 0;
function assertConserved(f: Fighter[], pot: bigint, v0Traced: number | undefined, where: string) {
  let after = 0n, side0 = 0n;
  for (const g of f) { after += g.hp + g.banked; if (g.side === 0) side0 += g.hp + g.banked; }
  if (after !== pot) {
    console.log(`\nCONSERVATION FAILED at ${where}: sum(hp+banked) = ${after} != pot = ${pot}`);
    process.exit(1);
  }
  if (v0Traced !== undefined && v0Traced !== Number(side0)) {
    console.log(`\nSIDE ACCOUNTING FAILED at ${where}: traced v0 = ${v0Traced} != ${side0}`);
    process.exit(1);
  }
  consChecked++;
}

// ------------------------------------------------------------------------------------------------
// THE CANDIDATES
// ------------------------------------------------------------------------------------------------

/** `stepDiv` divides the step budget. It is 1 for everything except the "fewer, bigger exchanges"
 *  rows, where the roll is multiplied by the same integer so expected total damage is unchanged. */
interface Cand { name: string; cfg: FightConfig; stepDiv: number; kind: string; }

const base = (extra: Partial<FightConfig>): FightConfig => ({ ...BASELINE, ...extra });

/** The deployed die's exact mean, 3904/256. Every mean-matched candidate is matched to THIS, not to
 *  the 15.5 a truly uniform 4..27 would give — the modulo bias is part of the shipped pacing. */
const LEGACY_MEAN = rollMean("legacy");

/** Pick the integer uniform base range for a spike die whose overall mean lands on the deployed
 *  one. Searched rather than solved because `hi` must be an integer and the closed form is not; ties
 *  break toward the wider range, which is the direction that buys variance. */
function matchedSpike(pDen: number, spike: number): RollSpec {
  let best: RollSpec = { kind: "spike", pDen, spike, lo: 0, hi: 1 };
  let bestErr = Infinity;
  for (let lo = 0; lo <= 2; lo++) {
    for (let hi = lo; hi <= 99; hi++) {
      const s: RollSpec = { kind: "spike", pDen, spike, lo, hi };
      const err = Math.abs(rollMean(s) - LEGACY_MEAN);
      if (err < bestErr - 1e-12 || (Math.abs(err - bestErr) < 1e-12 && hi - lo > (best as any).hi - (best as any).lo)) {
        best = s; bestErr = err;
      }
    }
  }
  return best;
}

const ALL_CANDS: Cand[] = [
  { name: "SHIPPED (baseline)          ", cfg: BASELINE, stepDiv: 1, kind: "-" },

  // 1. ROLL DISTRIBUTION. The mean pins the support of a uniform, so 0..31 is the widest a
  //    mean-matched uniform can be; everything wider is a pacing change or a skew.
  { name: "roll uniform 0..31   (matched)", cfg: base({ roll: { kind: "uniform", lo: 0, hi: 31 } }), stepDiv: 1, kind: "roll" },
  { name: "roll uniform 1..40           ", cfg: base({ roll: { kind: "uniform", lo: 1, hi: 40 } }), stepDiv: 1, kind: "roll" },
  { name: "roll uniform 1..60           ", cfg: base({ roll: { kind: "uniform", lo: 1, hi: 60 } }), stepDiv: 1, kind: "roll" },
  { name: "roll uniform 1..100          ", cfg: base({ roll: { kind: "uniform", lo: 1, hi: 100 } }), stepDiv: 1, kind: "roll" },
  { name: "roll spike p=1/16 @100 (matched)", cfg: base({ roll: matchedSpike(16, 100) }), stepDiv: 1, kind: "roll" },
  { name: "roll spike p=1/32 @100 (matched)", cfg: base({ roll: matchedSpike(32, 100) }), stepDiv: 1, kind: "roll" },
  { name: "roll spike p=1/64 @100 (matched)", cfg: base({ roll: matchedSpike(64, 100) }), stepDiv: 1, kind: "roll" },

  // THE NEGATIVE RESULT, run rather than asserted: a roll that can exceed 100 wakes the asymmetric
  // `dmg > D.hp` clamp and reopens the v5 defect.
  { name: "NEG roll uniform 1..200 (>100)", cfg: base({ roll: { kind: "uniform", lo: 1, hi: 200 } }), stepDiv: 1, kind: "neg" },
  { name: "NEG roll spike p=1/32 @400    ", cfg: base({ roll: { kind: "spike", pDen: 32, spike: 400, lo: 0, hi: 25 } }), stepDiv: 1, kind: "neg" },

  // 2. CORRELATION. Same marginal ordered-pair distribution, different joint.
  { name: "surge L=4                    ", cfg: base({ surgeWindow: 4 }), stepDiv: 1, kind: "surge" },
  { name: "surge L=8                    ", cfg: base({ surgeWindow: 8 }), stepDiv: 1, kind: "surge" },
  { name: "surge L=16                   ", cfg: base({ surgeWindow: 16 }), stepDiv: 1, kind: "surge" },
  { name: "surge L=32                   ", cfg: base({ surgeWindow: 32 }), stepDiv: 1, kind: "surge" },
  { name: "surge L=64                   ", cfg: base({ surgeWindow: 64 }), stepDiv: 1, kind: "surge" },
  { name: "surge L=128                  ", cfg: base({ surgeWindow: 128 }), stepDiv: 1, kind: "surge" },

  // 3. FEWER, BIGGER EXCHANGES. roll x m, steps / m: same expected total damage, sqrt(m) the
  //    aggregate swing, and 1/m the compute.
  { name: "fewer/bigger m=2 (roll x2, steps/2)", cfg: base({ rollMul: 2n }), stepDiv: 2, kind: "fewer" },
  { name: "fewer/bigger m=3 (roll x3, steps/3)", cfg: base({ rollMul: 3n }), stepDiv: 3, kind: "fewer" },

  // 4. THE RATCHET. Winnings back into the ring instead of into the bank — the only knob here that
  //    is still an exact martingale step by step.
  { name: "retain 25% into ring         ", cfg: base({ retainBps: 2500n }), stepDiv: 1, kind: "retain" },
  { name: "retain 50% into ring         ", cfg: base({ retainBps: 5000n }), stepDiv: 1, kind: "retain" },
  { name: "retain 75% into ring         ", cfg: base({ retainBps: 7500n }), stepDiv: 1, kind: "retain" },
  { name: "retain 100% into ring        ", cfg: base({ retainBps: 10000n }), stepDiv: 1, kind: "retain" },
  // ... and the same knob with the ring capped at the entry stake, which is what keeps fights ending.
  { name: "retain 100% capped at stake  ", cfg: base({ retainBps: 10000n, retainCap: "stake" }), stepDiv: 1, kind: "retain" },
  { name: "retain 50% capped at stake   ", cfg: base({ retainBps: 5000n, retainCap: "stake" }), stepDiv: 1, kind: "retain" },

  // 5. MEAN REVERSION. The see-saw. `rollCap` is set so this candidate cannot smuggle in the
  //    roll>100 defect and be credited (or blamed) for it.
  { name: "comeback k=0.5              ", cfg: base({ comebackBps: 5000n, rollCap: ROLL_CLAMP_FREE_MAX }), stepDiv: 1, kind: "comeback" },
  { name: "comeback k=1.0              ", cfg: base({ comebackBps: 10000n, rollCap: ROLL_CLAMP_FREE_MAX }), stepDiv: 1, kind: "comeback" },
  { name: "comeback k=2.0              ", cfg: base({ comebackBps: 20000n, rollCap: ROLL_CLAMP_FREE_MAX }), stepDiv: 1, kind: "comeback" },

  // 6. COMBINATIONS of the two levers that survive on their own merits.
  { name: "retain 75% + surge L=16      ", cfg: base({ retainBps: 7500n, surgeWindow: 16 }), stepDiv: 1, kind: "combo" },
  { name: "retain 75% + spike p=1/32    ", cfg: base({ retainBps: 7500n, roll: matchedSpike(32, 100) }), stepDiv: 1, kind: "combo" },
  { name: "retain 75% + fewer/bigger m=2", cfg: base({ retainBps: 7500n, rollMul: 2n }), stepDiv: 2, kind: "combo" },
  { name: "retain@stake + surge L=16    ", cfg: base({ retainBps: 10000n, retainCap: "stake", surgeWindow: 16 }), stepDiv: 1, kind: "combo" },
  { name: "retain@stake + fewer/bigger m=2", cfg: base({ retainBps: 10000n, retainCap: "stake", rollMul: 2n }), stepDiv: 2, kind: "combo" },
  { name: "retain@stake + spike p=1/32  ", cfg: base({ retainBps: 10000n, retainCap: "stake", roll: matchedSpike(32, 100) }), stepDiv: 1, kind: "combo" },
];

/** `HE_VOL_ONLY` keeps only the candidates whose name contains one of the comma-separated fragments.
 *  It exists so a shortlist can be re-run at many more rounds once the wide sweep has said which
 *  rows are worth the precision. The SHIPPED baseline is always kept and always stays first, because
 *  every ratio and every gain printed below is measured against it. */
const ONLY = process.env.HE_VOL_ONLY;
const CANDS: Cand[] = ONLY
  ? ALL_CANDS.filter((c, i) => i === 0 || ONLY.split(",").some(t => c.name.includes(t.trim())))
  : ALL_CANDS;

// ------------------------------------------------------------------------------------------------
// PATH STATISTICS
// ------------------------------------------------------------------------------------------------

interface Path {
  swing: number;        // time-weighted sd of s(t) over [0, T), in points of the pot
  maxExc: number;       // max |s(t) - 0.5|
  range: number;        // max s - min s
  cross: number;        // lead changes (crossings of 0.5)
  lastCrossFrac: number;// step of the last lead change / T; 0 when there is none
  winnerMin: number;    // the eventual winner's smallest share — the depth of their comeback
  finalS: number;
  dec: number[];        // s at 10%, 20%, ... 100% of T
  T: number;
}

const DECILES = 10;

/** Turn a trace into the statistics above.
 *
 *  s(t) is piecewise constant and only moves on an exchange, so the trace is LOSSLESS rather than a
 *  sample: the value holds from one exchange to the next. Time weighting is by STEPS, and steps are
 *  wall clock (`STEPS_PER_FIGHTER_PER_SECOND * n` per second), so a time-weighted moment is what a
 *  viewer's eye actually integrates. */
function analyse(tr: FightTrace, pot: number, s0: number, T: number): Path {
  let sumW = 0, sumS = 0, sumS2 = 0;
  let lo = s0, hi = s0, maxExc = Math.abs(s0 - 0.5);
  let cross = 0, lastCross = 0;
  let sign = s0 > 0.5 ? 1 : s0 < 0.5 ? -1 : 0;
  let prevStep = 0, prevVal = s0;

  const seg = (from: number, to: number, v: number) => {
    const w = to - from;
    if (w <= 0) return;
    sumW += w; sumS += v * w; sumS2 += v * v * w;
  };

  for (let k = 0; k < tr.count; k++) {
    const st = tr.step[k];
    if (st >= T) break;
    seg(prevStep, st, prevVal);
    const v = tr.v0[k] / pot;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
    const e = Math.abs(v - 0.5); if (e > maxExc) maxExc = e;
    const sg = v > 0.5 ? 1 : v < 0.5 ? -1 : 0;
    if (sg !== 0 && sign !== 0 && sg !== sign) { cross++; lastCross = st; }
    if (sg !== 0) sign = sg;
    prevStep = st; prevVal = v;
  }
  seg(prevStep, T, prevVal);

  const mean = sumW > 0 ? sumS / sumW : s0;
  const varS = sumW > 0 ? Math.max(0, sumS2 / sumW - mean * mean) : 0;
  const finalS = prevVal;

  // Deciles: the last value in force at or before ceil(q*T).
  const dec = new Array(DECILES).fill(s0);
  {
    let k = 0, v = s0;
    for (let q = 0; q < DECILES; q++) {
      const t = Math.ceil(((q + 1) / DECILES) * T);
      while (k < tr.count && tr.step[k] < t && tr.step[k] < T) { v = tr.v0[k] / pot; k++; }
      dec[q] = v;
    }
  }

  // The eventual winner's worst moment. Ties on the badge go to side 0, matching `settle_sides`.
  const winner0 = finalS >= 0.5;
  const winnerMin = winner0 ? lo : 1 - hi;

  return {
    swing: Math.sqrt(varS), maxExc, range: hi - lo, cross,
    lastCrossFrac: T > 0 ? lastCross / T : 0, winnerMin, finalS, dec, T,
  };
}

// ------------------------------------------------------------------------------------------------
// RUNNING ONE FIGHT
// ------------------------------------------------------------------------------------------------

const TRACE: FightTrace = {
  step: new Int32Array(stepBudget(MAX_FIGHTERS) + 2),
  v0: new Float64Array(stepBudget(MAX_FIGHTERS) + 2),
  count: 0,
};

interface Outcome { fighters: Fighter[]; path: Path; endedAt: number; steps: number; exchanges: number; deaths: number; }

function play(l: Lobby, c: Cand, where: string): Outcome {
  const { fighters } = fightersOf(l);
  let pot = 0n, s0u = 0n;
  for (const f of fighters) { pot += f.stake; if (f.side === 0) s0u += f.stake; }
  const steps = Math.max(1, Math.ceil(l.steps / c.stepDiv));
  const st = runFight(fighters, l.seed, steps, c.cfg, l.hashes, true, TRACE);
  const lastV0 = TRACE.count > 0 ? TRACE.v0[TRACE.count - 1] : Number(s0u);
  assertConserved(fighters, pot, lastV0, `${where} / ${c.name.trim()}`);
  const potN = Number(pot);
  const path = analyse(TRACE, potN, Number(s0u) / potN, st.endedAt);
  let deaths = 0; for (const f of fighters) if (f.dead === 1) deaths++;
  return { fighters, path, endedAt: st.endedAt, steps, exchanges: st.exchanges, deaths };
}

// ------------------------------------------------------------------------------------------------
// SMALL STATISTICS HELPERS. Floats live here and only here.
// ------------------------------------------------------------------------------------------------

const mean = (xs: number[]) => xs.reduce((a, x) => a + x, 0) / xs.length;
const sd = (xs: number[]) => { const m = mean(xs); return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(1, xs.length - 1)); };
const ci95 = (xs: number[]) => 1.96 * sd(xs) / Math.sqrt(xs.length);
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1]; };
const f2 = (x: number, d = 2) => x.toFixed(d);

/** Equal-stake lobby: the clean case, where s(0) is exactly 0.5 and every crossing of 0.5 is a real
 *  lead change rather than an artefact of an uneven draw. */
function equalLobby(tag: string, round: number, perSide: number, usdEach: number): Lobby {
  const entries: Entry[] = [];
  let id = 0;
  for (const side of [0, 1] as const)
    for (let i = 0; i < perSide; i++)
      entries.push({ wallet: `w${++id}`, side, grossUnits: usd(usdEach), band: 0, house: false });
  return finish(`${STUDY_SEED}|${tag}`, round, entries);
}

// ================================================================================================
// HEADER
// ================================================================================================

console.log(`
================================================================================================
 FIGHT VOLATILITY — how much does the scoreboard actually move?
================================================================================================
 reproduce:  cd engine && HE_FEE_BPS=100 npx tsx ../sandbox/house-edge/fight-volatility.ts ${ROUNDS} ${PART}
 fee        : ${FEE_BPS} bps ${FEE_BPS === 100n ? "(the live rate)" : "(NOT the live rate — the live arena charges 100)"}
 lobby seed : "${STUDY_SEED}"   fight seed = sha256("he|<seed>|<round>")
 rounds     : ${ROUNDS} per cell
 dust       : ${DUST_ABSOLUTE} units,  seats cap ${MAX_FIGHTERS},  bell ${stepBudget(1)} steps/fighter
 part       : ${PART}
================================================================================================`);

// ================================================================================================
// PART 0 — THE n-SWEEP. The hypothesis: the 16 -> 48 seat change flattened the money curve.
// ================================================================================================

if (runPart(0)) {
  console.log(`
------------------------------------------------------------------------------------------------
PART 0 — DOES AGGREGATE VOLATILITY FALL AS SEATS RISE?
------------------------------------------------------------------------------------------------
Shipped rule only. Two lineups per n: EQUAL stakes ($10 each, so s(0) = 0.500 exactly) and BANDS
(the invented stake distribution every other study in this directory uses).

The prediction to confirm or refute: early in a fight every ring is ~pot/n, so one exchange moves
about 0.1525*pot/n — a share of the pot that falls like 1/n — while the bell is 180*2*n steps, so
the number of exchanges rises like n. A driftless independent walk then has
   sd(s) ~ sqrt(N_ex) * 0.1525/n ~ n^(-1/2),
i.e. the 16 -> 48 change should have cut the swing by sqrt(3) = 1.73. The fitted exponent is
reported with a bootstrap CI. If it is not near -0.5 the walk is not driftless-independent, and the
two suspects are (a) fights terminating on side elimination, which is harder at large n, and (b) the
ratchet: winnings move to 'banked', permanently out of the at-risk pool, so the step size decays.
Both are reported beside the exponent so the reader can tell which.`);

  const NS = [4, 8, 16, 32, 48];
  for (const shape of ["equal", "bands"] as const) {
    console.log(`\n  --- ${shape === "equal" ? "EQUAL STAKES ($10 each)" : "BANDS STAKES (whale..minnow)"} ---`);
    const head = "   n  budget   swing x100      maxExc x100   range x100   cross   lastCross/T   sd(final s)   endedAt  end/bell  bell%  deaths  exch";
    console.log(head); console.log("  " + "-".repeat(head.length));
    const meansByN: number[] = [];
    const perRoundByN: number[][] = [];
    for (const n of NS) {
      const sw: number[] = [], mx: number[] = [], rg: number[] = [], cr: number[] = [],
        lc: number[] = [], fs: number[] = [], ea: number[] = [], eb: number[] = [], dd: number[] = [], ex: number[] = [];
      let bell = 0;
      for (let r = 0; r < ROUNDS; r++) {
        const l = shape === "equal" ? equalLobby(`n${n}eq`, r, n / 2, 10) : makeLobby(`${STUDY_SEED}|n${n}`, r, n / 2);
        const o = play(l, CANDS[0], `part0 n=${n} ${shape} r=${r}`);
        sw.push(o.path.swing); mx.push(o.path.maxExc); rg.push(o.path.range); cr.push(o.path.cross);
        lc.push(o.path.lastCrossFrac); fs.push(o.path.finalS); ea.push(o.endedAt);
        eb.push(o.endedAt / l.steps); if (o.endedAt >= l.steps) bell++;
        dd.push(o.deaths / n); ex.push(o.exchanges);
      }
      meansByN.push(mean(sw)); perRoundByN.push(sw);
      console.log(`  ${String(n).padStart(2)}  ${String(stepBudget(n)).padStart(6)}   ` +
        `${f2(100 * mean(sw)).padStart(6)}+-${f2(100 * ci95(sw)).padStart(4)}   ` +
        `${f2(100 * mean(mx)).padStart(6)}+-${f2(100 * ci95(mx)).padStart(4)}   ` +
        `${f2(100 * mean(rg)).padStart(6)}   ` +
        `${f2(mean(cr), 1).padStart(5)}   ` +
        `${f2(mean(lc), 3).padStart(9)}   ` +
        `${f2(100 * sd(fs)).padStart(9)}   ` +
        `${String(Math.round(median(ea))).padStart(7)}  ${f2(mean(eb), 3).padStart(7)}  ` +
        `${f2(100 * bell / ROUNDS, 0).padStart(4)}%  ${f2(100 * mean(dd), 0).padStart(5)}%  ${String(Math.round(mean(ex))).padStart(5)}`);
    }

    // OLS of log(mean swing) on log(n), with a bootstrap over rounds inside each n.
    const fit = (ms: number[]) => {
      const xs = NS.map(n => Math.log(n)), ys = ms.map(m => Math.log(m));
      const mx = mean(xs), my = mean(ys);
      let num = 0, den = 0;
      for (let i = 0; i < xs.length; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
      return num / den;
    };
    const point = fit(meansByN);
    const rnd = mulberry32(90210);
    const draws: number[] = [];
    for (let b = 0; b < 500; b++) {
      const ms = perRoundByN.map(xs => {
        let s = 0; for (let k = 0; k < xs.length; k++) s += xs[Math.floor(rnd() * xs.length)];
        return s / xs.length;
      });
      draws.push(fit(ms));
    }
    const lo = [...draws].sort((a, b) => a - b)[Math.floor(0.025 * draws.length)];
    const hi = [...draws].sort((a, b) => a - b)[Math.floor(0.975 * draws.length)];
    console.log(`\n  fitted exponent  d log(swing) / d log(n) = ${f2(point, 3)}   95% CI [${f2(lo, 3)}, ${f2(hi, 3)}]   (prediction: -0.500)`);
    const i16 = NS.indexOf(16), i48 = NS.indexOf(48);
    console.log(`  measured 16 -> 48 : swing ${f2(100 * meansByN[i16])} -> ${f2(100 * meansByN[i48])} points, a factor of ${f2(meansByN[i16] / meansByN[i48], 2)}x  (1/sqrt(3) predicts 1.73x)`);
  }
}

// ================================================================================================
// PART 1 — THE CANDIDATES
// ================================================================================================

if (runPart(1)) {
  console.log(`
------------------------------------------------------------------------------------------------
PART 1 — WHAT EACH KNOB BUYS, PAIRED ON SHARED LOBBIES
------------------------------------------------------------------------------------------------
48 seats, the lineup the arena now fields. Every candidate sees the identical lobby and the
identical sha256 chain, so the columns are paired and the "x base" ratios carry far less noise than
their levels do.

  swing   time-weighted sd of side 0's share through the fight, in points of the pot  [HEADLINE]
  maxExc  the largest excursion of that share from 50%                                [HEADLINE]
  cross   lead changes                                                                [secondary]
  wMin    the eventual winner's smallest share — how far behind they came from
  sd(fin) dispersion of the FINAL share across rounds: how varied the money outcome is
  clamp   the largest roll the die can produce; > 100 wakes the asymmetric dmg>D.hp clamp`);

  for (const shape of ["bands", "equal"] as const) {
    console.log(`\n  --- 48 seats, ${shape === "equal" ? "EQUAL $10 stakes" : "BANDS stakes"} ---`);
    const acc = CANDS.map(() => ({ sw: [] as number[], mx: [] as number[], cr: [] as number[], wm: [] as number[], fs: [] as number[], ea: [] as number[], ex: [] as number[], dd: [] as number[], dec: Array.from({ length: DECILES }, () => [] as number[]) }));
    for (let r = 0; r < ROUNDS; r++) {
      const l = shape === "equal" ? equalLobby("c48eq", r, 24, 10) : makeLobby(`${STUDY_SEED}|c48`, r, 24);
      for (let c = 0; c < CANDS.length; c++) {
        const o = play(l, CANDS[c], `part1 ${shape} r=${r}`);
        const a = acc[c];
        a.sw.push(o.path.swing); a.mx.push(o.path.maxExc); a.cr.push(o.path.cross);
        a.wm.push(o.path.winnerMin); a.fs.push(o.path.finalS); a.ea.push(o.endedAt);
        a.ex.push(o.exchanges); a.dd.push(o.deaths / l.entries.length);
        for (let q = 0; q < DECILES; q++) a.dec[q].push(o.path.dec[q]);
      }
    }
    const head = "candidate                            swing x100  x base   maxExc x100  x base   cross   wMin   sd(fin)x100   endedAt  deaths   exch   maxRoll";
    console.log(head); console.log("-".repeat(head.length));
    const b = acc[0];
    for (let c = 0; c < CANDS.length; c++) {
      const a = acc[c];
      const mr = rollMax(CANDS[c].cfg);
      console.log(`${CANDS[c].name.padEnd(36)} ${f2(100 * mean(a.sw)).padStart(6)}+-${f2(100 * ci95(a.sw)).padStart(4)}  ${f2(mean(a.sw) / mean(b.sw)).padStart(5)}   ` +
        `${f2(100 * mean(a.mx)).padStart(6)}+-${f2(100 * ci95(a.mx)).padStart(4)}  ${f2(mean(a.mx) / mean(b.mx)).padStart(5)}   ` +
        `${f2(mean(a.cr), 1).padStart(5)}  ${f2(mean(a.wm), 3).padStart(5)}  ${f2(100 * sd(a.fs)).padStart(9)}   ` +
        `${String(Math.round(median(a.ea))).padStart(7)}  ${f2(100 * mean(a.dd), 0).padStart(4)}%  ${String(Math.round(mean(a.ex))).padStart(5)}   ${String(mr).padStart(5)}${mr > ROLL_CLAMP_FREE_MAX ? " CLAMP" : ""}`);
    }

    if (shape === "bands") {
      console.log(`\n  --- the path envelope: sd across rounds of side 0's share, sampled at deciles of the fight (x100) ---\n`);
      console.log("candidate                            " + Array.from({ length: DECILES }, (_, q) => `${(q + 1) * 10}%`.padStart(7)).join(""));
      for (let c = 0; c < CANDS.length; c++)
        console.log(`${CANDS[c].name.padEnd(36)} ` + acc[c].dec.map(xs => f2(100 * sd(xs), 1).padStart(7)).join(""));
    }
  }
}

// ================================================================================================
// PART 2 — BAR 2: STILL A FAIR GAME?
// ================================================================================================

if (runPart(2)) {
  console.log(`
------------------------------------------------------------------------------------------------
PART 2 — BAR 2: IS IT STILL A FAIR GAME? (band ROI, ${FEE_BPS} bps)
------------------------------------------------------------------------------------------------
The bar: every band sits at minus the fee, i.e. ${pct(-Number(FEE_BPS) / 10000, 2)}, and the whale-to-minnow spread
stays inside the noise. Reproduces the shape of study-damage.ts's table for every candidate.

Run at BOTH lineup sizes on purpose. The path-dependent candidates (surge, comeback) have an effect
that scales with the run length a single fighter sees inside a window, which is L/n — so a rule can
look clean at 48 seats and be a farm at 8. A candidate has to pass at both.`);

  for (const perSide of [4, 24]) {
    const n = perSide * 2;
    console.log(`\n  --- ${n} seats, ${ROUNDS} rounds ---`);
    const acc = CANDS.map(() => BANDS.map(() => [] as { inn: number; out: number }[]));
    for (let r = 0; r < ROUNDS; r++) {
      const l = makeLobby(`${STUDY_SEED}|fair${n}`, r, perSide);
      for (let c = 0; c < CANDS.length; c++) {
        const o = play(l, CANDS[c], `part2 n=${n} r=${r}`);
        const row = BANDS.map(() => ({ inn: 0, out: 0 }));
        for (let i = 0; i < o.fighters.length; i++) {
          row[l.entries[i].band].inn += toUsd(l.entries[i].grossUnits);
          row[l.entries[i].band].out += toUsd(payout(o.fighters[i]));
        }
        for (let bi = 0; bi < BANDS.length; bi++) acc[c][bi].push(row[bi]);
      }
    }
    const head = "candidate                            " + ["whale", "big", "medium", "small", "minnow"].map(s => s.padStart(16)).join("") + "    spread";
    console.log(head); console.log("-".repeat(head.length));
    for (let c = 0; c < CANDS.length; c++) {
      const rs = BANDS.map((_, bi) => roiWithSE(acc[c][bi], 1000, 400 + c * 11 + bi));
      const spread = rs[4].roi - rs[0].roi;
      const flag = Math.abs(spread) > 3 * Math.hypot(rs[4].se, rs[0].se) ? "  <-- EDGE" : "";
      console.log(`${CANDS[c].name.padEnd(36)} ${rs.map(x => `${pct(x.roi, 2)}+-${(x.se * 100).toFixed(2)}`.padStart(16)).join("")}  ${pct(spread, 1).padStart(9)}${flag}`);
    }
    console.log(`\n  "<-- EDGE" marks a whale-minnow spread more than 3 paired SEs from zero. The shipped rule`);
    console.log(`  is the control: whatever spread IT shows at this sample size is the noise floor.`);
  }
}

// ================================================================================================
// PART 3 — BAR 3: THE SYBIL FARM
// ================================================================================================

if (runPart(3)) {
  console.log(`
------------------------------------------------------------------------------------------------
PART 3 — BAR 3: DOES IT REOPEN THE $80 SPLIT FARM?
------------------------------------------------------------------------------------------------
study-split.ts's design: 48 seats, an $80 budget split across k wallets, background fills the rest
from the bands. Two layouts, and the second is the one that matters:

  ALT    the splitter's wallets alternate sides, as study-split.ts had them. Half the splitter's
         exchanges are then internal washes between their own wallets — which the fight SKIPS
         (same wallet) or which move money from one of their pockets to another (different wallet,
         opposite sides). Either way the adversary wastes half their seats on themselves.
  STACK  every splitter wallet on ONE side. No internal washes at all, so every exchange the
         splitter is in is against the field.

THIS SECTION USED TO SAY "STACK IS THE LAYOUT AN ADVERSARY WOULD USE AND IS THE NUMBER THE BAR IS
SET AGAINST". THE MEASUREMENT SAYS OTHERWISE and the claim is corrected rather than deleted, because
the reasoning behind it was sound and still wrong. Under surge L=64 the splitter earns $4.33+-1.58
per round STACKED and $6.94+-1.29 ALTERNATING — alternating is BETTER for the adversary, despite
wasting exchanges on internal washes. The reason is that these defects are SIZE tilts, not SIDE
tilts: what pays is having many small wallets each facing a full opposing side, and stacking crowds
them onto one side against a thinner opposing field, which costs more than the washes do. So the bar
is the WORSE of the two layouts and both are reported. The stacked test was still necessary — it is
how we learned which layout binds.

The v5 defect was worth $150.87 per round on this design. Anything approaching that is a fail.`);

  const BUDGET = 80, SEATS = 48;
  const KS = [1, 2, 4, 8, 12, 16, 24];

  function splitLobbies(k: number, stack: boolean, rounds: number): Lobby[] {
    const out: Lobby[] = [];
    for (let r = 0; r < rounds; r++) {
      const rnd = mulberry32((r * 2654435761 + k * 7919 + (stack ? 13 : 0)) >>> 0);
      const entries: Entry[] = [];
      let id = 0;
      for (let i = 0; i < k; i++)
        entries.push({ wallet: `s${++id}`, side: (stack ? 0 : (i % 2)) as 0 | 1, grossUnits: usd(BUDGET / k), band: -1, house: true });
      for (let i = 0; i < SEATS - k; i++) {
        const bd = BANDS[Math.floor(rnd() * BANDS.length)];
        // When the splitter is stacked on side 0, the background must still fill both sides or there
        // is no fight at all; alternating it keeps side 1 populated and side 0 contested.
        entries.push({ wallet: `p${++id}`, side: (stack ? ((i % 2) as 0 | 1) : (((i + 1) % 2) as 0 | 1)), grossUnits: usd(bd.lo + rnd() * (bd.hi - bd.lo)), band: -1, house: false });
      }
      out.push(finish(`${STUDY_SEED}|split|${k}|${stack ? "stack" : "alt"}`, r, entries));
    }
    return out;
  }

  const R3 = Math.max(60, Math.round(ROUNDS / 2));
  for (const stack of [true, false]) {
    console.log(`\n  --- ${stack ? "STACK (all k wallets on side 0)" : "ALT (wallets alternate sides)"} — ${R3} rounds per cell, ROI on the whole $${BUDGET} ---`);
    const table: number[][] = CANDS.map(() => []);
    const seTable: number[][] = CANDS.map(() => []);
    for (const k of KS) {
      const lobbies = splitLobbies(k, stack, R3);
      for (let c = 0; c < CANDS.length; c++) {
        const per: number[] = [];
        let inn = 0, out = 0;
        for (const l of lobbies) {
          const o = play(l, CANDS[c], `part3 k=${k} stack=${stack}`);
          let i = 0, oo = 0;
          for (let j = 0; j < o.fighters.length; j++)
            if (l.entries[j].house) { i += toUsd(l.entries[j].grossUnits); oo += toUsd(payout(o.fighters[j])); }
          inn += i; out += oo; per.push(oo / i - 1);
        }
        table[c].push(out / inn - 1);
        seTable[c].push(sd(per) / Math.sqrt(per.length));
      }
    }
    const head = "candidate                        " + KS.map(k => `k=${k}`.padStart(11)).join("") + "    gain at k=8      argmax k    $/round(argmax)";
    console.log(head); console.log("-".repeat(head.length));
    const K8 = KS.indexOf(8);
    for (let c = 0; c < CANDS.length; c++) {
      const gains = table[c].map(x => x - table[c][0]);
      let bi = 0; for (let i = 1; i < gains.length; i++) if (gains[i] > gains[bi]) bi = i;
      const perRound = gains[bi] * BUDGET;
      const se8 = Math.hypot(seTable[c][K8], seTable[c][0]) * BUDGET;
      const seMax = Math.hypot(seTable[c][bi], seTable[c][0]) * BUDGET;
      console.log(`${CANDS[c].name.padEnd(32)} ` + table[c].map(x => pct(x, 2).padStart(11)).join("") +
        `  ${("$" + (gains[K8] * BUDGET).toFixed(2) + "+-" + se8.toFixed(2)).padStart(15)}  ${String(KS[bi]).padStart(8)}  ${("$" + perRound.toFixed(2) + "+-" + seMax.toFixed(2)).padStart(17)}`);
    }
    console.log(`
  TWO COLUMNS BECAUSE ONE OF THEM LIES. "$/round(argmax)" is a MAXIMUM OVER ${KS.length} NOISY CELLS, so it is
  biased upward and is positive even for a rule with no farm in it at all — read the SHIPPED row as
  the noise floor of that statistic and treat anything within it as zero. "gain at k=8" is fixed in
  advance, so its standard error means what it says. The v5 defect was $150.87/round on this design;
  the discrimination needed here is coarse, which is why a noisy argmax still separates the failures.
  Gas is $${(0.00041 * 150).toFixed(4)}/round post-reclaim per wallet; a farm worth less than k times that is not a farm.`);
  }
}

// ================================================================================================
// PART 4 — BAR 4: RETENTION, AND THE SIDE-SELECTION EDGE
// ================================================================================================

if (runPart(4)) {
  console.log(`
------------------------------------------------------------------------------------------------
PART 4a — BAR 4: RUIN. Higher variance at the same expectation means faster ruin.
------------------------------------------------------------------------------------------------
A focal fighter enters every round at a fixed band, 48 seats, background from the bands. Their
per-round multiplier R = payout / gross is collected over ${ROUNDS} rounds per candidate per band.

  sigma  sd(R) — the per-round ROI standard deviation the owner is asking to increase
  P(ruin) DIRECT BALANCE-PATH SIMULATION, and labelled as such: a player starts with $10, stakes
          their whole balance every round (capped at the $100 per-stake cap), and is ruined when the
          balance falls below the $0.01 minimum entry. Returns are drawn i.i.d. by BOOTSTRAP from
          the measured R pool for the band the balance currently sits in. The i.i.d.-across-rounds
          assumption is the model; the R distribution itself is measured, not assumed.`);

  const FOCAL = [
    { name: "whale $90", usd: 90, band: 0 },
    { name: "small $12", usd: 12, band: 3 },
    { name: "minnow $5", usd: 5, band: 4 },
  ];
  const R4 = Math.max(80, Math.round(ROUNDS / 2));
  const pools: number[][][] = CANDS.map(() => FOCAL.map(() => []));

  for (let r = 0; r < R4; r++) {
    for (let fi = 0; fi < FOCAL.length; fi++) {
      const rnd = mulberry32((r * 40503 + fi * 7919) >>> 0);
      const entries: Entry[] = [{ wallet: "focal", side: 0, grossUnits: usd(FOCAL[fi].usd), band: FOCAL[fi].band, house: true }];
      let id = 0;
      for (let i = 0; i < 47; i++) {
        const bd = BANDS[Math.floor(rnd() * BANDS.length)];
        entries.push({ wallet: `p${++id}`, side: ((i + 1) % 2) as 0 | 1, grossUnits: usd(bd.lo + rnd() * (bd.hi - bd.lo)), band: -1, house: false });
      }
      const l = finish(`${STUDY_SEED}|life|${fi}`, r, entries);
      for (let c = 0; c < CANDS.length; c++) {
        const o = play(l, CANDS[c], `part4a focal=${fi} r=${r}`);
        pools[c][fi].push(toUsd(payout(o.fighters[0])) / toUsd(l.entries[0].grossUnits));
      }
    }
  }

  const head = "candidate                        " + FOCAL.map(f => `${f.name} sigma  mean`.padStart(26)).join("") + "    P(ruin,200)";
  console.log(`\n${head}`); console.log("-".repeat(head.length));
  for (let c = 0; c < CANDS.length; c++) {
    // Balance path: bootstrap from the pool of whichever focal band the balance is nearest.
    const rnd = mulberry32(5150 + c);
    const bandFor = (bal: number) => bal >= 40 ? 0 : bal >= 8 ? 1 : 2;
    let ruined = 0;
    const PATHS = 20000;
    for (let p = 0; p < PATHS; p++) {
      let bal = 10;
      for (let t = 0; t < 200; t++) {
        const pool = pools[c][bandFor(bal)];
        bal = bal * pool[Math.floor(rnd() * pool.length)];
        if (bal < 0.01) { ruined++; break; }
      }
    }
    console.log(`${CANDS[c].name.padEnd(32)} ` +
      FOCAL.map((_, fi) => `${f2(sd(pools[c][fi]), 3)}  ${f2(mean(pools[c][fi]), 4)}`.padStart(26)).join("") +
      `    ${f2(100 * ruined / PATHS, 1).padStart(6)}%`);
  }
  console.log(`\n  mean R should be ${(1 - Number(FEE_BPS) / 10000).toFixed(4)} = 1 - fee for every candidate that is still a fair game.`);

  console.log(`
------------------------------------------------------------------------------------------------
PART 4b — THE SIDE-SELECTION TEST. It decides the comeback candidate.
------------------------------------------------------------------------------------------------
A rule that pays the trailing side pays whoever joins the lighter side, and side is a free choice at
entry. §11.3 removed an entry-order bias worth +-15% and it must not come back through this door.

Design: build a 46-fighter background with a DELIBERATE side imbalance, then seat one $20 focal
fighter on the LIGHTER side (variant A) or the HEAVIER side (variant B), paired on the same seed and
the same background. The reported number is ROI(lighter) - ROI(heavier) in percentage points. Zero
means side is not a choice worth making; anything materially positive is a new positional edge.`);

  const R4b = Math.max(120, ROUNDS);
  const lightAcc = CANDS.map(() => [] as { inn: number; out: number }[]);
  const heavyAcc = CANDS.map(() => [] as { inn: number; out: number }[]);
  for (let r = 0; r < R4b; r++) {
    const rnd = mulberry32((r * 22695477 + 991) >>> 0);
    // Side 0 deliberately heavier: it takes the top two bands, side 1 the bottom two.
    const bg: Entry[] = [];
    let id = 0, v0 = 0, v1 = 0;
    for (let i = 0; i < 46; i++) {
      const side = (i % 2) as 0 | 1;
      const bd = side === 0 ? BANDS[Math.floor(rnd() * 2)] : BANDS[3 + Math.floor(rnd() * 2)];
      const g = bd.lo + rnd() * (bd.hi - bd.lo);
      if (side === 0) v0 += g; else v1 += g;
      bg.push({ wallet: `p${++id}`, side, grossUnits: usd(g), band: -1, house: false });
    }
    const lighter: 0 | 1 = v0 < v1 ? 0 : 1;
    const heavier: 0 | 1 = lighter === 0 ? 1 : 0;
    for (const [which, side] of [["light", lighter], ["heavy", heavier]] as const) {
      const entries: Entry[] = [{ wallet: "focal", side, grossUnits: usd(20), band: -1, house: true }, ...bg];
      const l = finish(`${STUDY_SEED}|side`, r, entries);
      for (let c = 0; c < CANDS.length; c++) {
        const o = play(l, CANDS[c], `part4b ${which} r=${r}`);
        const rec = { inn: 20, out: toUsd(payout(o.fighters[0])) };
        (which === "light" ? lightAcc : heavyAcc)[c].push(rec);
      }
    }
  }
  const h2 = "candidate                            ROI on the LIGHT side   ROI on the HEAVY side      light - heavy";
  console.log(`\n${h2}`); console.log("-".repeat(h2.length));
  for (let c = 0; c < CANDS.length; c++) {
    const a = roiWithSE(lightAcc[c], 1000, 700 + c);
    const b = roiWithSE(heavyAcc[c], 1000, 900 + c);
    const d = a.roi - b.roi, se = Math.hypot(a.se, b.se);
    console.log(`${CANDS[c].name.padEnd(36)} ${`${pct(a.roi, 2)}+-${(a.se * 100).toFixed(2)}`.padStart(21)}   ${`${pct(b.roi, 2)}+-${(b.se * 100).toFixed(2)}`.padStart(21)}   ${`${pct(d, 2)}+-${(se * 100).toFixed(2)}`.padStart(17)}${Math.abs(d) > 3 * se ? "  <-- SIDE EDGE" : ""}`);
  }
}

// ================================================================================================
// THE DIE TABLE AND THE COMPUTE / REDEPLOY CLASSIFICATION
// ================================================================================================

if (PART === "all" || PART === "0") {
  console.log(`
------------------------------------------------------------------------------------------------
THE DICE, EXACTLY. Closed-form mean and sd of every roll spec used above.
------------------------------------------------------------------------------------------------
The deployed die is h[8] % 24 + 4 with modulo bias: mean ${f2(LEGACY_MEAN, 4)} (a uniform 4..27 would be 15.5),
sd ${f2(rollSd("legacy"), 4)}. A UNIFORM's mean is the midpoint of its support, so a mean-matched uniform cannot
reach past hi = 2 x ${f2(LEGACY_MEAN, 2)} = ${f2(2 * LEGACY_MEAN, 1)}. That is why 0..31 is the widest matched uniform there is,
and why widening further requires a SKEW.
`);
  const specs: [string, RollSpec][] = [
    ["legacy (deployed)", "legacy"],
    ["uniform 0..31", { kind: "uniform", lo: 0, hi: 31 }],
    ["uniform 1..40", { kind: "uniform", lo: 1, hi: 40 }],
    ["uniform 1..60", { kind: "uniform", lo: 1, hi: 60 }],
    ["uniform 1..100", { kind: "uniform", lo: 1, hi: 100 }],
    ["spike 1/16 @100", matchedSpike(16, 100)],
    ["spike 1/32 @100", matchedSpike(32, 100)],
    ["spike 1/64 @100", matchedSpike(64, 100)],
    ["uniform 1..200 (NEG)", { kind: "uniform", lo: 1, hi: 200 }],
  ];
  console.log("  spec                        support           mean     vs deployed    sd      x deployed   max roll");
  console.log("  " + "-".repeat(100));
  for (const [nm, s] of specs) {
    const sup = s === "legacy" ? "4..27" : s.kind === "uniform" ? `${s.lo}..${s.hi}` : `${s.lo}..${s.hi} + ${s.spike}@1/${s.pDen}`;
    const m = rollMean(s), d = rollSd(s);
    const mx = s === "legacy" ? 27 : s.kind === "uniform" ? s.hi : Math.max(s.hi, s.spike);
    console.log(`  ${nm.padEnd(26)} ${sup.padEnd(18)} ${f2(m, 3).padStart(6)}  ${f2(100 * (m / LEGACY_MEAN - 1), 1).padStart(9)}%   ${f2(d, 3).padStart(6)}  ${f2(d / rollSd("legacy")).padStart(9)}x   ${String(mx).padStart(6)}${mx > 100 ? "  CLAMP" : ""}`);
  }

  console.log(`
------------------------------------------------------------------------------------------------
COMPUTE AND REDEPLOY CLASSIFICATION
------------------------------------------------------------------------------------------------
Against the measured profile in programs/bulls-arena/src/lib.rs: ~3,000 CU fixed + ~214 CU/step
marginal, MAX_STEPS_PER_CALL = 3,000, a 1,400,000 CU ceiling, tick measured at 645,685 CU (46.1%).
The ceiling arrives at ~6,500 steps, so there is roughly 2.2x headroom on the step budget today.

  knob                O(1)/step?  extra hash bytes        step budget / bell    ships with a
                                                          -> PENALTY_HORIZON?   damage-basis change?
  ------------------  ----------  ----------------------  --------------------  --------------------
  roll spec           yes         h[20..28], both unused  unchanged             YES, same instruction
                                  by legacy and wide      (mean-matched rows)
  roll uniform 1..100 yes         same                    UNCHANGED in steps    YES
                                                          but 3.3x the pace
  spike               yes         h[20..24] + h[24..28]   unchanged             YES
  surge L             yes*        none; one EXTRA sha256  unchanged             YES
                                  per window (1/L per
                                  step, amortised)
  fewer/bigger m      yes         none                    DIVIDES the budget    YES, but it also
                                  (one multiply)          by m -> the bell in   changes
                                                          STEPS moves, so       STEPS_PER_FIGHTER_
                                                          PENALTY_HORIZON_STEPS PER_SECOND
                                                          must be refitted
  retain R            yes         none                    unchanged in steps;   YES, one line beside
                                  (one mul, one div,      fights run LONGER in  the basis itself
                                  one add)                exchanges - measured
  comeback k          yes**       none                    unchanged             YES

   * surge is O(1) per step but needs one sha256 per window boundary. At L = 16 that is 1/16 of a
     hash per step against a step that already costs one; call it +6% of the hash term, well inside
     the 2.2x headroom. It is also RESUMABLE: the window bit is a pure function of (seed, window
     index), so a fight advanced in MAX_STEPS_PER_CALL chunks is byte-identical to one advanced in
     a single call, which is the property catch_up depends on.
  ** comeback is O(1) per STEP and O(n) per CALL: the two side totals are summed once on entry to
     advance_fight and then moved by +-dmg. That is the same cost shape as a static stake weight,
     and n <= 48, so it is ~48 adds per call against a 3,000-step call.

  ALL of them are one instruction change to advance_fight. That means ONE new program id
  (~2.55 SOL = $382.50 at SOL $150), ONE PDA reset, ONE re-run of both TypeScript mirror parity
  tests — and they can be bundled with the small-stake damage-basis change being measured in
  parallel. The only one that drags a second constant with it is fewer/bigger m, which moves the
  step budget and therefore PENALTY_HORIZON_STEPS (fitted as round(25 * n^1.5) against fight length,
  see check-fight-length.ts).
`);
}

console.log(`\nconservation: ${consChecked.toLocaleString()} fight-rounds checked in integers, 0 failures.`);
console.log(`identity asserted: sum_i(hp_i + banked_i) == sum_i(stake_i), and traced side-0 value == a fresh O(n) sum.\n`);
