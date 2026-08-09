// SANDBOX. Run: npx tsx sandbox/house-edge/check-seat-law.ts
//
// The sharpest statement of what the deployed fight actually pays, tested against engine/src/er-sim.ts
// rather than the sandbox variant.
//
// THE SEAT LAW (hypothesis):  payout_i  ~=  S_opposing / n_myside
//
// i.e. a fight run to its natural end leaves each SIDE holding the other side's money, split evenly
// across that side's SEATS — and a fighter's own deposit does not appear in the formula at all. It
// enters only as the denominator of ROI:
//
//     ROI_i  ~=  (S_opposing / n_myside) / stake_i  -  1
//
// If that holds, "small stakes have an edge" is the wrong description of the deployed game. The right
// one is "deposits buy nothing; SEATS buy everything", and `MAX_FIGHTERS = 16` is the only thing
// standing between the game and an unbounded sybil.
//
// Tested by predicting each fighter's payout from the formula and reporting the error, across
// lineups chosen to stress it: balanced, lopsided in money, lopsided in headcount, and both.

import { newRound, enter, tick, settle } from "../../engine/src/er-sim.ts";
import { stepBudget, UNITS_PER_USD } from "./fight-variant.ts";
import { createHash } from "node:crypto";

const usd = (v: number) => BigInt(Math.round(v * 1e6));
const toUsd = (u: bigint) => Number(u) / Number(UNITS_PER_USD);
const TRIALS = 3000;

interface Case { label: string; stakes: [number, 0 | 1][]; }
const CASES: Case[] = [
  { label: "4v4 equal, $10 each                ", stakes: [[10, 0], [10, 1], [10, 0], [10, 1], [10, 0], [10, 1], [10, 0], [10, 1]] },
  { label: "4v4, one $200 whale vs seven $5    ", stakes: [[200, 0], [5, 1], [5, 0], [5, 1], [5, 0], [5, 1], [5, 0], [5, 1]] },
  { label: "4v4, money lopsided 4x             ", stakes: [[40, 0], [10, 1], [40, 0], [10, 1], [40, 0], [10, 1], [40, 0], [10, 1]] },
  { label: "2v6, headcount lopsided, equal $   ", stakes: [[10, 0], [10, 1], [10, 1], [10, 1], [10, 0], [10, 1], [10, 1], [10, 1]] },
  { label: "2v6, headcount AND money lopsided  ", stakes: [[60, 0], [10, 1], [10, 1], [10, 1], [60, 0], [10, 1], [10, 1], [10, 1]] },
  { label: "8v8 mixed sizes                    ", stakes: [[100, 0], [3, 1], [50, 0], [80, 1], [8, 0], [20, 1], [30, 0], [5, 1], [12, 0], [60, 1], [4, 0], [15, 1], [90, 0], [7, 1], [25, 0], [40, 1]] },
];

console.log(`\n=== the seat law: does payout = (opposing side's stake) / (my side's seats)? ===`);
console.log(`measured on engine/src/er-sim.ts, ${TRIALS} seeds per case, 20 bps fee, sides ALTERNATED across slots`);
console.log(`(alternated because check-positional-bias.ts shows a blocked layout adds a +-15% slot artefact`);
console.log(` that would otherwise be read as error in this table)\n`);

for (const c of CASES) {
  const n = c.stakes.length;
  const out = new Array(n).fill(0);
  let potSum = 0;
  for (let t = 0; t < TRIALS; t++) {
    const seed = createHash("sha256").update(`seat|${c.label}|${t}`).digest();
    const round = newRound(seed);
    for (let i = 0; i < n; i++) enter(round, `w${i}`, c.stakes[i][1], usd(c.stakes[i][0]), 20n);
    tick(round, stepBudget(n));
    settle(round);
    for (let i = 0; i < n; i++) out[i] += toUsd(round.fighters[i].hp + round.fighters[i].banked);
    potSum += toUsd(round.pot);
  }
  // net-of-fee side totals and seat counts
  const net = c.stakes.map(([v]) => v * 0.998);
  const sideTotal = [0, 0], sideSeats = [0, 0];
  for (let i = 0; i < n; i++) { sideTotal[c.stakes[i][1]] += net[i]; sideSeats[c.stakes[i][1]]++; }

  console.log(`--- ${c.label}  pot $${(potSum / TRIALS).toFixed(2)}  |  side0 $${sideTotal[0].toFixed(1)}/${sideSeats[0]} seats   side1 $${sideTotal[1].toFixed(1)}/${sideSeats[1]} seats`);
  let worst = 0, tot = 0;
  const rows: string[] = [];
  for (let i = 0; i < n; i++) {
    const side = c.stakes[i][1];
    const pred = sideTotal[1 - side] / sideSeats[side];
    const act = out[i] / TRIALS;
    const err = act / pred - 1;
    worst = Math.max(worst, Math.abs(err)); tot += Math.abs(err);
    rows.push(`  slot ${String(i).padStart(2)} side ${side} stake $${String(c.stakes[i][0]).padStart(3)}  predicted $${pred.toFixed(2).padStart(7)}  actual $${act.toFixed(2).padStart(7)}  err ${(err * 100 >= 0 ? "+" : "")}${(err * 100).toFixed(1)}%   ROI ${((act / c.stakes[i][0] - 1) * 100 >= 0 ? "+" : "")}${((act / c.stakes[i][0] - 1) * 100).toFixed(0)}%`);
  }
  console.log(rows.join("\n"));
  console.log(`   mean |err| ${(100 * tot / n).toFixed(1)}%,  worst ${(100 * worst).toFixed(1)}%\n`);
}

console.log(`If the errors are small, a fighter's own deposit predicts NOTHING about the payout: seats do.\n`);
