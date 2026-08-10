// SANDBOX. Run: npx tsx sandbox/house-edge/demo-equalizer.ts
//
// The mechanism, made legible. Everything else in this sandbox is a table; this is the one page that
// explains WHY the tables look the way they do, and it runs against engine/src/er-sim.ts itself —
// the checked-in mirror of the deployed program — not against the knobbed variant, so it cannot be
// accused of measuring the sandbox instead of the game.
//
// THE CLAIM IT WAS WRITTEN TO DEMONSTRATE. Under the v5 rule, a fight that ran to its natural end
// paid every surviving slot approximately `pot / n`, regardless of what that slot put in. Two lines
// of the loop did it:
//
//     let a = ... % n;                    // attacker: UNIFORM, so everyone collects equally often
//     let mut dmg = fighters[d].hp * roll / 100;   // and collects an amount set by the DEFENDER
//
// What an attacker banked did not depend on the attacker's own size at all. Meanwhile hp decayed
// exponentially for everyone at the same fractional rate, so by the bell nearly all value had moved
// out of rings and into banks — and the banks were filled by a uniform lottery over slots. The
// result was a wealth equaliser: `payout_i -> pot / n`, so `ROI_i -> (pot/n)/stake_i - 1`.
//
// THAT IS NO LONGER WHAT THIS PRINTS, and the file is kept precisely because it is the sharpest
// single page on which to see that. The damage basis is now `min(ring_a, ring_d)` — you cannot take
// more than you brought — so the whale's payout tracks the whale's deposit and `pot / n` predicts
// nothing. The verdict line at the bottom is COMPUTED from the run rather than asserted, so this
// page cannot go on claiming an equaliser after one stops existing. Run it against
// `DEPLOYED_V5` in fight-variant.ts to see the old behaviour.

import { newRound, enter, tick, settle } from "../../engine/src/er-sim.ts";
import { stepBudget, UNITS_PER_USD, FEE_BPS } from "./fight-variant.ts";
import { createHash } from "node:crypto";

const usd = (v: number) => BigInt(Math.round(v * 1e6));
const toUsd = (u: bigint) => Number(u) / Number(UNITS_PER_USD);

// One deliberately extreme lineup: a $200 whale against seven $5 minnows, four a side.
const STAKES: [number, 0 | 1][] = [
  [200, 0], [5, 0], [5, 0], [5, 0],
  [5, 1], [5, 1], [5, 1], [5, 1],
];

console.log(`\n=== does the fight pay by SEAT or by DEPOSIT? measured on engine/src/er-sim.ts ===\n`);
console.log(`lineup: $200 whale + seven $5 minnows, 4 a side, ${FEE_BPS} bps fee, ${stepBudget(8)} step budget`);
console.log(`averaged over 2,000 seeds (seed = sha256("equaliser|<i>"))\n`);

const N = STAKES.length;
const TRIALS = 2000;
const sumOut = new Array(N).fill(0);
let sumPot = 0, sumAlive = 0, sumEnd = 0;

for (let t = 0; t < TRIALS; t++) {
  const seed = createHash("sha256").update(`equaliser|${t}`).digest();
  const round = newRound(seed);
  for (let i = 0; i < N; i++) enter(round, `w${i}`, STAKES[i][1], usd(STAKES[i][0]), FEE_BPS);
  tick(round, stepBudget(N));
  settle(round);
  for (let i = 0; i < N; i++) sumOut[i] += toUsd(round.fighters[i].hp + round.fighters[i].banked);
  sumPot += toUsd(round.pot);
  sumAlive += round.fighters.filter(f => f.dead === 0).length;
  let ringLeft = 0; for (const f of round.fighters) ringLeft += toUsd(f.hp);
  sumEnd += ringLeft;
}

const potAvg = sumPot / TRIALS;
console.log(`slot   stake      mean payout    ROI        pot/n for reference`);
for (let i = 0; i < N; i++) {
  const stake = STAKES[i][0], out = sumOut[i] / TRIALS;
  console.log(`  ${String(i).padStart(2)}   $${String(stake).padStart(6)}   $${out.toFixed(2).padStart(9)}   ${((out / stake - 1) * 100).toFixed(1).padStart(8)}%       $${(potAvg / N).toFixed(2)}`);
}
console.log(`\npot (net of fee) $${potAvg.toFixed(2)}   ->   pot/n = $${(potAvg / N).toFixed(2)}`);
console.log(`ring value left unbanked at the bell: $${(sumEnd / TRIALS).toFixed(2)} of $${potAvg.toFixed(2)} (${(100 * sumEnd / sumPot).toFixed(1)}%)`);
console.log(`fighters still standing at the bell: ${(sumAlive / TRIALS).toFixed(2)} of ${N}`);
// THE VERDICT IS COMPUTED, NOT WRITTEN DOWN. Two rival predictors — "you get back a seat's share of
// the pot" and "you get back what you deposited" — scored by mean absolute error across the slots.
// Whichever fits is what the fight currently pays on, and this page reports that rather than the
// answer that happened to be true on the day it was written.
const seatShare = potAvg / N;
let errSeat = 0, errStake = 0;
for (let i = 0; i < N; i++) {
  const out = sumOut[i] / TRIALS, stake = STAKES[i][0];
  errSeat += Math.abs(out - seatShare) / seatShare;
  errStake += Math.abs(out - stake) / stake;
}
errSeat = 100 * errSeat / N; errStake = 100 * errStake / N;
console.log(`\npredictor "payout = pot/n  (a SEAT's share)": mean |error| ${errSeat.toFixed(1)}%`);
console.log(`predictor "payout = your own deposit"       : mean |error| ${errStake.toFixed(1)}%`);
console.log(
  errStake < errSeat
    ? `\n-> DEPOSITS. The whale put in 87% of the pot and gets ~87% of it back. Seats buy nothing.\n`
    : `\n-> SEATS. The whale put in 87% of the pot and gets back about 1/${N}th of it, the same as a $5 minnow.\n`,
);
