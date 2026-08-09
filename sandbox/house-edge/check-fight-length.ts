// SANDBOX. Run: npx tsx sandbox/house-edge/check-fight-length.ts [seedsPerSize]
//
// The seat-law fix has a KNOCK-ON that touches a constant nobody asked me to change, so it is
// measured here rather than assumed away.
//
// `PENALTY_HORIZON_STEPS` — the cursor at which extracting becomes free — is documented as
// `round(25 * n^1.5)`, fitted to a measurement of "steps until one side has nobody standing" taken
// against the DEFENDER-basis damage rule. Under `min(ring_a, ring_d)` a minnow hitting a whale takes
// minnow-sized bites, so fights run longer, and the horizon is now a smaller fraction of the fight
// than it was when it was fitted.
//
// That is not automatically a bug — the penalty prices an OPTION, and the option is over wall-clock
// exposure, not over a fraction of a fight. This script measures the drift so the decision to
// recalibrate (or not) is made against numbers.
//
// Runs against engine/src/er-sim.ts DIRECTLY, so it measures the shipped rule and not the rig's
// reconstruction of it.

import { newRound, enter, tick, PENALTY_HORIZON_STEPS } from "../../engine/src/er-sim.ts";
import { DEPLOYED_V5, runFight, makeFighter, stepBudget } from "./fight-variant.ts";
import type { Fighter } from "./fight-variant.ts";
import { createHash } from "node:crypto";

const SEEDS = Number(process.argv[2] ?? 400);
const STAKE = 10_000_000n;   // $10 each, equal — the same shape the horizon was fitted against

/** First step at which one side has nobody standing, or the step budget if that never happens. */
function endStepShipped(n: number, seed: Buffer): number {
  const round = newRound(seed);
  for (let i = 0; i < n; i++) enter(round, `w${i}`, (i % 2) as 0 | 1, STAKE, 20n);
  const budget = stepBudget(n);
  // Tick one step at a time so the FIRST step at which the fight is decided is observable; the
  // mirror has no "ended" flag of its own.
  for (let s = 0; s < budget; s++) {
    tick(round, 1);
    let a = 0, b = 0;
    for (const f of round.fighters) if (f.dead === 0) { if (f.side === 0) a++; else b++; }
    if (a === 0 || b === 0) return s + 1;
  }
  return budget;
}

function endStepV5(n: number, seed: Buffer): number {
  const fs: Fighter[] = [];
  for (let i = 0; i < n; i++) fs.push(makeFighter(`w${i}`, (i % 2) as 0 | 1, STAKE).f);
  return runFight(fs, seed, stepBudget(n), DEPLOYED_V5).endedAt;
}

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1]; };

console.log(`\n=== fight length, before vs after the seat-law fix ===`);
console.log(`${SEEDS} seeds per lineup size, $10 each, equal stakes — the shape PENALTY_HORIZON_STEPS was fitted against\n`);
const head = "   n  budget   horizon   median end (v5)   median end (shipped)   change   horizon as % of fight: v5 -> shipped";
console.log(head);
console.log("-".repeat(head.length));

for (let n = 2; n <= 16; n++) {
  const before: number[] = [], after: number[] = [];
  for (let t = 0; t < SEEDS; t++) {
    const seed = createHash("sha256").update(`len|${n}|${t}`).digest();
    before.push(endStepV5(n, seed));
    after.push(endStepShipped(n, seed));
  }
  const mb = median(before), ma = median(after);
  const horizon = PENALTY_HORIZON_STEPS[n - 2];
  const pctB = (100 * horizon / mb), pctA = (100 * horizon / ma);
  console.log(
    `  ${String(n).padStart(2)}  ${String(stepBudget(n)).padStart(6)}  ${String(horizon).padStart(8)}  ` +
    `${String(mb).padStart(16)}  ${String(ma).padStart(21)}  ${((ma / mb - 1) * 100 >= 0 ? "+" : "")}${((ma / mb - 1) * 100).toFixed(0).padStart(5)}%   ` +
    `${pctB.toFixed(0).padStart(3)}% -> ${pctA.toFixed(0)}%`,
  );
}
console.log(`\nThe horizon is unchanged in absolute steps. What moved is how far through a fight it lands.`);
