// SANDBOX. Run from engine/:  npx tsx ../sandbox/house-edge/check-house-bankroll.ts [rounds] [trials]
//
// "having a house edge of lets say 1%, so that over long time money accumulates in the house wallets
// and house treasury" — the owner's stated priority. THE RAKE IS NOT THE WHOLE ANSWER, and this is
// the script that says why.
//
// The house has two P&L lines, and only one of them has an edge:
//
//   1. THE RAKE.        1% of gross entries, deterministic, zero variance. Measured in
//                       check-house-accrual.ts: exactly 1.0000%.
//   2. THE BOT BOOK.    If the house fields bots to fill lobbies (engine/src/bot-bank.ts,
//                       bot-wallets.ts, seed-bots.ts do exactly that), those bots are ORDINARY
//                       FIGHTERS. The shipped rule is size-neutral, so their expected P&L is zero and
//                       their realised P&L is a random walk with a standard deviation far larger,
//                       per round, than the rake.
//
// Adding a zero-mean random walk to a small positive drift does not change the drift. It changes how
// long you must wait to SEE the drift, and it changes the probability that the house is behind at any
// given moment. That is a bankroll question, not an edge question, and it is the one that decides
// whether "money accumulates" is true on the timescale anybody actually looks at.
//
// Measured on engine/src/er-sim.ts. The lobby is 16 seats — the study's own room size, NOT the
// chain's cap, which is now MAX_FIGHTERS = 48; see `SEATS`. The house takes `botSeats` of them at a
// fixed stake, the rest are drawn from the five bands.

import { newRound, enter, tick, settle } from "../../engine/src/er-sim.ts";
import { stepBudget, FEE_BPS } from "./fight-variant.ts";
import { BANDS, usd, toUsd } from "./lobby.ts";
import { mulberry32 } from "./rng.ts";
import { createHash } from "node:crypto";

const ROUNDS = Number(process.argv[2] ?? 2000);
const TRIALS = Number(process.argv[3] ?? 400);
/** The room size this study models — A MODELLING CHOICE, NOT THE CHAIN'S CAP, and the distinction
 *  matters now that the two have stopped coinciding: `MAX_FIGHTERS` is 48. Left at 16 deliberately,
 *  because the recorded results are keyed to `STUDY_SEED = "house-bankroll-v1"` and re-scoping the
 *  room silently would invalidate them while still printing a number. A 48-seat run is a new study
 *  with a new seed, not a bigger version of this one. */
const SEATS = 16;
const BOT_STAKE = 25;      // USD per bot seat — mid-band, i.e. the house looks like an ordinary player
const STUDY_SEED = "house-bankroll-v1";

interface Outcome { rake: number; botPnl: number; }

/** One round. Returns the house's two P&L lines in dollars. */
function playRound(trial: number, r: number, botSeats: number): Outcome {
  const rnd = mulberry32(((trial * 2654435761) ^ (r * 40503) ^ (botSeats * 7919)) >>> 0);
  const seed = createHash("sha256").update(`${STUDY_SEED}|${trial}|${r}|${botSeats}`).digest();
  const round = newRound(seed);
  const isBot: boolean[] = [];
  const grossIn: number[] = [];

  // Alternate sides so the house is not concentrated on one — same-side pairs never exchange, so
  // concentrating the bots would quietly change how often they can trade at all.
  for (let i = 0; i < botSeats; i++) {
    enter(round, `h${i}`, (i % 2) as 0 | 1, usd(BOT_STAKE), FEE_BPS);
    isBot.push(true); grossIn.push(BOT_STAKE);
  }
  for (let i = 0; i < SEATS - botSeats; i++) {
    const b = BANDS[Math.floor(rnd() * BANDS.length)];
    const v = b.lo + rnd() * (b.hi - b.lo);
    enter(round, `p${i}`, ((i + 1) % 2) as 0 | 1, usd(v), FEE_BPS);
    isBot.push(false); grossIn.push(v);
  }
  tick(round, stepBudget(round.fighters.length));
  settle(round);

  const rake = toUsd(round.feesCollected);
  let botPnl = 0;
  for (let i = 0; i < round.fighters.length; i++) {
    if (!isBot[i]) continue;
    const f = round.fighters[i];
    botPnl += toUsd(f.hp + f.banked) - grossIn[i];   // includes the fee the bot itself paid
  }
  return { rake, botPnl };
}

console.log(`\n=== DOES THE HOUSE'S MONEY ACTUALLY ACCUMULATE, AND HOW LONG DOES IT TAKE TO SEE IT? ===`);
console.log(`measured on engine/src/er-sim.ts  |  fee = ${FEE_BPS} bps  |  ${SEATS}-seat lobbies, house bots at $${BOT_STAKE}`);
console.log(`${TRIALS} independent trials of ${ROUNDS} rounds each. Seeds: sha256("${STUDY_SEED}|<trial>|<round>|<botSeats>")\n`);

console.log(`bot   house P&L after ${ROUNDS} rounds        rake alone      bot book alone       P(house`);
console.log(`seats   mean         stdev                  (zero var)      mean      stdev       behind)   rake:noise`);
console.log("-".repeat(112));

for (const botSeats of [0, 2, 4, 8]) {
  const totals: number[] = [], rakes: number[] = [], bots: number[] = [];
  for (let t = 0; t < TRIALS; t++) {
    let R = 0, B = 0;
    for (let r = 0; r < ROUNDS; r++) { const o = playRound(t, r, botSeats); R += o.rake; B += o.botPnl; }
    totals.push(R + B); rakes.push(R); bots.push(B);
  }
  const mean = (xs: number[]) => xs.reduce((a, x) => a + x, 0) / xs.length;
  const sd = (xs: number[]) => { const m = mean(xs); return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1)); };
  const behind = totals.filter(x => x < 0).length / TRIALS;
  const ratio = sd(totals) > 0 ? mean(totals) / sd(totals) : Infinity;
  console.log(
    `${String(botSeats).padStart(4)}   $${mean(totals).toFixed(0).padStart(8)}   $${sd(totals).toFixed(0).padStart(8)}` +
    `           $${mean(rakes).toFixed(0).padStart(7)}   $${mean(bots).toFixed(0).padStart(7)}  $${sd(bots).toFixed(0).padStart(7)}` +
    `      ${(behind * 100).toFixed(1).padStart(5)}%      ${Number.isFinite(ratio) ? ratio.toFixed(2) : "inf"}`);
}

console.log(`\nREAD IT THIS WAY:`);
console.log(`  * "rake alone" has ZERO variance. With 0 bot seats the house cannot have a losing stretch;`);
console.log(`    accumulation is arithmetic, not probability.`);
console.log(`  * Every bot seat the house fields is an ordinary fighter in a size-neutral, zero-sum fight.`);
console.log(`    Its expected contribution is slightly NEGATIVE — the bot pays the rake too — and its`);
console.log(`    variance is large. The house's edge is unchanged; its BANKROLL RISK is not.`);
console.log(`  * "P(house behind)" is the fraction of ${TRIALS} trials where the house finished ${ROUNDS} rounds`);
console.log(`    down. That is the number to size the house float against, and it is NOT implied by "1%".`);
console.log(`  * "rake:noise" is mean/stdev of total P&L over the horizon. Below ~2 the house should expect`);
console.log(`    to spend meaningful stretches underwater even though the edge is real and positive.\n`);

// -------------------------------------------------------------------------------------------------
// How many rounds until the rake reliably dominates the bot book?
// -------------------------------------------------------------------------------------------------
console.log(`--- how many rounds until the rake reliably dominates ---\n`);
console.log(`Per round, the rake is a constant r and the bot book is ~zero-mean with standard deviation s.`);
console.log(`Over n rounds: drift = n*r, noise = s*sqrt(n). The house is ahead with ~97.5% confidence once`);
console.log(`n*r > 2*s*sqrt(n), i.e. n > (2s/r)^2.\n`);
console.log(`bot seats    rake/round    bot stdev/round      n for 97.5% confidence     at 1 round/2 min`);
console.log("-".repeat(104));
for (const botSeats of [2, 4, 8]) {
  const rs: number[] = [], bs: number[] = [];
  for (let t = 0; t < Math.min(TRIALS, 60); t++)
    for (let r = 0; r < Math.min(ROUNDS, 400); r++) { const o = playRound(t, r, botSeats); rs.push(o.rake); bs.push(o.botPnl); }
  const m = (xs: number[]) => xs.reduce((a, x) => a + x, 0) / xs.length;
  const sdv = (xs: number[]) => { const mm = m(xs); return Math.sqrt(xs.reduce((a, x) => a + (x - mm) ** 2, 0) / (xs.length - 1)); };
  const r0 = m(rs), s0 = sdv(bs);
  const n = Math.ceil((2 * s0 / r0) ** 2);
  console.log(`${String(botSeats).padStart(8)}     $${r0.toFixed(3).padStart(7)}      $${s0.toFixed(2).padStart(8)}          ${n.toLocaleString().padStart(14)} rounds     ${(n * 2 / 60 / 24).toFixed(1).padStart(8)} days`);
}
console.log(`\nIf that number is large, the correct conclusion is NOT "there is no edge". It is "the edge is`);
console.log(`real and the house should not field a bot book bigger than it can fund through the noise" —`);
console.log(`or should field none, in which case the accumulation is deterministic from round one.\n`);
