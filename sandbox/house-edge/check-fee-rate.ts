// SANDBOX. Run from engine/:  npx tsx ../sandbox/house-edge/check-fee-rate.ts [rounds] [perSide]
//
// What the 20 -> 100 bps move did. Measured on `engine/src/er-sim.ts` directly, same lobbies and same
// seeds at every rate, so the columns are paired and the differences are not sampling noise.
//
// The rate is swept INSIDE this script rather than taken from HE_FEE_BPS, because the whole point is
// to put the rates beside each other on identical draws.
//
// TWO QUESTIONS, and they have different answers:
//   * ROI      — a proportional rake shifts every band by the same amount, so the interesting result
//                would be a band that moves by MORE than the rate change. That would mean the rake
//                interacts with the fight, which it should not.
//   * VARIANCE — a 5x rake against unchanged variance is a 5x worse signal-to-noise for the player,
//                and the honest way to say it is "how many rounds before the rake is visible above
//                the swing", not "ROI fell by 0.8 points".

import { newRound, enter, tick, settle } from "../../engine/src/er-sim.ts";
import { stepBudget } from "./fight-variant.ts";
import { BANDS, makeLobby, toUsd, pct } from "./lobby.ts";
import { mulberry32 } from "./rng.ts";

const ROUNDS = Number(process.argv[2] ?? 20000);
const PER_SIDE = Number(process.argv[3] ?? 4);
const STUDY_SEED = "house-edge-v1";
const RATES = [0n, 20n, 100n, 200n];   // 0 isolates the MECHANISM from the rake; 200 is a stress case

interface Cell { inn: number[]; out: number[]; }
const byRate = RATES.map(() => ({ bands: BANDS.map(() => ({ inn: [], out: [] } as Cell)), all: { inn: [], out: [] } as Cell }));

for (let r = 0; r < ROUNDS; r++) {
  const lobby = makeLobby(STUDY_SEED, r, PER_SIDE);
  for (let k = 0; k < RATES.length; k++) {
    const round = newRound(lobby.seed);
    for (const e of lobby.entries) enter(round, e.wallet, e.side, e.grossUnits, RATES[k]);
    tick(round, stepBudget(round.fighters.length));
    settle(round);
    for (let i = 0; i < round.fighters.length; i++) {
      const f = round.fighters[i];
      const inn = toUsd(lobby.entries[i].grossUnits);
      const out = toUsd(f.hp + f.banked);
      byRate[k].bands[lobby.entries[i].band].inn.push(inn);
      byRate[k].bands[lobby.entries[i].band].out.push(out);
      byRate[k].all.inn.push(inn); byRate[k].all.out.push(out);
    }
  }
}

const roiOf = (c: Cell) => c.out.reduce((a, x) => a + x, 0) / c.inn.reduce((a, x) => a + x, 0) - 1;
/** Bootstrap SE of a ratio-of-sums, resampled over ENTRIES here (see the caveat printed below). */
function seOf(c: Cell, seed: number, resamples = 2000) {
  const rnd = mulberry32(seed); const d: number[] = [];
  for (let b = 0; b < resamples; b++) {
    let i = 0, o = 0;
    for (let k = 0; k < c.inn.length; k++) { const j = Math.floor(rnd() * c.inn.length); i += c.inn[j]; o += c.out[j]; }
    d.push(o / i - 1);
  }
  const m = d.reduce((a, x) => a + x, 0) / d.length;
  return Math.sqrt(d.reduce((a, x) => a + (x - m) ** 2, 0) / (d.length - 1));
}

console.log(`\n=== WHAT THE 20 -> 100 BPS MOVE DID ===`);
console.log(`measured on engine/src/er-sim.ts  |  study seed "${STUDY_SEED}"  |  ${ROUNDS} rounds x ${PER_SIDE * 2} fighters`);
console.log(`identical lobbies and identical hash draws at every rate — the columns are PAIRED.\n`);

console.log(`--- player ROI by stake band ---\n`);
const head = "band                 " + RATES.map(r => `${r} bps`.padStart(17)).join("") + "      100 vs 20";
console.log(head); console.log("-".repeat(head.length));
for (let b = 0; b < BANDS.length; b++) {
  const cells = RATES.map((_, k) => byRate[k].bands[b]);
  const rois = cells.map(c => roiOf(c));
  const ses = cells.map((c, k) => seOf(c, 300 + b * 17 + k));
  const d = rois[2] - rois[1];
  console.log(`${BANDS[b].name}  ` + rois.map((x, k) => `${pct(x, 3)}+-${(ses[k] * 100).toFixed(2)}`.padStart(17)).join("") + `      ${pct(d, 3).padStart(8)}`);
}
const allRois = RATES.map((_, k) => roiOf(byRate[k].all));
console.log("-".repeat(head.length));
console.log(`ALL SEATS          ` + allRois.map(x => `${pct(x, 3)}`.padStart(17)).join("") + `      ${pct(allRois[2] - allRois[1], 3).padStart(8)}`);
console.log(`\nexpected if the rake is purely proportional and does not touch the fight:`);
console.log(`  ROI(f) = (1 - f) x (1 + ROI(0)) - 1, so 20 -> 100 bps must cost exactly 0.80 points on a`);
console.log(`  band already at 0%. A band that moves by materially more than that is an interaction, and`);
console.log(`  an interaction would be a defect. Read the "100 vs 20" column against -0.800%.\n`);

console.log(`--- VARIANCE: what the player actually experiences, per seat, per round ---\n`);
console.log(`rate      mean ROI     stdev of one seat's ROI     P(seat loses money)     median seat ROI     rounds until`);
console.log(`                                                                                              rake > 1 stdev`);
console.log("-".repeat(120));
for (let k = 0; k < RATES.length; k++) {
  const c = byRate[k].all;
  const rois = c.inn.map((v, i) => c.out[i] / v - 1);
  const m = rois.reduce((a, x) => a + x, 0) / rois.length;
  const sd = Math.sqrt(rois.reduce((a, x) => a + (x - m) ** 2, 0) / (rois.length - 1));
  const lose = rois.filter(x => x < 0).length / rois.length;
  const sorted = [...rois].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  // n rounds of an iid seat: drift n*|m|, noise sqrt(n)*sd  =>  n > (sd/|m|)^2
  const n = m < 0 ? Math.ceil((sd / Math.abs(m)) ** 2) : Infinity;
  console.log(`${String(RATES[k]).padStart(4)} bps  ${pct(m, 3).padStart(9)}     ${(sd * 100).toFixed(2).padStart(19)}%     ${(lose * 100).toFixed(2).padStart(18)}%     ${pct(med, 2).padStart(15)}     ${(Number.isFinite(n) ? n.toLocaleString() : "never").padStart(12)}`);
}
console.log(`\n"rounds until rake > 1 stdev" is (stdev / |mean|)^2 — how long a single player must play before`);
console.log(`the house's cut is larger than a one-standard-deviation swing in their own results. It is the`);
console.log(`honest form of "the rake is small": it is small PER ROUND and inescapable over many.`);
console.log(`Raising 20 -> 100 bps divides that number by ~25, which is the real effect of the change: the`);
console.log(`rake became visible to an ordinary player roughly an order of magnitude sooner.\n`);

console.log(`CAVEAT ON THE ERROR BARS in the ROI table: they resample SEATS, not ROUNDS, so they are too`);
console.log(`small — two fighters in one round are not independent, one's gain is literally the other's`);
console.log(`loss. They are printed to compare COLUMNS on paired draws, where the pairing cancels the`);
console.log(`shared round effect. Do not read them as absolute confidence intervals on a single cell;`);
console.log(`study-damage.ts bootstraps over rounds and is the right source for that.\n`);
