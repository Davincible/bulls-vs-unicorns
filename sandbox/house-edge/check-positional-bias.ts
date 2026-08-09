// SANDBOX. Run: npx tsx sandbox/house-edge/check-positional-bias.ts
//
// A control, run against engine/src/er-sim.ts directly. With every fighter staking the SAME amount,
// nothing but slot index distinguishes them — so any systematic difference in payout by slot is a
// property of the selection rule, not of the stakes. Two candidates worth ruling in or out:
//
//   * `if d == a { d = (d + 1) % n }` gives slot (a+1) mod n extra defender probability. Whether that
//     matters depends on whether a and a+1 are on opposite sides, which depends on how sides are laid
//     out across the slot array — i.e. on ENTRY ORDER, which is whoever's transaction landed first.
//   * a fighter that dies stops attacking, so anything that kills one slot sooner compounds.
//
// If slot index is worth real money, that is a fairness defect in the DEPLOYED program independent of
// any house-edge question, and it is a race on transaction ordering.

import { newRound, enter, tick, settle } from "../../engine/src/er-sim.ts";
import { stepBudget, UNITS_PER_USD } from "./fight-variant.ts";
import { createHash } from "node:crypto";

const toUsd = (u: bigint) => Number(u) / Number(UNITS_PER_USD);
const TRIALS = Number(process.argv[2] ?? 4000);

/** Two side layouts over the same 8 slots. "blocked" is 0,0,0,0,1,1,1,1; "alternating" is 0,1,0,1,...
 *  Both are reachable in production — the array is filled in the order `enter` lands. */
const LAYOUTS: Record<string, (0 | 1)[]> = {
  "blocked  0000 1111": [0, 0, 0, 0, 1, 1, 1, 1],
  "alternate 0101 0101": [0, 1, 0, 1, 0, 1, 0, 1],
};

for (const [label, sides] of Object.entries(LAYOUTS)) {
  const n = sides.length;
  const out = new Array(n).fill(0);
  const sq = new Array(n).fill(0);
  const deaths = new Array(n).fill(0);
  for (let t = 0; t < TRIALS; t++) {
    const seed = createHash("sha256").update(`bias|${label}|${t}`).digest();
    const round = newRound(seed);
    for (let i = 0; i < n; i++) enter(round, `w${i}`, sides[i], 10_000_000n, 20n);   // $10 each
    tick(round, stepBudget(n));
    settle(round);
    for (let i = 0; i < n; i++) {
      const v = toUsd(round.fighters[i].hp + round.fighters[i].banked);
      out[i] += v; sq[i] += v * v;
      if (round.fighters[i].dead === 1) deaths[i]++;
    }
  }
  const mean = out.reduce((a, x) => a + x, 0) / n / TRIALS;
  console.log(`\n--- ${label} --- ${TRIALS} seeds, $10 each, fair share = $${mean.toFixed(3)}`);
  console.log(`slot  side   mean payout   vs fair share   death rate`);
  let worst = 0;
  for (let i = 0; i < n; i++) {
    const m = out[i] / TRIALS;
    // SE of the per-slot mean across seeds. It is reported because once the (d+1)%n bump is gone the
    // remaining differences are the SIZE OF THE NOISE, and a table of small numbers with no error
    // bar cannot tell "fixed" from "smaller". Seeds are independent by construction here.
    const se = Math.sqrt((sq[i] / TRIALS - m * m) / (TRIALS - 1));
    const dev = (m / mean - 1) * 100;
    const sigma = Math.abs(m - mean) / se;
    worst = Math.max(worst, sigma);
    console.log(`  ${i}     ${sides[i]}    $${m.toFixed(3).padStart(8)}   ${(dev >= 0 ? "+" : "")}${dev.toFixed(1).padStart(6)}% +-${(100 * se / mean).toFixed(1)}   ${(100 * deaths[i] / TRIALS).toFixed(1)}%   ${sigma.toFixed(1)} sigma`);
  }
  // 8 slots x 2 layouts = 16 comparisons, so the honest threshold is the one corrected for looking
  // 16 times: a 3-sigma maximum turns up by chance about 4% of the time. Anything that survives a
  // 5x increase in seeds is real; anything that does not was the multiplicity.
  console.log(`  worst slot deviation: ${worst.toFixed(1)} sigma over ${n} slots  ` +
    `(${worst < 3.5 ? "within what 16 looks costs you — re-run with more seeds to confirm" : "REAL — slot index is worth money"})`);
}
console.log("");
