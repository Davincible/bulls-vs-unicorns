// Balance study: does any strategy dominate?
// Runs many independent rounds with mixed fighter sizes and measures ROI by strategy, so we can
// see whether being big, small, or an underdog is systematically better. Run: npm run study
import { simulateRound } from "./game.ts";
import type { Entry, Mode, RoundConfig } from "./game.ts";

const FEE = 0.002;
const cfg = (mode: Mode, multiplier: number): RoundConfig =>
  ({ mode, multiplier, base: 0.085, hitCapFrac: 0.25, battleMs: 60000, tickMs: 50, dust: 1.2 });

interface Strat { name: string; stake: () => number; }
const STRATS: Strat[] = [
  { name: "whale   (80-100)", stake: () => 80 + Math.random() * 20 },
  { name: "big     (50-80) ", stake: () => 50 + Math.random() * 30 },
  { name: "medium  (20-50) ", stake: () => 20 + Math.random() * 30 },
  { name: "small   (8-20)  ", stake: () => 8 + Math.random() * 12 },
  { name: "minnow  (3-8)   ", stake: () => 3 + Math.random() * 5 },
];

function rollMult() { const u = Math.random(); return u < 0.7 ? 1 : u < 0.85 ? 2 : u < 0.93 ? 4 : u < 0.97 ? 6 : u < 0.99 ? 8 : 10; }

interface Acc { in: number; out: number; rounds: number; wins: number; busts: number; best: number; }
const blank = (): Acc => ({ in: 0, out: 0, rounds: 0, wins: 0, busts: 0, best: 0 });

function run(mode: Mode, rounds: number, perSide: number) {
  const byStrat = new Map<string, Acc>(STRATS.map(s => [s.name, blank()]));
  const bySide = { bull: blank(), uwu: blank() };
  const byUnderdog = { underdog: blank(), favourite: blank() };
  let houseTake = 0, totalIn = 0, totalOut = 0;

  for (let r = 0; r < rounds; r++) {
    const entries: Entry[] = [];
    const meta = new Map<string, { strat: string; side: "bull" | "uwu"; gross: number }>();
    let id = 0;
    for (const side of ["bull", "uwu"] as const) {
      for (let i = 0; i < perSide; i++) {
        const st = STRATS[Math.floor(Math.random() * STRATS.length)];
        const gross = st.stake();
        const key = "p" + (++id);
        entries.push({ id: key, side, stake: gross * (1 - FEE) });   // fee skimmed on deploy
        meta.set(key, { strat: st.name, side, gross });
        houseTake += gross * FEE; totalIn += gross;
      }
    }
    const sideTotal = { bull: 0, uwu: 0 };
    for (const e of entries) sideTotal[e.side] += e.stake;

    const res = simulateRound("study-" + mode + "-" + r, entries, cfg(mode, rollMult()));
    for (const [key, bal] of Object.entries(res.settlement)) {
      const m = meta.get(key)!;
      const out = bal.bull + bal.uwu;
      totalOut += out;
      const acc = byStrat.get(m.strat)!;
      acc.in += m.gross; acc.out += out; acc.rounds++;
      if (m.side === res.winner) acc.wins++;
      if (out < m.gross * 0.05) acc.busts++;
      const roi = out / m.gross; if (roi > acc.best) acc.best = roi;
      const s = bySide[m.side]; s.in += m.gross; s.out += out; s.rounds++; if (m.side === res.winner) s.wins++;
      // was this fighter on the smaller (underdog) side at deploy time?
      const dog = sideTotal[m.side] < sideTotal[m.side === "bull" ? "uwu" : "bull"];
      const u = dog ? byUnderdog.underdog : byUnderdog.favourite;
      u.in += m.gross; u.out += out; u.rounds++; if (m.side === res.winner) u.wins++;
    }
  }
  return { byStrat, bySide, byUnderdog, houseTake, totalIn, totalOut };
}

const pct = (a: Acc) => ((a.out / a.in - 1) * 100);
const line = (label: string, a: Acc) =>
  `  ${label}  ROI ${pct(a) >= 0 ? "+" : ""}${pct(a).toFixed(2)}%   win ${(100 * a.wins / Math.max(1, a.rounds)).toFixed(0)}%   wipeout ${(100 * a.busts / Math.max(1, a.rounds)).toFixed(0)}%   best ${a.best.toFixed(1)}x   n=${a.rounds}`;

for (const mode of ["normal", "extraction"] as Mode[]) {
  const ROUNDS = 100, PER_SIDE = 10;
  const R = run(mode, ROUNDS, PER_SIDE);
  console.log(`\n=== ${mode.toUpperCase()} — ${ROUNDS} rounds x ${PER_SIDE * 2} fighters (${ROUNDS * PER_SIDE * 2} entries) ===`);
  console.log(` by stake size:`);
  for (const s of STRATS) console.log(line(s.name, R.byStrat.get(s.name)!));
  console.log(` by side:`);
  console.log(line("bull            ", R.bySide.bull));
  console.log(line("uwu             ", R.bySide.uwu));
  console.log(` by position at deploy:`);
  console.log(line("underdog side   ", R.byUnderdog.underdog));
  console.log(line("favourite side  ", R.byUnderdog.favourite));
  const edge = (1 - R.totalOut / R.totalIn) * 100;
  console.log(` house: took ${R.houseTake.toFixed(2)} of ${R.totalIn.toFixed(0)} deployed = ${edge.toFixed(3)}% actual edge (target 0.200%)`);
}
