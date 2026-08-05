// "How do I actually make money?" — bankroll simulation.
// The ROI study measures single rounds. This plays STRATEGIES over many rounds with a real
// bankroll, which is what a player experiences: does a style compound, or bleed out?
// Run: npm run strategy
import { simulateRound } from "./game.ts";
import type { Entry, Mode, RoundConfig } from "./game.ts";

const FEE = 0.002, CAP = 100;
const cfg = (mode: Mode, multiplier: number): RoundConfig =>
  ({ mode, multiplier, base: 0.085, hitCapFrac: 0.25, battleMs: 60000, tickMs: 50, dust: 1.2 });
const rollMult = () => { const u = Math.random(); return u < 0.7 ? 1 : u < 0.85 ? 2 : u < 0.93 ? 4 : u < 0.97 ? 6 : u < 0.99 ? 8 : 10; };

// a strategy decides how much of its bankroll to put in, given the round it can see
interface Strat { name: string; bet: (bank: number, ctx: { favSide: "bull" | "uwu"; mySide: "bull" | "uwu" }) => number; side?: "fav" | "dog" | "random"; }

const STRATS: Strat[] = [
  { name: "flat $5 every round     ", bet: () => 5 },
  { name: "flat $25 every round    ", bet: () => 25 },
  { name: "flat $100 (max)         ", bet: () => 100 },
  { name: "5% of bankroll          ", bet: b => Math.max(1, b * 0.05) },
  { name: "25% of bankroll         ", bet: b => Math.max(1, b * 0.25) },
  { name: "all-in every round      ", bet: b => b },
  { name: "flat $25, join FAVOURITE", bet: () => 25, side: "fav" },
  { name: "flat $25, join UNDERDOG ", bet: () => 25, side: "dog" },
];

const START = 500, ROUNDS = 120, TRIALS = 14;

function play(mode: Mode, st: Strat) {
  const finals: number[] = []; let ruined = 0, totalStaked = 0, totalBack = 0;
  for (let trial = 0; trial < TRIALS; trial++) {
    let bank = START;
    for (let r = 0; r < ROUNDS; r++) {
      if (bank < 1) { ruined++; break; }
      // the rest of the field: a mixed crowd, both sides
      const field: Entry[] = []; let id = 0;
      const sideTot = { bull: 0, uwu: 0 };
      for (const side of ["bull", "uwu"] as const)
        for (let i = 0; i < 9; i++) {
          const g = 5 + Math.random() * 95;
          field.push({ id: "n" + (++id), side, stake: g * (1 - FEE) });
          sideTot[side] += g;
        }
      const favSide: "bull" | "uwu" = sideTot.bull >= sideTot.uwu ? "bull" : "uwu";
      const mySide: "bull" | "uwu" =
        st.side === "fav" ? favSide : st.side === "dog" ? (favSide === "bull" ? "uwu" : "bull")
        : Math.random() < 0.5 ? "bull" : "uwu";
      const gross = Math.min(st.bet(bank, { favSide, mySide }), bank, CAP);
      if (gross < 1) { ruined++; break; }
      bank -= gross; totalStaked += gross;
      const entries = [...field, { id: "ME", side: mySide, stake: gross * (1 - FEE) }];
      const res = simulateRound(`strat-${mode}-${st.name}-${trial}-${r}`, entries, cfg(mode, rollMult()));
      const back = (res.settlement["ME"]?.bull || 0) + (res.settlement["ME"]?.uwu || 0);
      bank += back; totalBack += back;
    }
    finals.push(bank);
  }
  finals.sort((a, b) => a - b);
  const median = finals[Math.floor(finals.length / 2)];
  const mean = finals.reduce((a, b) => a + b, 0) / finals.length;
  const profitable = finals.filter(f => f > START).length;
  return { median, mean, profitable, ruined, roi: (totalBack / totalStaked - 1) * 100 };
}

for (const mode of ["normal", "extraction"] as Mode[]) {
  console.log(`\n=== ${mode.toUpperCase()} — start $${START}, ${ROUNDS} rounds, ${TRIALS} players each ===`);
  console.log(` strategy                    median end   mean end   ended up   busted   per-round ROI`);
  for (const st of STRATS) {
    const r = play(mode, st);
    const flag = r.median >= START ? " <-- profitable" : "";
    console.log(`  ${st.name}  $${r.median.toFixed(0).padStart(6)}   $${r.mean.toFixed(0).padStart(6)}   ${String(r.profitable + "/" + TRIALS).padStart(5)}   ${String(r.ruined).padStart(2)}     ${(r.roi >= 0 ? "+" : "") + r.roi.toFixed(2)}%${flag}`);
  }
}
