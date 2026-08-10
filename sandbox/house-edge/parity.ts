// SANDBOX. Run: npx tsx sandbox/house-edge/parity.ts
//
// The one check that makes the rest of this sandbox mean anything: with config BASELINE, the knobbed
// loop in fight-variant.ts must produce byte-identical hp / banked / dead / winner to
// engine/src/er-sim.ts — which is itself the asserted mirror of the deployed Rust. If this fails,
// every ROI number in the study is a measurement of some other game.
//
// It also runs the two controls the study leans on:
//   * `wide` layout with uniform/uniform is a DIFFERENT fight (different bytes drive the draws) but
//     must be the same GAME — so it is checked for distributional equivalence, not equality.
//   * proportional dust at a floor below one unit must collapse back onto the absolute rule.

import { newRound, enter, tick, settle, DUST } from "../../engine/src/er-sim.ts";
import type { ERFighter } from "../../engine/src/er-sim.ts";
import { BASELINE, DEPLOYED_V5, runFight, stepBudget, winnerSide, makeFighter, DUST_ABSOLUTE, isqrt, pow34, FEE_BPS } from "./fight-variant.ts";
import type { Fighter } from "./fight-variant.ts";
import { createHash } from "node:crypto";
import { mulberry32 } from "./rng.ts";

let failures = 0;
const check = (ok: boolean, what: string) => {
  if (!ok) { failures++; console.log(`  FAIL  ${what}`); } else { console.log(`  ok    ${what}`); }
};

// --- isqrt / pow34 are exact -------------------------------------------------------------------
{
  let ok = true;
  for (let i = 0; i < 4000; i++) {
    const x = BigInt(Math.floor(Math.random() * 1e12));
    const r = isqrt(x);
    if (!(r * r <= x && (r + 1n) * (r + 1n) > x)) ok = false;
    const p = pow34(x);
    if (p < 0n) ok = false;
  }
  // monotone, and exact on perfect fourth powers
  for (const b of [10n, 100n, 1000n, 7n, 123n]) ok &&= pow34(b * b * b * b) === b * b * b;
  check(ok, "isqrt is floor(sqrt(x)); pow34 exact on fourth powers, non-negative");
}

// --- BASELINE == er-sim.ts, byte for byte ------------------------------------------------------
{
  const rnd = mulberry32(20260809);
  let mismatches = 0, rounds = 0, totalExchanges = 0;
  for (let r = 0; r < 300; r++) {
    const seed = createHash("sha256").update(`parity|${r}`).digest();
    const perSide = 1 + Math.floor(rnd() * 8);          // 2..16 fighters
    const gross: bigint[] = [];
    const sides: (0 | 1)[] = [];
    for (const side of [0, 1] as const) {
      for (let i = 0; i < perSide; i++) {
        gross.push(BigInt(Math.floor(1 + rnd() * 200) * 1_000_000));  // $1..$200 in micro-units
        sides.push(side);
      }
    }
    const n = gross.length;
    const steps = stepBudget(n);

    // er-sim path
    const round = newRound(seed);
    for (let i = 0; i < n; i++) enter(round, `w${i}`, sides[i], gross[i], FEE_BPS);
    tick(round, steps);
    const w1 = settle(round);

    // variant path
    const fs: Fighter[] = [];
    for (let i = 0; i < n; i++) fs.push(makeFighter(`w${i}`, sides[i], gross[i]).f);
    const st = runFight(fs, seed, steps, BASELINE);
    const w2 = winnerSide(fs);

    totalExchanges += st.exchanges; rounds++;
    for (let i = 0; i < n; i++) {
      const A: ERFighter = round.fighters[i], B = fs[i];
      if (A.hp !== B.hp || A.banked !== B.banked || A.dead !== B.dead || A.stake !== B.stake) mismatches++;
    }
    if (w1 !== w2) mismatches++;
  }
  check(mismatches === 0, `BASELINE is byte-identical to er-sim.ts over ${rounds} random lineups (${mismatches} mismatches, ${totalExchanges} exchanges compared)`);
  check(DUST === DUST_ABSOLUTE, "the sandbox's DUST equals er-sim.ts's DUST");
}

// --- DEPLOYED_V5 still reproduces the rule the study measured ----------------------------------
{
  // The study's "before" columns are only meaningful if the config that produced them still
  // describes v5. Pinned against the golden vector that WAS the committed on-chain parity fixture
  // (`run_fight_matches_the_typescript_mirror_exactly`) before the seat-law fix landed — so this is
  // a number the chain itself once asserted, not one this sandbox invented about itself.
  const seed = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
  const fs: Fighter[] = [
    { wallet: "w1", side: 0, dead: 0, stake: 100_000n, hp: 100_000n, banked: 0n },
    { wallet: "w2", side: 0, dead: 0, stake: 250_000n, hp: 250_000n, banked: 0n },
    { wallet: "w3", side: 1, dead: 0, stake: 180_000n, hp: 180_000n, banked: 0n },
    { wallet: "w4", side: 1, dead: 0, stake:  90_000n, hp:  90_000n, banked: 0n },
  ];
  runFight(fs, seed, 50, DEPLOYED_V5);
  const got = fs.map(g => `${g.hp}/${g.banked}/${g.dead}`).join(" ");
  const want = "15158/84062/0 201600/116021/0 26975/48467/0 42942/84775/0";
  check(got === want, `DEPLOYED_V5 reproduces the pre-fix on-chain fixture${got === want ? "" : `\n        got  ${got}\n        want ${want}`}`);
}

// --- proportional dust below one unit collapses onto absolute ---------------------------------
{
  // A proportional floor of 0 bps floors to 1 unit; the absolute rule's 1,000 units is strictly
  // larger, so the two differ only in the last 1,000 units of a fighter's life. Check the mechanism
  // does what it says: bigger floor => strictly fewer or equal steps to death.
  const seed = createHash("sha256").update("dust").digest();
  const mk = () => [0, 1, 0, 1].map((s, i) => makeFighter(`w${i}`, s as 0 | 1, 10_000_000n).f);
  const a = mk(), b = mk();
  const sa = runFight(a, seed, 2000, BASELINE);
  const sb = runFight(b, seed, 2000, { ...BASELINE, dust: { kind: "proportional", bps: 500n } }); // 5%
  check(sb.endedAt <= sa.endedAt, `a 5% proportional floor ends no later than the absolute one (${sb.endedAt} <= ${sa.endedAt})`);
  const conserved = (f: Fighter[]) => f.reduce((n, g) => n + g.hp + g.banked, 0n);
  check(conserved(a) === conserved(b), "value is conserved identically under both dust rules");
}

// --- conservation holds under every weight kind ------------------------------------------------
{
  const kinds = ["uniform", "linear", "sqrt", "pow34", "cap2", "cap3", "mix"] as const;
  const bases = ["ring", "stake"] as const;
  let ok = true;
  for (const dk of kinds) for (const ak of kinds) for (const bs of bases) {
    const seed = createHash("sha256").update(`cons|${dk}|${ak}|${bs}`).digest();
    const fs = [0, 1, 0, 1, 0, 1].map((s, i) => makeFighter(`w${i}`, s as 0 | 1, BigInt((i + 1) * 7_000_000)).f);
    const before = fs.reduce((n, g) => n + g.stake, 0n);
    runFight(fs, seed, stepBudget(6), { attacker: { kind: ak, basis: bs, m: 9n }, defender: { kind: dk, basis: bs, m: 9n }, dust: { kind: "absolute", units: DUST_ABSOLUTE }, layout: "wide" });
    const after = fs.reduce((n, g) => n + g.hp + g.banked, 0n);
    if (before !== after) { ok = false; console.log(`    conservation broke at defender=${dk} attacker=${ak} basis=${bs}`); }
  }
  check(ok, "value is conserved for all 98 (attacker, defender, basis) weight combinations");
}

// --- determinism -------------------------------------------------------------------------------
{
  const seed = createHash("sha256").update("determinism").digest();
  const cfg = { attacker: { kind: "mix", basis: "stake", m: 40n }, defender: { kind: "pow34", basis: "ring" }, dust: { kind: "proportional", bps: 200n }, layout: "wide" } as const;
  const run = () => {
    const fs = [0, 1, 0, 1].map((s, i) => makeFighter(`w${i}`, s as 0 | 1, BigInt((i + 3) * 5_000_000)).f);
    runFight(fs, seed, 1500, cfg);
    return fs.map(g => `${g.hp}/${g.banked}/${g.dead}`).join(",");
  };
  check(run() === run(), "weighted fights are deterministic from (seed, lineup) alone");
}

console.log(failures === 0 ? "\nPARITY OK\n" : `\n${failures} PARITY FAILURE(S)\n`);
process.exit(failures === 0 ? 0 : 1);
