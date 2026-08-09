// SANDBOX. Run: npx tsx sandbox/house-edge/study-damage.ts [rounds] [perSide]
//
// Experiment 5: the O(1) route. Weighted selection costs O(n) per step against a 1.4M-CU ceiling this
// repo has already broken twice. Changing what the damage is a percentage OF costs nothing — no
// table, no cumulative walk, no wide modulo, no change to the byte layout, and (for `min`) not even
// an extra multiply.
//
// If `min` or `geo` reproduces what attacker weighting buys, it is the mechanism to ship, and the
// entire compute argument evaporates.

import { runFight, payout, DUST_ABSOLUTE, W_UNIFORM, mix, BASELINE, DEPLOYED_V5 } from "./fight-variant.ts";
import type { FightConfig, DustRule } from "./fight-variant.ts";
import { BANDS, makeLobby, fightersOf, roiWithSE, pct, toUsd } from "./lobby.ts";

const ROUNDS = Number(process.argv[2] ?? 3000);
const PER_SIDE = Number(process.argv[3] ?? 4);
const STUDY_SEED = "house-edge-v1";
const ABS: DustRule = { kind: "absolute", units: DUST_ABSOLUTE };

const CONFIGS: { name: string; cfg: FightConfig }[] = [
  // The two rows that matter now: what v5 does, and what the fix ships. Both on the DEPLOYED byte
  // layout, so the comparison is not confounded by which hash bytes drive the draws — the exploratory
  // rows below use `wide`, which is why they should not be read as before/after pairs.
  { name: "v5   dmg=defender, draw=bump (before) ", cfg: DEPLOYED_V5 },
  { name: "SHIPPED  dmg=min, draw=shift (after)  ", cfg: BASELINE },
  { name: "DEPLOYED   dmg=defender, atk uniform  ", cfg: { attacker: W_UNIFORM, defender: W_UNIFORM, dust: ABS, layout: "legacy" } },
  { name: "O(1)  dmg=min,  atk uniform           ", cfg: { attacker: W_UNIFORM, defender: W_UNIFORM, dust: ABS, layout: "wide", damage: "min" } },
  { name: "O(1)  dmg=geo,  atk uniform           ", cfg: { attacker: W_UNIFORM, defender: W_UNIFORM, dust: ABS, layout: "wide", damage: "geo" } },
  { name: "O(n)  dmg=defender, atk linear(ring)  ", cfg: { attacker: { kind: "linear", basis: "ring" }, defender: W_UNIFORM, dust: ABS, layout: "wide" } },
  { name: "O(n)  dmg=defender, atk mix M=30      ", cfg: { attacker: mix(30n, "ring"), defender: W_UNIFORM, dust: ABS, layout: "wide" } },
  { name: "O(1)  dmg=min,  atk uniform, dust 5%  ", cfg: { attacker: W_UNIFORM, defender: W_UNIFORM, dust: { kind: "proportional", bps: 500n }, layout: "wide", damage: "min" } },
  { name: "O(1)  dmg=geo,  atk uniform, dust 5%  ", cfg: { attacker: W_UNIFORM, defender: W_UNIFORM, dust: { kind: "proportional", bps: 500n }, layout: "wide", damage: "geo" } },
  ...[0n, 5n, 10n, 15n, 20n, 30n, 40n, 60n, 100n, 200n, 500n, 10000n].map(P => ({
    name: `O(1)  dmg blend P=${String(P).padStart(5)} bps (0=min)`.padEnd(38),
    cfg: { attacker: W_UNIFORM, defender: W_UNIFORM, dust: ABS, layout: "wide" as const, damage: { blend: P } },
  })),
];

const acc = CONFIGS.map(() => ({ byBand: BANDS.map(() => [] as { inn: number; out: number }[]), ended: 0, alive: 0, seats: 0 }));

for (let r = 0; r < ROUNDS; r++) {
  const lobby = makeLobby(STUDY_SEED, r, PER_SIDE);
  for (let c = 0; c < CONFIGS.length; c++) {
    const { fighters } = fightersOf(lobby);
    const st = runFight(fighters, lobby.seed, lobby.steps, CONFIGS[c].cfg, lobby.hashes, true);
    const row = BANDS.map(() => ({ inn: 0, out: 0 }));
    for (let i = 0; i < fighters.length; i++) {
      row[lobby.entries[i].band].inn += toUsd(lobby.entries[i].grossUnits);
      row[lobby.entries[i].band].out += toUsd(payout(fighters[i]));
      acc[c].seats++; if (fighters[i].dead === 0) acc[c].alive++;
    }
    for (let b = 0; b < BANDS.length; b++) acc[c].byBand[b].push(row[b]);
    acc[c].ended += st.endedAt;
  }
}

console.log(`\n=== EXPERIMENT 5: O(1) damage rules vs O(n) weighted selection ===`);
console.log(`study seed "${STUDY_SEED}"  |  ${ROUNDS} rounds x ${PER_SIDE * 2} fighters  |  20 bps fee\n`);
const head = "config                                 " + ["whale", "big", "medium", "small", "minnow"].map(s => s.padStart(16)).join("") + "    spread  alive  ends";
console.log(head); console.log("-".repeat(head.length));
for (let c = 0; c < CONFIGS.length; c++) {
  const rs = BANDS.map((_, b) => roiWithSE(acc[c].byBand[b], 2000, 400 + c * 11 + b));
  console.log(`${CONFIGS[c].name} ${rs.map(r => `${pct(r.roi, 2)}+-${(r.se * 100).toFixed(2)}`.padStart(16)).join("")}  ${pct(rs[4].roi - rs[0].roi, 1).padStart(9)}  ${(100 * acc[c].alive / acc[c].seats).toFixed(0).padStart(4)}% ${(acc[c].ended / ROUNDS).toFixed(0).padStart(5)}`);
}
console.log("");
