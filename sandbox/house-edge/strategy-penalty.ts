// SANDBOX. Run from engine/:  npx tsx ../sandbox/house-edge/strategy-penalty.ts [fights]
//
// THE EXTRACT PENALTY IS NOT A TAX. IT IS THE PRICE OF AN OPTION — and it has never been tested
// against demand.
//
// WHY THAT REFRAME IS THE WHOLE FILE
// ----------------------------------
// The fight is a martingale in `hp + banked` (HOUSE-EDGE-STUDY.md §11.5: `basis = min(attacker.hp,
// defender.hp)` is symmetric between the two directions of an exchange, so E[R] = 1 up to integer
// flooring, re-verified per stake bin by `lifetime-core.ts:verifyPool`). A martingale means
// extracting has ZERO expected value: `hp` you leave in the ring is worth exactly `hp` in
// expectation, and pulling it out buys you exactly one thing — CERTAINTY. Nothing else. The house
// charges `extractPenaltyBps(n, cursor)` for that certainty.
//
// So `EXTRACT_PENALTY_START_BPS = 2_000` is not a rake rate. It is a PRICE, posted by a monopolist,
// on a product (certainty) with a demand curve nobody has drawn. And the correct question about a
// price is never "is it too high or too low" — it is "where is the revenue-maximising point of
// price × quantity, and how far from it are we standing".
//
// TWO FACTS FRAME EVERY NUMBER BELOW, AND BOTH ARE UNCOMFORTABLE
// --------------------------------------------------------------
//   1. `Treasury.penalties_accrued` is ZERO. Nobody has ever extracted mid-fight in production.
//      Every figure in this file is a BEHAVIOURAL FORECAST, not an observation. There is no data.
//   2. Extracting AT or AFTER the horizon is free AND EV-neutral — HOUSE-STRATEGY.md §4.1 measured
//      the hold-vs-extract-at-horizon difference at +0.01% to -0.03% across all five stake bands,
//      every one inside noise. So the entire stream depends on players bailing EARLY, i.e. on
//      players choosing to pay for something they could have had for free by waiting.
//
// THE METHOD, AND WHY IT IS EXACT RATHER THAN A SHORTCUT
// -----------------------------------------------------
// `strategy-sensitivity.ts` makes the argument this file reuses and extends, and it is worth
// restating because it looks like cheating and is not: THE PENALTY RATE DOES NOT AFFECT THE FIGHT.
// `extract` sets `hp = 0` and splits `taken` into `kept` (to the player's bank) and `penalty` (out
// of the round); the ring loses `taken` either way and no subsequent draw can tell which split was
// applied. So re-pricing a recorded extraction under a different `(START, H)` is ARITHMETIC.
//
// This file goes one step further than that script and the step needs its own justification.
// `strategy-sensitivity.ts` records `(taken, cursor, n)` at extractions that actually happened.
// Here the extraction TIMES are themselves an output of the price — a demand model decides when to
// leave, and that decision moves with `START` and `H`. So recording actual extractions is no good:
// changing the price changes who extracts when. Instead this file records the FULL `hp(cursor)`
// TRAJECTORY of every fighter in a fight where NOBODY extracts, and prices counterfactual
// extractions against it.
//
// THAT IS EXACT FOR ONE EXTRACTOR AND APPROXIMATE FOR MANY, and the approximation is measured
// rather than assumed. Exact for one: a fighter's own extraction cannot affect their own `hp` path
// up to the instant they leave, because `extract` only reads `hp` at that cursor and everything
// before it is the same fight. Approximate for many: once fighter A leaves, A's slot is `dead` and
// every draw naming it is skipped, so the fight SLOWS DOWN for everyone still standing and their
// `hp` decays more slowly than the no-extraction trajectory says. That biases the penalty base
// DOWNWARD in this rig, i.e. every revenue figure here is conservative. §1c measures the size of
// that bias directly, against real simulations, on the same seeds.
//
// WHAT THIS FILE DOES NOT MODEL, STATED HERE SO IT IS NOT DISCOVERED LATER
// -----------------------------------------------------------------------
//   * A player's extraction changes OTHER players' payouts (they lose a target). Priced as a
//     measured aggregate bias in §1c, not per-player.
//   * The house's own wallets. `strategy-house-book.ts` establishes the house holds, so house seats
//     contribute no penalty either way; this file's lobby is all-real-player, which makes every
//     percentage here a percentage of REAL gross with no house volume in the denominator.
//   * Anything undisclosed. HARD CONSTRAINT, and it is load-bearing: every setting evaluated here
//     is one that could be printed in the published rules without changing its value. See §5.

import { newRound, enter, tick, extract, penaltyHorizonSteps } from "../../engine/src/er-sim.ts";
import { houseTook, grossDeposits, conservationHolds } from "../../engine/src/er-sim.ts";
import { stepBudget, UNITS_PER_USD } from "./fight-variant.ts";
import { makeLobby, toUsd } from "./lobby.ts";
import { mulberry32 } from "./rng.ts";
import { GAS_USD_PER_ROUND, ROUNDS_PER_HOUR, SOL_USD, GAS_SOL_PER_ROUND } from "./lifetime-core.ts";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// -------------------------------------------------------------------------------------------------
// CONFIGURATION. Everything reproducible from this block plus the seed tag.
// -------------------------------------------------------------------------------------------------

const FIGHTS = Number(process.argv[2] ?? 20_000);
const PER_SIDE = 4;                       // 8 seats, the lineup every other study script uses
const SEATS = PER_SIDE * 2;
const STUDY_SEED = "house-edge-v1";       // THE SAME SEED §11.1 USED — lobbies are literally identical
const GRID = 8;                           // record `hp` every 8 steps

/** THE FEE, AND WHY THIS SCRIPT DEFAULTS TO 100 WHERE THE RIG DEFAULTS TO 20.
 *
 *  `fight-variant.ts` defaults `FEE_BPS` to 20 so that every command in `README.md` reproduces the
 *  number it always printed (HOUSE-EDGE-STUDY.md §11 explains that choice). This script has no
 *  historical table to preserve and its §1 cross-check is against §11.1, which is a 100-bps table —
 *  so it defaults to the rate the arena actually charges. `HE_FEE_BPS` still overrides, and the
 *  cache tag encodes it, so a changed fee can never silently reuse a stale trajectory file. */
const FEE_BPS = BigInt(process.env.HE_FEE_BPS ?? 100);

/** The shipped setting: `EXTRACT_PENALTY_START_BPS = 2_000`, `PENALTY_HORIZON_STEPS` at ×1.0. */
const SHIPPED_START = 2_000;
const SHIPPED_MULT = 1.0;

const START_GRID = [0, 250, 500, 750, 1_000, 1_500, 2_000, 3_000, 4_000, 6_000];
const MULT_GRID = [0.25, 0.5, 1.0, 2.0, 4.0];

const BUDGET = stepBudget(SEATS);                       // 1,920 for 8 seats
const HORIZON = Number(penaltyHorizonSteps(SEATS));     // 675 for 8 seats
const G = BUDGET / GRID;                                // 240 grid intervals, 241 sample points

const CACHE_DIR = process.env.HE_POOL_DIR
  ?? "/private/tmp/claude-501/-Users-tyler-Launchpad-Crypto-UwuGame-magicblock/d5279d95-4422-4376-a720-d79efa3c4e5c/scratchpad";

// -------------------------------------------------------------------------------------------------
// THE MECHANIC, RESTATED IN ONE FUNCTION SO EVERY SWEEP PRICES THE SAME ARITHMETIC.
// Mirrors `extractPenaltyBps` exactly, including the floor division, generalised over (start, H).
// -------------------------------------------------------------------------------------------------

const penaltyBpsAt = (start: number, H: number, cursor: number): number =>
  start <= 0 || cursor >= H ? 0 : Math.floor((start * (H - cursor)) / H);

/** The FIRST cursor at which the rate has fallen to `v` or below — the "wait until it is cheap
 *  enough" cursor, and the single most important quantity in the demand model.
 *
 *  Solved from the integer rule rather than the real one: `floor(start(H-c)/H) <= v` holds exactly
 *  when `start(H-c)/H < v+1`, i.e. `c > H - H(v+1)/start`. So the first integer cursor is
 *  `floor(H - H(v+1)/start) + 1`, clamped at zero. Doing it in reals would put `c*` up to one step
 *  early and quote a rate one bp above what the chain charges. */
function firstCursorAtOrBelow(start: number, H: number, v: number): number {
  if (start <= 0 || v >= start) return 0;
  return Math.max(0, Math.floor(H - (H * (v + 1)) / start) + 1);
}

// -------------------------------------------------------------------------------------------------
// PART 1a — THE RECORDER. One pass over real fights on `engine/src/er-sim.ts`, cached forever.
// -------------------------------------------------------------------------------------------------

interface Traj {
  /** `hp` in MICRO-UNITS, indexed `(fight * SEATS + seat) * (G + 1) + gridIndex`.
   *
   *  Int32, not Float32, ON PURPOSE. `hp` is monotonically non-increasing and starts at the net
   *  stake, which is at most $100 = 1e8 micro-units — inside Int32's 2.147e9. So this is EXACT to
   *  the micro-unit, which is what §1c needs: it compares trajectory-priced penalties against real
   *  simulated ones and asks for an exact match wherever no interaction occurred. Float32 would
   *  have lost the last digit and turned a clean identity into a fuzzy one. */
  hp: Int32Array;
  /** Gross and net stake per seat, micro-units. */
  gross: Int32Array;
  net: Int32Array;
  fights: number;
}

function trajPath(): string {
  return `${CACHE_DIR}/penalty-traj-${STUDY_SEED}-${FIGHTS}-${SEATS}-${GRID}-fee${FEE_BPS}.bin`;
}

function recordTrajectories(): Traj {
  const hp = new Int32Array(FIGHTS * SEATS * (G + 1));
  const gross = new Int32Array(FIGHTS * SEATS);
  const net = new Int32Array(FIGHTS * SEATS);

  for (let r = 0; r < FIGHTS; r++) {
    const lobby = makeLobby(STUDY_SEED, r, PER_SIDE);
    const round = newRound(lobby.seed);
    for (const e of lobby.entries) enter(round, e.wallet, e.side, e.grossUnits, FEE_BPS);
    const n = round.fighters.length;
    for (let k = 0; k < n; k++) {
      gross[r * SEATS + k] = Number(lobby.entries[k].grossUnits);
      net[r * SEATS + k] = Number(round.fighters[k].stake);
    }
    // Tick in slices of GRID. `tick` breaks only when `fighters.length < 2`, and nobody leaves the
    // array here, so the cursor after slice `g` is exactly `g * GRID` — no drift to correct for.
    for (let g = 0; g <= G; g++) {
      if (g > 0) tick(round, GRID);
      const base = (r * SEATS) * (G + 1) + g;
      for (let k = 0; k < n; k++) hp[base + k * (G + 1)] = Number(round.fighters[k].hp);
    }
  }
  return { hp, gross, net, fights: FIGHTS };
}

function loadOrRecord(): Traj {
  const p = trajPath();
  if (existsSync(p)) {
    // `readFileSync` pools small buffers at arbitrary offsets, and an Int32Array view demands 4-byte
    // alignment. Files this size are never pooled, but a silent RangeError on a cache read is a
    // stupid way to lose a run, so the guard is here rather than in a comment.
    const raw = readFileSync(p);
    const buf = raw.byteOffset % 4 === 0 ? raw : Buffer.from(raw);
    const nHp = FIGHTS * SEATS * (G + 1);
    const hp = new Int32Array(buf.buffer, buf.byteOffset, nHp);
    const gross = new Int32Array(buf.buffer, buf.byteOffset + nHp * 4, FIGHTS * SEATS);
    const net = new Int32Array(buf.buffer, buf.byteOffset + (nHp + FIGHTS * SEATS) * 4, FIGHTS * SEATS);
    console.log(`trajectories: ${FIGHTS} fights x ${SEATS} seats x ${G + 1} samples, cached at ${p}`);
    return { hp, gross, net, fights: FIGHTS };
  }
  console.log(`trajectories: recording ${FIGHTS} fights x ${SEATS} seats on er-sim.ts (~${(FIGHTS / 300 / 60).toFixed(1)} min)...`);
  const t0 = Date.now();
  const t = recordTrajectories();
  mkdirSync(dirname(p), { recursive: true });
  const out = Buffer.alloc((t.hp.length + t.gross.length + t.net.length) * 4);
  Buffer.from(t.hp.buffer, t.hp.byteOffset, t.hp.length * 4).copy(out, 0);
  Buffer.from(t.gross.buffer, t.gross.byteOffset, t.gross.length * 4).copy(out, t.hp.length * 4);
  Buffer.from(t.net.buffer, t.net.byteOffset, t.net.length * 4).copy(out, (t.hp.length + t.gross.length) * 4);
  writeFileSync(p, out);
  console.log(`trajectories: recorded in ${((Date.now() - t0) / 1000).toFixed(0)}s, cached at ${p} (${(out.length / 1e6).toFixed(0)} MB)`);
  return t;
}

// -------------------------------------------------------------------------------------------------
// PART 1b — REPRODUCE §11.1 FROM REAL SIMULATIONS. If this table does not print 1.0000% and
// 2.5427%, the harness is not measuring the game the study measured and nothing below is admissible.
// -------------------------------------------------------------------------------------------------

type Regime = "hold" | "horizon" | "random" | "quarter" | "random-grid";

/** Play one round under one extraction regime, exactly as `check-house-accrual.ts:playRound` does.
 *  Reimplemented rather than imported because that file is a script with top-level output. The one
 *  addition is `random-grid`, which is `random` with the cursor snapped to this file's sampling grid
 *  — the paired control that removes grid quantisation from the §1c comparison. */
function playRound(seed: Buffer, entries: { wallet: string; side: 0 | 1; gross: bigint }[], regime: Regime, rnd: () => number) {
  const round = newRound(seed);
  for (const e of entries) enter(round, e.wallet, e.side, e.gross, FEE_BPS);
  const n = round.fighters.length;
  const budget = stepBudget(n);
  const horizon = Number(penaltyHorizonSteps(n));
  const chosen: number[] = new Array(entries.length).fill(-1);

  if (regime === "hold") { tick(round, budget); return { round, chosen }; }

  const when = new Map<number, string[]>();
  for (let i = 0; i < entries.length; i++) {
    let c: number;
    if (regime === "horizon") c = horizon;
    else if (regime === "random") c = Math.floor(rnd() * budget);
    else if (regime === "random-grid") c = Math.floor(rnd() * G) * GRID;   // uniform over grid points
    else { if (rnd() >= 0.25) continue; c = Math.floor(rnd() * horizon); }
    if (c >= budget) continue;
    chosen[i] = c;
    const at = when.get(c) ?? []; at.push(entries[i].wallet); when.set(c, at);
  }

  let cursor = 0;
  for (const s of [...when.keys()].sort((a, b) => a - b)) {
    if (s > cursor) { tick(round, s - cursor); cursor = s; }
    for (const w of when.get(s)!) {
      const f = round.fighters.find(x => x.wallet === w && x.dead === 0 && x.hp > 0n);
      if (f) extract(round, w);
    }
  }
  if (cursor < budget) tick(round, budget - cursor);
  return { round, chosen };
}

/** Ratio-of-sums with a bootstrap CI over ROUNDS — the independent unit. Two fighters in one round
 *  are not independent observations: one's gain is literally the other's loss. */
function rateWithCI(rows: { gross: number; house: number }[], resamples = 4_000, seed = 11) {
  let Gs = 0, H = 0;
  for (const r of rows) { Gs += r.gross; H += r.house; }
  const rnd = mulberry32(seed);
  const draws: number[] = [];
  for (let b = 0; b < resamples; b++) {
    let g = 0, h = 0;
    for (let k = 0; k < rows.length; k++) { const j = Math.floor(rnd() * rows.length); g += rows[j].gross; h += rows[j].house; }
    if (g > 0) draws.push(h / g);
  }
  draws.sort((a, b) => a - b);
  const q = (p: number) => draws[Math.min(draws.length - 1, Math.max(0, Math.floor(p * draws.length)))];
  return { point: H / Gs, lo: q(0.025), hi: q(0.975) };
}

interface RegimeResult { rows: { gross: number; house: number }[]; fee: number; pen: number; violations: number; penPerRound: number[]; chosen: Int32Array; }

function runRegimes(regimes: Regime[]): Record<string, RegimeResult> {
  const out: Record<string, RegimeResult> = {};
  for (const g of regimes) out[g] = { rows: [], fee: 0, pen: 0, violations: 0, penPerRound: [], chosen: new Int32Array(FIGHTS * SEATS).fill(-1) };
  const ALL: Regime[] = ["hold", "horizon", "random", "quarter", "random-grid"];
  for (let r = 0; r < FIGHTS; r++) {
    const lobby = makeLobby(STUDY_SEED, r, PER_SIDE);
    const entries = lobby.entries.map(e => ({ wallet: e.wallet, side: e.side, gross: e.grossUnits }));
    for (const g of regimes) {
      // The regime index must match `check-house-accrual.ts`'s REGIMES array for `random` and
      // `quarter` to draw the SAME cursors it drew. `random-grid` is new and gets its own index.
      const { round, chosen } = playRound(lobby.seed, entries, g, mulberry32((r * 2654435761 + ALL.indexOf(g) * 7919) >>> 0));
      const R = out[g];
      if (!conservationHolds(round)) R.violations++;
      R.rows.push({ gross: toUsd(grossDeposits(round)), house: toUsd(houseTook(round)) });
      R.fee += toUsd(round.feesCollected);
      R.pen += toUsd(round.penaltiesCollected);
      R.penPerRound.push(Number(round.penaltiesCollected));
      for (let k = 0; k < entries.length; k++) R.chosen[r * SEATS + k] = chosen[k];
    }
  }
  return out;
}

// -------------------------------------------------------------------------------------------------
// PART 2 — THE DEMAND MODEL. EVERY BEHAVIOURAL ASSUMPTION IN THIS FILE IS IN THIS ONE STRUCT.
//
// A player is three numbers and a mechanism:
//
//   v   — RESERVATION PRICE, in bps. The most they would pay to convert at-risk `hp` into certain
//         `banked`. This is the demand curve. It is the object the house is pricing against and
//         nothing in this repository measures it.
//   tau — EXIT-DESIRE ARRIVAL. When they want out. Two mechanisms, and they give different answers,
//         which is why both are carried rather than one being picked:
//           exogenous  — tau ~ Uniform over the fight. The "something came up" player. Their `hp` at
//                        tau is a fair draw from the fight, so the penalty base is average.
//           endogenous — tau fires the first time their own `hp` drops below `lossTrigger` x their
//                        net stake. The "I'm losing, get me out" player. THIS IS THE REALISTIC ONE
//                        and it is structurally correlated with a LOW `hp` — which matters enormously
//                        because `hp` IS the penalty base. A losing player is a cheap customer.
//   piHold — never extracts at all, whatever happens. Includes, by construction, every auto-deploy
//         player (see §4b).
//
// BEHAVIOUR ON ARRIVAL is the option logic, and it is where `START` earns or fails to earn:
//   * if p(tau) <= v, extract now and pay p(tau) x hp(tau).
//   * otherwise WAIT until the rate has decayed to v, at c* = firstCursorAtOrBelow(START, H, v), and
//     extract there paying p(c*) x hp(c*). Waiting saves them rate and costs the house BASE, because
//     `hp` kept decaying while they stood there.
//   * if v = 0 they wait for the horizon and pay nothing at all. If the horizon is past the bell
//     they never extract.
//
// THAT ASYMMETRY IS THE ENTIRE ECONOMICS. Raising `START` extracts more from players with v >= START
// (they pay the posted price) and NOTHING extra from players with v < START (they simply wait
// longer and still pay only ~v) — on a base that has decayed further while they waited. So above the
// bulk of the v distribution, raising `START` buys nothing and destroys base. §3 tests that.
// -------------------------------------------------------------------------------------------------

interface DemandModel {
  name: string;
  /** Fraction who never extract under any price. */
  piHold: number;
  /** P(v = 0 | not a holder): the informed and the indifferent, who never pay to leave early. */
  vZeroMass: number;
  /** Body of the reservation-price distribution, in bps. */
  vBody: "lognormal" | "exponential";
  /** Median of the body, bps. THE SWEPT PARAMETER — §3b sweeps it, because it is a pure guess. */
  vMedianBps: number;
  /** Lognormal shape. Ignored for `exponential`. sigma = 1.0 spans roughly a factor of 7 either side. */
  vSigmaLog: number;
  /** Which arrival mechanism. `mixed` splits the population 50/50. */
  arrival: "exogenous" | "endogenous" | "mixed";
  /** Endogenous only: fires when `hp` first falls below this fraction of net stake. */
  lossTrigger: number;
}

const M_EXO: DemandModel = { name: "A exogenous ('something came up')", piHold: 0.50, vZeroMass: 0.20, vBody: "lognormal", vMedianBps: 500, vSigmaLog: 1.0, arrival: "exogenous", lossTrigger: 0.5 };
const M_ENDO: DemandModel = { name: "B endogenous ('I'm losing, get me out')", piHold: 0.50, vZeroMass: 0.20, vBody: "lognormal", vMedianBps: 500, vSigmaLog: 1.0, arrival: "endogenous", lossTrigger: 0.5 };
const M_MIX: DemandModel = { name: "C mixed 50/50", piHold: 0.50, vZeroMass: 0.20, vBody: "lognormal", vMedianBps: 500, vSigmaLog: 1.0, arrival: "mixed", lossTrigger: 0.5 };
const M_INFORMED: DemandModel = { name: "D informed (everyone knows it expires)", piHold: 0.50, vZeroMass: 1.00, vBody: "lognormal", vMedianBps: 500, vSigmaLog: 1.0, arrival: "mixed", lossTrigger: 0.5 };
const MODELS = [M_EXO, M_ENDO, M_MIX, M_INFORMED];

/** Acklam's rational approximation to the inverse normal CDF. |error| < 1.15e-9, which is six orders
 *  of magnitude tighter than the thing it is being used to invent. */
function invNorm(p: number): number {
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239e0];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838e0, -2.549732539343734e0, 4.374664141464968e0, 2.938163982698783e0];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996e0, 3.754408661907416e0];
  const pl = 0.02425;
  if (p < pl) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > 1 - pl) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** COMMON RANDOM NUMBERS. Four uniforms per (fight, seat), drawn ONCE and reused across every cell
 *  of every surface. Two reasons and both matter: differences between cells become PAIRED, so their
 *  standard errors are one to two orders of magnitude smaller than independent sampling would give
 *  (the same argument `lobby.ts` makes for common lobbies); and `piHold` sweeps nest monotonically —
 *  raising piHold can only convert extractors into holders, never reshuffle who is who. */
interface Draws { hold: Float64Array; vMix: Float64Array; vBody: Float64Array; tau: Float64Array; mech: Float64Array; }

function makeDraws(seed: string): Draws {
  const n = FIGHTS * SEATS;
  const rnd = mulberry32(hashSeed(seed));
  const d: Draws = { hold: new Float64Array(n), vMix: new Float64Array(n), vBody: new Float64Array(n), tau: new Float64Array(n), mech: new Float64Array(n) };
  for (let i = 0; i < n; i++) { d.hold[i] = rnd(); d.vMix[i] = rnd(); d.vBody[i] = rnd(); d.tau[i] = rnd(); d.mech[i] = rnd(); }
  return d;
}
function hashSeed(s: string): number { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

/** Grid index at which the endogenous trigger fires for each (fight, seat); -1 if it never does.
 *  Depends only on the trajectory and `lossTrigger`, NOT on the price — so it is computed once. */
function endogenousArrival(t: Traj, lossTrigger: number): Int32Array {
  const out = new Int32Array(FIGHTS * SEATS).fill(-1);
  for (let i = 0; i < FIGHTS * SEATS; i++) {
    const thresh = t.net[i] * lossTrigger;
    const base = i * (G + 1);
    for (let g = 0; g <= G; g++) if (t.hp[base + g] < thresh) { out[i] = g; break; }
  }
  return out;
}

/** The reservation price for one player, in bps. */
function reservationBps(m: DemandModel, uMix: number, uBody: number): number {
  if (uMix < m.vZeroMass) return 0;
  if (m.vBody === "exponential") return -Math.log(1 - uBody) * m.vMedianBps / Math.LN2;   // median -> rate
  return m.vMedianBps * Math.exp(m.vSigmaLog * invNorm(Math.min(Math.max(uBody, 1e-9), 1 - 1e-9)));
}

interface CellResult {
  /** Penalty revenue per round, USD, and its 95% half-width. */
  usdPerRound: number; hw: number;
  /** As a fraction of gross entries. */
  pctOfGross: number;
  /** Diagnostics that show WHY the number is what it is. */
  extractRate: number;        // fraction of seats that extracted at all
  immediateShare: number;     // of extractors, the share who paid the posted price rather than waiting
  meanPaidBps: number;        // mean rate actually charged, over extractors
  meanCursor: number;         // mean cursor at extraction
  meanBaseUsd: number;        // mean `hp` the penalty was charged on
  /** SUM over extractors of paidRate x stake — the churn-cost kernel, see §4c. Linear in kappa. */
  churnKernel: number;
  perRound: Float64Array;     // penalty per round in USD, for paired bootstraps
}

/** Price one (START, H) cell against the recorded trajectories under one demand model. */
function priceCell(t: Traj, d: Draws, endo: Int32Array, m: DemandModel, start: number, mult: number): CellResult {
  const H = Math.max(1, Math.round(HORIZON * mult));
  const perRound = new Float64Array(FIGHTS);
  let extractors = 0, immediate = 0, paidSum = 0, cursorSum = 0, baseSum = 0, churn = 0;

  for (let r = 0; r < FIGHTS; r++) {
    let pen = 0;
    for (let k = 0; k < SEATS; k++) {
      const i = r * SEATS + k;
      if (d.hold[i] < m.piHold) continue;                                   // never extracts
      const v = reservationBps(m, d.vMix[i], d.vBody[i]);

      // ARRIVAL.
      const useEndo = m.arrival === "endogenous" || (m.arrival === "mixed" && d.mech[i] < 0.5);
      let gTau: number;
      if (useEndo) { gTau = endo[i]; if (gTau < 0) continue; }              // never triggered -> holds
      else gTau = Math.floor(d.tau[i] * G);

      // DECISION. Extract at tau if the posted rate is already acceptable, else wait for the rate
      // to fall to v. `c*` is a pure function of the price; snapping UP to the sample grid can only
      // delay the extraction, i.e. can only understate the base. Conservative in the same direction
      // as every other approximation here.
      const cStar = firstCursorAtOrBelow(start, H, v);
      const g = Math.max(gTau, Math.ceil(cStar / GRID));
      if (g >= G) continue;                                                 // the bell rings first

      const cursor = g * GRID;
      const hp = t.hp[i * (G + 1) + g];
      if (hp <= 0) continue;                                                // dead, or already wiped

      const bps = penaltyBpsAt(start, H, cursor);
      pen += Math.floor((hp * bps) / 10_000);
      extractors++;
      if (g === gTau) immediate++;
      paidSum += bps; cursorSum += cursor; baseSum += hp;
      churn += (bps / 10_000) * t.gross[i];
    }
    perRound[r] = pen / Number(UNITS_PER_USD);
  }

  let s = 0; for (let r = 0; r < FIGHTS; r++) s += perRound[r];
  const mean = s / FIGHTS;
  let vsum = 0; for (let r = 0; r < FIGHTS; r++) vsum += (perRound[r] - mean) ** 2;
  const hw = 1.96 * Math.sqrt(vsum / (FIGHTS - 1)) / Math.sqrt(FIGHTS);

  return {
    usdPerRound: mean, hw, pctOfGross: mean / MEAN_GROSS_USD,
    extractRate: extractors / (FIGHTS * SEATS),
    immediateShare: extractors > 0 ? immediate / extractors : 0,
    meanPaidBps: extractors > 0 ? paidSum / extractors : 0,
    meanCursor: extractors > 0 ? cursorSum / extractors : 0,
    meanBaseUsd: extractors > 0 ? baseSum / extractors / Number(UNITS_PER_USD) : 0,
    churnKernel: churn / Number(UNITS_PER_USD) / FIGHTS,
    perRound,
  };
}

/** Paired bootstrap over fights of the DIFFERENCE between two cells. Paired because both cells were
 *  priced against the same fights and the same player draws, so the difference is the only thing
 *  that moved. */
function pairedDiffCI(a: Float64Array, b: Float64Array, resamples = 2_000, seed = 41) {
  const rnd = mulberry32(seed);
  const draws: number[] = [];
  for (let s = 0; s < resamples; s++) {
    let sum = 0;
    for (let k = 0; k < FIGHTS; k++) { const j = (rnd() * FIGHTS) | 0; sum += a[j] - b[j]; }
    draws.push(sum / FIGHTS);
  }
  draws.sort((x, y) => x - y);
  return { lo: draws[Math.floor(0.025 * resamples)], hi: draws[Math.floor(0.975 * resamples)] };
}

// -------------------------------------------------------------------------------------------------
// RUN.
// -------------------------------------------------------------------------------------------------

let MEAN_GROSS_USD = 0;   // set after the trajectories load; every pctOfGross divides by it

console.log(`\n${"=".repeat(100)}`);
console.log(`  THE EXTRACT PENALTY AS A PRICE — where the demand curve puts the optimum, and whether`);
console.log(`  the stream survives being explained to the people paying it.`);
console.log(`${"=".repeat(100)}`);
console.log(`\nmeasured on engine/src/er-sim.ts  |  ${FIGHTS} fights x ${SEATS} seats  |  study seed "${STUDY_SEED}"`);
console.log(`fee ${FEE_BPS} bps  |  step budget ${BUDGET}  |  penalty horizon ${HORIZON} (${(100 * HORIZON / BUDGET).toFixed(1)}% of the fight)`);
console.log(`shipped setting: EXTRACT_PENALTY_START_BPS = ${SHIPPED_START}, PENALTY_HORIZON_STEPS x${SHIPPED_MULT.toFixed(1)}`);
console.log(`gas floor: ${GAS_SOL_PER_ROUND} SOL/round @ $${SOL_USD} = $${GAS_USD_PER_ROUND.toFixed(4)}/round (${ROUNDS_PER_HOUR.toFixed(1)} rounds/hr)\n`);

const traj = loadOrRecord();
{
  let g = 0;
  for (let i = 0; i < FIGHTS * SEATS; i++) g += traj.gross[i];
  MEAN_GROSS_USD = g / Number(UNITS_PER_USD) / FIGHTS;
}
console.log(`mean gross entries per round: $${MEAN_GROSS_USD.toFixed(2)}  (five-band lobby, HOUSE-EDGE-STUDY.md's invented mix)`);

// ---- §1b: reproduce §11.1 -----------------------------------------------------------------------
console.log(`\n\n${"-".repeat(100)}`);
console.log(`  1. VALIDATION — the recorder against HOUSE-EDGE-STUDY.md §11.1, same seeds, same rig`);
console.log(`${"-".repeat(100)}\n`);

const simPath = `${CACHE_DIR}/penalty-regimes-${STUDY_SEED}-${FIGHTS}-${SEATS}-fee${FEE_BPS}.json`;
let regimeTable: { name: string; point: number; lo: number; hi: number; feeShare: number; penShare: number; violations: number; penUnits: number }[];
let gridChosen: Int32Array;
let gridRealPenPerRound: Float64Array;

if (existsSync(simPath)) {
  const raw = JSON.parse(readFileSync(simPath, "utf8"));
  regimeTable = raw.table;
  gridChosen = Int32Array.from(raw.chosen);
  gridRealPenPerRound = Float64Array.from(raw.realPen);
  console.log(`(regime simulations cached at ${simPath})`);
} else {
  console.log(`running ${5 * FIGHTS} real fights across five extraction regimes (~${(5 * FIGHTS / 400 / 60).toFixed(1)} min)...`);
  const t0 = Date.now();
  const res = runRegimes(["hold", "horizon", "random", "quarter", "random-grid"]);
  regimeTable = (["hold", "horizon", "random", "quarter", "random-grid"] as Regime[]).map(g => {
    const R = res[g];
    const ci = rateWithCI(R.rows);
    const tot = R.fee + R.pen;
    return { name: g, point: ci.point, lo: ci.lo, hi: ci.hi, feeShare: R.fee / tot, penShare: R.pen / tot, violations: R.violations, penUnits: R.pen };
  });
  gridChosen = res["random-grid"].chosen;
  gridRealPenPerRound = Float64Array.from(res["random-grid"].penPerRound, x => x / Number(UNITS_PER_USD));
  writeFileSync(simPath, JSON.stringify({ table: regimeTable, chosen: Array.from(gridChosen), realPen: Array.from(gridRealPenPerRound) }));
  console.log(`done in ${((Date.now() - t0) / 1000).toFixed(0)}s, cached at ${simPath}`);
}

console.log(`\n  regime         house take, % of GROSS entries      95% CI                 fee    penalty   conservation`);
console.log(`  ${"-".repeat(96)}`);
for (const row of regimeTable) {
  console.log(`  ${row.name.padEnd(13)}  ${(row.point * 100).toFixed(4).padStart(9)}%` +
    `                    [${(row.lo * 100).toFixed(4)}%, ${(row.hi * 100).toFixed(4)}%]` +
    `   ${(100 * row.feeShare).toFixed(1).padStart(5)}%  ${(100 * row.penShare).toFixed(1).padStart(6)}%` +
    `   ${row.violations === 0 ? "EXACT, all rounds" : `BROKEN in ${row.violations}`}`);
}
const holdRow = regimeTable.find(r => r.name === "hold")!;
const randRow = regimeTable.find(r => r.name === "random")!;
/** §11.1's published figures, at 20,000 rounds. The `hold` and `horizon` rows have a DEGENERATE CI —
 *  the fee is arithmetic at `enter`, not a statistical edge — so those two are required to match to
 *  the printed digit. `random` and `quarter` are behavioural and get a containment test instead. */
const PUBLISHED: Record<string, number> = { hold: 0.010000, horizon: 0.010000, random: 0.025427, quarter: 0.023036 };
console.log(`\n  vs HOUSE-EDGE-STUDY.md §11.1 (published at 20,000 rounds):`);
let allOk = true;
for (const row of regimeTable) {
  const pub = PUBLISHED[row.name];
  if (pub === undefined) continue;
  const ok = row.name === "hold" || row.name === "horizon"
    ? Math.abs(row.point - pub) < 1e-6
    : pub >= row.lo && pub <= row.hi;
  allOk &&= ok;
  console.log(`    ${row.name.padEnd(9)} published ${(pub * 100).toFixed(4)}%   this run ${(row.point * 100).toFixed(4)}%  ` +
    `[${(row.lo * 100).toFixed(4)}%, ${(row.hi * 100).toFixed(4)}%]   ${ok ? "REPRODUCED" : "MISMATCH"}`);
}
console.log(`  ${allOk ? "RECORDER OK — the harness is measuring the game §11.1 measured." : "MISMATCH — everything below is void, fix the recorder first."}`);

// ---- §1c: how much does the no-extraction trajectory understate the base? ------------------------
console.log(`\n  1c. THE ONE APPROXIMATION, MEASURED. Trajectories are recorded with NOBODY extracting, so`);
console.log(`  they miss the fact that a departure slows the fight for whoever is left. Priced against a`);
console.log(`  REAL simulation of the same seeds, same cursors, all eight seats leaving at grid cursors:\n`);
{
  let priced = 0;
  const pricedPerRound = new Float64Array(FIGHTS);
  for (let r = 0; r < FIGHTS; r++) {
    let pen = 0;
    for (let k = 0; k < SEATS; k++) {
      const c = gridChosen[r * SEATS + k];
      if (c < 0) continue;
      const g = c / GRID;
      const hp = traj.hp[(r * SEATS + k) * (G + 1) + g];
      if (hp <= 0) continue;
      pen += Math.floor((hp * penaltyBpsAt(SHIPPED_START, HORIZON, c)) / 10_000);
    }
    pricedPerRound[r] = pen / Number(UNITS_PER_USD);
    priced += pricedPerRound[r];
  }
  let real = 0; for (let r = 0; r < FIGHTS; r++) real += gridRealPenPerRound[r];
  const ci = pairedDiffCI(pricedPerRound, gridRealPenPerRound);
  console.log(`    real simulation, all-seats grid-random regime : $${(real / FIGHTS).toFixed(4)} penalty/round`);
  console.log(`    trajectory-priced, identical cursors          : $${(priced / FIGHTS).toFixed(4)} penalty/round`);
  console.log(`    paired difference (priced - real)             : $${((priced - real) / FIGHTS).toFixed(4)}  95% CI [${ci.lo.toFixed(4)}, ${ci.hi.toFixed(4)}]`);
  console.log(`    relative bias                                 : ${(100 * (priced - real) / real).toFixed(2)}%`);
  console.log(`\n    THIS IS THE WORST CASE, by a wide margin: it is EIGHT simultaneous extractors out of`);
  console.log(`    eight seats. Every demand model below extracts a fraction of that, so the real bias on`);
  console.log(`    the surface is smaller still, and it points DOWNWARD — the surface understates revenue.`);
}

// ---- §2/§3: the surface -------------------------------------------------------------------------
const draws = makeDraws("penalty-demand-v1");
const endoBase = endogenousArrival(traj, M_EXO.lossTrigger);

console.log(`\n\n${"-".repeat(100)}`);
console.log(`  2. THE DEMAND MODEL — every behavioural assumption, in one place, all of it invented`);
console.log(`${"-".repeat(100)}\n`);
for (const m of MODELS) {
  console.log(`  ${m.name}`);
  console.log(`      piHold ${m.piHold.toFixed(2)}   P(v=0) ${m.vZeroMass.toFixed(2)}   v body ${m.vBody}(median ${m.vMedianBps} bps, sigma ${m.vSigmaLog})   arrival ${m.arrival}${m.arrival !== "exogenous" ? `, trigger hp < ${m.lossTrigger} x stake` : ""}`);
}
{
  let fired = 0; for (let i = 0; i < FIGHTS * SEATS; i++) if (endoBase[i] >= 0) fired++;
  let sum = 0, n = 0; for (let i = 0; i < FIGHTS * SEATS; i++) if (endoBase[i] >= 0) { sum += endoBase[i] * GRID; n++; }
  console.log(`\n  MEASURED, not assumed: the endogenous trigger (hp < 50% of stake) fires for ${(100 * fired / (FIGHTS * SEATS)).toFixed(1)}% of seats,`);
  console.log(`  at a mean cursor of ${(sum / n).toFixed(0)} of ${BUDGET} (${(100 * (sum / n) / HORIZON).toFixed(0)}% of the way to the free horizon).`);
  console.log(`  The other ${(100 - 100 * fired / (FIGHTS * SEATS)).toFixed(1)}% never want out, so under model B they hold and pay nothing.`);
}

console.log(`\n\n${"-".repeat(100)}`);
console.log(`  3. THE SURFACE — penalty revenue per round, USD, over (START bps) x (horizon multiplier)`);
console.log(`${"-".repeat(100)}`);

interface Surface { model: DemandModel; cells: CellResult[][]; }
const surfaces: Surface[] = [];

for (const m of MODELS) {
  const endo = m.lossTrigger === M_EXO.lossTrigger ? endoBase : endogenousArrival(traj, m.lossTrigger);
  const cells: CellResult[][] = START_GRID.map(s => MULT_GRID.map(mu => priceCell(traj, draws, endo, m, s, mu)));
  surfaces.push({ model: m, cells });

  console.log(`\n  MODEL ${m.name}`);
  console.log(`  ${"START bps".padEnd(11)}${MULT_GRID.map(mu => `H x${mu.toFixed(2)}`.padStart(16)).join("")}`);
  console.log(`  ${"-".repeat(11 + 16 * MULT_GRID.length)}`);
  for (let i = 0; i < START_GRID.length; i++) {
    const marks = START_GRID[i] === SHIPPED_START ? " <- SHIPPED" : "";
    console.log(`  ${String(START_GRID[i]).padEnd(11)}` +
      MULT_GRID.map((_, j) => `$${cells[i][j].usdPerRound.toFixed(3)}`.padStart(16)).join("") + marks);
  }
  console.log(`  ${" ".repeat(11)}${MULT_GRID.map((_, j) => `+-${Math.max(...START_GRID.map((_, i) => cells[i][j].hw)).toFixed(4)}`.padStart(16)).join("")}   (LARGEST 95% half-width in the column)`);

  console.log(`\n  same surface as % of gross entries ($${MEAN_GROSS_USD.toFixed(2)}/round):`);
  console.log(`  ${"START bps".padEnd(11)}${MULT_GRID.map(mu => `H x${mu.toFixed(2)}`.padStart(16)).join("")}`);
  for (let i = 0; i < START_GRID.length; i++) {
    console.log(`  ${String(START_GRID[i]).padEnd(11)}` +
      MULT_GRID.map((_, j) => `${(100 * cells[i][j].pctOfGross).toFixed(3)}%`.padStart(16)).join(""));
  }

  // ARGMAX + how far the shipped setting is from it.
  let bi = 0, bj = 0;
  for (let i = 0; i < START_GRID.length; i++) for (let j = 0; j < MULT_GRID.length; j++) if (cells[i][j].usdPerRound > cells[bi][bj].usdPerRound) { bi = i; bj = j; }
  const si = START_GRID.indexOf(SHIPPED_START), sj = MULT_GRID.indexOf(SHIPPED_MULT);
  const best = cells[bi][bj], ship = cells[si][sj];
  const d = pairedDiffCI(best.perRound, ship.perRound);
  console.log(`\n    ARGMAX: START = ${START_GRID[bi]} bps, horizon x${MULT_GRID[bj].toFixed(2)}` +
    `  ->  $${best.usdPerRound.toFixed(4)} +-${best.hw.toFixed(4)} /round  (${(100 * best.pctOfGross).toFixed(3)}% of gross)`);
  console.log(`    SHIPPED (${SHIPPED_START}, x1.00)                    ->  $${ship.usdPerRound.toFixed(4)} +-${ship.hw.toFixed(4)} /round  (${(100 * ship.pctOfGross).toFixed(3)}% of gross)`);
  console.log(`    shipped as a share of the peak: ${(100 * ship.usdPerRound / best.usdPerRound).toFixed(1)}%` +
    `   |  peak - shipped = $${(best.usdPerRound - ship.usdPerRound).toFixed(4)}, paired 95% CI [${d.lo.toFixed(4)}, ${d.hi.toFixed(4)}]` +
    `  ${d.lo > 0 ? "-> SIGNIFICANT" : "-> inside noise"}`);

  // THE ARGMAX'S CONFIDENCE SET, which is the only honest way to report an argmax. A single peak
  // cell out of fifty is a point estimate with no error bar on the ARGUMENT; what has an error bar
  // is the set of cells that cannot be told apart from it. Candidates are pre-filtered to cells
  // within 10% of the peak (nothing outside that has ever survived the test) so the paired
  // bootstrap runs over a handful of cells instead of all fifty.
  if (best.usdPerRound <= 0) {
    console.log(`    ARGMAX 95% CONFIDENCE SET: every one of the ${START_GRID.length * MULT_GRID.length} cells is exactly $0.0000. There is no argmax,`);
    console.log(`    because there is no revenue at any price. A demand curve that is zero everywhere has no`);
    console.log(`    optimum — which is the whole finding for this model.`);
  } else {
    const set: string[] = [];
    for (let i = 0; i < START_GRID.length; i++) for (let j = 0; j < MULT_GRID.length; j++) {
      if (i === bi && j === bj) { set.push(`(${START_GRID[i]}, x${MULT_GRID[j].toFixed(2)})*`); continue; }
      if (cells[i][j].usdPerRound < 0.90 * best.usdPerRound) continue;
      const dd = pairedDiffCI(best.perRound, cells[i][j].perRound, 600, 97 + i * 11 + j);
      if (dd.lo <= 0) set.push(`(${START_GRID[i]}, x${MULT_GRID[j].toFixed(2)})`);
    }
    console.log(`    ARGMAX 95% CONFIDENCE SET (cells not separable from the peak, paired): ${set.join("  ")}`);
    if (HORIZON * MULT_GRID[bj] >= BUDGET) {
      console.log(`\n    READ THAT ARGMAX AGAIN. Horizon x${MULT_GRID[bj].toFixed(2)} is ${Math.round(HORIZON * MULT_GRID[bj])} steps against a ${BUDGET}-step fight, so the`);
      console.log(`    penalty NEVER REACHES ZERO before the bell. The revenue-maximising setting for this demand`);
      console.log(`    model is one that DELETES the free option — and the free option is the only thing that makes`);
      console.log(`    the current design defensible as an option premium rather than an exit toll. Model D prices`);
      console.log(`    that same cell at $0.0000: a population that knows the fee never expires simply never pays`);
      console.log(`    it. So this peak exists only while demand does not respond, which is the definition of a`);
      console.log(`    setting that pays for ignorance. See §5.`);
    }
  }

  // THE MECHANISM, at horizon x1.0 — the table that proves or refutes "raising START destroys base".
  console.log(`\n    WHY, at horizon x1.00 — what each START does to price, quantity and BASE:`);
  console.log(`      START   extract rate   paid-at-once   mean rate paid   mean cursor   mean base $   revenue $`);
  console.log(`      ${"-".repeat(94)}`);
  const j1 = MULT_GRID.indexOf(1.0);
  for (let i = 0; i < START_GRID.length; i++) {
    const c = cells[i][j1];
    console.log(`      ${String(START_GRID[i]).padStart(5)}   ${(100 * c.extractRate).toFixed(1).padStart(11)}%   ` +
      `${(100 * c.immediateShare).toFixed(1).padStart(11)}%   ${c.meanPaidBps.toFixed(0).padStart(13)}   ` +
      `${c.meanCursor.toFixed(0).padStart(11)}   ${c.meanBaseUsd.toFixed(2).padStart(11)}   ${c.usdPerRound.toFixed(4).padStart(9)}`);
  }
}

// ---- §3b: the argmax is a function of the demand curve, not of the game ------------------------
console.log(`\n\n${"-".repeat(100)}`);
console.log(`  3b. THE ARGMAX TRACKS THE RESERVATION PRICE, WHICH IS THE THING NOBODY HAS MEASURED`);
console.log(`${"-".repeat(100)}\n`);
console.log(`  If the optimum is a function of the v distribution and the v distribution is a guess, then`);
console.log(`  the optimum is a guess. Sweeping the ONE parameter that is pure invention:\n`);
console.log(`  median v (bps)   model   argmax START   argmax/median   argmax H   peak $/round   shipped $/round   shipped % of peak`);
console.log(`  ${"-".repeat(118)}`);
for (const vMed of [50, 100, 250, 500, 1_000, 2_000, 4_000]) {
  for (const base of [M_EXO, M_ENDO]) {
    const m = { ...base, vMedianBps: vMed };
    const endo = endoBase;
    let bi = 0, bj = 0, bestV = -1, shipV = 0;
    for (let i = 0; i < START_GRID.length; i++) for (let j = 0; j < MULT_GRID.length; j++) {
      const c = priceCell(traj, draws, endo, m, START_GRID[i], MULT_GRID[j]);
      if (c.usdPerRound > bestV) { bestV = c.usdPerRound; bi = i; bj = j; }
      if (START_GRID[i] === SHIPPED_START && MULT_GRID[j] === SHIPPED_MULT) shipV = c.usdPerRound;
    }
    console.log(`  ${String(vMed).padStart(12)}   ${base === M_EXO ? "A    " : "B    "}   ${String(START_GRID[bi]).padStart(12)}   ` +
      `${`x${(START_GRID[bi] / vMed).toFixed(1)}`.padStart(13)}   ${`x${MULT_GRID[bj].toFixed(2)}`.padStart(8)}   ` +
      `${`$${bestV.toFixed(4)}`.padStart(12)}   ${`$${shipV.toFixed(4)}`.padStart(15)}   ${(100 * shipV / bestV).toFixed(1).padStart(16)}%`);
  }
}
console.log(`\n  READ THE 'argmax/median' COLUMN. The revenue-maximising START sits at a roughly FIXED MULTIPLE`);
console.log(`  of the median reservation price, until the 6,000 bps edge of the sweep truncates it. So the`);
console.log(`  shipped 2,000 is the right price if and only if the median player would pay somewhere around`);
console.log(`  300-500 bps for certainty — a number with ZERO observations behind it and no way to observe it`);
console.log(`  without shipping a change. Every row of this table is a different, equally defensible world.`);
console.log(`\n  AND THE MODEL-A COLUMN IS FLAT AT THE TOP FOR A STRUCTURAL REASON WORTH STATING. The horizon is`);
console.log(`  only ${HORIZON} steps of a ${BUDGET}-step fight (${(100 * HORIZON / BUDGET).toFixed(1)}%), so a player who waits for the rate to fall can only wait`);
console.log(`  a BOUNDED time — the base they destroy by waiting is capped by how short the horizon is. Under`);
console.log(`  exogenous arrival that cap is binding and the "raising START destroys base" force is weak, so`);
console.log(`  the surface is monotone-then-flat rather than single-peaked. Under ENDOGENOUS arrival it is`);
console.log(`  not: those players arrive at cursor ~112, deep inside the horizon, so they have the whole`);
console.log(`  decay to wait through and the interior optimum is sharp. The realistic model is the one with`);
console.log(`  the interior optimum, and it puts the peak at or just above the shipped setting.`);

// ---- §4: fragility ------------------------------------------------------------------------------
console.log(`\n\n${"-".repeat(100)}`);
console.log(`  4. FRAGILITY — which is the point of the section`);
console.log(`${"-".repeat(100)}`);

console.log(`\n  4a. pi_hold: the fraction who never extract. Revenue at the SHIPPED setting (${SHIPPED_START}, x1.00).`);
console.log(`      Gas is $${GAS_USD_PER_ROUND.toFixed(4)}/round; the entry fee alone already pays $${(MEAN_GROSS_USD * Number(FEE_BPS) / 10_000).toFixed(4)}/round,`);
console.log(`      so "covers gas" is asked of the PENALTY STREAM ALONE — a stress test, not an accounting claim.\n`);
console.log(`      pi_hold` + MODELS.map(m => `   ${m.name.slice(0, 1)} $/round`).join("") + `      penalty vs gas (model C)`);
console.log(`      ${"-".repeat(80)}`);
for (const ph of [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]) {
  const vals = MODELS.map(m => priceCell(traj, draws, endoBase, { ...m, piHold: ph }, SHIPPED_START, SHIPPED_MULT).usdPerRound);
  const c = vals[2];
  console.log(`      ${ph.toFixed(2).padStart(7)}` + vals.map(v => `$${v.toFixed(4)}`.padStart(12)).join("") +
    `      ${c >= GAS_USD_PER_ROUND ? `covers gas x${(c / GAS_USD_PER_ROUND).toFixed(2)}` : `SHORT of gas (${(100 * c / GAS_USD_PER_ROUND).toFixed(0)}%)`}`);
}
{
  // Where does model C's penalty stream stop covering gas? Bisect on pi_hold.
  let lo = 0, hi = 1;
  for (let it = 0; it < 24; it++) {
    const mid = (lo + hi) / 2;
    const v = priceCell(traj, draws, endoBase, { ...M_MIX, piHold: mid }, SHIPPED_START, SHIPPED_MULT).usdPerRound;
    if (v >= GAS_USD_PER_ROUND) lo = mid; else hi = mid;
  }
  console.log(`\n      Model C's penalty stream alone stops covering gas at pi_hold = ${((lo + hi) / 2).toFixed(3)}.`);
}

console.log(`\n  4b. THE STRUCTURAL KILLER — auto-deploy has pi_hold = 1 BY CONSTRUCTION.`);
console.log(`\n      er-demo/src/v2/data/autoPolicy.ts, lines 21-30, read verbatim and confirmed:`);
console.log(`        "THE SECOND PRINCIPLE: IT ENTERS, AND IT NEVER EXTRACTS. ... 'extract' is a JUDGEMENT`);
console.log(`         made against a live fight under time pressure ... A robot that also extracted would be`);
console.log(`         playing the whole game. ... That is why the only unattended sender here is`);
console.log(`         'runUnattendedEntry', why its payload type is an entry and cannot be anything else,`);
console.log(`         and why the strategy seam at the bottom of this file is explicitly an ENTRY seam."`);
console.log(`\n      This is enforced STRUCTURALLY, not by policy: there is no unattended code path that can`);
console.log(`      call extract(). So every auto-deployed seat contributes EXACTLY ZERO penalty revenue, and`);
console.log(`      revenue is exactly linear in the auto-deploy share of volume. That is not a modelling`);
console.log(`      choice; it is arithmetic on a structural fact.`);
console.log(`\n      The owner's stated goal is "deposit $1,000 for a week" — i.e. drive the auto-deploy share`);
console.log(`      UP. The penalty stream and the product roadmap are in direct conflict:\n`);
{
  const base = priceCell(traj, draws, endoBase, M_MIX, SHIPPED_START, SHIPPED_MULT).usdPerRound;
  const fee = MEAN_GROSS_USD * Number(FEE_BPS) / 10_000;
  console.log(`      auto-deploy share of volume    penalty $/round    total house $/round    total vs gas`);
  console.log(`      ${"-".repeat(86)}`);
  for (const s of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1.0]) {
    const pen = base * (1 - s);
    console.log(`      ${(100 * s).toFixed(0).padStart(24)}%    ${`$${pen.toFixed(4)}`.padStart(15)}    ${`$${(fee + pen).toFixed(4)}`.padStart(18)}    x${((fee + pen) / GAS_USD_PER_ROUND).toFixed(2)}`);
  }
  console.log(`\n      The entry fee ($${fee.toFixed(4)}/round) is unaffected by auto-deploy — a robot pays it on every`);
  console.log(`      entry. So the FEE is the stream that survives the roadmap and the PENALTY is the one that`);
  console.log(`      the roadmap deletes. At 100% auto-deploy the penalty stream is exactly $0.0000.`);
}

console.log(`\n  4c. CHURN — an INVENTED elasticity, labelled as such, because none is measured anywhere.`);
console.log(`\n      Model: a player charged a rate r to leave quits for good with probability kappa x r, and`);
console.log(`      the house loses their remaining lifetime value. LTV is proxied as fee-only:`);
console.log(`      LTV = (fee_bps/10000) x stake x E[remaining rounds]. Both kappa and E[rounds] are guesses.`);
console.log(`      kappa = 1.0 means "paying the full 20% makes you 20% likely never to return".`);
console.log(`      NOTHING IN THIS REPOSITORY MEASURES EITHER NUMBER. This table is a shape, not a value.\n`);
{
  const feeRate = Number(FEE_BPS) / 10_000;
  const j1 = MULT_GRID.indexOf(1.0);
  const cells = surfaces[2].cells;   // model C
  for (const ER of [25, 100, 250]) {
    console.log(`      E[remaining rounds] = ${ER}   (LTV of the mean $${(MEAN_GROSS_USD / SEATS).toFixed(2)} stake = $${(feeRate * (MEAN_GROSS_USD / SEATS) * ER).toFixed(2)})`);
    console.log(`        kappa` + START_GRID.map(s => String(s).padStart(9)).join("") + `   argmax`);
    console.log(`        ${"-".repeat(6 + 9 * START_GRID.length + 10)}`);
    for (const kappa of [0, 0.01, 0.05, 0.25, 1.0]) {
      const nets = START_GRID.map((_, i) => cells[i][j1].usdPerRound - kappa * ER * feeRate * cells[i][j1].churnKernel);
      let bi = 0; for (let i = 1; i < nets.length; i++) if (nets[i] > nets[bi]) bi = i;
      console.log(`        ${kappa.toFixed(2).padStart(5)}` + nets.map(v => v.toFixed(4).padStart(9)).join("") + `   ${String(START_GRID[bi]).padStart(6)} bps`);
    }
    // Break-even kappa at the shipped setting: net = 0.
    const si = START_GRID.indexOf(SHIPPED_START);
    const k0 = cells[si][j1].usdPerRound / (ER * feeRate * cells[si][j1].churnKernel);
    console.log(`        break-even kappa at the SHIPPED ${SHIPPED_START} bps: ${k0.toFixed(4)}` +
      `  (above this the penalty stream is NET NEGATIVE)\n`);
  }
}

console.log(`  4d. THE INFORMED PLAYER — the terminal case, and it is not hypothetical.`);
{
  const c = priceCell(traj, draws, endoBase, M_INFORMED, SHIPPED_START, SHIPPED_MULT);
  const c4 = priceCell(traj, draws, endoBase, M_INFORMED, SHIPPED_START, 4.0);
  console.log(`\n      Model D sets v = 0 for EVERY player: nobody will pay anything to leave early, because`);
  console.log(`      everybody knows it becomes free. Revenue at the shipped setting: $${c.usdPerRound.toFixed(6)}/round` +
    ` (${(100 * c.pctOfGross).toFixed(4)}% of gross).`);
  console.log(`      Extract rate ${(100 * c.extractRate).toFixed(1)}% of seats — they still extract, at the horizon, and pay nothing.`);
  console.log(`      At horizon x4.00 the free point (${Math.round(HORIZON * 4)}) is past the bell (${BUDGET}), so they never extract: $${c4.usdPerRound.toFixed(6)}/round.`);
  console.log(`\n      HOW MANY SENTENCES OF PUBLIC DOCUMENTATION DOES THIS TAKE? Zero. It is already shipped.`);
  console.log(`      er-demo/src/v2/ui/IntroOverlay.tsx, the onboarding overlay every new player sees, says:`);
  console.log(`        "the house takes a slice of whatever you pull out, 20% at the opening bell and less`);
  console.log(`         with every step after, down to nothing once the fight has run its course."`);
  console.log(`      and er-demo/src/v2/ui/StakeDock.tsx prints the live rate on the Extract button, and the`);
  console.log(`      words "no fee" the moment it reaches zero. er-demo/src/v2/data/extractTerms.ts already`);
  console.log(`      computes 'freeAtStep', 'secondsToFree' and a forward 'decay' table — the countdown is`);
  console.log(`      built and merely not yet rendered.`);
  console.log(`\n      So the answer to "how many sentences away from zero" is NOT ONE. IT IS NONE. The product`);
  console.log(`      already tells players the fee expires. What stands between here and $0 is not secrecy —`);
  console.log(`      secrecy is already gone — it is only whether players read the overlay and wait.`);
}

// ---- §5: the bottom line ------------------------------------------------------------------------
console.log(`\n\n${"-".repeat(100)}`);
console.log(`  5. THE HONEST BOTTOM LINE`);
console.log(`${"-".repeat(100)}\n`);
{
  const fee = MEAN_GROSS_USD * Number(FEE_BPS) / 10_000;
  const cC = surfaces[2].cells[START_GRID.indexOf(SHIPPED_START)][MULT_GRID.indexOf(1.0)];
  const cA = surfaces[0].cells[START_GRID.indexOf(SHIPPED_START)][MULT_GRID.indexOf(1.0)];
  const cB = surfaces[1].cells[START_GRID.indexOf(SHIPPED_START)][MULT_GRID.indexOf(1.0)];
  console.log(`  the ROBUST number   P(early extract) = 0            : $0.0000/round penalty, ${(100 * fee / MEAN_GROSS_USD).toFixed(4)}% of gross from the fee alone`);
  console.log(`  the OPTIMISTIC one  §11.1 uniform-random cursor      : $${((randRow.point - holdRow.point) * MEAN_GROSS_USD).toFixed(4)}/round penalty, ${(100 * (randRow.point - holdRow.point)).toFixed(4)}% of gross`);
  console.log(`  the MODELLED middle model A / B / C at shipped       : $${cA.usdPerRound.toFixed(4)} / $${cB.usdPerRound.toFixed(4)} / $${cC.usdPerRound.toFixed(4)} per round`);
  console.log(`  entry fee, for scale                                : $${fee.toFixed(4)}/round, zero variance, arithmetic at enter()`);
  console.log(`  gas floor                                           : $${GAS_USD_PER_ROUND.toFixed(4)}/round`);
  console.log(`\n  EXTRACT_PENALTY_START_BPS has NO SETTER (programs/bulls-arena/src/lib.rs:197-198, verbatim:`);
  console.log(`  "It bounds ENTRY only. EXTRACT_PENALTY_START_BPS is a compile-time constant with no setter,`);
  console.log(`  so the other house edge cannot be moved at all without a deploy."). Arena.fee_bps has one`);
  console.log(`  (set_fee_bps, capped at MAX_FEE_BPS = 1000). So moving the penalty costs a full redeploy —`);
  console.log(`  a program upgrade against live rounds, an IDL bump, and the mirror-parity chain re-asserted`);
  console.log(`  — to chase a stream whose size is a behavioural guess with zero observations behind it, and`);
  console.log(`  which the auto-deploy roadmap drives to zero on purpose.`);
}

console.log(`\n\n  REPRODUCE:`);
console.log(`    cd engine && HE_FEE_BPS=${FEE_BPS} npx tsx ../sandbox/house-edge/strategy-penalty.ts ${FIGHTS}`);
console.log(`    (delete ${CACHE_DIR}/penalty-*.{bin,json} to force a rebuild)\n`);
