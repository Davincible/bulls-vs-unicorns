// SANDBOX. Run: npx tsx sandbox/house-edge/study-dial.ts [rounds] [perSide]
//
// Experiment 2: calibrate the dial.
//
// Experiment 1 established that the ATTACKER draw is the size-fairness knob and that `w = ring`
// lands almost exactly on size-neutral. This sweeps `w = M*ring + mean_ring` — one integer M,
// M = 0 reproducing today's uniform draw and M -> infinity approaching `w = ring` — and asks the
// only question that matters for a house edge: **what M buys a small, controllable tilt?**
//
// Both bases are swept, because they are different products:
//   * basis = ring  : the weight tracks live hp. Reaches neutrality; O(n) to maintain per step.
//   * basis = stake : the weight is frozen at entry. Cheap (one table per call) but has a residual
//                     structural tilt it cannot dial out — measured here rather than asserted.

import { runFight, payout, DUST_ABSOLUTE, mix } from "./fight-variant.ts";
import type { FightConfig, DustRule, WeightBasis } from "./fight-variant.ts";
import { BANDS, makeLobby, fightersOf, roiWithSE, pct, toUsd } from "./lobby.ts";

const ROUNDS = Number(process.argv[2] ?? 4000);
const PER_SIDE = Number(process.argv[3] ?? 4);
const STUDY_SEED = "house-edge-v1";
const ABS: DustRule = { kind: "absolute", units: DUST_ABSOLUTE };

const MS = [0n, 1n, 3n, 10n, 30n, 100n, 300n, 1_000n, 3_000n, 10_000n, 100_000n, 1_000_000n];
const CONFIGS: { name: string; cfg: FightConfig }[] = [];
for (const basis of ["ring", "stake"] as WeightBasis[])
  for (const m of MS)
    CONFIGS.push({
      name: `ATK mix basis=${basis.padEnd(5)} M=${String(m).padStart(9)}`,
      cfg: { attacker: mix(m, basis), defender: { kind: "uniform", basis: "ring" }, dust: ABS, layout: "wide" },
    });
CONFIGS.push({
  name: `ATK linear  basis=ring   (M = inf)  `,
  cfg: { attacker: { kind: "linear", basis: "ring" }, defender: { kind: "uniform", basis: "ring" }, dust: ABS, layout: "wide" },
});

const acc = CONFIGS.map(() => ({ byBand: BANDS.map(() => [] as { inn: number; out: number }[]) }));

for (let r = 0; r < ROUNDS; r++) {
  const lobby = makeLobby(STUDY_SEED, r, PER_SIDE);
  for (let c = 0; c < CONFIGS.length; c++) {
    const { fighters } = fightersOf(lobby);
    runFight(fighters, lobby.seed, lobby.steps, CONFIGS[c].cfg, lobby.hashes);
    const row = BANDS.map(() => ({ inn: 0, out: 0 }));
    for (let i = 0; i < fighters.length; i++) {
      row[lobby.entries[i].band].inn += toUsd(lobby.entries[i].grossUnits);
      row[lobby.entries[i].band].out += toUsd(payout(fighters[i]));
    }
    for (let b = 0; b < BANDS.length; b++) acc[c].byBand[b].push(row[b]);
  }
}

console.log(`\n=== EXPERIMENT 2: calibrating the attacker-weight dial  w = M*v + mean(v) ===`);
console.log(`study seed "${STUDY_SEED}"  |  ${ROUNDS} rounds x ${PER_SIDE * 2} fighters  |  20 bps fee, absolute dust\n`);
const head = "config                              " + ["whale", "big", "medium", "small", "minnow"].map(s => s.padStart(16)).join("") + "     spread";
console.log(head); console.log("-".repeat(head.length));
for (let c = 0; c < CONFIGS.length; c++) {
  const rs = BANDS.map((_, b) => roiWithSE(acc[c].byBand[b], 2000, 900 + c * 13 + b));
  const cells = rs.map(r => `${pct(r.roi, 2)}+-${(r.se * 100).toFixed(2)}`.padStart(16)).join("");
  console.log(`${CONFIGS[c].name} ${cells}  ${pct(rs[4].roi - rs[0].roi, 2).padStart(9)}`);
}
console.log(`\nspread = minnow ROI - whale ROI. The whole pot is redistributed, so band ROIs sum to -fee by construction.`);
