// SANDBOX. Run from engine/:  npx tsx ../sandbox/house-edge/strategy-retention.ts [players] [rounds]
//
// "People leave their tokens in there for a long time" — the owner's own description of the target
// behaviour, and the reason a per-round edge is the wrong unit to think in.
//
// A 1% rake sounds small because it is quoted per ROUND. A retained player does not play one round.
// They redeploy their balance again and again, and the rake compounds against them multiplicatively
// while their own variance compounds as a square root. This script measures the LIFETIME, which is
// the number that decides whether retention is a business model or a countdown.
//
// THE PLAYER MODEL, stated plainly because it is an assumption and not a measurement:
//   * starts with a bankroll
//   * each round stakes a fixed FRACTION of their current balance (swept: 25%, 50%, 100%)
//   * holds to the bell (never extracts) in the base case, so this isolates the ENTRY FEE and
//     charges the player nothing for the penalty. It is therefore the house's WORST case and the
//     player's BEST case.
//   * stops if the balance falls below the minimum entry
// Nothing in the repo measures real player behaviour (HOUSE-EDGE-STUDY.md §8 uncertainty 2).

import { newRound, enter, tick, settle } from "../../engine/src/er-sim.ts";
import { stepBudget } from "./fight-variant.ts";
import { BANDS, usd, toUsd } from "./lobby.ts";
import { mulberry32 } from "./rng.ts";
import { createHash } from "node:crypto";

const PLAYERS = Number(process.argv[2] ?? 4000);
const ROUNDS = Number(process.argv[3] ?? 200);
const FEE_BPS = 100n;
const SEATS = 8;
const START = 100;          // USD
const MIN_ENTRY = 0.01;     // engine/src/arenas.ts MIN_ENTRY; the chain's own floor is stake > 0
const TAG = "retention-v1";

/** One round for ONE tracked player against a field drawn from the five bands. Returns the player's
 *  payout in dollars. The other seats are scenery: they are redrawn each round, which is the
 *  "you meet a fresh lobby every time" assumption. */
function playOne(tag: string, stakeUsd: number, rnd: () => number): number {
  const round = newRound(createHash("sha256").update(tag).digest());
  const g = usd(stakeUsd);
  enter(round, "me", 0, g, FEE_BPS);
  for (let i = 1; i < SEATS; i++) {
    const b = BANDS[Math.floor(rnd() * BANDS.length)];
    enter(round, `o${i}`, (i % 2) as 0 | 1, usd(b.lo + rnd() * (b.hi - b.lo)), FEE_BPS);
  }
  tick(round, stepBudget(round.fighters.length));
  settle(round);
  const me = round.fighters[0];
  return toUsd(me.hp + me.banked);
}

const mean = (xs: number[]) => xs.reduce((a, x) => a + x, 0) / xs.length;
const quant = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

console.log(`\n=== PLAYER LIFETIME: what a retained player's balance does ===`);
console.log(`measured on engine/src/er-sim.ts  |  fee ${FEE_BPS} bps  |  ${SEATS}-seat lobbies`);
console.log(`${PLAYERS} independent players, ${ROUNDS} rounds each, starting balance $${START}`);
console.log(`seeds: sha256("${TAG}|<fraction>|<player>|<round>")   player holds to the bell (pays NO extract penalty)\n`);

console.log(`stake      rounds     mean balance    median      10th pct    P(down)    P(below      house take`);
console.log(`fraction   played                                                        $10)        per player`);
console.log("-".repeat(104));

// ONE PATH PER PLAYER, SAMPLED AT CHECKPOINTS. Running the horizons as separate simulations
// re-walked the same players three times over and cost 3x the fights for no extra information —
// and worse, it made the N=10 and N=200 rows independent samples when they are the same players
// earlier and later, which is exactly the comparison the table is for.
const CHECKPOINTS = [10, 50, 200].filter(x => x <= ROUNDS);
for (const frac of [0.25, 0.5, 1.0]) {
  const at: Map<number, number[]> = new Map(CHECKPOINTS.map(c => [c, []]));
  for (let p = 0; p < PLAYERS; p++) {
    const rnd = mulberry32(((p * 2654435761) ^ Math.round(frac * 1000) * 7919) >>> 0);
    let bal = START;
    for (let r = 0; r < ROUNDS; r++) {
      const stake = Math.min(bal, bal * frac);
      if (stake >= MIN_ENTRY) bal = bal - stake + playOne(`${TAG}|${frac}|${p}|${r}`, stake, rnd);
      if (at.has(r + 1)) at.get(r + 1)!.push(bal);
    }
  }
  for (const N of CHECKPOINTS) {
    const finals = at.get(N)!;
    console.log(
      `${(frac * 100).toFixed(0).padStart(6)}%   ${String(N).padStart(6)}     $${mean(finals).toFixed(2).padStart(9)}   $${quant(finals, 0.5).toFixed(2).padStart(8)}   $${quant(finals, 0.1).toFixed(2).padStart(8)}   ` +
      `${(100 * finals.filter(x => x < START).length / PLAYERS).toFixed(1).padStart(5)}%   ${(100 * finals.filter(x => x < 10).length / PLAYERS).toFixed(1).padStart(5)}%      $${(START - mean(finals)).toFixed(2).padStart(6)}`);
  }
  console.log();
}

console.log(`THE ARITHMETIC THIS CONFIRMS. Staking the FULL balance every round multiplies expected wealth`);
console.log(`by (1 - fee) each time, so after N rounds the player expects to hold (1 - 0.01)^N of what they`);
console.log(`started with:\n`);
console.log(`   rounds     expected fraction remaining    expected loss`);
for (const N of [10, 50, 100, 200, 500]) {
  const f = Math.pow(0.99, N);
  console.log(`   ${String(N).padStart(6)}          ${(100 * f).toFixed(2).padStart(8)}%              ${(100 * (1 - f)).toFixed(2).padStart(7)}%`);
}
console.log(`\n  A 1% rake is not a 1% cost to a retained player. It is 1% PER ROUND, and at the ~110s cadence`);
console.log(`  a player who redeploys their whole balance every round loses HALF of it in about 69 rounds —`);
console.log(`  a little over two hours. Staking a fraction f of the balance slows this to (1 - 0.01f)^N.`);
console.log(`\n  THIS IS THE TENSION IN THE BRIEF, AND IT IS NOT RESOLVABLE BY MEASUREMENT. "People leave their`);
console.log(`  tokens in there for a long time" and "the house takes 1% of every entry" are the same`);
console.log(`  sentence viewed from two ends. The rake is charged on ENTRY, not on time held, so retention`);
console.log(`  only earns the house money to the extent that retained players KEEP RE-ENTERING — and every`);
console.log(`  re-entry is another 1%. The player-facing half of that arithmetic is what decides whether`);
console.log(`  they retain at all, and nothing in this repo measures it.\n`);
