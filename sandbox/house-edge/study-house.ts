// SANDBOX. Run: npx tsx sandbox/house-edge/study-house.ts [rounds]
//
// Experiment 3: the number the user actually asked for — house take as a fraction of TOTAL VOLUME
// when the house fields N small fighters, swept over N, over the dial M, and over what the players
// look like.
//
// The framing to be careful about. The fight redistributes; it does not create. So
// `house_profit = -player_profit` exactly, and the house's edge is not a property of the mechanism
// alone — it is a property of the mechanism AND of how different the house's stakes are from the
// players'. Two consequences that the arithmetic in the brief does not capture and this experiment
// is built to expose:
//
//   1. As house share -> 100% the house is playing itself and its profit -> 0, however strong the
//      tilt. So `house_profit / volume` is not monotone in house share: it has an interior maximum.
//   2. If players stake like the house does, the tilt has nothing to bite on and the take is zero
//      at every M. "Small stakes win" only pays the house while the house is the SMALL one.
//
// Both are measured below rather than argued.

import { runFight, payout, DUST_ABSOLUTE, mix, FEE_BPS, BPS } from "./fight-variant.ts";
import type { FightConfig, DustRule } from "./fight-variant.ts";
import { BANDS, finish, fightersOf, roiWithSE, usd, pct, toUsd } from "./lobby.ts";
import type { Entry } from "./lobby.ts";
import { mulberry32 } from "./rng.ts";

const ROUNDS = Number(process.argv[2] ?? 3000);
const STUDY_SEED = "house-edge-v1";
const ABS: DustRule = { kind: "absolute", units: DUST_ABSOLUTE };
const MAX_FIGHTERS = 16;

const dial = (m: bigint): FightConfig =>
  ({ attacker: mix(m, "ring"), defender: { kind: "uniform", basis: "ring" }, dust: ABS, layout: "wide" });

/** Player populations. `wide` is study.ts's five-band mix; `small` is what a lobby looks like once
 *  players have worked out that small is better and copied the house. */
const POPULATIONS = {
  wide: (rnd: () => number) => { const b = BANDS[Math.floor(rnd() * BANDS.length)]; return b.lo + rnd() * (b.hi - b.lo); },
  small: (rnd: () => number) => 3 + rnd() * 17,     // $3-20, i.e. the bottom two bands only
} as const;
type Pop = keyof typeof POPULATIONS;

interface Row { houseIn: number; houseOut: number; volume: number; fees: number; playerIn: number; playerOut: number; }

/** Build the lobbies for one (population, houseCount) cell once. The hash chain is the expensive
 *  part and depends only on the lobby, never on M, so every dial setting is scored against the same
 *  lobbies AND the same draws — the same paired design as experiment 1, and about 6x faster. */
function lobbiesFor(houseCount: number, houseStakeUsd: number, pop: Pop, rounds: number) {
  const out = [];
  const playerCount = MAX_FIGHTERS - houseCount;
  for (let r = 0; r < rounds; r++) {
    const rnd = mulberry32((r * 2654435761 + houseCount * 40503 + (pop === "wide" ? 0 : 999983)) >>> 0);
    const entries: Entry[] = [];
    let id = 0;
    // Alternate sides so neither the house nor the players are concentrated on one side; the badge
    // is not paid on, but same-side pairs never exchange, so concentration would silently change how
    // often the house can raid at all.
    for (let i = 0; i < houseCount; i++)
      entries.push({ wallet: `h${++id}`, side: (i % 2) as 0 | 1, grossUnits: usd(houseStakeUsd), band: -1, house: true });
    for (let i = 0; i < playerCount; i++)
      entries.push({ wallet: `p${++id}`, side: ((i + 1) % 2) as 0 | 1, grossUnits: usd(POPULATIONS[pop](rnd)), band: -1, house: false });
    out.push(finish(`${STUDY_SEED}|house|${pop}|${houseCount}`, r, entries));
  }
  return out;
}

function scenario(m: bigint, lobbies: ReturnType<typeof lobbiesFor>): Row[] {
  const cfg = dial(m);
  const out: Row[] = [];
  for (const lobby of lobbies) {
    const { fighters, fees } = fightersOf(lobby);
    runFight(fighters, lobby.seed, lobby.steps, cfg, lobby.hashes, true);
    const row: Row = { houseIn: 0, houseOut: 0, volume: 0, fees: toUsd(fees), playerIn: 0, playerOut: 0 };
    for (let i = 0; i < fighters.length; i++) {
      const gin = toUsd(lobby.entries[i].grossUnits), gout = toUsd(payout(fighters[i]));
      row.volume += gin;
      if (lobby.entries[i].house) { row.houseIn += gin; row.houseOut += gout; }
      else { row.playerIn += gin; row.playerOut += gout; }
    }
    out.push(row);
  }
  return out;
}

const agg = (rs: Row[]) => {
  const s = rs.reduce((a, r) => ({
    houseIn: a.houseIn + r.houseIn, houseOut: a.houseOut + r.houseOut, volume: a.volume + r.volume,
    fees: a.fees + r.fees, playerIn: a.playerIn + r.playerIn, playerOut: a.playerOut + r.playerOut,
  }), { houseIn: 0, houseOut: 0, volume: 0, fees: 0, playerIn: 0, playerOut: 0 });
  return {
    share: s.houseIn / s.volume,
    edgeOwn: s.houseOut / s.houseIn - 1,
    onVolume: (s.houseOut - s.houseIn) / s.volume,
    withFee: (s.houseOut - s.houseIn + s.fees) / s.volume,
    playerRoi: s.playerOut / s.playerIn - 1,
  };
};
/** Bootstrap SE of house profit / volume, resampling rounds. */
const seOnVolume = (rs: Row[], seed = 11) => {
  const rnd = mulberry32(seed), draws: number[] = [];
  for (let b = 0; b < 1500; b++) {
    let hi = 0, ho = 0, v = 0;
    for (let k = 0; k < rs.length; k++) { const j = Math.floor(rnd() * rs.length); hi += rs[j].houseIn; ho += rs[j].houseOut; v += rs[j].volume; }
    draws.push((ho - hi) / v);
  }
  const mu = draws.reduce((a, x) => a + x, 0) / draws.length;
  return Math.sqrt(draws.reduce((a, x) => a + (x - mu) ** 2, 0) / (draws.length - 1));
};

console.log(`\n=== EXPERIMENT 3: house take vs dial M, house fighter count, and player population ===`);
console.log(`study seed "${STUDY_SEED}"  |  ${ROUNDS} rounds per cell  |  16 fighters per round (MAX_FIGHTERS)`);
console.log(`house plays $5 fighters. "wide" players = study.ts's five bands (mean ~$42). "small" players = $3-20 (mean ~$11.5).`);
console.log(`fee = ${FEE_BPS} bps = ${Number(FEE_BPS * 100n / BPS)}% of volume, collected regardless — shown separately, never mixed into the edge.\n`);

const MS = [30n, 100n, 200n, 300n, 600n, 1000n];
const HNS = [2, 4, 6, 8, 10, 12, 14];

for (const pop of ["wide", "small"] as Pop[]) {
  console.log(`--- player population: ${pop} ---\n`);
  console.log(`houseN  house share  ` + MS.map(m => `M=${m}`.padStart(17)).join(""));
  console.log(`                     ` + MS.map(() => "take/volume".padStart(17)).join(""));
  for (const hn of HNS) {
    const lobbies = lobbiesFor(hn, 5, pop, ROUNDS);
    const cells: string[] = []; let share = 0;
    for (const m of MS) {
      const rs = scenario(m, lobbies);
      const a = agg(rs), se = seOnVolume(rs, 11 + hn);
      share = a.share;
      cells.push(`${pct(a.onVolume, 3)}+-${(se * 100).toFixed(3)}`.padStart(17));
    }
    console.log(`${String(hn).padStart(6)}  ${pct(share, 1).padStart(11)}  ` + cells.join(""));
  }
  console.log("");
  // The decomposition the brief asks about: is take/volume really share x edge-on-own-stake, and is
  // edge-on-own-stake independent of share? Printed at one M so the two columns can be compared.
  console.log(`  decomposition at M=100:`);
  console.log(`  houseN   share   edge on own stake   share x edge   measured take/volume   player ROI`);
  for (const hn of HNS) {
    const a = agg(scenario(100n, lobbiesFor(hn, 5, pop, ROUNDS)));
    console.log(`  ${String(hn).padStart(6)}  ${pct(a.share, 1).padStart(6)}  ${pct(a.edgeOwn, 2).padStart(17)}  ${pct(a.share * a.edgeOwn, 3).padStart(13)}  ${pct(a.onVolume, 3).padStart(21)}  ${pct(a.playerRoi, 3).padStart(11)}`);
  }
  console.log("");
}
