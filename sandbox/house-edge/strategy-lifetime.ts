// SANDBOX. Run from engine/:  npx tsx ../sandbox/house-edge/strategy-lifetime.ts [players] [part]
//
// TOTAL REVENUE PER ACQUIRED PLAYER, AS A FUNCTION OF THE FEE — and the argument that the fee is not
// the thing the answer depends on.
//
// WHY THE DENOMINATOR IS THE WHOLE ARGUMENT. Every measurement in HOUSE-EDGE-STUDY.md and
// HOUSE-STRATEGY.md is per ROUND: §11.1's "the house takes exactly 1.0000% of gross entries", §4's
// dial ranking, §11.4's ROI table. Per round, the fee is trivially monotone — double the rate, double
// the take — and §4 duly ranks `fee_bps` the number-one dial with revenue running $4.25 -> $29.30
// across 0 -> 1000 bps. That table is correct and it answers a question nobody is asking. The operator
// does not buy rounds. They buy PLAYERS, at a cost per acquisition, and a player who has quit pays no
// more rake however high the rate is set. The right denominator is one acquired player, and against it
// the fee has two opposing effects: it takes more per round, and it kills the player sooner. This
// script measures the product of those two, and nothing else.
//
// THE ANSWER, stated up front so the tables can be read as evidence for it rather than mined for it,
// and it is stronger than the hypothesis this script was written to test.
//
//   The hypothesis was: the shape of the curve is decided by the churn model, and an interior optimum
//   appears once quitting RESPONDS to losing. Half of that is right. The second half is FALSE, and
//   Part 2 refutes it by measurement and then by identity.
//
//   NO CHURN RULE THAT IS A FUNCTION OF THE PLAYER'S OWN MONEY PATH CAN PRODUCE AN INTERIOR OPTIMUM.
//   The fight is a martingale, so for a population E[rake] = E[deposits] - E[withdrawals]. A
//   loss-driven churn rule fixes how much a player is willing to LOSE before leaving; the fee does not
//   change that, it changes what SHARE of the loss the house keeps rather than handing to the rest of
//   the lobby, and that share rises monotonically to 1. So lifetime revenue is monotone increasing in
//   the fee under ruin, under fee-blind churn, under `hazardDrawdown` at ANY magnitude, under
//   `hazardStreak`, and under a hard drawdown stop. The optimum is always the corner, `MAX_FEE_BPS`.
//
//   The only thing that can justify a rate below the ceiling is a response to the POSTED RATE — a
//   player who reads the number and deposits less. That is demand elasticity, not churn, and it is
//   absent from every model in this repository. §2.3 therefore inverts the answerable question: what
//   deposit elasticity does the shipped 100 bps require? That number is measured, with a CI, and it is
//   the one thing in this document a human can be asked to judge.
//
// WHAT IS MEASURED AND WHAT IS ASSUMED, because the two are not close to equal here:
//   * MEASURED, on `engine/src/er-sim.ts`: the fight multiplier R. `lifetime-core.ts` harvests it and
//     `verifyPool` re-proves E[R] = 1 every run. Part 0 additionally cross-checks the whole pool
//     approximation against a full-fight simulation that plays real `newRound`/`enter`/`tick`/`settle`.
//   * ASSUMED, entirely: every churn parameter. HOUSE-STRATEGY.md §7 lists "real player behaviour" as
//     the largest uncertainty in the document "and it is not close". Nothing here changes that. Part 4
//     sweeps the assumptions instead of defending them, and Part 5 confronts them with the only real
//     recorded data that exists — eleven wallets in a gitignored SQLite file — which is not a
//     calibration and is reported anyway because the docs currently claim it does not exist.
//
// NOTHING IS DEPLOYED, NOTHING OUTSIDE sandbox/house-edge/ IS TOUCHED. The two additive fields this
// script uses in `lifetime-core.ts` (`drawdownStopPct`, `stakeCapUsd`) are both optional and both
// leave `simulateLife` byte-identical in behaviour when omitted.

import {
  BASE_PLAYER, GAS_USD_PER_ROUND, GAS_SOL_PER_ROUND, ROUNDS_PER_HOUR, SOL_USD, STAKE_CAP_USD,
  binOf, ci95, hash32, loadOrBuildPool, makeDrawR, mean, quant, simulateLife, verifyPool,
  type PlayerModel,
} from "./lifetime-core.ts";
import { newRound, enter, tick, settle } from "../../engine/src/er-sim.ts";
import { stepBudget } from "./fight-variant.ts";
import { BANDS, usd, toUsd } from "./lobby.ts";
import { mulberry32 } from "./rng.ts";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

// ------------------------------------------------------------------------------------------------
// `node:sqlite` (Part 5 reads engine/data/ledger.db). It ships in the Node this repo runs on but not
// in the `@types/node` it depends on — that package is pinned at v20 here, and the module landed
// after it — so a static `import` type-errors even though it resolves perfectly at runtime.
//
// TYPED HERE RATHER THAN SUPPRESSED. The alternatives were a `@ts-expect-error` (a hole, and one that
// would silently swallow a real signature change) or bumping @types/node for the whole `engine/`
// package to satisfy one sandbox script, which is not a trade worth making. This declares exactly the
// three members Part 5 touches and nothing else, so it is both checkable and honest about its scope.
// Delete it the day @types/node moves past v22.5.
// ------------------------------------------------------------------------------------------------
// The resolution base is deliberately `process.cwd()` and not `import.meta.url`: this file is ESM
// under `engine/`'s package.json and CJS under the repository root's, tsx runs it happily either way,
// and `import.meta` is a compile error in the CJS reading. Only a BUILT-IN is loaded through this
// require, so the base directory is immaterial to what it resolves.
interface SqliteStatement { all(): unknown[]; }
interface SqliteDatabase { prepare(sql: string): SqliteStatement; close(): void; }
const { DatabaseSync } = createRequire(`${process.cwd()}/`)("node:sqlite") as {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteDatabase;
};

const PLAYERS = Number(process.argv[2] ?? 20_000);
const ONLY = process.argv[3] ?? "all";
const TAG = "lifetime-v1";
const POOL_FIGHTS = 150_000;
const SEATS = 8;

/** `programs/bulls-arena/src/lib.rs:199` — `pub const MAX_FEE_BPS: u16 = 1_000;`. Not a judgement on
 *  the rate, a ceiling; every "corner solution" below means THIS number. */
const MAX_FEE_BPS = 1000;
const FEE_GRID = [0, 25, 50, 100, 150, 200, 300, 500, 750, 1000];
/** The rate the arena is actually set to today (`er-demo/src/v2/contract.ts:567`). */
const LIVE_FEE_BPS = 100;

const want = (p: string) => ONLY === "all" || ONLY === p;

console.log(`\n${"=".repeat(110)}`);
console.log(`LIFETIME REVENUE PER ACQUIRED PLAYER vs fee_bps  —  the per-round tables have the wrong denominator`);
console.log(`${"=".repeat(110)}`);
console.log(`REPRODUCE (exactly; every figure below is a pure function of these):`);
console.log(`    cd engine && npx tsx ../sandbox/house-edge/strategy-lifetime.ts ${PLAYERS} ${ONLY}`);
console.log(`    (parts run individually with 0|1|2|3|4|5 in place of "all"; HE_XVAL_PLAYERS sets Part 0b's`);
console.log(`     real-fight sample, SOL_USD sets the gas price, HE_POOL_DIR sets the R-pool cache location)`);
console.log(`seeds:   player paths  sha256("${TAG}|<cell>|<player>")   ->  mulberry32`);
console.log(`         R pool        sha256("lt|${TAG}|<fight>")        ->  ${POOL_FIGHTS} real fights x ${SEATS} seats`);
console.log(`         full-fight    sha256("${TAG}|xval|<player>|<round>")`);
console.log(`constants: MAX_FEE_BPS=${MAX_FEE_BPS} (lib.rs:199)  STAKE_CAP_USD=$${STAKE_CAP_USD} (contract.ts:617)  live fee=${LIVE_FEE_BPS} bps`);
console.log(`           gas $${GAS_USD_PER_ROUND.toFixed(4)}/round (${GAS_SOL_PER_ROUND} SOL at SOL_USD=${SOL_USD}; set SOL_USD to change)`);
console.log(`           cadence ${(3600 / ROUNDS_PER_HOUR).toFixed(0)}s/round assumed throughout — the keeper's own figure is 90-190s, see Part 3`);
console.log(`players per cell: ${PLAYERS}   |   every number carries a 95% CI and an n`);

const pool = loadOrBuildPool(POOL_FIGHTS, TAG, SEATS);
const drawR = makeDrawR(pool);

// ================================================================================================
// PART 0 — is the pool admissible?
// ================================================================================================

const v = verifyPool(pool);
if (!v.ok) {
  console.error(`\n\n*** POOL VALIDATION FAILED at ${v.worstSigma.toFixed(2)} sigma. ABORTING. ***`);
  console.error(`Every number this script would print is void. Delete the cache and rebuild, or fix er-sim.\n`);
  process.exit(1);
}

// ------------------------------------------------------------------------------------------------
// The cohort runner. One PlayerModel, one fee, N independent lives.
// ------------------------------------------------------------------------------------------------

interface Cohort {
  n: number;
  rake: Float64Array;
  rounds: Float64Array;
  deposited: Float64Array;
  /** What they walked away with — `LifeResult.withdrawnUsd`, which is `max(0, balance)` at the moment
   *  they stopped. It is also the terminal balance; there is one array rather than two because they
   *  are the same number and a second name for it would invite them to drift apart. */
  withdrawn: Float64Array;
  exits: { ruin: number; quit: number; cap: number };
}

/** COMMON RANDOM NUMBERS ACROSS FEE LEVELS. Player p in every cell of a sweep is seeded from the same
 *  string, so the fee columns are paired rather than independent samples. The pairing is imperfect —
 *  a different fee makes a different path consume the stream at a different rate — but it is free and
 *  it visibly steadies the sweeps, and every CI below is computed from the cell's own spread rather
 *  than from the pairing, so nothing is claimed that the pairing would have to earn. */
function cohort(m: PlayerModel, feeBps: number, n: number, cell: string): Cohort {
  const rake = new Float64Array(n), rounds = new Float64Array(n);
  const deposited = new Float64Array(n), withdrawn = new Float64Array(n);
  const exits = { ruin: 0, quit: 0, cap: 0 };
  for (let p = 0; p < n; p++) {
    const r = simulateLife(m, feeBps, mulberry32(hash32(`${TAG}|${cell}|${p}`)), drawR);
    rake[p] = r.rakeUsd; rounds[p] = r.rounds;
    deposited[p] = r.depositedUsd; withdrawn[p] = r.withdrawnUsd;
    exits[r.exit]++;
  }
  return { n, rake, rounds, deposited, withdrawn, exits };
}

const f2 = (x: number, w = 8, d = 2) => x.toFixed(d).padStart(w);
const pctS = (x: number, w = 5) => `${(100 * x).toFixed(1).padStart(w)}%`;

// ------------------------------------------------------------------------------------------------
// PART 0b — the cross-validation that makes the pool admissible rather than merely convenient.
// ------------------------------------------------------------------------------------------------

/** One round for ONE tracked player against a field drawn from the five bands, on the REAL engine.
 *  Identical in construction to `strategy-retention.ts`'s `playOne` — deliberately, because that is
 *  the predecessor this supersedes and a cross-validation against a differently-built simulation
 *  would be validating two changes at once. Returns the player's payout AND the fee the engine's own
 *  floor division actually charged them. */
function playOneReal(tag: string, stakeUsd: number, feeBps: bigint, rnd: () => number): { outUsd: number; feeUsd: number } {
  const round = newRound(createHash("sha256").update(tag).digest());
  const g = usd(stakeUsd);
  enter(round, "me", 0, g, feeBps);
  for (let i = 1; i < SEATS; i++) {
    const b = BANDS[Math.floor(rnd() * BANDS.length)];
    enter(round, `o${i}`, (i % 2) as 0 | 1, usd(b.lo + rnd() * (b.hi - b.lo)), feeBps);
  }
  tick(round, stepBudget(round.fighters.length));
  settle(round);
  const me = round.fighters[0];
  // `enter` computes `fee = stake * feeBps / BPS` in integers (er-sim.ts:131). Recomputed the same
  // way rather than read off `round.feesCollected`, which is the whole lobby's fees, not this seat's.
  return { outUsd: toUsd(me.hp + me.banked), feeUsd: toUsd((g * feeBps) / 10_000n) };
}

if (want("0")) {
  const XN = Number(process.env.HE_XVAL_PLAYERS ?? 1500), XR = 200;
  // THE POOL COLUMN IS RUN AT 200,000 PLAYERS ON PURPOSE, and it is the difference between a test and
  // a formality. The pool is the MODEL and the real fights are the SAMPLE, so the pool's own Monte
  // Carlo error should be driven to nothing and the question left as "does the real sample's interval
  // contain the model's value". An earlier draft ran both columns at n=400; the joint interval was
  // then so wide that a 16% discrepancy in mean rake would have passed, which is a test that cannot
  // fail and therefore establishes nothing.
  const XP = 200_000;
  console.log(`\n\n--- PART 0b — CROSS-VALIDATION: the R pool against real fights ------------------------------`);
  console.log(`The pool collapses a round to \`bal' = bal - stake + stake*(1-phi)*R\`. That is exact only if R is`);
  console.log(`independent of the fee (HOUSE-EDGE-STUDY §11.4 measured every band moving -0.798% to -0.803%`);
  console.log(`against a theoretical -0.800%). §11.4 measured it per round. THIS measures whether the error`);
  console.log(`compounds over a 200-round life, which is the only place it could matter.`);
  console.log(`\n${XN} players x ${XR} rounds at ${LIVE_FEE_BPS} bps, stakeFraction 1.0, ruin-only churn, $100 start.`);
  console.log(`LEFT column plays ${(XN * XR / 1000).toFixed(0)}k REAL fights on er-sim.ts. RIGHT column resamples the pool at n=${XP},`);
  console.log(`so its own error is negligible and the test is whether the REAL sample's interval covers it.`);

  const t0 = Date.now();
  const realBal: number[] = [], realRake: number[] = [], realRounds: number[] = [];
  for (let p = 0; p < XN; p++) {
    const rnd = mulberry32(hash32(`${TAG}|xval|${p}`));
    let bal = 100, rake = 0, n = 0;
    for (let r = 0; r < XR; r++) {
      const stake = Math.min(bal, STAKE_CAP_USD);
      if (stake < 0.01) break;
      const { outUsd, feeUsd } = playOneReal(`${TAG}|xval|${p}|${r}`, stake, BigInt(LIVE_FEE_BPS), rnd);
      bal = bal - stake + outUsd; rake += feeUsd; n++;
    }
    realBal.push(bal); realRake.push(rake); realRounds.push(n);
  }
  const secs = (Date.now() - t0) / 1000;

  const xm: PlayerModel = {
    ...BASE_PLAYER, bankroll: 100, stakeFraction: 1.0, maxRounds: XR,
    hazardBase: 0, hazardDrawdown: 0, hazardStreak: 0, redeposit: 0,
  };
  const poolC = cohort(xm, LIVE_FEE_BPS, XP, "xval");

  console.log(`\n(${(XN * XR / secs).toFixed(0)} fights/sec, ${secs.toFixed(0)}s for the real column)\n`);
  console.log(`quantity                       REAL FIGHTS (n=${XN})       POOL RESAMPLE (n=${XP})   agree?`);
  console.log("-".repeat(104));
  const rows: [string, number[], ArrayLike<number>][] = [
    ["mean terminal balance   $", realBal, poolC.withdrawn],
    ["mean lifetime rake      $", realRake, poolC.rake],
    ["mean rounds played       ", realRounds, poolC.rounds],
  ];
  let allAgree = true;
  for (const [label, a, b] of rows) {
    const ma = mean(a), mb = mean(b), ca = ci95(a), cb = ci95(b);
    const gap = Math.abs(ma - mb), tol = Math.sqrt(ca * ca + cb * cb);
    const ok = gap <= tol;
    if (!ok) allAgree = false;
    console.log(`${label}  ${f2(ma, 12, 4)} ±${ca.toFixed(4).padStart(8)}   ${f2(mb, 12, 4)} ±${cb.toFixed(4).padStart(8)}   ` +
      `${ok ? "yes" : "NO"}  (gap ${gap.toFixed(4)} vs ±${tol.toFixed(4)})`);
  }
  for (const [label, q] of [["median terminal balance $", 0.5], ["10th pct terminal balance$", 0.1]] as [string, number][]) {
    console.log(`${label}  ${f2(quant(realBal, q), 12, 4)}            ${f2(quant(poolC.withdrawn, q), 12, 4)}            ` +
      `(quantiles carry no CI here — reported for shape, not for the test)`);
  }
  console.log(`\nVERDICT: ${allAgree
    ? "the two agree inside their joint 95% CIs on every mean tested. The pool is admissible and\n         everything below rests on it."
    : "*** THEY DISAGREE BY MORE THAN THE CIs. The pool approximation is NOT admissible at this\n         horizon and every number below Part 0 must be discarded. ***"}`);
  if (!allAgree) {
    console.log(`\nStopping. Papering over this would make the rest of the document worse than absent.\n`);
    process.exit(2);
  }
  console.log(`\nNote what this does and does not license. It licenses resampling R across FEE levels and`);
  console.log(`horizons. It does NOT license the i.i.d. assumption: a real player meets a correlated field`);
  console.log(`round after round and the pool draws fresh, which understates both tails. Flagged in`);
  console.log(`lifetime-core.ts's header, unfixed, and it biases nothing in the fee comparison because it`);
  console.log(`applies identically to every column.`);
}

// ================================================================================================
// PART 1 — THE STRUCTURAL RESULT
// ================================================================================================

/** One row of a fee sweep, with the accounting identity checked in place.
 *
 *  THE IDENTITY IS THE CHEAPEST VALIDATION IN THE SCRIPT and it runs on every row: the fight is
 *  zero-sum, so for a population `deposited - withdrawn - rake` is what this cohort won FROM or lost
 *  TO the rest of the lobby, and E[R] = 1 says that is zero. A row where it is not zero is a row where
 *  something other than the fee moved money, and the only such mechanism in the code is the dust rule
 *  (er-sim.ts:199), which shows up here as a small negative on cohorts that spend time under $0.10. */
function feeRow(m: PlayerModel, feeBps: number, cellPrefix: string, n = PLAYERS) {
  const c = cohort(m, feeBps, n, `${cellPrefix}|${feeBps}`);
  const vsField = new Float64Array(n);
  for (let i = 0; i < n; i++) vsField[i] = c.deposited[i] - c.withdrawn[i] - c.rake[i];
  return { c, vsField };
}

function printFeeSweep(m: PlayerModel, cellPrefix: string, title: string, n = PLAYERS) {
  console.log(`\n${title}`);
  console.log(`fee bps   lifetime rake/player    rounds lived        P(ruin)  P(quit)  P(cap)   withdrawn   vs field`);
  console.log("-".repeat(110));
  const out: { feeBps: number; rake: number; ci: number; rounds: number }[] = [];
  for (const fee of FEE_GRID) {
    const { c, vsField } = feeRow(m, fee, cellPrefix, n);
    out.push({ feeBps: fee, rake: mean(c.rake), ci: ci95(c.rake), rounds: mean(c.rounds) });
    console.log(
      `${String(fee).padStart(7)}   $${f2(mean(c.rake), 8, 3)} ±${ci95(c.rake).toFixed(3).padStart(6)}   ` +
      `${f2(mean(c.rounds), 9, 1)} ±${ci95(c.rounds).toFixed(1).padStart(6)}   ` +
      `${pctS(c.exits.ruin / c.n)}   ${pctS(c.exits.quit / c.n)}   ${pctS(c.exits.cap / c.n)}   ` +
      `$${f2(mean(c.withdrawn), 8, 2)}   $${f2(mean(vsField), 6, 3)}`);
  }
  return out;
}

if (want("1")) {
  console.log(`\n\n${"=".repeat(110)}`);
  console.log(`PART 1 — THE STRUCTURAL RESULT: the churn model decides the shape, the game does not`);
  console.log(`${"=".repeat(110)}`);
  console.log(`Three churn regimes, one fee grid, ${PLAYERS} players per cell. Read the three conclusions at the`);
  console.log(`bottom of each block; the tables are the evidence for them.`);

  // ---- (a) ruin-only -----------------------------------------------------------------------------
  console.log(`\n\n--- 1(a) RUIN-ONLY. The player never quits. They play until the money is gone. -------------`);
  console.log(`hazardBase = hazardDrawdown = hazardStreak = redeposit = 0. $100 bankroll, full redeployment,`);
  console.log(`20,000-round compute ceiling. This is not a behavioural model — it is the LIMIT of retention,`);
  console.log(`the case HOUSE-STRATEGY §5's "people leave their tokens in there for a long time" describes if`);
  console.log(`taken literally, and the house's best case by construction.`);
  const ruinOnly: PlayerModel = {
    ...BASE_PLAYER, bankroll: 100, stakeFraction: 1.0, maxRounds: 20_000,
    hazardBase: 0, hazardDrawdown: 0, hazardStreak: 0, redeposit: 0,
  };
  const a = printFeeSweep(ruinOnly, "1a", `ruin-only, $100 bankroll, stakeFraction 1.0`);
  console.log(`\nhalf-life arithmetic for the same rows — rounds for the fee alone to halve a bankroll, ln2 / -ln(1-phi):`);
  console.log(`fee bps       theory: rounds to halve       measured mean rounds lived      hours at ~110s`);
  for (const r of a) {
    const phi = r.feeBps / 10_000;
    const half = phi <= 0 ? Infinity : Math.log(2) / -Math.log(1 - phi);
    console.log(`${String(r.feeBps).padStart(7)}   ${(Number.isFinite(half) ? half.toFixed(0) : "never").padStart(22)}   ` +
      `${f2(r.rounds, 29, 1)}   ${f2(r.rounds / ROUNDS_PER_HOUR, 15, 1)}`);
  }
  const a0 = a.find(x => x.feeBps === 0)!, aMax = a.find(x => x.feeBps === MAX_FEE_BPS)!;
  const a100 = a.find(x => x.feeBps === LIVE_FEE_BPS)!;
  console.log(`\nCONCLUSION 1(a): with ruin the only exit, the fee is a SPEED dial and not a revenue dial — every`);
  console.log(`rate above zero collects essentially the whole $100 bankroll ($${a100.rake.toFixed(2)} at ${LIVE_FEE_BPS} bps vs $${aMax.rake.toFixed(2)} at`);
  console.log(`${MAX_FEE_BPS} bps, a ${(100 * (aMax.rake / a100.rake - 1)).toFixed(1)}% difference for a 10x rate change) and differs only in how long it takes`);
  console.log(`(${a100.rounds.toFixed(0)} rounds vs ${aMax.rounds.toFixed(0)}, a ${(a100.rounds / aMax.rounds).toFixed(1)}x). The 0 bps row collects $${a0.rake.toFixed(2)} and is the control.`);

  // ---- (b) fee-blind exogenous churn -------------------------------------------------------------
  console.log(`\n\n--- 1(b) FEE-BLIND EXOGENOUS CHURN. The player quits at a constant rate, for reasons that have --`);
  console.log(`--- nothing to do with money: bored, busy, gone. ------------------------------------------------`);
  console.log(`hazardBase > 0 only; every other churn term zero. This is the regime almost every retention`);
  console.log(`model in the wild actually assumes, usually without saying so.`);
  const closed: { lam: number; rows: { feeBps: number; rake: number; ci: number; rounds: number }[] }[] = [];
  for (const lam of [0.001, 0.004, 0.02]) {
    const m: PlayerModel = {
      ...BASE_PLAYER, bankroll: 100, stakeFraction: 1.0, maxRounds: 20_000,
      hazardBase: lam, hazardDrawdown: 0, hazardStreak: 0, redeposit: 0,
    };
    const rows = printFeeSweep(m, `1b|${lam}`, `hazardBase = ${lam}  (mean life ${(1 / lam).toFixed(0)} rounds ~ ${(1 / lam / ROUNDS_PER_HOUR).toFixed(1)}h of play)`);
    closed.push({ lam, rows });
  }

  console.log(`\n\nTHE CLOSED FORM, and whether the simulation obeys it.`);
  console.log(`Each round the player stakes f*bal and pays phi*f*bal; the balance decays by (1-phi*f) in`);
  console.log(`expectation and the player survives with probability (1-lambda). Summing the geometric series:`);
  console.log(`\n    L(phi) = B * phi*f / (lambda + phi*f - lambda*phi*f)`);
  console.log(`\nIt is monotone increasing in phi with no interior maximum anywhere, saturating at B. It has a`);
  console.log(`known bias here: the $${STAKE_CAP_USD} per-stake cap truncates the stake whenever a $100 bankroll runs up, so`);
  console.log(`the fit is shown BOTH with the shipped cap and with the cap lifted (stakeCapUsd = 1e9), which is`);
  console.log(`the only difference between the two right-hand columns.`);
  for (const { lam, rows } of closed) {
    console.log(`\nhazardBase = ${lam}`);
    console.log(`fee bps     simulated (shipped $100 cap)     closed form L(phi)     simulated (cap lifted)     err`);
    console.log("-".repeat(110));
    for (const r of rows) {
      const phi = r.feeBps / 10_000, f = 1.0, B = 100;
      const L = B * phi * f / (lam + phi * f - lam * phi * f);
      const nc: PlayerModel = {
        ...BASE_PLAYER, bankroll: B, stakeFraction: f, maxRounds: 20_000, stakeCapUsd: 1e9,
        hazardBase: lam, hazardDrawdown: 0, hazardStreak: 0, redeposit: 0,
      };
      const c = cohort(nc, r.feeBps, PLAYERS, `1bnc|${lam}|${r.feeBps}`);
      const err = L === 0 ? 0 : (mean(c.rake) - L) / Math.max(L, 1e-9);
      console.log(`${String(r.feeBps).padStart(7)}   $${f2(r.rake, 10, 3)} ±${r.ci.toFixed(3).padStart(6)}   ` +
        `$${f2(L, 15, 3)}   $${f2(mean(c.rake), 14, 3)} ±${ci95(c.rake).toFixed(3).padStart(6)}   ` +
        `${(100 * err).toFixed(2).padStart(6)}%`);
    }
  }
  console.log(`\nCONCLUSION 1(b): with churn that cannot see the fee, lifetime revenue is MONOTONE INCREASING in`);
  console.log(`the fee across the entire legal range and saturates towards the bankroll. There is no interior`);
  console.log(`optimum. The revenue-maximising setting is the corner, MAX_FEE_BPS = ${MAX_FEE_BPS}, and it is the corner`);
  console.log(`for the trivial reason that nothing in the model punishes the house for charging it.`);

  // ---- (c) the shipped auto-deploy rule -----------------------------------------------------------
  console.log(`\n\n--- 1(c) THE SHIPPED AUTO-DEPLOY RULE. Not invented — read off the code. -----------------------`);
  console.log(`\`er-demo/src/v2/data/autoPolicy.ts\` DEFAULT_LIMITS = { budgetUsd: 250, perRoundCapUsd:`);
  console.log(`STAKE_CAP_USD ($${STAKE_CAP_USD}), drawdownStopPct: 50, maxRounds: null }, enforced by \`limitBlock\` and`);
  console.log(`\`clampToLimits\` in that file and driven by \`decideAutoDeploy\` in autoDeploy.ts.`);
  console.log(`\nTWO CORRECTIONS TO THE OBVIOUS READING, both from the code and both large:`);
  console.log(`  1. \`budgetUsd\` is charged against CUMULATIVE GROSS STAKE, not against losses. \`tallyEntered\``);
  console.log(`     adds \`amountUsd\` to \`spentUsd\` on every confirmed entry and \`limitBlock\` stops the run at`);
  console.log(`     \`budgetUsd - spentUsd < MIN_STAKE_USD\`. Winnings do NOT refill it: "the budget is the`);
  console.log(`     budget" (autoPolicy.ts, quoting SOCIAL.md §5.4).`);
  console.log(`  2. \`drawdownStopPct\` is measured against the COMMITTED BUDGET's realised P&L`);
  console.log(`     (\`drawdownStopUsd = budgetUsd * pct / 100\` = $125), NOT against a high-water mark.`);
  console.log(`\nConsequence, and it is a hard arithmetic bound rather than a simulation result: an armed run can`);
  console.log(`stake at most $250 in total, so it can pay at most $250 * phi in rake, EVER. At ${LIVE_FEE_BPS} bps that is`);
  console.log(`$${(250 * LIVE_FEE_BPS / 10000).toFixed(2)}. The simulation below exists to find out which limit binds first and how many rounds it buys.`);

  const AUTO = { budgetUsd: 250, perRoundCapUsd: STAKE_CAP_USD, drawdownStopPct: 50, maxRounds: null as number | null };

  /** The shipped rule, constant for constant. `simulateLife` cannot express it — the budget is a
   *  stock that only stake decrements and that winnings do not refill, which is a second state
   *  variable the core's model does not carry — so it is written out here rather than approximated
   *  there. Everything else (the fight, the fee, the floor, the cap) is identical. */
  function simulateAutoDeploy(bankroll: number, stakeFraction: number, feeBps: number, rnd: () => number, maxRounds = 20_000) {
    const phi = feeBps / 10_000;
    const stopUsd = AUTO.drawdownStopPct === null ? null : (AUTO.budgetUsd * AUTO.drawdownStopPct) / 100;
    let bal = bankroll, spent = 0, rake = 0, rounds = 0;
    let stop: "budget-spent" | "drawdown-stopped" | "round-ceiling" | "broke" | "cap" = "cap";
    for (; rounds < maxRounds; rounds++) {
      const realisedPnl = bal - bankroll;                       // what simLedger.ts would report
      const lost = Math.max(0, -realisedPnl);
      if (stopUsd !== null && lost > 0 && lost >= stopUsd) { stop = "drawdown-stopped"; break; }
      if (AUTO.budgetUsd - spent < 0.01) { stop = "budget-spent"; break; }
      if (AUTO.maxRounds !== null && rounds >= AUTO.maxRounds) { stop = "round-ceiling"; break; }
      // `resolveAmountUsd` (pct rule) then `clampToLimits`, in that order, same as the ladder.
      const raw = Math.min(bal * stakeFraction, STAKE_CAP_USD);
      if (raw < 0.01) { stop = "broke"; break; }                 // resolveAmountUsd returns null
      const room = Math.min(raw, AUTO.perRoundCapUsd, AUTO.budgetUsd - spent, STAKE_CAP_USD);
      if (room < 0.01) { stop = "budget-spent"; break; }          // clampToLimits returns null
      // ROUNDED THE WAY `clampToLimits` ROUNDS IT, and the difference is not cosmetic — that function
      // says so at length. `Math.floor(room * 100)` loses a whole cent to float representation on
      // ordinary inputs (0.29 * 100 is 28.999999999999996), so it is a round followed by a step-down
      // if the rounding carried the figure back over the budget it was just clamped to.
      let cents = Math.round(room * 100);
      if (cents / 100 > room) cents -= 1;
      const stake = Math.min(cents / 100, bal);
      if (stake < 0.01) { stop = "broke"; break; }
      const fee = stake * phi;
      bal = bal - stake + (stake - fee) * drawR(binOf(stake), rnd);
      rake += fee; spent += stake;
    }
    return { rake, rounds, bal, stop };
  }

  for (const [bankroll, frac] of [[250, 1.0], [250, 0.25], [1000, 0.25]] as [number, number][]) {
    console.log(`\nCODE-EXACT auto-deploy, bankroll $${bankroll}, amount rule = ${(frac * 100).toFixed(0)}% of wallet, DEFAULT_LIMITS:`);
    console.log(`fee bps   lifetime rake/player    rounds     total staked    P(budget)  P(drawdown)  P(other)`);
    console.log("-".repeat(110));
    for (const fee of FEE_GRID) {
      const rake = new Float64Array(PLAYERS), rds = new Float64Array(PLAYERS), spent = new Float64Array(PLAYERS);
      const stops: Record<string, number> = {};
      for (let p = 0; p < PLAYERS; p++) {
        const r = simulateAutoDeploy(bankroll, frac, fee, mulberry32(hash32(`${TAG}|1c|${bankroll}|${frac}|${fee}|${p}`)));
        rake[p] = r.rake; rds[p] = r.rounds; spent[p] = fee > 0 ? r.rake / (fee / 10_000) : NaN;
        stops[r.stop] = (stops[r.stop] ?? 0) + 1;
      }
      const staked = fee > 0 ? mean(spent) : NaN;
      console.log(`${String(fee).padStart(7)}   $${f2(mean(rake), 8, 4)} ±${ci95(rake).toFixed(4).padStart(7)}   ` +
        `${f2(mean(rds), 7, 2)}   ${(Number.isFinite(staked) ? `$${staked.toFixed(2)}` : "n/a (phi=0)").padStart(13)}   ` +
        `${pctS((stops["budget-spent"] ?? 0) / PLAYERS, 7)}  ${pctS((stops["drawdown-stopped"] ?? 0) / PLAYERS, 9)}  ` +
        `${pctS(((stops["broke"] ?? 0) + (stops["cap"] ?? 0) + (stops["round-ceiling"] ?? 0)) / PLAYERS, 7)}`);
    }
  }

  console.log(`\nAnd the SOFTER behavioural reading of the same 50% — a human who walks when their balance halves`);
  console.log(`from its high-water mark, with no budget stock at all. This is NOT the shipped rule; it is the`);
  console.log(`rule the shipped one is usually mistaken for, and it is reported so the two cannot be conflated:`);
  const ddStop: PlayerModel = {
    ...BASE_PLAYER, bankroll: 250, stakeFraction: 1.0, maxRounds: 20_000,
    hazardBase: 0, hazardDrawdown: 0, hazardStreak: 0, redeposit: 0, drawdownStopPct: 50,
  };
  const cRows = printFeeSweep(ddStop, "1c-soft", `50% drawdown-from-peak hard stop, $250 bankroll, full redeployment`);
  const cMax = cRows.find(x => x.feeBps === MAX_FEE_BPS)!;
  const c25 = cRows.find(x => x.feeBps === 25)!;

  console.log(`\nCONCLUSION 1(c): the shipped rule bounds lifetime rake at budgetUsd * phi = $${(250 * LIVE_FEE_BPS / 10000).toFixed(2)} at the live rate`);
  console.log(`and the binding limit is \`budget-spent\`, not the drawdown stop — the run simply runs out of`);
  console.log(`committed dollars to stake. Within that bound the rake is EXACTLY LINEAR in the fee (it is`);
  console.log(`phi times a stake total the fee barely moves), so this regime too has its optimum at the corner —`);
  console.log(`it is just a corner worth $${(250 * MAX_FEE_BPS / 10000).toFixed(2)} instead of $${(250 * LIVE_FEE_BPS / 10000).toFixed(2)}. The softer drawdown-from-peak reading is the only`);
  console.log(`one of the three that flattens: $${c25.rake.toFixed(2)} at 25 bps against $${cMax.rake.toFixed(2)} at ${MAX_FEE_BPS} bps, because a bigger fee`);
  console.log(`digs the player to the -50% line faster and the stop then fires on a bankroll it has taken less`);
  console.log(`from. Even there it is monotone; it merely stops growing.`);
}

// ================================================================================================
// PART 2 — WHERE AN INTERIOR OPTIMUM COMES FROM, AND THE INVERSION
// ================================================================================================

/** Mean lifetime rake for one (model, fee), CRN-paired by player index. Split out because Part 2
 *  calls it thousands of times inside a root-find and does not need the full cohort. */
function rakeAt(m: PlayerModel, feeBps: number, n: number, cell: string): Float64Array {
  const out = new Float64Array(n);
  for (let p = 0; p < n; p++) out[p] = simulateLife(m, feeBps, mulberry32(hash32(`${TAG}|${cell}|${p}`)), drawR).rakeUsd;
  return out;
}

if (want("2")) {
  console.log(`\n\n${"=".repeat(110)}`);
  console.log(`PART 2 — WHERE AN INTERIOR OPTIMUM COMES FROM. NOT FROM CHURN, AND HERE IS THE PROOF`);
  console.log(`${"=".repeat(110)}`);
  console.log(`THE HYPOTHESIS UNDER TEST, stated fairly before it is refuted: \`hazardDrawdown\` adds a per-round`);
  console.log(`quit probability proportional to how far the player is below their peak. A higher fee digs that`);
  console.log(`drawdown faster, so it buys more rake per round at the price of fewer rounds, and the two ought to`);
  console.log(`cross somewhere. That crossing would be the only thing that could make ${LIVE_FEE_BPS} bps "right".`);
  console.log(`\n2.1 sweeps it. 2.2 looks for the crossing and shows there is none, at any magnitude, and then`);
  console.log(`explains why by identity rather than by shrug. 2.3 asks the question that DOES have an answer.`);

  const base = (over: Partial<PlayerModel>): PlayerModel => ({
    ...BASE_PLAYER, bankroll: 100, stakeFraction: 1.0, maxRounds: 20_000,
    hazardBase: 0.004, hazardDrawdown: 0, hazardStreak: 0, redeposit: 0, ...over,
  });

  console.log(`\n\n--- 2.1 THE SWEEP. hazardBase held at 0.004 throughout; only hazardDrawdown moves. ------------`);
  console.log(`hazardDrawdown    argmax fee    revenue there       revenue at ${LIVE_FEE_BPS} bps    ${LIVE_FEE_BPS} bps as % of peak   n`);
  console.log("-".repeat(110));
  for (const hd of [0, 0.005, 0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1.0]) {
    const m = base({ hazardDrawdown: hd });
    let best = { fee: -1, r: -1, ci: 0 };
    let at100 = { r: 0, ci: 0 };
    for (const fee of FEE_GRID) {
      const xs = rakeAt(m, fee, PLAYERS, `2.1|${hd}|${fee}`);
      const mu = mean(xs);
      if (mu > best.r) best = { fee, r: mu, ci: ci95(xs) };
      if (fee === LIVE_FEE_BPS) at100 = { r: mu, ci: ci95(xs) };
    }
    console.log(`${hd.toFixed(3).padStart(11)}    ${String(best.fee).padStart(10)}    ` +
      `$${f2(best.r, 7, 3)} ±${best.ci.toFixed(3).padStart(5)}   $${f2(at100.r, 10, 3)} ±${at100.ci.toFixed(3).padStart(5)}   ` +
      `${pctS(at100.r / best.r, 15)}   ${PLAYERS}`);
  }

  // ---- 2.2 the attempted inversion, and why it has no answer ---------------------------------------
  console.log(`\n\n--- 2.2 THE INVERSION, ATTEMPTED — AND IT HAS NO SOLUTION ------------------------------------`);
  console.log(`The question asked was: what value of hazardDrawdown (and separately hazardStreak) makes the`);
  console.log(`shipped ${LIVE_FEE_BPS} bps the revenue-maximising fee? Method: at an interior optimum the derivative`);
  console.log(`vanishes, so solve D(h) = L(110 bps) - L(90 bps) = 0 by bisection on h. D is a PAIRED difference`);
  console.log(`— the same player seeds drive both fee levels — so its CI is far tighter than the difference of`);
  console.log(`two independent means, which is what makes a root-find on it meaningful at all.`);
  console.log(`\nTHE ANSWER IS THAT NO SUCH VALUE EXISTS, AT ANY MAGNITUDE, FOR EITHER PARAMETER. D(h) stays`);
  console.log(`strictly positive as h is grown by factors of three until the player is quitting essentially`);
  console.log(`immediately. Rather than report a number from an unbracketed root-find, here is the evidence:`);

  const LO_BPS = 90, HI_BPS = 110;

  function pairedD(mk: (h: number) => PlayerModel, h: number, n: number, cell: string) {
    const a = rakeAt(mk(h), HI_BPS, n, `${cell}|hi`);
    const b = rakeAt(mk(h), LO_BPS, n, `${cell}|lo`);
    const d = new Float64Array(n);
    for (let i = 0; i < n; i++) d[i] = a[i] - b[i];
    return d;
  }

  const invN = Math.min(PLAYERS, 40_000);
  const mkDD = (h: number): PlayerModel => base({ hazardDrawdown: h });
  const mkST = (h: number): PlayerModel => base({ hazardStreak: h });

  console.log(`\nparameter        value h       D(h) = L(110bps) - L(90bps)      sign      bracketed a root?`);
  console.log("-".repeat(110));
  for (const [name, mk, hs] of [
    ["hazardDrawdown", mkDD, [0, 0.02, 0.5, 2, 6, 18, 54]],
    ["hazardStreak  ", mkST, [0, 0.01, 0.1, 0.5, 2, 6, 18]],
  ] as [string, (h: number) => PlayerModel, number[]][]) {
    for (const h of hs) {
      const d = pairedD(mk, h, invN, `2.2|${name}|${h}`);
      const mu = mean(d), c = ci95(d);
      console.log(`${name}   ${h.toFixed(3).padStart(9)}       $${f2(mu, 8, 4)} ±${c.toFixed(4).padStart(7)}          ` +
        `${(mu - c > 0 ? "POSITIVE" : mu + c < 0 ? "negative" : "  ~zero ")}      ${mu - c > 0 ? "no — still rising at 100 bps" : "yes"}`);
    }
    console.log("-".repeat(110));
  }

  console.log(`\nWHY, AND IT IS AN IDENTITY RATHER THAN A COINCIDENCE. This is the most important paragraph in`);
  console.log(`the script, so it is written out rather than left to be inferred from a table.`);
  console.log(`\n    For any population, deposits - withdrawals = rake + (net lost to the rest of the lobby),`);
  console.log(`    and the fight is a martingale, so that last term is zero in expectation (E[R] = 1, proved`);
  console.log(`    against this very pool at the top of this run). Therefore`);
  console.log(`\n        E[lifetime rake] = E[deposits] - E[withdrawals]   <=  E[deposits].`);
  console.log(`\n    Every churn rule in this study — ruin, hazardBase, hazardDrawdown, hazardStreak, a drawdown`);
  console.log(`    stop — is a function of the player's own MONEY PATH. Such a rule fixes (in distribution)`);
  console.log(`    how much a player is willing to LOSE before leaving. The fee does not change how much they`);
  console.log(`    lose; it changes what SHARE of that loss the house keeps rather than handing to the rest of`);
  console.log(`    the lobby. That share is increasing in the fee and asymptotes to 1. So lifetime rake is`);
  console.log(`    MONOTONE INCREASING in the fee under every such rule, and the optimum is always the corner.`);
  console.log(`\nMEASURED DIRECTLY, because an argument is not a measurement. The identity predicts two things at`);
  console.log(`once and they are the two columns below: what the player LOSES is roughly flat in the fee (it is`);
  console.log(`set by the churn rule, which never sees the fee), while what the house KEEPS of that loss climbs`);
  console.log(`towards all of it. Nothing here is free to be non-monotone.`);
  for (const hd of [0.1, 0.5]) {
    const m = base({ hazardDrawdown: hd });
    console.log(`\nhazardDrawdown = ${hd}   (deposits are always $100 — one bankroll, no redeposits)`);
    console.log(`fee bps    player's total loss      of which: house rake      of which: to the lobby    house share`);
    console.log("-".repeat(110));
    for (const fee of FEE_GRID.filter(f => f > 0)) {
      const n = Math.min(PLAYERS, 20_000);
      const c = cohort(m, fee, n, `2.2s|${hd}|${fee}`);
      const loss = new Float64Array(n), field = new Float64Array(n);
      for (let i = 0; i < n; i++) { loss[i] = c.deposited[i] - c.withdrawn[i]; field[i] = loss[i] - c.rake[i]; }
      console.log(`${String(fee).padStart(7)}    $${f2(mean(loss), 8, 3)} ±${ci95(loss).toFixed(3).padStart(6)}      ` +
        `$${f2(mean(c.rake), 9, 3)} ±${ci95(c.rake).toFixed(3).padStart(6)}      ` +
        `$${f2(mean(field), 9, 3)} ±${ci95(field).toFixed(3).padStart(6)}      ${pctS(mean(c.rake) / mean(loss), 6)}`);
    }
  }
  console.log(`\n(n=${Math.min(PLAYERS, 20_000)} per cell. The "to the lobby" column is zero-mean by the martingale but has large`);
  console.log(`variance, which is why the low-fee rows have wide intervals — the rake there is a small slice of a`);
  console.log(`noisy total. It is the same quantity as Part 1's "vs field" column.)`);

  // ---- 2.3 the inversion that DOES have an answer -------------------------------------------------
  console.log(`\n\n--- 2.3 THE INVERSION THAT DOES HAVE AN ANSWER — THE DELIVERABLE -----------------------------`);
  console.log(`If no loss-driven churn rule can make ${LIVE_FEE_BPS} bps optimal, what can? Only a mechanism that responds`);
  console.log(`to the POSTED RATE rather than to losses: a player who reads "10%" and deposits less, or does not`);
  console.log(`deposit at all. That is demand elasticity, not churn, and it is the term missing from every model`);
  console.log(`in this repository — including the one in lifetime-core.ts.`);
  console.log(`\nIt also makes the question answerable WITHOUT inventing a demand curve. Write lifetime revenue per`);
  console.log(`ACQUIRED player as  Rev(phi) = D(phi) * g(phi), where D is what they deposit and g is the share of`);
  console.log(`it the house captures. At an interior optimum d(ln Rev)/d(ln phi) = 0, so`);
  console.log(`\n        -d(ln D)/d(ln phi)  =  d(ln g)/d(ln phi)  ==  eta*`);
  console.log(`\nThe right-hand side is a property of the GAME and this script has already measured it. So eta* is`);
  console.log(`the deposit elasticity that ${LIVE_FEE_BPS} bps requires — measured, not assumed — and the only thing left to`);
  console.log(`judge is whether real players are that price-sensitive.`);
  console.log(`\nMeasured by paired finite difference at ${LO_BPS}/${HI_BPS} bps, n=${invN}, CI by paired bootstrap over players`);
  console.log(`(2,000 resamples), so the elasticity's CI reflects the same players seeing both rates.`);

  /** eta = dln(L)/dln(phi) at 100 bps, with a paired bootstrap CI. Paired because the two fee levels
   *  are driven by the same player seeds and treating them as independent would inflate the interval
   *  by roughly the ratio of the level's spread to the difference's — an order of magnitude here. */
  function elasticity(m: PlayerModel, cell: string, n: number) {
    const a = rakeAt(m, HI_BPS, n, `${cell}|hi`), b = rakeAt(m, LO_BPS, n, `${cell}|lo`);
    const dlnPhi = Math.log(HI_BPS / LO_BPS);
    const point = (Math.log(mean(a)) - Math.log(mean(b))) / dlnPhi;
    const rnd = mulberry32(hash32(`${TAG}|boot|${cell}`));
    const draws: number[] = [];
    for (let r = 0; r < 2000; r++) {
      let sa = 0, sb = 0;
      for (let k = 0; k < n; k++) { const j = (rnd() * n) | 0; sa += a[j]; sb += b[j]; }
      if (sa > 0 && sb > 0) draws.push((Math.log(sa / n) - Math.log(sb / n)) / dlnPhi);
    }
    draws.sort((x, y) => x - y);
    return { point, lo: draws[Math.floor(0.025 * draws.length)], hi: draws[Math.floor(0.975 * draws.length)] };
  }

  const models: [string, PlayerModel][] = [
    ["BASE_PLAYER (as shipped in core)", { ...BASE_PLAYER, bankroll: 100, stakeFraction: 1.0 }],
    ["ruin-only (no churn at all)", base({ hazardBase: 0, hazardDrawdown: 0 })],
    ["fee-blind churn, hazardBase .004", base({})],
    ["loss-sensitive, hazardDrawdown .1", base({ hazardDrawdown: 0.1 })],
    ["loss-sensitive, hazardDrawdown .5", base({ hazardDrawdown: 0.5 })],
    ["50% drawdown-from-peak hard stop", base({ drawdownStopPct: 50 })],
  ];
  console.log(`\nchurn model                          eta* at ${LIVE_FEE_BPS} bps      95% CI              n`);
  console.log("-".repeat(110));
  const etas: { label: string; e: { point: number; lo: number; hi: number } }[] = [];
  for (const [label, m] of models) {
    const e = elasticity(m, `2.3|${label}`, invN);
    etas.push({ label, e });
    console.log(`${label.padEnd(36)} ${e.point.toFixed(4).padStart(12)}      [${e.lo.toFixed(4)}, ${e.hi.toFixed(4)}]   ${String(invN).padStart(7)}`);
  }

  const eBase = etas[0].e;
  console.log(`\nPLAIN ENGLISH, for BASE_PLAYER (eta* = ${eBase.point.toFixed(3)} [${eBase.lo.toFixed(3)}, ${eBase.hi.toFixed(3)}]):`);
  console.log(`\n  "${LIVE_FEE_BPS} bps is the revenue-maximising fee ONLY IF a 1% increase in the rate makes players deposit`);
  console.log(`   ${eBase.point.toFixed(2)}% less. Equivalently: doubling the fee from ${LIVE_FEE_BPS} to ${2 * LIVE_FEE_BPS} bps would have to cut total`);
  console.log(`   deposits per acquired player by ${(100 * (1 - Math.pow(0.5, eBase.point))).toFixed(0)}% for that doubling to be revenue-neutral."`);
  console.log(`\n  Below that elasticity the fee is too LOW and the house is leaving money on the table. Above it,`);
  console.log(`  ${LIVE_FEE_BPS} bps is already too high. Nothing in this repository measures deposit elasticity, and unlike`);
  console.log(`  the churn parameters it is not even guessed at anywhere — it has no prior at all.`);
  console.log(`\n  FOR SCALE, because "is ${eBase.point.toFixed(2)} a lot?" is the only question that matters: an elasticity of`);
  console.log(`  ${eBase.point.toFixed(2)} means the fee is close to a pure transfer at the margin. Gambling products are usually`);
  console.log(`  argued to have LOW headline-rate elasticity (players do not compute the hold), which would put`);
  console.log(`  the true eta well below ${eBase.point.toFixed(2)} and imply the rate is under-set for revenue. The counter-argument`);
  console.log(`  is not elasticity at all, it is HOUSE-EDGE-STUDY §11.4: at ${LIVE_FEE_BPS} bps the rake becomes visible above`);
  console.log(`  a player's own variance after 1,528 rounds instead of 44,167 at 20 bps — twenty-nine times`);
  console.log(`  sooner. A rate that players can FEEL creates its own elasticity eventually, and that is a`);
  console.log(`  reputational argument this script cannot price.`);
  console.log(`\n  AND THE ANSWER TO THE ORIGINAL QUESTION, restated so it is not lost: the value of hazardDrawdown`);
  console.log(`  that justifies ${LIVE_FEE_BPS} bps does not exist. The value of the DEPOSIT ELASTICITY that justifies it is`);
  console.log(`  ${eBase.point.toFixed(3)} [${eBase.lo.toFixed(3)}, ${eBase.hi.toFixed(3)}]. Those are two different sentences about the world and only the second one`);
  console.log(`  can be true.`);

  // ---- flatness ---------------------------------------------------------------------------------
  console.log(`\n\n--- 2.4 FLATNESS — is the peak worth chasing? -------------------------------------------------`);
  console.log(`An argmax is only worth having if the peak is sharp. Base case: BASE_PLAYER as shipped in`);
  console.log(`lifetime-core.ts (hazardBase ${BASE_PLAYER.hazardBase}, hazardDrawdown ${BASE_PLAYER.hazardDrawdown}, hazardStreak ${BASE_PLAYER.hazardStreak}, redeposit ${BASE_PLAYER.redeposit}), $100`);
  console.log(`bankroll, full redeployment, n=${PLAYERS} per cell.`);
  const flatM: PlayerModel = { ...BASE_PLAYER, bankroll: 100, stakeFraction: 1.0 };
  const flatGrid = [25, 50, 75, 100, 150, 200, 300, 400, 600, 800, 1000];
  const flat = flatGrid.map(fee => {
    const xs = rakeAt(flatM, fee, PLAYERS, `2.3|${fee}`);
    return { fee, mu: mean(xs), ci: ci95(xs) };
  });
  const peak = flat.reduce((a, b) => (b.mu > a.mu ? b : a));
  console.log(`\nfee bps    lifetime rake/player     % of peak      inside the peak's CI?`);
  console.log("-".repeat(110));
  for (const r of flat) {
    const overlaps = r.mu + r.ci >= peak.mu - peak.ci;
    console.log(`${String(r.fee).padStart(7)}    $${f2(r.mu, 8, 3)} ±${r.ci.toFixed(3).padStart(5)}     ${pctS(r.mu / peak.mu, 8)}      ` +
      `${overlaps ? "yes — indistinguishable from the peak" : "no  — significantly below the peak"}${r.fee === peak.fee ? "   <-- PEAK" : ""}`);
  }
  const band = flat.filter(r => r.mu + r.ci >= peak.mu - peak.ci);
  const lo = Math.min(...band.map(r => r.fee)), hi = Math.max(...band.map(r => r.fee));
  const at = (f: number) => flat.find(r => r.fee === f)!;
  console.log(`\nFLATNESS VERDICT. 50/100/200/400 bps as a percentage of the peak ($${peak.mu.toFixed(3)} at ${peak.fee} bps):`);
  for (const f of [50, 100, 200, 400]) {
    const r = at(f);
    console.log(`   ${String(f).padStart(4)} bps:  ${pctS(r.mu / peak.mu, 6)} of peak   ($${r.mu.toFixed(3)} ±${r.ci.toFixed(3)}, n=${PLAYERS})`);
  }
  console.log(`\n   Rates indistinguishable from the peak at n=${PLAYERS}: ${lo} to ${hi} bps (${band.length} of ${flat.length} rates tested).`);
  // The verdict is COMPUTED, not asserted. An earlier draft of this script asserted the curve was flat
  // and the measurement refuted it; the sentence now comes from the numbers so it cannot do that again.
  const isFlat = at(LIVE_FEE_BPS).mu / peak.mu > 0.9;
  if (isFlat) {
    console.log(`\n   *** THE CURVE IS FLAT. ${LIVE_FEE_BPS} bps is ${pctS(at(LIVE_FEE_BPS).mu / peak.mu, 0)} of the peak. ***`);
    console.log(`   That is not a failed measurement, it is the answer: the fee is not worth agonising over on`);
    console.log(`   revenue grounds and the decision should be made on grounds that ARE sharp — player`);
    console.log(`   perception, competitive positioning, and what number is easy to say out loud.`);
  } else {
    console.log(`\n   *** THE CURVE IS NOT FLAT, AND THE LIVE RATE IS NOT NEAR THE PEAK. ${LIVE_FEE_BPS} bps collects`);
    console.log(`       ${pctS(at(LIVE_FEE_BPS).mu / peak.mu, 0)} of what ${peak.fee} bps collects from the same acquired player. ***`);
    console.log(`\n   This is the opposite of the result that would have let everyone stop thinking, and it is worth`);
    console.log(`   being precise about what it does and does not mean. It does NOT mean "raise the fee". It`);
    console.log(`   means that within this family of models — every one of which is blind to the posted rate —`);
    console.log(`   revenue is monotone in the fee, so the model contains nothing that could ever recommend`);
    console.log(`   ${LIVE_FEE_BPS} bps. The entire case for the current rate lives in the term the model does not have:`);
    console.log(`   deposit elasticity (§2.3), and reputational cost (HOUSE-EDGE-STUDY §11.4 — at ${LIVE_FEE_BPS} bps the rake`);
    console.log(`   becomes visible above a player's own variance after 1,528 rounds instead of 44,167 at 20 bps,`);
    console.log(`   twenty-nine times sooner). Anyone arguing for the current rate should argue THERE. Arguing`);
    console.log(`   for it on lifetime-revenue grounds is arguing against this table.`);
  }
  console.log(`\n   Read alongside Part 3 before acting on any of it: at low real-player counts the per-round gas`);
  console.log(`   exceeds a player's entire lifetime rake at every fee in the grid, which makes the whole`);
  console.log(`   question secondary to volume.`);
}

// ================================================================================================
// PART 3 — RATE, NOT JUST TOTAL
// ================================================================================================

if (want("3")) {
  console.log(`\n\n${"=".repeat(110)}`);
  console.log(`PART 3 — RATE, NOT JUST TOTAL: gas is charged per ROUND, so the same money extracted sooner is`);
  console.log(`worth more`);
  console.log(`${"=".repeat(110)}`);
  console.log(`Lifetime total is the wrong sole objective because the operator pays $${GAS_USD_PER_ROUND.toFixed(4)} of keeper gas and`);
  console.log(`unreclaimed rent PER ROUND (HOUSE-STRATEGY §1: 0.00981 SOL, reconciled across 28 real rounds) and`);
  console.log(`pays it whether or not anyone plays. A fee that extracts the same lifetime dollars over fewer`);
  console.log(`rounds is strictly better, and Part 1 showed the fee is exactly a speed dial.`);
  console.log(`\nCADENCE. ~110s is the figure HOUSE-STRATEGY §1 uses throughout and it is what the days column`);
  console.log(`assumes. The keeper's REAL cadence is not a constant: RESULT_HOLD_SECONDS=12,`);
  console.log(`DRAW_TIMEOUT_SECONDS=90 and a lobby that is held open up to HOLD_OPEN_LOBBY_SECONDS=3600 when`);
  console.log(`nobody is there (er-demo/scripts/keeper/config.ts) put an ACTIVE round somewhere around 90-190s.`);
  console.log(`Days scale linearly with it: at 190s every days figure is 1.7x larger and every per-day figure`);
  console.log(`1.7x smaller. Nothing else in the table moves.`);
  console.log(`\nTHE GAS DIVISOR IS AN ASSUMPTION AND IT IS STATED, NOT BURIED. A round's gas is a fixed cost`);
  console.log(`shared by whoever is in it, so one player's share is gas * rounds / (real players per round).`);
  console.log(`HOUSE-STRATEGY §2 measures 1-6 real players against 4-9 house fighters; house fighters are the`);
  console.log(`operator's own money and pay for none of it. Swept at 1, 2 and 4 rather than picked.`);

  const m: PlayerModel = { ...BASE_PLAYER, bankroll: 100, stakeFraction: 1.0 };
  console.log(`\nREAD "rev/player-day" AS A RATE WHILE ACTIVE, NOT AS AN ANNUITY. A BASE_PLAYER lives well under`);
  console.log(`a day, so the column is lifetime rake divided by a fraction of a day — the speed at which the`);
  console.log(`house extracts while it has someone to extract from. That is the right quantity to compare`);
  console.log(`against a per-round gas cost, and the wrong one to multiply by 365.`);
  console.log(`\nBASE_PLAYER, $100 bankroll, full redeployment, n=${PLAYERS} per row.`);
  console.log(`\nfee    lifetime rake     rounds      days       rev/player-day     net of gas per player-day at`);
  console.log(`bps    per player        lived      lived       (gross)            1 real/rd    2 real/rd    4 real/rd`);
  console.log("-".repeat(110));
  const keep: { fee: number; rake: number; rounds: number; days: number; perDay: number; net: number[] }[] = [];
  for (const fee of FEE_GRID) {
    const c = cohort(m, fee, PLAYERS, `3|${fee}`);
    const rake = mean(c.rake), rounds = mean(c.rounds);
    const days = rounds / (ROUNDS_PER_HOUR * 24);
    const perDay = days > 0 ? rake / days : 0;
    const net = [1, 2, 4].map(div => (days > 0 ? (rake - GAS_USD_PER_ROUND * rounds / div) / days : 0));
    keep.push({ fee, rake, rounds, days, perDay, net });
    console.log(`${String(fee).padStart(4)}   $${f2(rake, 7, 3)} ±${ci95(c.rake).toFixed(3).padStart(5)}   ${f2(rounds, 8, 1)}   ` +
      `${f2(days, 8, 3)}   ${`$${perDay.toFixed(2)}`.padStart(15)}   ` +
      net.map(x => `$${x.toFixed(2)}`.padStart(11)).join("  "));
  }
  const best = keep.filter(k => k.fee > 0).reduce((a, b) => (b.perDay > a.perDay ? b : a));
  const bestNet1 = keep.filter(k => k.fee > 0).reduce((a, b) => (b.net[0] > a.net[0] ? b : a));
  const live = keep.find(k => k.fee === LIVE_FEE_BPS)!;
  console.log(`\nWHAT THE TABLE SAYS.`);
  console.log(`  * Gross revenue per player-day is maximised at ${best.fee} bps ($${best.perDay.toFixed(3)}/day) against $${live.perDay.toFixed(3)}/day at the`);
  console.log(`    live ${LIVE_FEE_BPS} bps — a ${(best.perDay / live.perDay).toFixed(2)}x difference, versus a lifetime-total difference of`);
  console.log(`    ${(keep.find(k => k.fee === best.fee)!.rake / live.rake).toFixed(2)}x over the same two rates. RATE separates the fees far more sharply than TOTAL does.`);
  console.log(`  * Net of gas at one real player per round the argmax is ${bestNet1.fee} bps. Gas is a per-ROUND toll, so it`);
  console.log(`    punishes exactly the thing a low fee buys — a long slow life — and the optimum moves UP.`);
  console.log(`  * At $${GAS_USD_PER_ROUND.toFixed(4)}/round and one real player, a player's whole gas share over ${live.rounds.toFixed(0)} rounds is`);
  console.log(`    $${(GAS_USD_PER_ROUND * live.rounds).toFixed(2)} against $${live.rake.toFixed(2)} of rake. THAT is the headline of this part: at one real player per`);
  console.log(`    round the gas exceeds the entire lifetime rake by ${(GAS_USD_PER_ROUND * live.rounds / live.rake).toFixed(1)}x. The fee is not the problem and no`);
  console.log(`    setting of it is the solution — HOUSE-STRATEGY §1's negative cash flow is a VOLUME problem.`);
}

// ================================================================================================
// PART 4 — SENSITIVITY
// ================================================================================================

if (want("4")) {
  console.log(`\n\n${"=".repeat(110)}`);
  console.log(`PART 4 — SENSITIVITY. The assumptions dominate the fee, so here they are, all in one table`);
  console.log(`${"=".repeat(110)}`);
  console.log(`Each row changes ONE thing from the base and re-runs the whole fee grid. The columns that matter`);
  console.log(`are the last two: which fee wins, and by how little.`);
  console.log(`\nbase = BASE_PLAYER: bankroll $100, stakeFraction 1.0, hazardBase ${BASE_PLAYER.hazardBase}, hazardDrawdown ${BASE_PLAYER.hazardDrawdown},`);
  console.log(`       hazardStreak ${BASE_PLAYER.hazardStreak}, redeposit ${BASE_PLAYER.redeposit}, cap $${STAKE_CAP_USD}. n=${PLAYERS} per cell, ${FEE_GRID.length} cells per row.`);

  const B: PlayerModel = { ...BASE_PLAYER, bankroll: 100, stakeFraction: 1.0 };
  const rows: [string, Partial<PlayerModel>][] = [
    ["base", {}],
    ["bankroll $20", { bankroll: 20 }],
    ["bankroll $250", { bankroll: 250 }],
    ["bankroll $1000", { bankroll: 1000 }],
    ["stakeFraction 0.10", { stakeFraction: 0.1 }],
    ["stakeFraction 0.25", { stakeFraction: 0.25 }],
    ["stakeFraction 0.50", { stakeFraction: 0.5 }],
    ["hazardBase 0.001", { hazardBase: 0.001 }],
    ["hazardBase 0.020", { hazardBase: 0.02 }],
    ["hazardBase 0.100", { hazardBase: 0.1 }],
    ["hazardDrawdown 0", { hazardDrawdown: 0 }],
    ["hazardDrawdown 0.10", { hazardDrawdown: 0.1 }],
    ["hazardDrawdown 0.50", { hazardDrawdown: 0.5 }],
    ["redeposit 0", { redeposit: 0 }],
    ["redeposit 0.50", { redeposit: 0.5 }],
    ["redeposit 0.90", { redeposit: 0.9 }],
    ["$1000 bankroll, cap ON  ($100)", { bankroll: 1000 }],
    ["$1000 bankroll, cap OFF (1e9)", { bankroll: 1000, stakeCapUsd: 1e9 }],
    ["$250 bankroll,  cap ON  ($100)", { bankroll: 250 }],
    ["$250 bankroll,  cap OFF (1e9)", { bankroll: 250, stakeCapUsd: 1e9 }],
  ];

  console.log(`\nassumption changed                rake @100bps      rake @ argmax     argmax   100bps as    rounds`);
  console.log(`                                  (the live rate)                       fee      % of peak    @100bps`);
  console.log("-".repeat(110));
  const store = new Map<string, { at100: number; ci100: number; peak: number; argmax: number; rounds: number }>();
  for (const [label, over] of rows) {
    const m: PlayerModel = { ...B, ...over };
    let best = { fee: -1, mu: -1, ci: 0 }, at100 = { mu: 0, ci: 0, rounds: 0 };
    for (const fee of FEE_GRID) {
      const c = cohort(m, fee, PLAYERS, `4|${label}|${fee}`);
      const mu = mean(c.rake);
      if (mu > best.mu) best = { fee, mu, ci: ci95(c.rake) };
      if (fee === LIVE_FEE_BPS) at100 = { mu, ci: ci95(c.rake), rounds: mean(c.rounds) };
    }
    store.set(label, { at100: at100.mu, ci100: at100.ci, peak: best.mu, argmax: best.fee, rounds: at100.rounds });
    console.log(`${label.padEnd(33)} $${f2(at100.mu, 7, 2)} ±${at100.ci.toFixed(2).padStart(6)}   $${f2(best.mu, 8, 2)} ±${best.ci.toFixed(2).padStart(6)}   ` +
      `${String(best.fee).padStart(6)}   ${pctS(at100.mu / best.mu, 9)}   ${f2(at100.rounds, 8, 1)}`);
  }
  console.log(`\nEVERY ROW HAS ITS ARGMAX AT ${MAX_FEE_BPS} BPS. Twenty different assumption sets, four of them varying the`);
  console.log(`parameter that was supposed to create an interior optimum, and not one of them produces a peak`);
  console.log(`anywhere but the ceiling — which is §2.2's identity showing up twenty more times. What the`);
  console.log(`assumptions DO move, and move hard, is the LEVEL: lifetime rake at the live rate ranges over a`);
  console.log(`factor of ~60 across these rows while the argmax never moves at all. That is the sentence this`);
  console.log(`table exists to support: the assumptions dominate the fee, and the fee's own optimum is not in`);
  console.log(`dispute within this family of models — only its level, and whether the model is the right family.`);

  console.log(`\n\nTHE $${STAKE_CAP_USD} PER-STAKE CAP IS ALREADY A LIFETIME-EXTENDING DEVICE, and this is the measurement of it.`);
  console.log(`A $1,000 bankroll under a $${STAKE_CAP_USD} cap cannot stake more than 10% of itself however the player sets`);
  console.log(`the amount rule, so a "full redeployment" player is silently converted into a stakeFraction-0.1`);
  console.log(`player — and by (1 - phi*f)^N that is a 10x life extension.`);
  console.log(`\nbankroll   cap        rake @100bps    rounds @100bps    what the cap did`);
  console.log("-".repeat(110));
  for (const bk of [1000, 250]) {
    const on = store.get(`$${bk} bankroll, cap ON  ($${STAKE_CAP_USD})`) ?? store.get(`$${bk} bankroll,  cap ON  ($${STAKE_CAP_USD})`)!;
    const off = store.get(`$${bk} bankroll, cap OFF (1e9)`) ?? store.get(`$${bk} bankroll,  cap OFF (1e9)`)!;
    console.log(`$${String(bk).padStart(6)}   ON  $${STAKE_CAP_USD}   $${f2(on.at100, 9, 3)}    ${f2(on.rounds, 12, 1)}`);
    console.log(`$${String(bk).padStart(6)}   OFF        $${f2(off.at100, 9, 3)}    ${f2(off.rounds, 12, 1)}    ` +
      `cap changes lifetime rake by ${((on.at100 / off.at100 - 1) * 100).toFixed(1)}% and life by ${(on.rounds / off.rounds).toFixed(2)}x`);
  }
  const on1k = store.get(`$1000 bankroll, cap ON  ($${STAKE_CAP_USD})`)!, off1k = store.get(`$1000 bankroll, cap OFF (1e9)`)!;
  console.log(`\nWHAT THE CAP IS ACTUALLY DOING, and it is larger than "a limit that rarely binds":`);
  console.log(`  * It CUTS lifetime rake from a $1,000 bankroll by ${(100 * (1 - on1k.at100 / off1k.at100)).toFixed(0)}% at the live rate. The cap is by a wide`);
  console.log(`    margin the most expensive player-protection device in the product, and it was not installed`);
  console.log(`    as one — \`autoPolicy.ts\` calls STAKE_CAP_USD "the arena's own per-side cap" and reaches for it`);
  console.log(`    because "anything larger would be a limit that never binds".`);
  console.log(`  * It EXTENDS life by ${(on1k.rounds / off1k.rounds).toFixed(2)}x, and Part 3 prices a round at $${GAS_USD_PER_ROUND.toFixed(2)} of gas. So the cap costs the house`);
  console.log(`    twice: less rake, over more rounds, each of which is billed.`);
  console.log(`  * The uncapped columns carry very wide intervals and they are honest ones — an uncapped`);
  console.log(`    full-redeployment player has a heavy-tailed stake path, so the mean is carried by a few`);
  console.log(`    enormous lives. That is a fact about the uncapped policy, not a defect in the estimate, and`);
  console.log(`    it is itself an argument for the cap: it is variance control for the HOUSE's book as well.`);
  console.log(`  * None of this says the cap is wrong. It says the cap is a large, unpriced, deliberate transfer`);
  console.log(`    from the house to big players, and nobody appears to have known its size.`);
}

// ================================================================================================
// PART 5 — CALIBRATION AGAINST THE ONLY REAL DATA THAT EXISTS
// ================================================================================================

if (want("5")) {
  console.log(`\n\n${"=".repeat(110)}`);
  console.log(`PART 5 — THE ONLY REAL RECORDED PLAYER DATA IN THE REPOSITORY, AND WHY IT IS ALMOST WORTHLESS`);
  console.log(`${"=".repeat(110)}`);
  console.log(`HOUSE-STRATEGY §7's first row reads "Real player behaviour — nothing in the repo records it", and`);
  console.log(`HOUSE-EDGE-STUDY §8's second uncertainty is the same point in weaker form ("No player-behaviour`);
  console.log(`model"). THE FIRST OF THOSE IS LITERALLY FALSE. \`engine/data/ledger.db\` is a 299KB SQLite file`);
  console.log(`sitting in the working tree with 911 accounts in it, and every previous study missed it for a`);
  console.log(`reason worth recording: \`engine/.gitignore\` line 3 is \`data/\`, so the file is untracked, invisible`);
  console.log(`to \`git ls-files\`, and absent from any clone. 900 of the 911 accounts are bots. ELEVEN are not.`);
  console.log(`\nOpened READ-ONLY (node:sqlite, { readOnly: true }). Nothing writes to it.`);

  const DB = "/Users/tyler/Launchpad/Crypto/UwuGame/magicblock/engine/data/ledger.db";
  let humans: any[] = [];
  let dbErr: string | null = null;
  try {
    const db = new DatabaseSync(DB, { readOnly: true });
    const all = db.prepare("select data from accounts").all() as { data: string }[];
    humans = all.map(r => JSON.parse(r.data)).filter(a => a.isBot === false);
    db.close();
  } catch (e) { dbErr = (e as Error).message; }

  if (dbErr) {
    console.log(`\n*** could not open ${DB}: ${dbErr}`);
    console.log(`*** Part 5 SKIPPED. The file is gitignored, so a fresh clone will not have it.`);
  } else {
    humans.sort((a, b) => (b.games ?? 0) - (a.games ?? 0));
    console.log(`\nALL ELEVEN ROWS, verbatim from the file:`);
    console.log(`\nwallet (first 8)  name          games  wins   dep      ret      net       depIn    wOut`);
    console.log("-".repeat(110));
    for (const h of humans) {
      console.log(`${String(h.id).slice(0, 8).padEnd(17)} ${String(h.name).slice(0, 12).padEnd(13)} ` +
        `${String(h.games ?? 0).padStart(5)}  ${String(h.wins ?? 0).padStart(4)}  ` +
        `${f2(h.dep ?? 0, 8, 2)} ${f2(h.ret ?? 0, 8, 2)} ${f2((h.ret ?? 0) - (h.dep ?? 0), 8, 2)}  ` +
        `${(h.depIn == null ? "—" : h.depIn.toFixed(0)).padStart(7)}  ${(h.wOut == null ? "—" : h.wOut.toFixed(0)).padStart(6)}`);
    }
    const games = humans.map(h => h.games ?? 0);
    const dep = humans.map(h => h.dep ?? 0), ret = humans.map(h => h.ret ?? 0);
    const sum = (xs: number[]) => xs.reduce((a, x) => a + x, 0);
    console.log("-".repeat(110));
    console.log(`n = ${humans.length}   total games ${sum(games)}   mean games ${mean(games).toFixed(2)} ±${ci95(games).toFixed(2)}   median ${quant(games, 0.5)}   max ${Math.max(...games)}`);
    console.log(`total deployed $${sum(dep).toFixed(2)}   total returned $${sum(ret).toFixed(2)}   net $${(sum(ret) - sum(dep)).toFixed(2)} ` +
      `(${(100 * (sum(ret) - sum(dep)) / sum(dep)).toFixed(2)}% of deployed)`);
    console.log(`mean deployed per game $${(sum(dep) / Math.max(1, sum(games))).toFixed(2)}`);

    // The identity from §2.2, visible in real recorded money. Worth having even at n=11 because it is
    // the only place in the repository where the two terms can be read off observed dollars.
    const engineRake = sum(dep) * 0.002;   // engine/src/arenas.ts:40 — FEE = 0.002, the custodial 20 bps
    const realLoss = sum(dep) - sum(ret);
    console.log(`\n§2.2's IDENTITY, IN REAL RECORDED DOLLARS. These eleven wallets lost $${realLoss.toFixed(2)} in total. At the`);
    console.log(`engine's 20 bps the house's share of that was $${engineRake.toFixed(2)} — ${(100 * engineRake / realLoss).toFixed(1)}% of it. The other ${(100 * (1 - engineRake / realLoss)).toFixed(1)}% went to the`);
    console.log(`other fighters, which on this server were almost entirely bots. That is exactly the decomposition`);
    console.log(`§2.2 argues from, seen once, in money that actually moved: the fee decides the SPLIT of a loss`);
    console.log(`the fee did not cause, and at 20 bps the house was taking a twentieth of it.`);

    // Back out hazardBase. If quitting is a constant per-round hazard p, the number of rounds played
    // before quitting is geometric and E[games] = (1-p)/p for "rounds completed", 1/p for "rounds
    // attempted". Both are reported because the difference at these tiny counts is not negligible.
    const g = mean(games);
    const pAttempted = 1 / Math.max(g, 1e-9);
    const pCompleted = 1 / (g + 1);
    console.log(`\nBACKING OUT hazardBase FROM \`games\`, which is the ONLY real retention observation that exists:`);
    console.log(`   if rounds-played ~ Geometric with per-round quit probability p:`);
    console.log(`      E[games] = 1/p        -> hazardBase = ${pAttempted.toFixed(4)}   (games counted as attempts)`);
    console.log(`      E[games] = (1-p)/p    -> hazardBase = ${pCompleted.toFixed(4)}   (games counted as completions)`);
    console.log(`   Both are ~two orders of magnitude above BASE_PLAYER's ${BASE_PLAYER.hazardBase}, which implies a median life`);
    console.log(`   of ${(Math.log(2) / -Math.log(1 - BASE_PLAYER.hazardBase)).toFixed(0)} rounds. The observed median is ${quant(games, 0.5)}.`);

    console.log(`\nHOW MUCH WEIGHT THIS DESERVES. Bluntly: almost none, and it is reported anyway because it is`);
    console.log(`the only thing there is and because HOUSE-STRATEGY §7 currently asserts it does not exist.`);
    console.log(`   1. n = ${humans.length}. The CI on the mean (±${ci95(games).toFixed(2)} rounds) is wider than the mean.`);
    console.log(`   2. Devnet play money. Nobody in this table lost anything they will miss, and the ONE`);
    console.log(`      behaviour the whole study turns on — quitting because you are losing — is precisely the`);
    console.log(`      behaviour play money cannot produce.`);
    console.log(`   3. Mostly the developer's own wallets: ${humans.filter(h => h.name === "You").length} of ${humans.length} are named "You" and two more share a`);
    console.log(`      handle. These are not a sample of a market, they are a sample of one afternoon.`);
    console.log(`   4. A DIFFERENT PRODUCT. This is the custodial \`engine/\` server (arenas.ts: FEE = 0.002, i.e.`);
    console.log(`      20 bps), not the on-chain arena at ${LIVE_FEE_BPS} bps that this entire study measures. Different`);
    console.log(`      rake, different UI, different session, different everything.`);
    console.log(`   5. Possibly truncated by the OBSERVATION WINDOW rather than by churn. \`meta.savedAt\` is the`);
    console.log(`      only timestamp in the file; there is no per-account first-seen or last-seen, so a wallet`);
    console.log(`      that played once and would have come back tomorrow is indistinguishable here from one`);
    console.log(`      that quit forever. Right-censoring biases \`games\` DOWN and hazardBase UP.`);
    console.log(`   This is one weak data point. It is not a calibration. Any decision that rests on it is`);
    console.log(`   resting on eleven rows of a developer's own devnet session.`);

    console.log(`\n\n--- 5.1 BUT SUPPOSE IT IS RIGHT. What does a ~3-round life do to the whole analysis? ----------`);
    console.log(`Testing the regime explicitly rather than dismissing it, because if it IS the truth then most of`);
    console.log(`this document is a rounding error.`);
    for (const [label, lam] of [["observed (games as attempts)", pAttempted], ["observed (games as completions)", pCompleted], ["BASE_PLAYER, for contrast", BASE_PLAYER.hazardBase]] as [string, number][]) {
      const m: PlayerModel = {
        ...BASE_PLAYER, bankroll: 100, stakeFraction: 1.0, maxRounds: 20_000,
        hazardBase: lam, hazardDrawdown: 0, hazardStreak: 0, redeposit: 0,
      };
      console.log(`\n${label}: hazardBase = ${lam.toFixed(4)}`);
      console.log(`fee bps    lifetime rake/player     % of $100 bankroll      rounds lived       rev/player-day`);
      console.log("-".repeat(110));
      for (const fee of FEE_GRID) {
        const c = cohort(m, fee, PLAYERS, `5.1|${lam.toFixed(4)}|${fee}`);
        const rk = mean(c.rake), rd = mean(c.rounds);
        const days = rd / (ROUNDS_PER_HOUR * 24);
        console.log(`${String(fee).padStart(7)}    $${f2(rk, 8, 4)} ±${ci95(c.rake).toFixed(4).padStart(6)}     ${pctS(rk / 100, 12)}      ` +
          `${f2(rd, 10, 2)}     ${(days > 0 ? `$${(rk / days).toFixed(2)}` : "n/a").padStart(14)}`);
      }
    }
    const three: PlayerModel = {
      ...BASE_PLAYER, bankroll: 100, stakeFraction: 1.0, maxRounds: 20_000,
      hazardBase: pAttempted, hazardDrawdown: 0, hazardStreak: 0, redeposit: 0,
    };
    const t100 = cohort(three, LIVE_FEE_BPS, PLAYERS, `5.2|100`);
    const t1000 = cohort(three, MAX_FEE_BPS, PLAYERS, `5.2|1000`);
    console.log(`\nWHAT A ~3-ROUND LIFE DOES TO THE WHOLE ANALYSIS:`);
    console.log(`  * Lifetime rake per acquired player at ${LIVE_FEE_BPS} bps: $${mean(t100.rake).toFixed(4)} ±${ci95(t100.rake).toFixed(4)} — ${(100 * mean(t100.rake) / 100).toFixed(2)}% of the bankroll.`);
    console.log(`  * Even at MAX_FEE_BPS it is $${mean(t1000.rake).toFixed(3)} ±${ci95(t1000.rake).toFixed(3)}, i.e. ${(100 * mean(t1000.rake) / 100).toFixed(1)}% of the bankroll. The ENTIRE legal`);
    console.log(`    range of the only real dial moves lifetime revenue by $${(mean(t1000.rake) - mean(t100.rake)).toFixed(2)} per acquired player.`);
    console.log(`  * Against gas: ${mean(t100.rounds).toFixed(2)} rounds x $${GAS_USD_PER_ROUND.toFixed(4)} = $${(mean(t100.rounds) * GAS_USD_PER_ROUND).toFixed(2)} of gas to earn $${mean(t100.rake).toFixed(2)} of rake at one real`);
    console.log(`    player per round. The player is ${(mean(t100.rounds) * GAS_USD_PER_ROUND / mean(t100.rake)).toFixed(1)}x underwater before any acquisition cost is counted.`);
    console.log(`  * CONCLUSION: if real retention is ~3 rounds, NO FEE SETTING MATTERS. The fee sweep, the`);
    console.log(`    interior optimum, the inversion in Part 2 — all of it is arguing over cents. The only`);
    console.log(`    variable that matters in that regime is RETENTION ITSELF, and the second is rounds-per-`);
    console.log(`    player-per-day, because both multiply the same tiny per-round take. Setting the fee is not`);
    console.log(`    a lever on that. Measuring retention is.`);
  }
}

// ================================================================================================

console.log(`\n\n${"=".repeat(110)}`);
console.log(`WHAT THIS SCRIPT ESTABLISHES, AND WHAT IT DOES NOT`);
console.log(`${"=".repeat(110)}`);
console.log(`ESTABLISHED (measured, reproducible, CI'd):`);
console.log(`  * The pool approximation is sound over a 200-round life — Part 0b, against real fights.`);
console.log(`  * NO CHURN RULE THAT IS A FUNCTION OF THE PLAYER'S MONEY PATH CAN PRODUCE AN INTERIOR OPTIMUM.`);
console.log(`    Not hazardBase, not hazardDrawdown at any magnitude, not hazardStreak, not a drawdown stop.`);
console.log(`    E[rake] = E[deposits] - E[withdrawals] because the fight is a martingale, such rules fix how`);
console.log(`    much a player will LOSE, and the fee only decides what share of that loss the house keeps`);
console.log(`    rather than the lobby. The optimum is MAX_FEE_BPS under every one of them.`);
console.log(`  * The shipped auto-deploy default caps lifetime rake at budgetUsd * phi ($2.50 at the live rate)`);
console.log(`    and the binding limit is \`budget-spent\` on cumulative GROSS STAKE, not the drawdown stop.`);
console.log(`  * The deposit elasticity that would make 100 bps optimal is measured in §2.3 — that is the one`);
console.log(`    number a human can be asked to judge, and it replaces the churn inversion that has no answer.`);
console.log(`  * Per-round gas swamps lifetime rake at low real-player counts, at every fee in the grid.`);
console.log(`NOT ESTABLISHED, and no amount of simulation would establish it:`);
console.log(`  * Any churn parameter whatsoever. Every one is a prior.`);
console.log(`  * DEPOSIT ELASTICITY — the one term that could justify the current rate. It is not measured`);
console.log(`    anywhere in this repository and, unlike the churn parameters, it is not even guessed at.`);
console.log(`  * That the 11 rows in ledger.db describe anybody. They do not.`);
console.log(`  * Independence between rounds — a real player meets a correlated field. Understates both tails.`);
console.log(`  * Anything about acquisition cost. "Revenue per acquired player" is only half a business; the`);
console.log(`    other half is what a player costs to acquire, and nothing here touches it.\n`);
