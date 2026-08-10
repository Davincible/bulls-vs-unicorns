// SANDBOX. Run from engine/:  npx tsx ../sandbox/house-edge/check-house-accrual.ts [rounds]
//                             HE_FEE_BPS=100 npx tsx ../sandbox/house-edge/check-house-accrual.ts 20000
//
// THE HEADLINE QUESTION: over many rounds, does the house actually end up with ~1% of gross entries?
//
// Measured against `engine/src/er-sim.ts` DIRECTLY — its own `enter`/`tick`/`extract`/`settle` and its
// own `houseTook`/`grossDeposits`/`conservationHolds` — not against the sandbox's knobbed variant, so
// the answer cannot be an artefact of the rig. `parity.ts` separately asserts er-sim.ts is
// byte-identical to the Rust's `advance_fight`.
//
// WHAT "THE HOUSE TOOK" MEANS HERE. `houseTook = feesCollected + penaltiesCollected`. Those are the
// only two terms by which value leaves the round: the fight itself is a pure redistribution (asserted
// per round below by `conservationHolds`), so every unit a player does not receive is one of those
// two. Player aggregate ROI is therefore exactly `-houseTook / grossDeposits`, and the two questions
// "what does the house make" and "what do players lose" are one question.
//
// FOUR EXTRACTION REGIMES, because `penaltiesCollected` depends entirely on player behaviour and the
// study has no behaviour model (§8, uncertainty 2). Rather than invent one, bracket it:
//   hold     nobody extracts                          -> house = the entry fee alone. THE FLOOR.
//   horizon  everyone extracts the instant the        -> house = the entry fee alone, again, but by
//            penalty hits zero (the free option)         a route that pays the house nothing extra.
//   random   each fighter extracts at a uniform       -> a naive population.
//            random cursor in [0, budget)
//   quarter  a quarter of them panic-extract early    -> the realistic middle.
// `hold` and `horizon` are the two that bound the fee-only case from opposite directions; if they
// disagree, something other than the fee is moving money.

import {
  newRound, enter, tick, extract, settle,
  houseTook, grossDeposits, conservationHolds, totalValue, penaltyHorizonSteps,
} from "../../engine/src/er-sim.ts";
import type { ERRound } from "../../engine/src/er-sim.ts";
import { stepBudget, UNITS_PER_USD, FEE_BPS } from "./fight-variant.ts";
import { BANDS, makeLobby, toUsd, pct } from "./lobby.ts";
import { mulberry32 } from "./rng.ts";

const ROUNDS = Number(process.argv[2] ?? 20000);
const PER_SIDE = Number(process.argv[3] ?? 4);
const STUDY_SEED = "house-edge-v1";

type Regime = "hold" | "horizon" | "random" | "quarter";
const REGIMES: Regime[] = ["hold", "horizon", "random", "quarter"];

/** Play one round under one regime. Ticks in slices so extractions land at a chosen cursor, exactly
 *  as `extract` does on chain (it calls `catch_up` first, so the cursor it prices against is wherever
 *  the fight has actually got to). */
function playRound(seed: Buffer, entries: { wallet: string; side: 0 | 1; gross: bigint }[], regime: Regime, rnd: () => number): ERRound {
  const round = newRound(seed);
  for (const e of entries) enter(round, e.wallet, e.side, e.gross, FEE_BPS);
  const n = round.fighters.length;
  const budget = stepBudget(n);

  if (regime === "hold") { tick(round, budget); return round; }

  // cursor -> wallets that leave at it
  const when = new Map<number, string[]>();
  const horizon = Number(penaltyHorizonSteps(n));
  for (const e of entries) {
    let c: number;
    if (regime === "horizon") c = horizon;                       // the first free second
    else if (regime === "random") c = Math.floor(rnd() * budget);
    else { if (rnd() >= 0.25) continue; c = Math.floor(rnd() * horizon); }  // panic: early, so it costs
    if (c >= budget) continue;
    const at = when.get(c) ?? []; at.push(e.wallet); when.set(c, at);
  }

  const stops = [...when.keys()].sort((a, b) => a - b);
  let cursor = 0;
  for (const s of stops) {
    if (s > cursor) { tick(round, s - cursor); cursor = s; }
    for (const w of when.get(s)!) {
      // A fighter already dead or already out has nothing to pull; `extract` throws, and on chain the
      // instruction would simply fail. Skipping is the same outcome, without the exception.
      const f = round.fighters.find(x => x.wallet === w && x.dead === 0 && x.hp > 0n);
      if (f) extract(round, w);
    }
  }
  if (cursor < budget) tick(round, budget - cursor);
  return round;
}

/** Bootstrap over ROUNDS (the independent unit) of the ratio-of-sums house rate. */
function rateWithCI(rows: { gross: number; house: number }[], resamples = 4000, seed = 11) {
  let G = 0, H = 0;
  for (const r of rows) { G += r.gross; H += r.house; }
  const point = H / G;
  const rnd = mulberry32(seed);
  const draws: number[] = [];
  for (let b = 0; b < resamples; b++) {
    let g = 0, h = 0;
    for (let k = 0; k < rows.length; k++) { const j = Math.floor(rnd() * rows.length); g += rows[j].gross; h += rows[j].house; }
    if (g > 0) draws.push(h / g);
  }
  draws.sort((a, b) => a - b);
  const q = (p: number) => draws[Math.min(draws.length - 1, Math.max(0, Math.floor(p * draws.length)))];
  return { point, lo: q(0.025), hi: q(0.975) };
}

console.log(`\n=== DOES THE HOUSE ACCRUE ~1% OF GROSS ENTRIES? ===`);
console.log(`measured on engine/src/er-sim.ts  |  fee = ${FEE_BPS} bps  |  study seed "${STUDY_SEED}"`);
console.log(`${ROUNDS} rounds x ${PER_SIDE * 2} fighters, five-band lobby (HOUSE-EDGE-STUDY.md's invented mix, §8 uncertainty 3)\n`);

const results: Record<Regime, { rows: { gross: number; house: number }[]; fees: number; pen: number; violations: number; extracted: number; seats: number; floorLoss: bigint }> = {} as never;
for (const g of REGIMES) results[g] = { rows: [], fees: 0, pen: 0, violations: 0, extracted: 0, seats: 0, floorLoss: 0n };

for (let r = 0; r < ROUNDS; r++) {
  const lobby = makeLobby(STUDY_SEED, r, PER_SIDE);
  const entries = lobby.entries.map(e => ({ wallet: e.wallet, side: e.side, gross: e.grossUnits }));
  // What a fee with NO flooring would have taken — the gap is the rounding the house gives away.
  let idealFee = 0n, gross = 0n;
  for (const e of entries) { gross += e.gross; idealFee += e.gross * FEE_BPS; }
  for (const g of REGIMES) {
    const round = playRound(lobby.seed, entries, g, mulberry32((r * 2654435761 + REGIMES.indexOf(g) * 7919) >>> 0));
    if (!conservationHolds(round)) results[g].violations++;
    results[g].rows.push({ gross: toUsd(grossDeposits(round)), house: toUsd(houseTook(round)) });
    results[g].fees += toUsd(round.feesCollected);
    results[g].pen += toUsd(round.penaltiesCollected);
    results[g].floorLoss += idealFee / 10_000n - round.feesCollected;
    for (const f of round.fighters) { results[g].seats++; if (f.dead === 1 && f.hp === 0n) { /* died or left */ } }
    results[g].extracted += Number(round.penaltiesCollected > 0n);
  }
}

const target = Number(FEE_BPS) / 100;
console.log(`regime      house take as % of GROSS entries        95% CI          of which fee     penalty   conservation`);
console.log("-".repeat(112));
for (const g of REGIMES) {
  const R = results[g];
  const ci = rateWithCI(R.rows);
  const tot = R.fees + R.pen;
  console.log(
    `${g.padEnd(10)}  ${(ci.point * 100).toFixed(4).padStart(9)}%` +
    `                     [${(ci.lo * 100).toFixed(4)}%, ${(ci.hi * 100).toFixed(4)}%]` +
    `   ${(100 * R.fees / tot).toFixed(1).padStart(6)}%   ${(100 * R.pen / tot).toFixed(1).padStart(7)}%` +
    `   ${R.violations === 0 ? "EXACT, all rounds" : `BROKEN in ${R.violations}`}`);
}

console.log(`\ntarget (fee_bps as a percentage) = ${target.toFixed(2)}%`);
console.log(`player aggregate ROI is the same number with the sign flipped — conservation makes them one statement.\n`);

console.log(`--- what the FLOOR in split_entry gives away ---`);
const fl = results.hold.floorLoss;
console.log(`  fee is floor(stake x fee_bps / 10000), so the house rounds DOWN on every entry.`);
console.log(`  total given away over ${ROUNDS} rounds: ${fl} micro-units = $${(Number(fl) / Number(UNITS_PER_USD)).toFixed(6)}`);
console.log(`  per round: ${(Number(fl) / ROUNDS).toFixed(3)} micro-units. Upper bound is (fighters x 1) unit/round = $0.000048 at 48 seats`);
console.log(`  (was $0.000016 at the 16-seat cap this bound was first measured against — the ceiling moved with`);
console.log(`  MAX_FIGHTERS, not the per-seat rounding, which is why it is still exactly (seats x 1) unit).`);
console.log(`  It is bounded by SEATS, not by stake, so it cannot be farmed: MAX_FIGHTERS caps it at`);
console.log(`  48 units/round however the money is arranged.\n`);

// -------------------------------------------------------------------------------------------------
// Is the free option (extract the instant the penalty reaches zero) worth anything?
// -------------------------------------------------------------------------------------------------
console.log(`--- the free option: is extracting at the penalty horizon +EV for the player who does it? ---`);
console.log(`one designated fighter either HOLDS to the bell or EXTRACTS at cursor == horizon (penalty = 0),`);
console.log(`everyone else holds. Same lobbies, same seeds, paired.\n`);

const bands: { hold: number[]; opt: number[]; inn: number[] }[] = BANDS.map(() => ({ hold: [], opt: [], inn: [] }));
for (let r = 0; r < ROUNDS; r++) {
  const lobby = makeLobby(STUDY_SEED, r, PER_SIDE);
  const entries = lobby.entries.map(e => ({ wallet: e.wallet, side: e.side, gross: e.grossUnits }));
  const victim = r % entries.length;
  const band = lobby.entries[victim].band;
  const n = entries.length;
  const budget = stepBudget(n);
  const horizon = Number(penaltyHorizonSteps(n));

  const a = newRound(lobby.seed);
  for (const e of entries) enter(a, e.wallet, e.side, e.gross, FEE_BPS);
  tick(a, budget);

  const b = newRound(lobby.seed);
  for (const e of entries) enter(b, e.wallet, e.side, e.gross, FEE_BPS);
  tick(b, Math.min(horizon, budget));
  const alive = b.fighters.find(x => x.wallet === entries[victim].wallet && x.dead === 0 && x.hp > 0n);
  if (alive) extract(b, entries[victim].wallet);
  if (budget > horizon) tick(b, budget - horizon);

  const fa = a.fighters[victim], fb = b.fighters[victim];
  bands[band].hold.push(toUsd(fa.hp + fa.banked));
  bands[band].opt.push(toUsd(fb.hp + fb.banked));
  bands[band].inn.push(toUsd(entries[victim].gross));
}

console.log(`band                 n     ROI holding      ROI extracting at horizon      difference`);
console.log("-".repeat(96));
for (let i = 0; i < BANDS.length; i++) {
  const B = bands[i];
  if (B.inn.length === 0) continue;
  const I = B.inn.reduce((a, x) => a + x, 0);
  const rh = B.hold.reduce((a, x) => a + x, 0) / I - 1;
  const ro = B.opt.reduce((a, x) => a + x, 0) / I - 1;
  // paired bootstrap on the difference
  const rnd = mulberry32(97 + i);
  const d: number[] = [];
  for (let s = 0; s < 2000; s++) {
    let ih = 0, oh = 0, oo = 0;
    for (let k = 0; k < B.inn.length; k++) { const j = Math.floor(rnd() * B.inn.length); ih += B.inn[j]; oh += B.hold[j]; oo += B.opt[j]; }
    d.push((oo / ih - 1) - (oh / ih - 1));
  }
  const m = d.reduce((a, x) => a + x, 0) / d.length;
  const se = Math.sqrt(d.reduce((a, x) => a + (x - m) ** 2, 0) / (d.length - 1));
  console.log(`${BANDS[i].name}  ${String(B.inn.length).padStart(6)}  ${pct(rh, 2).padStart(12)}  ${pct(ro, 2).padStart(28)}      ${pct(ro - rh, 2).padStart(8)} +-${(se * 100).toFixed(2)}`);
}
console.log(`\nA difference indistinguishable from zero means the free option is a VARIANCE choice, not an edge:`);
console.log(`taking it costs the house its penalty revenue but transfers nothing between players.\n`);
