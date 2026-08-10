// SANDBOX. Run: npx tsx sandbox/house-edge/study-weights.ts [rounds] [perSide]
//
// Experiment 1: which knob actually moves ROI by stake band, and by how much?
//
// Method is engine/src/study.ts's, with three changes it needs to be worth anything at this scale:
//   * COMMON RANDOM NUMBERS. Every configuration is run against the same lobbies and the same hash
//     chain, so the comparison between configs is paired.
//   * BOOTSTRAP STANDARD ERRORS over rounds, not over entries. Fighters within a round are not
//     independent — one's gain is another's loss by construction.
//   * The DEPLOYED economy: settlement is per-fighter `hp + banked` (ARCHITECTURE-N-TEAM.md §3.4),
//     the winner is a badge, and nobody extracts. Extraction is a player choice, not a mechanism
//     knob, and folding a behavioural model of it into this table would make the table a measurement
//     of the model instead of the mechanism.

import { runFight, payout, DUST_ABSOLUTE, winnerSide, W_UNIFORM, mix, isStatic, FEE_BPS } from "./fight-variant.ts";
import type { FightConfig, WeightSpec, DustRule } from "./fight-variant.ts";
import { BANDS, makeLobby, fightersOf, roiWithSE, diffWithSE, pct, toUsd } from "./lobby.ts";

const ROUNDS = Number(process.argv[2] ?? 4000);
const PER_SIDE = Number(process.argv[3] ?? 4);
const STUDY_SEED = "house-edge-v1";

const ABS: DustRule = { kind: "absolute", units: DUST_ABSOLUTE };
const W = (kind: WeightSpec["kind"], basis: WeightSpec["basis"] = "ring"): WeightSpec => ({ kind, basis });
const cfg = (defender: WeightSpec, attacker: WeightSpec = W_UNIFORM, dust: DustRule = ABS): FightConfig =>
  ({ defender, attacker, dust, layout: "wide" });

const CONFIGS: { name: string; cfg: FightConfig }[] = [
  { name: "A  DEPLOYED  uniform/uniform, abs dust", cfg: { defender: W_UNIFORM, attacker: W_UNIFORM, dust: ABS, layout: "legacy" } },
  { name: "B  control   same rule, wide bytes    ", cfg: cfg(W_UNIFORM) },
  // --- defender weighting: the hypothesis under test -------------------------------------------
  { name: "C  DEF linear (ring)                  ", cfg: cfg(W("linear")) },
  { name: "D  DEF sqrt   (ring)                  ", cfg: cfg(W("sqrt")) },
  { name: "E  DEF pow34  (ring)                  ", cfg: cfg(W("pow34")) },
  { name: "F  DEF cap2   (min ring, 2x mean)     ", cfg: cfg(W("cap2")) },
  { name: "G  DEF cap3   (min ring, 3x mean)     ", cfg: cfg(W("cap3")) },
  // --- attacker weighting ----------------------------------------------------------------------
  { name: "H  ATK linear (ring)                  ", cfg: cfg(W_UNIFORM, W("linear")) },
  { name: "I  ATK sqrt   (ring)                  ", cfg: cfg(W_UNIFORM, W("sqrt")) },
  { name: "J  ATK linear (stake, STATIC)         ", cfg: cfg(W_UNIFORM, W("linear", "stake")) },
  { name: "K  ATK+DEF both linear (ring)         ", cfg: cfg(W("linear"), W("linear")) },
  // --- dust ------------------------------------------------------------------------------------
  { name: "L  dust 1% of stake                   ", cfg: cfg(W_UNIFORM, W_UNIFORM, { kind: "proportional", bps: 100n }) },
  { name: "M  dust 5% of stake                   ", cfg: cfg(W_UNIFORM, W_UNIFORM, { kind: "proportional", bps: 500n }) },
  { name: "N  dust 20% of stake                  ", cfg: cfg(W_UNIFORM, W_UNIFORM, { kind: "proportional", bps: 2000n }) },
  { name: "O  dust 50% of stake                  ", cfg: cfg(W_UNIFORM, W_UNIFORM, { kind: "proportional", bps: 5000n }) },
  // --- THE DIAL: attacker mix on static stake weights ------------------------------------------
  ...[0n, 1n, 3n, 10n, 30n, 100n, 300n, 1000n, 3000n].map(m => ({
    name: `Q  ATK mix M=${String(m).padEnd(4)} (stake, STATIC)   `.slice(0, 38),
    cfg: cfg(W_UNIFORM, mix(m, "stake")),
  })),
];

interface Acc {
  perRoundByBand: { inn: number; out: number }[][];
  deaths: number[]; entries: number[];
  steps: number; ended: number; exchanges: number; weightPasses: number; rounds: number;
}
const blank = (): Acc => ({
  perRoundByBand: BANDS.map(() => []),
  deaths: BANDS.map(() => 0), entries: BANDS.map(() => 0),
  steps: 0, ended: 0, exchanges: 0, weightPasses: 0, rounds: 0,
});

const acc = CONFIGS.map(blank);

for (let r = 0; r < ROUNDS; r++) {
  const lobby = makeLobby(STUDY_SEED, r, PER_SIDE);
  for (let c = 0; c < CONFIGS.length; c++) {
    const { fighters } = fightersOf(lobby);
    const st = runFight(fighters, lobby.seed, lobby.steps, CONFIGS[c].cfg, lobby.hashes);
    const A = acc[c];
    const byBand = BANDS.map(() => ({ inn: 0, out: 0 }));
    for (let i = 0; i < fighters.length; i++) {
      const e = lobby.entries[i], f = fighters[i];
      byBand[e.band].inn += toUsd(e.grossUnits);
      byBand[e.band].out += toUsd(payout(f));
      A.entries[e.band]++; if (f.dead === 1) A.deaths[e.band]++;
    }
    for (let b = 0; b < BANDS.length; b++) A.perRoundByBand[b].push(byBand[b]);
    A.steps += st.steps; A.ended += st.endedAt; A.exchanges += st.exchanges;
    A.weightPasses += st.weightPasses; A.rounds++;
  }
}

console.log(`\n=== EXPERIMENT 1: what moves ROI by stake band ===`);
console.log(`study seed "${STUDY_SEED}"  |  ${ROUNDS} rounds x ${PER_SIDE * 2} fighters = ${ROUNDS * PER_SIDE * 2} entries`);
console.log(`economy: per-fighter settlement (hp + banked), ${FEE_BPS} bps entry fee, no extractions`);
console.log(`step budget: min(4000, 240 x n) = ${Math.min(4000, 240 * PER_SIDE * 2)} steps`);
console.log(`ROI is dollar-weighted (sum payout / sum gross - 1); +/- is a bootstrap SE over rounds (2000 resamples)\n`);

const head = "config                                 " + ["whale", "big", "medium", "small", "minnow"].map(s => s.padStart(16)).join("") + "   alive  ends";
console.log(head);
console.log("-".repeat(head.length));

for (let c = 0; c < CONFIGS.length; c++) {
  const A = acc[c];
  const cells = BANDS.map((_, b) => {
    const { roi, se } = roiWithSE(A.perRoundByBand[b], 2000, 1000 + c * 17 + b);
    return `${pct(roi, 1)}+-${(se * 100).toFixed(1)}`.padStart(16);
  }).join("");
  const survive = 1 - A.deaths.reduce((a, x) => a + x, 0) / A.entries.reduce((a, x) => a + x, 0);
  console.log(`${CONFIGS[c].name} ${cells}   ${(survive * 100).toFixed(0).padStart(4)}% ${(A.ended / A.rounds).toFixed(0).padStart(5)}`);
}

console.log(`\nalive = share of fighters standing at the bell.  ends = mean step at which one side was wiped.`);

console.log(`\n--- tilt: minnow ROI minus whale ROI, and the paired change vs DEPLOYED ---\n`);
console.log(`config                                   spread     d(minnow)         d(whale)          static?`);
const base = acc[0];
for (let c = 0; c < CONFIGS.length; c++) {
  const A = acc[c];
  const mn = roiWithSE(A.perRoundByBand[4], 1000, 5000 + c);
  const wh = roiWithSE(A.perRoundByBand[0], 1000, 6000 + c);
  const dMn = diffWithSE(A.perRoundByBand[4], base.perRoundByBand[4], 1000, 7000 + c);
  const dWh = diffWithSE(A.perRoundByBand[0], base.perRoundByBand[0], 1000, 8000 + c);
  const stat = isStatic(CONFIGS[c].cfg.attacker) && isStatic(CONFIGS[c].cfg.defender) ? "yes" : "NO ";
  console.log(`${CONFIGS[c].name} ${pct(mn.roi - wh.roi, 1).padStart(9)}  ${(pct(dMn.diff, 1) + "+-" + (dMn.se * 100).toFixed(1)).padStart(16)}  ${(pct(dWh.diff, 1) + "+-" + (dWh.se * 100).toFixed(1)).padStart(16)}   ${stat}`);
}

console.log(`\n--- compute: O(n) weight rebuilds per step (n = ${PER_SIDE * 2}) ---\n`);
for (let c = 0; c < CONFIGS.length; c++) {
  const A = acc[c];
  console.log(`${CONFIGS[c].name}  ${(A.weightPasses / A.steps).toFixed(3)} rebuilds/step  (${(A.weightPasses / A.rounds).toFixed(1)} per round)`);
}
