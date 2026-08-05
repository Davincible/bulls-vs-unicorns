// Proves the engine is deterministic + verifiable (the core of provable fairness).
import { simulateRound, verifyRound, seedHash } from "./game.ts";
import type { Entry, Mode } from "./game.ts";
import { newRoundConfig } from "./round.ts";

function makeEntries(n: number): Entry[] {
  const e: Entry[] = [];
  for (let i = 0; i < n; i++) e.push({ id: "acct_" + i, side: i % 2 ? "uwu" : "bull", stake: 15 + Math.round(Math.random() * 85) });
  return e;
}

const seed = "a".repeat(64);           // in prod: randomBytes(32).hex, committed before lobby close
const entries = makeEntries(24);
const cfg = newRoundConfig("normal" as Mode, 1);

// 1) determinism: same seed+entries => identical result every time
const r1 = simulateRound(seed, entries, cfg);
const r2 = simulateRound(seed, entries, cfg);
const deterministic = JSON.stringify(r1.settlement) === JSON.stringify(r2.settlement) && r1.winner === r2.winner;

// 2) verification: an auditor re-runs and confirms
const ok = verifyRound(seed, entries, cfg, r1);

// 3) tamper detection: a wrong seed fails the published hash
const tampered = verifyRound("b".repeat(64), entries, { ...cfg }, r1);

// 4) economics sanity: total value roughly conserved (zero-sum among players; fee taken at deposit, not here)
const totalIn = entries.reduce((s, e) => s + e.stake, 0);
const totalOut = Object.values(r1.settlement).reduce((s, v) => s + v.bull + v.uwu, 0);

console.log(JSON.stringify({
  seedHash: seedHash(seed).slice(0, 16) + "…",
  winner: r1.winner,
  hitsLogged: r1.hits.length,
  deterministic,
  auditorVerifies: ok,
  tamperRejected: tampered === false,
  totalIn: Math.round(totalIn),
  totalOut: Math.round(totalOut),
  conservedPct: (totalOut / totalIn * 100).toFixed(1) + "%",
  sampleSettle: Object.entries(r1.settlement).slice(0, 3).map(([k, v]) => k + ":$" + Math.round(v.bull + v.uwu)),
}, null, 2));
