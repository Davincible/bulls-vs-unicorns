// SANDBOX. Run: npx tsx sandbox/house-edge/study-split.ts [rounds]
//
// Experiment 4: where it breaks. A player with a fixed budget B splits it across k wallets instead
// of one. If splitting pays, the tilt is not a house edge — it is a public subsidy to whoever
// bothers to open more wallets, and the house's "many small accounts" strategy is simply the first
// instance of an attack anyone can run.
//
// The bound is structural and worth stating before the numbers: `MAX_FIGHTERS = 48` (raised from 16
// in the zero_copy migration — the seat law itself is unchanged, only how many seats there are to
// claim), and `enter` tops up rather than duplicating a wallet already on that side — so k is capped
// at 48 minus however many slots other people took, and at 96 wallets even in principle (48 slots x
// two sides; a wallet may hold one entry per side, so 48 slots is the real bound). Sybil resistance
// here is a seat limit, not an identity check, and seats are the only thing that is scarce. The
// conclusion below (splitting does not pay under the shipped rule) does not depend on the seat count —
// it follows from the seat law holding at ANY k <= seats — so raising the cap moves how far the sweep
// can run, not what it finds.
//
// Design: the lobby is always exactly MAX_FIGHTERS fighters (48). The splitter takes k of them, the
// background takes 48 - k. That confounds "more of my wallets" with "fewer of theirs" — deliberately,
// because that is the actual trade a player faces in a full lobby, and separating the two would
// measure a game nobody can play.

import { runFight, payout, DUST_ABSOLUTE, W_UNIFORM, BASELINE, DEPLOYED_V5 } from "./fight-variant.ts";
import type { FightConfig, DustRule } from "./fight-variant.ts";
import { BANDS, finish, fightersOf, usd, pct, toUsd } from "./lobby.ts";
import type { Entry } from "./lobby.ts";
import { mulberry32 } from "./rng.ts";

const ROUNDS = Number(process.argv[2] ?? 3000);
const STUDY_SEED = "house-edge-v1";
const ABS: DustRule = { kind: "absolute", units: DUST_ABSOLUTE };
const SEATS = 48;
const BUDGET = 80;    // USD — a whale-band budget, so k = 1 is the top band of experiment 1

/** The recommended mechanism from experiment 5: uniform selection exactly as deployed, and the only
 *  change is what the damage roll is a percentage OF. `P` is in basis points; P = 0 is size-neutral,
 *  P = 10,000 is the deployed rule. O(1) per step. */
const dial = (P: bigint): FightConfig =>
  ({ attacker: W_UNIFORM, defender: W_UNIFORM, dust: ABS, layout: "wide", damage: { blend: P } });

function lobbiesFor(k: number, rounds: number) {
  const out = [];
  for (let r = 0; r < rounds; r++) {
    const rnd = mulberry32((r * 2654435761 + k * 7919) >>> 0);
    const entries: Entry[] = [];
    let id = 0;
    for (let i = 0; i < k; i++)
      entries.push({ wallet: `s${++id}`, side: (i % 2) as 0 | 1, grossUnits: usd(BUDGET / k), band: -1, house: true });
    for (let i = 0; i < SEATS - k; i++) {
      const b = BANDS[Math.floor(rnd() * BANDS.length)];
      entries.push({ wallet: `p${++id}`, side: ((i + 1) % 2) as 0 | 1, grossUnits: usd(b.lo + rnd() * (b.hi - b.lo)), band: -1, house: false });
    }
    out.push(finish(`${STUDY_SEED}|split|${k}`, r, entries));
  }
  return out;
}

/** The two rules that actually exist: v5, and what shipped. The `dial(P)` columns beside them are
 *  exploratory — they answer "what if a tilt were reintroduced", not "what happens now". */
const NAMED: { label: string; cfg: FightConfig }[] = [
  { label: "v5 (before)", cfg: DEPLOYED_V5 },
  { label: "SHIPPED", cfg: BASELINE },
];

function score(cfg: FightConfig, lobbies: ReturnType<typeof lobbiesFor>) {
  let inn = 0, out = 0;
  const per: number[] = [];
  for (const lobby of lobbies) {
    const { fighters } = fightersOf(lobby);
    runFight(fighters, lobby.seed, lobby.steps, cfg, lobby.hashes, true);
    let i = 0, o = 0;
    for (let j = 0; j < fighters.length; j++)
      if (lobby.entries[j].house) { i += toUsd(lobby.entries[j].grossUnits); o += toUsd(payout(fighters[j])); }
    inn += i; out += o; per.push(o / i - 1);
  }
  const roi = out / inn - 1;
  const mu = per.reduce((a, x) => a + x, 0) / per.length;
  const se = Math.sqrt(per.reduce((a, x) => a + (x - mu) ** 2, 0) / (per.length - 1) / per.length);
  return { roi, se };
}

const KS = [1, 2, 3, 4, 6, 8, 10, 12];
const MS = [0n, 10n, 20n, 40n, 100n, 10000n];  // blend P in BPS (10000 = deployed)
const COLUMNS: { label: string; cfg: FightConfig }[] = [
  ...NAMED,
  ...MS.map(m => ({ label: `P=${m}bps`, cfg: dial(m) })),
];

console.log(`\n=== EXPERIMENT 4: is splitting a $${BUDGET} budget across k wallets profitable? ===`);
console.log(`study seed "${STUDY_SEED}"  |  ${ROUNDS} rounds per cell  |  ${SEATS} seats, splitter takes k, background takes ${SEATS}-k`);
console.log(`background drawn from the five bands (mean ~$42). ROI is on the splitter's whole $${BUDGET}.\n`);

const header = "  k   stake each " + COLUMNS.map(c => c.label.padStart(17)).join("");
console.log(header); console.log("-".repeat(header.length));
const table: Record<string, { roi: number; se: number }[]> = {};
for (const k of KS) {
  const lobbies = lobbiesFor(k, ROUNDS);
  const row = COLUMNS.map(c => score(c.cfg, lobbies));
  table[k] = row;
  console.log(`${String(k).padStart(3)}   ${("$" + (BUDGET / k).toFixed(2)).padStart(9)}  ` +
    row.map(r => `${pct(r.roi, 2)}+-${(r.se * 100).toFixed(2)}`.padStart(17)).join(""));
}

console.log(`\n--- gain from splitting, relative to entering as one $${BUDGET} fighter (percentage points of ROI) ---\n`);
console.log("  k  " + COLUMNS.map(c => c.label.padStart(14)).join(""));
for (const k of KS) {
  console.log(`${String(k).padStart(3)}  ` + COLUMNS.map((_, i) => {
    const d = table[k][i].roi - table[1][i].roi;
    const se = Math.hypot(table[k][i].se, table[1][i].se);
    return `${pct(d, 1)}+-${(se * 100).toFixed(1)}`.padStart(14);
  }).join(""));
}

console.log(`\n--- the practical question: how much is one extra wallet worth, in dollars per round, on a $${BUDGET} budget ---\n`);
console.log("  k  " + COLUMNS.map(c => c.label.padStart(12)).join(""));
for (const k of KS) {
  console.log(`${String(k).padStart(3)}  ` + COLUMNS.map((_, i) =>
    `$${((table[k][i].roi - table[1][i].roi) * BUDGET).toFixed(2)}`.padStart(12)).join(""));
}
console.log(`\nA row worth less than the gas + signing cost of running k wallets is a tilt nobody will farm.`);
