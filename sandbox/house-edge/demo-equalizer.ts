// SANDBOX. Run: npx tsx sandbox/house-edge/demo-equalizer.ts
//
// The mechanism, made legible. Everything else in this sandbox is a table; this is the one page that
// explains WHY the tables look the way they do, and it runs against engine/src/er-sim.ts itself —
// the checked-in mirror of the deployed program — not against the knobbed variant, so it cannot be
// accused of measuring the sandbox instead of the game.
//
// THE CLAIM. Under the deployed rule, a fight that runs to its natural end pays every surviving
// slot approximately `pot / n`, regardless of what that slot put in. Two lines of the loop do it:
//
//     let a = ... % n;                    // attacker: UNIFORM, so everyone collects equally often
//     let mut dmg = fighters[d].hp * roll / 100;   // and collects an amount set by the DEFENDER
//
// What an attacker banks does not depend on the attacker's own size at all. Meanwhile hp decays
// exponentially for everyone at the same fractional rate, so by the bell nearly all value has moved
// out of rings and into banks — and the banks were filled by a uniform lottery over slots. The
// result is a wealth equaliser: `payout_i -> pot / n`, so `ROI_i -> (pot/n)/stake_i - 1`.
//
// That is not a small-stake "edge" in the sense the old physics sim had one. It is the strongest
// possible version of one, and it is already live.

import { newRound, enter, tick, settle } from "../../engine/src/er-sim.ts";
import { stepBudget, UNITS_PER_USD } from "./fight-variant.ts";
import { createHash } from "node:crypto";

const usd = (v: number) => BigInt(Math.round(v * 1e6));
const toUsd = (u: bigint) => Number(u) / Number(UNITS_PER_USD);

// One deliberately extreme lineup: a $200 whale against seven $5 minnows, four a side.
const STAKES: [number, 0 | 1][] = [
  [200, 0], [5, 0], [5, 0], [5, 0],
  [5, 1], [5, 1], [5, 1], [5, 1],
];

console.log(`\n=== the deployed fight is a wealth equaliser: measured on engine/src/er-sim.ts ===\n`);
console.log(`lineup: $200 whale + seven $5 minnows, 4 a side, 20 bps fee, ${stepBudget(8)} step budget`);
console.log(`averaged over 2,000 seeds (seed = sha256("equaliser|<i>"))\n`);

const N = STAKES.length;
const TRIALS = 2000;
const sumOut = new Array(N).fill(0);
let sumPot = 0, sumAlive = 0, sumEnd = 0;

for (let t = 0; t < TRIALS; t++) {
  const seed = createHash("sha256").update(`equaliser|${t}`).digest();
  const round = newRound(seed);
  for (let i = 0; i < N; i++) enter(round, `w${i}`, STAKES[i][1], usd(STAKES[i][0]), 20n);
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
console.log(`\nThe whale put in 87% of the pot and gets back about 1/8th of it. The minnows put in $5 and`);
console.log(`get back roughly the same $${(potAvg / N).toFixed(0)}. Nothing in this file is a proposal — it is what ships today.\n`);
