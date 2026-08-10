// SANDBOX. Run from engine/:
//   npx tsx ../sandbox/house-edge/strategy-house-book.ts [rounds] [trials]
//
// THE HOUSE'S COMPLETE POSITION, with circular fees netted out.
//
// The treasury balance is NOT the house's revenue. House wallets pay the entry fee through the same
// `enter` instruction as everyone else, into a treasury the house owns, so every dollar of fee a
// house wallet pays is counted as revenue AND paid by the house. On live round #27 the field was 2
// house fighters to 2 real ones; at that ratio roughly half of `fees_collected` is the house moving
// money from its left pocket to its right.
//
// THE ONLY HONEST ACCOUNTING IS THE CONSOLIDATED ONE:
//
//     net_house = (fees_collected + penalties_collected)      <- the treasury's gross intake
//               + SUM over HOUSE fighters (payout - gross)    <- the house wallets' own P&L
//
// The circular term cancels inside that sum automatically, without anyone having to remember to
// subtract it. Conservation gives the same number a second way, and the script asserts they agree
// every round:
//
//     net_house == -( SUM over REAL fighters (payout - gross) )
//
// i.e. THE HOUSE'S NET REVENUE IS EXACTLY WHAT REAL PLAYERS LOSE. Nothing else is revenue. If that
// identity ever fails, the accounting below is wrong and every number in it should be discarded.
//
// Measured on `engine/src/er-sim.ts` — the mirror `parity.ts` asserts byte-identical to the deployed
// Rust `advance_fight`.
//
// ------------------------------------------------------------------------------------------------
// EVERY BEHAVIOURAL ASSUMPTION IS IN THE `ASSUMPTIONS` BLOCK BELOW AND NOWHERE ELSE.
// They are the weakest part of this answer. §E sweeps the ones that matter.
// ------------------------------------------------------------------------------------------------

import { newRound, enter, tick, extract, settle, penaltyHorizonSteps, conservationHolds } from "../../engine/src/er-sim.ts";
import { stepBudget, UNITS_PER_USD } from "./fight-variant.ts";
import { BANDS, usd, toUsd, pct } from "./lobby.ts";
import { mulberry32 } from "./rng.ts";
import { createHash } from "node:crypto";

const ROUNDS = Number(process.argv[2] ?? 4000);
const TRIALS = Number(process.argv[3] ?? 200);
const SEED_TAG = "house-book-v1";

/** THE ASSUMPTIONS. Each is a guess about behaviour, not a measurement of it. */
const ASSUMPTIONS = {
  /** Fee rate now live on chain, confirmed by round #27 (680,000 units on 68,000,000 gross). */
  feeBps: 100n,
  /** Seats a lobby fills to. MAX_FIGHTERS is 48; a real lobby is usually much smaller. */
  seats: 8,
  /** What a real player stakes. HOUSE-EDGE-STUDY.md's five-band mix — INVENTED, §8 uncertainty 3. */
  realStake: (rnd: () => number) => { const b = BANDS[Math.floor(rnd() * BANDS.length)]; return b.lo + rnd() * (b.hi - b.lo); },
  /** What a house wallet stakes, per seat, in USD. "Army of small wallets" => small. */
  houseStakeUsd: 10,
  /** Probability a REAL player extracts before the bell at all. THE SINGLE MOST LOAD-BEARING GUESS
   *  in this file: it alone decides whether the penalty stream is large or nil. Swept in §E. */
  realExtractProb: 0.30,
  /** Given they extract, WHEN — as a fraction of the penalty horizon, uniform on [0, x]. Extracting
   *  after the horizon is free, so anything at or past 1.0 pays the house nothing. */
  realExtractLatest: 1.0,
  /** Do HOUSE wallets extract? If they do they pay the penalty to themselves — circular again, and
   *  netted out by the consolidated accounting exactly as the fee is. Default: they hold. */
  houseExtracts: false,
  /** The house's operating balance, for the ruin section. */
  bankrollSol: 3.66,
  /** SOL price used to turn that into dollars. NOT MEASURED — set SOL_USD to change it. */
  solUsd: Number(process.env.SOL_USD ?? 150),
};

interface RoundOut {
  grossReal: number; grossHouse: number;
  feesReal: number; feesHouse: number;
  penReal: number; penHouse: number;
  housePnl: number;      // house wallets only: payout - gross
  netHouse: number;      // the consolidated number
  realNet: number;       // real players: payout - gross
  ok: boolean;           // conservation + the identity both held
}

function simRound(tag: string, houseSeats: number, houseStakeUsd: number, rnd: () => number): RoundOut {
  const seats = ASSUMPTIONS.seats;
  const seed = createHash("sha256").update(tag).digest();
  const round = newRound(seed);
  const isHouse: boolean[] = [];
  /** GROSS IS HELD IN MICRO-UNITS, NOT DOLLARS, and that is not a detail. `enter` receives
   *  `usd(v) = round(v * 1e6)`, so the dollars the lobby generator produced and the units the chain
   *  actually charged differ by up to half a micro-unit per seat. Carrying the float through to the
   *  P&L made the consolidated identity fail by ~4e-6 on an 8-seat lobby — small enough to look like
   *  a tolerance question and large enough to be a real mis-attribution. Convert once, from the same
   *  integer the round was built from. */
  const grossUnits: bigint[] = [];

  // Alternate sides so neither cohort is concentrated — same-side pairs never exchange, so
  // concentrating the house would silently change how often it can trade at all.
  let placed = 0;
  for (let i = 0; i < houseSeats && placed < seats; i++, placed++) {
    const g = usd(houseStakeUsd);
    enter(round, `h${i}`, (placed % 2) as 0 | 1, g, ASSUMPTIONS.feeBps);
    isHouse.push(true); grossUnits.push(g);
  }
  for (let i = 0; placed < seats; i++, placed++) {
    const g = usd(ASSUMPTIONS.realStake(rnd));
    enter(round, `p${i}`, (placed % 2) as 0 | 1, g, ASSUMPTIONS.feeBps);
    isHouse.push(false); grossUnits.push(g);
  }

  const n = round.fighters.length;
  const budget = stepBudget(n);
  const horizon = Number(penaltyHorizonSteps(n));

  // Fees are attributable at entry: floor(gross x feeBps / BPS), exactly as `split_entry` does.
  let feesRealU = 0n, feesHouseU = 0n;
  for (let i = 0; i < n; i++) {
    const f = (grossUnits[i] * ASSUMPTIONS.feeBps) / 10_000n;
    if (isHouse[i]) feesHouseU += f; else feesRealU += f;
  }

  // Decide extractions up front, then tick in slices so each lands at its chosen cursor.
  const when = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const willExtract = isHouse[i] ? ASSUMPTIONS.houseExtracts : rnd() < ASSUMPTIONS.realExtractProb;
    if (!willExtract) continue;
    const c = Math.floor(rnd() * horizon * ASSUMPTIONS.realExtractLatest);
    if (c >= budget) continue;
    const at = when.get(c) ?? []; at.push(i); when.set(c, at);
  }

  let penRealU = 0n, penHouseU = 0n;
  let cursor = 0;
  for (const s of [...when.keys()].sort((a, b) => a - b)) {
    if (s > cursor) { tick(round, s - cursor); cursor = s; }
    for (const i of when.get(s)!) {
      const w = round.fighters[i].wallet;
      const alive = round.fighters.find(x => x.wallet === w && x.dead === 0 && x.hp > 0n);
      if (!alive) continue;                       // beaten to nothing already; `extract` would throw
      const { penalty } = extract(round, w);
      if (isHouse[i]) penHouseU += penalty; else penRealU += penalty;
    }
  }
  if (cursor < budget) tick(round, budget - cursor);
  settle(round);

  // EVERYTHING BELOW IS INTEGER UNTIL THE LAST LINE. The identity is exact in micro-units; converting
  // first and comparing after would only ever prove something about floating point.
  let grossRealU = 0n, grossHouseU = 0n, housePnlU = 0n, realNetU = 0n;
  for (let i = 0; i < n; i++) {
    const out = round.fighters[i].hp + round.fighters[i].banked;
    const pnl = out - grossUnits[i];
    if (isHouse[i]) { grossHouseU += grossUnits[i]; housePnlU += pnl; }
    else { grossRealU += grossUnits[i]; realNetU += pnl; }
  }
  const treasuryU = round.feesCollected + round.penaltiesCollected;
  const netHouseU = treasuryU + housePnlU;
  const ok = conservationHolds(round) && netHouseU === -realNetU;   // EXACT, in integers
  return {
    grossReal: toUsd(grossRealU), grossHouse: toUsd(grossHouseU),
    feesReal: toUsd(feesRealU), feesHouse: toUsd(feesHouseU),
    penReal: toUsd(penRealU), penHouse: toUsd(penHouseU),
    housePnl: toUsd(housePnlU), netHouse: toUsd(netHouseU), realNet: toUsd(realNetU), ok,
  };
}

const mean = (xs: number[]) => xs.reduce((a, x) => a + x, 0) / xs.length;
const sd = (xs: number[]) => { const m = mean(xs); return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(1, xs.length - 1)); };
function ci95(xs: number[], resamples = 2000, seed = 5) {
  const rnd = mulberry32(seed); const d: number[] = [];
  for (let b = 0; b < resamples; b++) { let s = 0; for (let k = 0; k < xs.length; k++) s += xs[Math.floor(rnd() * xs.length)]; d.push(s / xs.length); }
  d.sort((a, b) => a - b);
  return [d[Math.floor(0.025 * d.length)], d[Math.floor(0.975 * d.length)]] as const;
}

console.log(`\n${"=".repeat(108)}`);
console.log(`THE HOUSE'S COMPLETE POSITION — three revenue streams, circular fees netted out`);
console.log(`${"=".repeat(108)}`);
console.log(`measured on engine/src/er-sim.ts   seeds sha256("${SEED_TAG}|...")   ${ROUNDS} rounds per cell`);
console.log(`\nASSUMPTIONS (all of them, and they are guesses, not measurements):`);
console.log(`  fee                    ${ASSUMPTIONS.feeBps} bps            (MEASURED — live on chain, round #27)`);
console.log(`  lobby seats            ${ASSUMPTIONS.seats}`);
console.log(`  real stake mix         five bands $3-$100, mean ~$42   (INVENTED — study §8 uncertainty 3)`);
console.log(`  house stake per seat   $${ASSUMPTIONS.houseStakeUsd}`);
console.log(`  P(real player extracts) ${ASSUMPTIONS.realExtractProb}          (GUESS — the load-bearing one, swept in §E)`);
console.log(`  extract timing         uniform on [0, ${ASSUMPTIONS.realExtractLatest} x horizon]`);
console.log(`  house extracts         ${ASSUMPTIONS.houseExtracts}`);

// ------------------------------------------------------------------------------------------------
console.log(`\n\n--- A. THE CIRCULARITY TRAP: what fraction of "revenue" is the house paying itself? ---\n`);
console.log(`house real   TREASURY   of which   |  THE THREE STREAMS, net of circularity   |  NET HOUSE   net %  net %`);
console.log(`seats seats   intake    house-paid |   fee(real)  penalty(real)  house P&L  |   REVENUE    /REAL  /TOTAL`);
console.log("-".repeat(118));

for (const hs of [0, 1, 2, 4, 6]) {
  if (hs >= ASSUMPTIONS.seats) continue;
  const net: number[] = [], treas: number[] = [], circ: number[] = [], gr: number[] = [], gt: number[] = [];
  const fR: number[] = [], pR: number[] = [], hP: number[] = [];
  let bad = 0;
  for (let r = 0; r < ROUNDS; r++) {
    const o = simRound(`${SEED_TAG}|circ|${hs}|${r}`, hs, ASSUMPTIONS.houseStakeUsd, mulberry32((r * 2654435761 + hs * 7919) >>> 0));
    if (!o.ok) bad++;
    net.push(o.netHouse); treas.push(o.feesReal + o.feesHouse + o.penReal + o.penHouse);
    circ.push(o.feesHouse + o.penHouse); gr.push(o.grossReal); gt.push(o.grossReal + o.grossHouse);
    fR.push(o.feesReal); pR.push(o.penReal); hP.push(o.housePnl);
  }
  if (bad) console.log(`  !!! ACCOUNTING IDENTITY FAILED in ${bad} rounds — do not trust this row`);
  const [lo, hi] = ci95(net, 2000, 100 + hs);
  console.log(
    `${String(hs).padStart(4)} ${String(ASSUMPTIONS.seats - hs).padStart(5)}   ` +
    `$${mean(treas).toFixed(2).padStart(6)}   $${mean(circ).toFixed(2).padStart(5)}(${(100 * mean(circ) / mean(treas)).toFixed(0).padStart(2)}%) |` +
    `  $${mean(fR).toFixed(3).padStart(6)}   $${mean(pR).toFixed(3).padStart(7)}    $${mean(hP).toFixed(3).padStart(6)}  |` +
    `  $${mean(net).toFixed(2).padStart(5)}  ${(100 * mean(net) / mean(gr)).toFixed(2).padStart(5)}% ${(100 * mean(net) / mean(gt)).toFixed(2).padStart(5)}%`);
  if (hs === 0) console.log(`       (95% CI on net house revenue at ${hs} house seats: [$${lo.toFixed(3)}, $${hi.toFixed(3)}])`);
}
console.log(`\n  The "net as % of REAL gross" column is the house's true take rate. If it sits at the fee rate`);
console.log(`  regardless of how many seats the house occupies, then house wallets contribute NOTHING to`);
console.log(`  revenue — they are a marketing/liquidity cost with zero expected return and real variance.`);
console.log(`  The "net as % of TOTAL gross" column is what a naive treasury/volume ratio would report, and`);
console.log(`  the gap between the two columns is the size of the illusion.\n`);

// ------------------------------------------------------------------------------------------------
console.log(`\n--- B. THE SMALL-WALLET ARMY: does splitting a house budget across many wallets pay? ---\n`);
console.log(`House budget fixed at $${(ASSUMPTIONS.houseStakeUsd * 4).toFixed(0)} per round, split k ways, against a ${ASSUMPTIONS.seats}-seat lobby.`);
console.log(`This is the strategy "an army of small wallets to farm the game" describes. It was worth`);
console.log(`+$152/round under v5 (HOUSE-EDGE-STUDY.md §10.3). What is it worth now?\n`);
console.log(`   k   stake each    house-wallet P&L alone      NET HOUSE REVENUE        vs k=1`);
console.log(`                       per round + 95% CI          per round + 95% CI`);
console.log("-".repeat(100));
const BUDGET = ASSUMPTIONS.houseStakeUsd * 4;
let base = 0;
for (const k of [1, 2, 4, 6]) {
  if (k >= ASSUMPTIONS.seats) continue;
  const pnl: number[] = [], net: number[] = [];
  for (let r = 0; r < ROUNDS; r++) {
    const o = simRound(`${SEED_TAG}|army|${k}|${r}`, k, BUDGET / k, mulberry32((r * 2654435761 + k * 40503) >>> 0));
    pnl.push(o.housePnl); net.push(o.netHouse);
  }
  const [plo, phi] = ci95(pnl, 2000, 200 + k);
  const [nlo, nhi] = ci95(net, 2000, 300 + k);
  if (k === 1) base = mean(net);
  console.log(
    `${String(k).padStart(4)}   $${(BUDGET / k).toFixed(2).padStart(8)}    ` +
    `$${mean(pnl).toFixed(3).padStart(7)} [${plo.toFixed(3)}, ${phi.toFixed(3)}]    ` +
    `$${mean(net).toFixed(3).padStart(7)} [${nlo.toFixed(3)}, ${nhi.toFixed(3)}]   ` +
    `${(mean(net) - base >= 0 ? "+" : "")}$${(mean(net) - base).toFixed(3)}`);
}
console.log(`\n  "house-wallet P&L alone" should sit at MINUS the fee those wallets paid, because the fight is`);
console.log(`  a martingale in net stakes (check-dice.ts §3): E[payout] = net stake, so E[P&L] = -fee.`);
console.log(`  That loss returns to the treasury, which is why NET HOUSE REVENUE barely moves with k.\n`);

// ------------------------------------------------------------------------------------------------
console.log(`\n--- C. RISK: the distribution, not the mean ---\n`);
const HS = 2;   // the live round #27 ratio: 2 house, 2 real (scaled to this lobby's seat count)
const per: number[] = [];
for (let r = 0; r < ROUNDS; r++)
  per.push(simRound(`${SEED_TAG}|risk|${r}`, HS, ASSUMPTIONS.houseStakeUsd, mulberry32((r * 2654435761 + 991) >>> 0)).netHouse);
const m1 = mean(per), s1 = sd(per);
const sorted = [...per].sort((a, b) => a - b);
const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
console.log(`With ${HS} house seats of $${ASSUMPTIONS.houseStakeUsd} in a ${ASSUMPTIONS.seats}-seat lobby, per round:`);
console.log(`  mean net house revenue   $${m1.toFixed(4)}`);
console.log(`  standard deviation       $${s1.toFixed(4)}       <- ${(s1 / Math.abs(m1)).toFixed(1)}x the mean`);
console.log(`  P(house loses money)     ${(100 * per.filter(x => x < 0).length / per.length).toFixed(1)}%`);
console.log(`  5th / 50th / 95th pct    $${q(0.05).toFixed(3)} / $${q(0.5).toFixed(3)} / $${q(0.95).toFixed(3)}`);
console.log(`  worst round observed     $${sorted[0].toFixed(3)}`);

console.log(`\n  Cumulative over ${TRIALS} independent runs of ${ROUNDS} rounds each:\n`);
const bankUsd = ASSUMPTIONS.bankrollSol * ASSUMPTIONS.solUsd;
const finals: number[] = [], maxDD: number[] = [];
let ruined = 0;
for (let t = 0; t < TRIALS; t++) {
  let cum = 0, peak = 0, dd = 0;
  let ruin = false;
  for (let r = 0; r < ROUNDS; r++) {
    cum += simRound(`${SEED_TAG}|path|${t}|${r}`, HS, ASSUMPTIONS.houseStakeUsd, mulberry32(((t * 2654435761) ^ (r * 40503)) >>> 0)).netHouse;
    if (cum > peak) peak = cum;
    dd = Math.max(dd, peak - cum);
    if (cum < -bankUsd) ruin = true;
  }
  finals.push(cum); maxDD.push(dd); if (ruin) ruined++;
}
const [flo, fhi] = ci95(finals, 2000, 777);
console.log(`  final P&L after ${ROUNDS} rounds   mean $${mean(finals).toFixed(2)}  [95% CI on the mean: $${flo.toFixed(2)}, $${fhi.toFixed(2)}]`);
console.log(`                                 stdev $${sd(finals).toFixed(2)},  worst run $${Math.min(...finals).toFixed(2)},  P(run ends down) ${(100 * finals.filter(x => x < 0).length / TRIALS).toFixed(1)}%`);
console.log(`  max drawdown within a run      mean $${mean(maxDD).toFixed(2)},  worst $${Math.max(...maxDD).toFixed(2)}`);
console.log(`\n  RUIN, against the stated operating balance:`);
console.log(`    bankroll = ${ASSUMPTIONS.bankrollSol} SOL x $${ASSUMPTIONS.solUsd}/SOL = $${bankUsd.toFixed(0)}   (SOL price is an ASSUMPTION — set SOL_USD to change it)`);
console.log(`    P(cumulative net house revenue ever below -$${bankUsd.toFixed(0)} within ${ROUNDS} rounds) = ${(100 * ruined / TRIALS).toFixed(2)}%`);
console.log(`\n  SEPARATELY FROM RUIN — working capital. The house must have ${HS} x $${ASSUMPTIONS.houseStakeUsd} = $${(HS * ASSUMPTIONS.houseStakeUsd).toFixed(0)} staked and`);
console.log(`  at risk in EVERY round simultaneously. That is a float requirement, not a loss, but it is`);
console.log(`  capital that cannot be withdrawn while the round runs.\n`);

// ------------------------------------------------------------------------------------------------
console.log(`\n--- D. HOW BIG CAN THE HOUSE BOOK GET BEFORE IT EATS THE EDGE? ---\n`);
console.log(`The fee+penalty stream is bounded by REAL volume. The bot book's variance is not bounded by`);
console.log(`anything except the house's own stake. Sweeping house stake per seat, ${HS} seats, ${ROUNDS} rounds:\n`);
console.log(`house stake   net house revenue    stdev per   P(losing    worst round   P(ruin at`);
console.log(`  per seat        per round          round      round)      observed     $${bankUsd.toFixed(0)} bank)`);
console.log("-".repeat(96));
for (const hstake of [1, 10, 50, 200, 1000]) {
  const xs: number[] = [];
  for (let r = 0; r < ROUNDS; r++)
    xs.push(simRound(`${SEED_TAG}|size|${hstake}|${r}`, HS, hstake, mulberry32((r * 2654435761 + hstake * 7919) >>> 0)).netHouse);
  // ruin over TRIALS resampled paths of ROUNDS rounds (bootstrap of the same per-round population)
  const rnd = mulberry32(4242);
  let ruin = 0;
  for (let t = 0; t < TRIALS; t++) {
    let cum = 0, dead = false;
    for (let r = 0; r < ROUNDS; r++) { cum += xs[Math.floor(rnd() * xs.length)]; if (cum < -bankUsd) dead = true; }
    if (dead) ruin++;
  }
  const s = [...xs].sort((a, b) => a - b);
  console.log(
    `$${String(hstake).padStart(8)}     $${mean(xs).toFixed(3).padStart(8)}       $${sd(xs).toFixed(2).padStart(8)}    ${(100 * xs.filter(x => x < 0).length / xs.length).toFixed(1).padStart(5)}%   $${s[0].toFixed(2).padStart(10)}     ${(100 * ruin / TRIALS).toFixed(1).padStart(6)}%`);
}
console.log(`\n  The mean column should be roughly FLAT in house stake — the bot book has no expectancy, so`);
console.log(`  scaling it scales the noise and not the edge. The stdev and ruin columns are what move.`);
console.log(`  THIS IS THE SIZING RULE: the house's stake per seat is a pure risk dial with no return`);
console.log(`  attached to it. The only reason to turn it up is to make lobbies look full.\n`);
