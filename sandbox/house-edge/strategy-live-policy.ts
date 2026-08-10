// SANDBOX. Run from engine/:
//   npx tsx ../sandbox/house-edge/strategy-live-policy.ts [rounds] [trials]
//   SOL_USD=200 npx tsx ../sandbox/house-edge/strategy-live-policy.ts
//
// THE HOUSE'S ACTUAL POSITION UNDER THE ACTUAL DEPLOYED POLICY.
//
// Every other script in this directory models a house the operator might run. This one models the
// house the keeper IS running, by reimplementing `er-demo/scripts/keeper/houseSizing.ts` exactly —
// the same ladder, the same avalanche hash for stakes, the same greedy side allocation, the same
// "never extract". Numbers below therefore describe the live devnet arena, not a strategy proposal.
//
// SOURCE OF EVERY CONSTANT, so this can be re-verified rather than believed:
//   HOUSE_FLOOR = 2, HOUSE_TARGET = 4, DISPLACEMENT = 2, HOUSE_MAX = 6
//                                          er-demo/scripts/keeper/houseSizing.ts:41,74,80,86
//   HOUSE_STAKE_MIN_USD = 5, HOUSE_STAKE_MAX_USD = 50            houseSizing.ts:148-149
//   houseFighterCount / allocateHouseSides / houseStake / mix    houseSizing.ts:116-121,135-144,174-183,193-206
//   house never calls `extract`                                   grep over scripts/keeper: 0 call sites
//   house pays the same fee as a player                           lib.rs:1253,1268 — no caller check
//   keeper cost 0.00981 SOL/round, all-in, reconciled over 28 real rounds
//                                          er-demo/scripts/keeper/config.ts:114, keeper/README.md:145,595
//
// ================================================================================================
// THE FACT THAT DECIDES THE ANSWER, AND IT IS NOT AN ECONOMIC ONE
// ================================================================================================
// `programs/bulls-arena/src/lib.rs` MOVES NO TOKENS. Verified, not assumed: zero occurrences of
// `anchor_spl`, `token::transfer` or `TokenAccount` in the file; `Enter<'info>` (lib.rs:2413-2425)
// carries five accounts and not one of them is a token account; `programs/vault/` is excluded from
// the workspace `members` and still declares the placeholder id `VauLt1111...`.
//
// So `fees_collected`, `penalties_collected` and `Treasury.fees_accrued` are u64 COUNTERS. The 1%
// is real arithmetic over unreal money. On the live site every balance is browser localStorage
// (`er-demo/src/v2/data/simLedger.ts`, key `v2.sim.ledger.1`, marked SIM on every surface).
//
// The script therefore reports TWO regimes and refuses to blend them:
//
//   REGIME A — TODAY (non-custodial). Ledger revenue is a number in an account. The only real cash
//              flow is the keeper's gas and rent, which is a genuine, measured, outgoing cost.
//   REGIME B — IF CUSTODY SHIPS. The same ledger arithmetic, but the units are tokens. This is the
//              regime every "house edge" conversation has implicitly been about.
//
// Regime B is an EXTRAPOLATION. It assumes a custody path that does not exist yet behaves exactly
// like the counters do. Labelled as such everywhere it appears.

import { newRound, enter, tick, extract, settle, penaltyHorizonSteps, conservationHolds } from "../../engine/src/er-sim.ts";
import { stepBudget } from "./fight-variant.ts";
import { BANDS, usd, toUsd } from "./lobby.ts";
import { mulberry32 } from "./rng.ts";
import { createHash } from "node:crypto";

const ROUNDS = Number(process.argv[2] ?? 6000);
const TRIALS = Number(process.argv[3] ?? 300);
const TAG = "live-policy-v1";

const FEE_BPS = 100n;                     // MEASURED on chain (round #27: 680,000 on 68,000,000)
const KEEPER_SOL_PER_ROUND = 0.00981;     // MEASURED, config.ts:114
const SOL_USD = Number(process.env.SOL_USD ?? 150);   // ASSUMPTION
const MAX_FIGHTERS = 48;

// ---- houseSizing.ts, reimplemented ---------------------------------------------------------------
//
// THE POLICY MOVED WHILE THIS WAS BEING MEASURED, and that is recorded rather than quietly absorbed.
// At the start of the session (tree clean at commit 8ccf1ea) the constants were local literals:
//     HOUSE_FLOOR 2, HOUSE_TARGET 4, DISPLACEMENT 2, HOUSE_MAX 6, stake band $5-$50
// giving the ladder 0 real -> 4 house, 1 -> 2, 2+ -> 0 (plus the empty-side cover fighter).
//
// They are now env-tunable in `config.ts` with MUCH more aggressive defaults, and `houseSizing.ts`
// gained an early return for the empty room:
//     HOUSE_WALLET_COUNT      10   (config.ts:524, was 6)
//     HOUSE_BOARD_TARGET      10   (config.ts:539, was 4)
//     HOUSE_DISPLACEMENT       1   (config.ts:551, was 2)
//     HOUSE_STAKE_MAX_USD     20   (config.ts:570, was 50)
//     HOUSE_MAX_WITHOUT_REAL_PLAYER 1  (houseSizing.ts:114, new)
// config.ts:538 says so itself: "KEEPER_HOUSE_BOARD_TARGET=4 with KEEPER_HOUSE_DISPLACEMENT=2
// restores the old ladder exactly."
//
// Set POLICY=old to measure the ladder as it was; the default measures the ladder as it is. Both are
// reported in HOUSE-STRATEGY.md, because the DIRECTION of the change is the finding: the house now
// stays in the lobby far longer, which is precisely the regime in which the treasury figure and the
// real revenue diverge most.
const OLD_POLICY = process.env.POLICY === "old";
const HOUSE_FLOOR = 2;
const HOUSE_TARGET = OLD_POLICY ? 4 : 10;
const DISPLACEMENT = OLD_POLICY ? 2 : 1;
const HOUSE_MAX = OLD_POLICY ? 6 : 10;
const HOUSE_MAX_WITHOUT_REAL_PLAYER = OLD_POLICY ? 4 : 1;
const HOUSE_STAKE_MIN_USD = 5, HOUSE_STAKE_MAX_USD = OLD_POLICY ? 50 : 20;

function avalanche(value: number): number {
  let h = Math.trunc(value) >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x21f0aaad);
  h ^= h >>> 15; h = Math.imul(h, 0x735a2d97);
  h ^= h >>> 15; return h >>> 0;
}
const mix = (roundNo: number, walletIndex: number) =>
  avalanche((avalanche(roundNo) ^ (avalanche(walletIndex) + 0x9e3779b9)) >>> 0);

/** houseSizing.ts:168-182 */
function houseFighterCount(side0: number, side1: number): number {
  const realTotal = side0 + side1;
  // A room with nobody real in it must not be able to hold a fight. Early return, not a clamp —
  // houseSizing.ts:170-174 argues the difference.
  if (realTotal === 0) return HOUSE_MAX_WITHOUT_REAL_PLAYER;
  const throttled = Math.max(HOUSE_FLOOR - realTotal, HOUSE_TARGET - DISPLACEMENT * realTotal);
  const cover = (side0 === 0 ? 1 : 0) + (side1 === 0 ? 1 : 0);
  return Math.max(0, Math.min(HOUSE_MAX, Math.max(throttled, cover)));
}
/** houseSizing.ts:135-144 */
function allocateHouseSides(count: number, side0: number, side1: number): (0 | 1)[] {
  const filled: [number, number] = [side0, side1]; const out: (0 | 1)[] = [];
  for (let i = 0; i < count; i++) { const s: 0 | 1 = filled[1] < filled[0] ? 1 : 0; filled[s]++; out.push(s); }
  return out;
}
/** houseSizing.ts:174-183 */
const houseStakeUsd = (roundNo: number, walletIndex: number) =>
  HOUSE_STAKE_MIN_USD + (mix(roundNo, walletIndex) % (HOUSE_STAKE_MAX_USD - HOUSE_STAKE_MIN_USD + 1));

// ---- the round ----------------------------------------------------------------------------------
interface Out {
  realCount: number; houseFighters: number;
  grossRealU: bigint; grossHouseU: bigint;
  feesRealU: bigint; feesHouseU: bigint; penRealU: bigint;
  housePnlU: bigint; netHouseU: bigint;
  ok: boolean;
}

/** ASSUMPTIONS about real players, isolated here: how many turn up, what they stake, whether they
 *  bail early, and which side they pick. None of these is measured — there is no player-behaviour
 *  data in the repo (HOUSE-EDGE-STUDY.md §8 uncertainty 2). All are swept below. */
function simRound(roundNo: number, realCount: number, extractProb: number, rnd: () => number): Out {
  const round = newRound(createHash("sha256").update(`${TAG}|${roundNo}|${realCount}|${extractProb}`).digest());
  const isHouse: boolean[] = []; const grossUnits: bigint[] = [];

  // Real players first — the keeper's throttle reads the real side counts at T-12s, so the real
  // crowd is what the house sizes against.
  let s0 = 0, s1 = 0;
  const realSides: (0 | 1)[] = [];
  for (let i = 0; i < realCount; i++) { const side = (rnd() < 0.5 ? 0 : 1) as 0 | 1; realSides.push(side); if (side === 0) s0++; else s1++; }
  const hCount = Math.min(houseFighterCount(s0, s1), MAX_FIGHTERS - realCount);
  const hSides = allocateHouseSides(hCount, s0, s1);

  for (let i = 0; i < realCount; i++) {
    const b = BANDS[Math.floor(rnd() * BANDS.length)];
    const g = usd(b.lo + rnd() * (b.hi - b.lo));
    enter(round, `p${i}`, realSides[i], g, FEE_BPS); isHouse.push(false); grossUnits.push(g);
  }
  for (let i = 0; i < hCount; i++) {
    const g = usd(houseStakeUsd(roundNo, i));
    enter(round, `h${i}`, hSides[i], g, FEE_BPS); isHouse.push(true); grossUnits.push(g);
  }

  const n = round.fighters.length;
  let feesRealU = 0n, feesHouseU = 0n;
  for (let i = 0; i < n; i++) { const f = (grossUnits[i] * FEE_BPS) / 10_000n; if (isHouse[i]) feesHouseU += f; else feesRealU += f; }

  let penRealU = 0n;
  if (n >= 2) {
    const budget = stepBudget(n), horizon = Number(penaltyHorizonSteps(n));
    const when = new Map<number, number[]>();
    for (let i = 0; i < n; i++) {
      if (isHouse[i]) continue;                    // MEASURED: the keeper never calls extract
      if (rnd() >= extractProb) continue;
      const c = Math.floor(rnd() * horizon);
      if (c < budget) { const at = when.get(c) ?? []; at.push(i); when.set(c, at); }
    }
    let cursor = 0;
    for (const s of [...when.keys()].sort((a, b) => a - b)) {
      if (s > cursor) { tick(round, s - cursor); cursor = s; }
      for (const i of when.get(s)!) {
        const w = round.fighters[i].wallet;
        if (!round.fighters.find(x => x.wallet === w && x.dead === 0 && x.hp > 0n)) continue;
        penRealU += extract(round, w).penalty;
      }
    }
    if (cursor < budget) tick(round, budget - cursor);
    settle(round);
  }

  let grossRealU = 0n, grossHouseU = 0n, housePnlU = 0n, realNetU = 0n;
  for (let i = 0; i < n; i++) {
    const pnl = round.fighters[i].hp + round.fighters[i].banked - grossUnits[i];
    if (isHouse[i]) { grossHouseU += grossUnits[i]; housePnlU += pnl; } else { grossRealU += grossUnits[i]; realNetU += pnl; }
  }
  const netHouseU = round.feesCollected + round.penaltiesCollected + housePnlU;
  return {
    realCount, houseFighters: hCount, grossRealU, grossHouseU, feesRealU, feesHouseU, penRealU, housePnlU, netHouseU,
    ok: conservationHolds(round) && netHouseU === -realNetU,
  };
}

const mean = (xs: number[]) => xs.reduce((a, x) => a + x, 0) / xs.length;
const sd = (xs: number[]) => { const m = mean(xs); return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(1, xs.length - 1)); };
function ci95(xs: number[], seed = 9, resamples = 2000) {
  const rnd = mulberry32(seed); const d: number[] = [];
  for (let b = 0; b < resamples; b++) { let s = 0; for (let k = 0; k < xs.length; k++) s += xs[Math.floor(rnd() * xs.length)]; d.push(s / xs.length); }
  d.sort((a, b) => a - b); return [d[Math.floor(0.025 * d.length)], d[Math.floor(0.975 * d.length)]] as const;
}

const gasUsd = KEEPER_SOL_PER_ROUND * SOL_USD;

console.log(`\n${"=".repeat(112)}`);
console.log(`THE LIVE HOUSE POLICY — measured, not proposed`);
console.log(`${"=".repeat(112)}`);
console.log(`er-sim.ts + er-demo/scripts/keeper/houseSizing.ts reimplemented exactly  |  ${ROUNDS} rounds/cell`);
console.log(`POLICY = ${OLD_POLICY ? "OLD (session start)" : "CURRENT (config.ts defaults)"}: target ${HOUSE_TARGET}, displacement ${DISPLACEMENT}, max ${HOUSE_MAX}, stake $${HOUSE_STAKE_MIN_USD}-$${HOUSE_STAKE_MAX_USD}`);
console.log(`fee ${FEE_BPS} bps (MEASURED)  |  keeper cost ${KEEPER_SOL_PER_ROUND} SOL/round (MEASURED)  |  SOL $${SOL_USD} (ASSUMPTION)`);
console.log(`=> keeper cost $${gasUsd.toFixed(3)} per round\n`);

console.log(`--- THE HOUSE THROTTLE: the keeper WITHDRAWS as real players arrive ---\n`);
console.log(`real players   house fighters   (houseSizing.ts ladder, worst-case side split)`);
for (let r = 0; r <= 7; r++) {
  const worst = houseFighterCount(r, 0);      // all real on one side — the `cover` term bites
  const even = houseFighterCount(Math.ceil(r / 2), Math.floor(r / 2));
  console.log(`      ${String(r).padStart(2)}          ${String(even).padStart(2)} (even split)   ${String(worst).padStart(2)} (all one side)`);
}
console.log(`\n  THE THROTTLE IS THE WHOLE OF THE CIRCULARITY ANSWER, AND ITS SLOPE IS THE POLICY DECISION.`);
console.log(`  Under the OLD ladder (POLICY=old) house volume collapsed to zero the moment two real`);
console.log(`  players were in, so circular fees could never be more than a rounding note. Under the`);
console.log(`  CURRENT defaults the house withdraws one seat per real player from a target of ${HOUSE_TARGET}, so it`);
console.log(`  is still fielding ${houseFighterCount(1, 1)} fighters at two real players and does not clear out until ${HOUSE_TARGET} of them`);
console.log(`  arrive. That is a much larger circular share for much longer - quantified in the next table.\n`);

console.log(`\n--- REGIME A — TODAY. Ledger revenue is a counter; gas is real money going out. ---\n`);
console.log(`real   house   real gross   LEDGER net house   circular    REAL cash flow    net real`);
console.log(`plyrs  house    per round     revenue (u64)     share       (gas only)       cash/round
       fghtrs
       (mean)`);
console.log("-".repeat(104));

const rows: { rc: number; net: number[]; gr: number[]; circ: number[]; hc: number[]; gh: number[] }[] = [];
for (const rc of [0, 1, 2, 3, 4, 6]) {
  const net: number[] = [], gr: number[] = [], circ: number[] = [], hc: number[] = [], gh: number[] = [];
  let bad = 0;
  for (let r = 0; r < ROUNDS; r++) {
    const o = simRound(r, rc, 0.30, mulberry32((r * 2654435761 + rc * 7919) >>> 0));
    if (!o.ok) bad++;
    net.push(toUsd(o.netHouseU)); gr.push(toUsd(o.grossRealU));
    circ.push(toUsd(o.feesHouseU));
    // ACTUAL house fighters this round, not the ladder's even-split value: real players choose sides
    // independently, so a 2-player lobby lands both on one side about half the time and the
    // empty-side `cover` fighter appears. Printing the ladder value here would have understated the
    // house's exposure in exactly the rows where it exists.
    hc.push(o.houseFighters); gh.push(toUsd(o.grossHouseU));
  }
  if (bad) console.log(`  !!! ACCOUNTING IDENTITY FAILED in ${bad} rounds — discard this row`);
  rows.push({ rc, net, gr, circ, hc, gh });
  const circShare = mean(net) !== 0 ? (100 * mean(circ) / mean(net)).toFixed(1) + "%" : "n/a";
  console.log(
    `${String(rc).padStart(4)}   ${mean(hc).toFixed(2).padStart(5)}   $${mean(gr).toFixed(2).padStart(8)}    $${mean(net).toFixed(3).padStart(8)}` +
    `      ${circShare.padStart(6)}       -$${gasUsd.toFixed(3)}         -$${gasUsd.toFixed(3)}`);
}
console.log(`\n  THE "REAL CASH FLOW" COLUMN IS THE HEADLINE AND IT IS NEGATIVE IN EVERY ROW. Today the arena`);
console.log(`  takes no tokens, so the ledger column buys nothing: the house's realised P&L is exactly`);
console.log(`  minus the keeper's gas, ${KEEPER_SOL_PER_ROUND} SOL = $${gasUsd.toFixed(3)} per round, whatever the fee is set to.\n`);

console.log(`\n--- REGIME B — IF CUSTODY SHIPS (EXTRAPOLATION: no such code path exists today) ---\n`);
console.log(`real   real gross   net house rev    95% CI on the mean     take rate     minus gas     break-even`);
console.log(`plyrs   per round     per round                            of real gross   per round    real gross`);
console.log("-".repeat(112));
for (const R of rows) {
  const [lo, hi] = ci95(R.net, 40 + R.rc);
  const g = mean(R.gr);
  const rate = g > 0 ? mean(R.net) / g : 0;
  const be = rate > 0 ? gasUsd / rate : Infinity;
  console.log(
    `${String(R.rc).padStart(4)}   $${g.toFixed(2).padStart(8)}    $${mean(R.net).toFixed(3).padStart(8)}   [${lo.toFixed(3)}, ${hi.toFixed(3)}]` +
    `     ${g > 0 ? (100 * rate).toFixed(2).padStart(6) + "%" : "   n/a"}     $${(mean(R.net) - gasUsd).toFixed(3).padStart(7)}    ${Number.isFinite(be) ? "$" + be.toFixed(0) : "never"}`);
}
console.log(`\n  "break-even real gross" is the real-player volume per round at which the take rate covers the`);
console.log(`  keeper's gas. Below it the arena loses money per round no matter how good the edge is.\n`);

// -------------------------------------------------------------------------------------------------
console.log(`\n--- RISK: the house's own book, under the live policy ---\n`);
const RC = 2;
const per = rows.find(r => r.rc === RC)!.net;
const s = [...per].sort((a, b) => a - b);
const rowRC = rows.find(r => r.rc === RC)!;
console.log(`At ${RC} real players (the ladder gives ${houseFighterCount(1, 1)} house fighters on an even split, but real`);
console.log(`players pick sides independently, so the empty-side COVER fighter appears in some rounds —`);
console.log(`measured mean house fighters here: ${mean(rowRC.hc).toFixed(2)}, mean house stake at risk $${mean(rowRC.gh).toFixed(2)}):`);
console.log(`  mean ledger net house revenue   $${mean(per).toFixed(4)} / round`);
console.log(`  standard deviation              $${sd(per).toFixed(4)}`);
console.log(`  P(a round is a ledger loss)     ${(100 * per.filter(x => x < 0).length / per.length).toFixed(2)}%`);
console.log(`  5th / 50th / 95th percentile    $${s[Math.floor(0.05 * s.length)].toFixed(3)} / $${s[Math.floor(0.5 * s.length)].toFixed(3)} / $${s[Math.floor(0.95 * s.length)].toFixed(3)}`);
console.log(`  worst round observed            $${s[0].toFixed(3)}`);

console.log(`\n  Ruin, REGIME B, against a stated operating balance. NOTE: the "3.66 SOL" figure in the brief`);
console.log(`  appears NOWHERE in this repository — it could not be verified and is carried as given.`);
for (const bankSol of [0.5, 3.66, 20]) {
  const bank = bankSol * SOL_USD;
  const rnd = mulberry32(31337); let ruin = 0;
  for (let t = 0; t < TRIALS; t++) {
    let cum = 0, dead = false;
    for (let r = 0; r < ROUNDS; r++) { cum += per[Math.floor(rnd() * per.length)] - gasUsd; if (cum < -bank) dead = true; }
    if (dead) ruin++;
  }
  console.log(`    bankroll ${String(bankSol).padStart(5)} SOL = $${bank.toFixed(0).padStart(5)}   P(ruin over ${ROUNDS} rounds, net of gas) = ${(100 * ruin / TRIALS).toFixed(2)}%`);
}
console.log(`\n  REGIME A ruin is a different and simpler calculation: with no token revenue at all, the gas`);
console.log(`  burn is deterministic. A bankroll of B SOL funds B / ${KEEPER_SOL_PER_ROUND} rounds and then stops.`);
for (const bankSol of [0.5, 3.66, 20]) {
  const n = bankSol / KEEPER_SOL_PER_ROUND;
  console.log(`    ${String(bankSol).padStart(5)} SOL  ->  ${n.toFixed(0).padStart(6)} rounds  =  ${(n * 110 / 3600).toFixed(1).padStart(6)} hours at the ~110s cadence`);
}
console.log(``);
