#!/usr/bin/env node
// ER-030 — measure what a whole fight actually COSTS, on devnet.
//
// The design decision this settles: can one transaction resolve an entire match? That depends on
// compute units per simulation step, and estimating compute is how you end up with a program that
// works at 500 steps and dies at 4,000 in front of players.
//
// Method: SIMULATE `bench_fight` at increasing step counts and read `unitsConsumed` back. Simulation
// returns real compute without spending anything or mutating state, so this can sweep freely.
//
//   node engine/scripts/er-cu-bench.mjs
//
// IT COSTS NOTHING AND LEAVES NOTHING BEHIND. This script used to open a real round and enter two
// fighters before measuring — a leftover from when it simulated `resolve`, which refuses outside the
// Fight phase and so only ever measured the guard in front of the fight (a flat ~12,758 CU whatever
// was asked for, which is the giveaway that nothing was running). `bench_fight` exists precisely to
// remove that dependency: its whole account list is one signer, it writes nothing, and it runs the
// identical inner loop over a local array. So the setup is gone, and with it the rent, the fees, and
// a permanently-unresolved round left in the arena's history on every run.
//
// EVERY INSTRUCTION IS BUILT THROUGH THE IDL — see arena-client.mjs. The old version hand-packed
// `bench_fight`'s arguments behind a hand-computed discriminator, which is what let it keep
// assembling perfectly valid transactions for a program that had moved on.

import { readFileSync } from "node:fs";
import { ComputeBudgetProgram, Connection, Keypair, Transaction } from "@solana/web3.js";
import {
  BASE_RPC, DEVNET_GENESIS, FIGHT_TIMEOUT_SECONDS, MAX_STEPS, PROGRAM_ID, createArenaProgram,
  loadArenaIdl, stepsPerSecond,
} from "./arena-client.mjs";

const c = { g: "\x1b[32m", y: "\x1b[33m", r: "\x1b[31m", d: "\x1b[2m", x: "\x1b[0m" };

/** The most compute a single Solana transaction may request. A runtime limit, not one of ours — it
 *  is why this measurement matters at all. Mirrored in er-demo/src/chain/round.ts, which sizes
 *  `resolve` and `extract` against it. */
const CU_CEILING = 1_400_000;

/** Reserved out of the ceiling when reporting how much fight fits in one transaction: the commit CPI
 *  and Anchor's own frame are real costs `bench_fight` deliberately does not include, because it
 *  measures the FIGHT rather than the instruction wrapped around it. */
const CU_RESERVED_FOR_THE_REST = 30_000;

/** The sweep. `MAX_STEPS` is in it BY CONSTRUCTION rather than by the coincidence that it currently
 *  equals 4,000 — the headroom assertion at the bottom reads the measurement at that exact point, so
 *  a `MAX_STEPS` that moved out of a hardcoded list would silently turn that assertion into an
 *  extrapolation. */
const STEP_SWEEP = [...new Set([100, 250, 500, 1_000, 2_000, MAX_STEPS, 8_000])].sort((a, b) => a - b);

/** The full lineup, read off the IDL's own `Round.fighters` array rather than written as 16.
 *
 *  Fighter count changes the modulo, not the per-step cost (every step touches exactly two fighters
 *  however many exist), but it does change how often the expensive damage branch fires as fighters
 *  die — so measuring at the maximum measures the worst case, and "the maximum" is a fact about the
 *  program that belongs in the same place every other such fact here comes from. */
function benchFighters(idl) {
  const fighters = idl.types.find((t) => t.name === "Round").type.fields.find((f) => f.name === "fighters");
  const count = fighters?.type?.array?.[1];
  if (typeof count !== "number") throw new Error("could not read Round.fighters' length from the IDL");
  return count;
}

(async () => {
  const { idl, programId, path: idlPath, isOverride } = loadArenaIdl();

  const conn = new Connection(BASE_RPC, "confirmed");
  const genesis = await conn.getGenesisHash();
  if (genesis !== DEVNET_GENESIS) {
    console.error(`  ${c.r}✗ not devnet — genesis ${genesis}${c.x}`);
    process.exit(1);
  }

  console.log(`${c.d}ER-030 compute benchmark — devnet${c.x}`);
  console.log(`  ${c.d}idl     ${idlPath}${c.x}`);
  console.log(`  ${c.d}program ${programId.toBase58()}${c.x}`);
  // Announced only when the override actually changes which program is measured. An override that
  // names the same id is the ordinary case (a bench build of the deployed code) and does not need a
  // warning; one that names a different id means these numbers describe a program the app does not
  // run, which does.
  if (isOverride && !programId.equals(PROGRAM_ID)) {
    console.log(`  ${c.y}!${c.x} this is NOT the program the app runs against ` +
      `(${PROGRAM_ID.toBase58()}) — the numbers below describe a different deploy.`);
  }

  // The honest failure, said plainly rather than worked around. `bench_fight` is behind Cargo's
  // `bench` feature and off by default (it costs binary bytes in a program that is rent-constrained
  // on devnet — see the feature's own comment in Cargo.toml), so the IDL a normal build emits does
  // not contain it and neither does the deployed binary. There is no honest way to measure without
  // one that does: hand-rolling the discriminator would produce a transaction the program has no
  // instruction for, and simulating some other instruction would measure something else and report
  // it as this.
  if (!idl.instructions.some((i) => i.name === "bench_fight")) {
    console.error(`\n  ${c.r}✗ this build has no bench_fight instruction, so there is nothing to measure.${c.x}`);
    console.error(`  ${c.d}It is feature-gated off by default (programs/bulls-arena/Cargo.toml, [features] bench).`);
    console.error(`  To measure:`);
    console.error(`    1. cd programs/bulls-arena && anchor build -- --features bench`);
    console.error(`    2. deploy that binary (it needs its own program id — the default deploy must not`);
    console.error(`       carry a measurement probe)`);
    console.error(`    3. ARENA_IDL=<path to the bench build's idl> node engine/scripts/er-cu-bench.mjs`);
    console.error(`  The IDL carries the program id, so step 3 is the only thing that needs telling.${c.x}`);
    process.exit(1);
  }

  // Simulation verifies no signatures and moves no lamports, but the runtime still wants a fee payer
  // that exists. The devnet payer is used if it is there, purely to satisfy that; nothing is spent.
  const payer = loadPayer();
  const program = createArenaProgram(conn, payer, idl);

  const fighters = benchFighters(idl);
  console.log(`  ${c.d}measuring at ${fighters} fighters — the full lineup, the worst case${c.x}`);
  console.log(`\n  ${"steps".padStart(7)} ${"CU".padStart(11)} ${"CU/step".padStart(9)}   verdict`);
  console.log(`  ${"-".repeat(48)}`);

  // One blockhash for the whole sweep. Simulation neither verifies signatures nor cares whether the
  // blockhash is the newest one, so a fresh round trip per row bought nothing but latency.
  const { blockhash } = await conn.getLatestBlockhash();

  const results = [];
  for (const steps of STEP_SWEEP) {
    const tx = new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: CU_CEILING }))
      .add(await program.methods
        .benchFight(steps, fighters)
        .accounts({ payer: payer.publicKey })
        .instruction());
    tx.feePayer = payer.publicKey;
    tx.recentBlockhash = blockhash;

    const sim = await conn.simulateTransaction(tx);
    const cu = sim.value.unitsConsumed ?? 0;
    const err = sim.value.err ? JSON.stringify(sim.value.err).slice(0, 34) : null;
    results.push({ steps, cu, err });
    console.log(`  ${String(steps).padStart(7)} ${String(cu).padStart(11)} ${
      (cu / steps).toFixed(1).padStart(9)}   ${
      err ? `${c.r}${err}${c.x}` : cu < CU_CEILING ? `${c.g}fits${c.x}` : `${c.r}OVER${c.x}`}`);
  }

  const usable = results.filter((r) => !r.err && r.cu > 0);
  if (usable.length < 2) {
    console.error(`\n  ${c.r}✗ fewer than two usable measurements — nothing can be derived from this.${c.x}`);
    if (results[0]?.err) console.error(`  ${c.d}first error: ${results[0].err}${c.x}`);
    process.exit(1);
  }

  // Two points and a line: the slope is the marginal per-step cost and the intercept is everything
  // the instruction pays once. Taking the extremes of the usable range rather than averaging keeps
  // the fixed overhead from being smeared into the slope.
  const [first] = usable;
  const last = usable[usable.length - 1];
  const perStep = (last.cu - first.cu) / (last.steps - first.steps);

  // A FLAT COST IS THE FAILURE THIS SCRIPT EXISTS TO CATCH, and without this check it reports as a
  // pass. It is what the old version did for months: it simulated `resolve`, which refuses outside
  // the Fight phase, so it measured the guard and got the same ~12,758 CU for 100 steps and for
  // 8,000. Left unguarded here, `perStep` would be 0, `fits` would be Infinity, and the headroom
  // assertion below would cheerfully succeed while nothing had been measured at all.
  if (!(perStep > 0)) {
    console.error(`\n  ${c.r}✗ compute did not grow with steps (${first.steps}→${last.steps} both cost ` +
      `${first.cu} CU) — whatever ran, it was not the fight loop.${c.x}`);
    console.error(`  ${c.d}That is the signature of measuring a guard instead of a body: an instruction ` +
      `that rejects before doing the work costs the same however much work was asked for.${c.x}`);
    process.exit(1);
  }

  const overhead = first.cu - perStep * first.steps;
  const fits = Math.floor((CU_CEILING - overhead - CU_RESERVED_FOR_THE_REST) / perStep);

  console.log(`\n  marginal cost   ${perStep.toFixed(1)} CU per step`);
  console.log(`  fixed overhead  ${Math.round(overhead).toLocaleString()} CU`);
  console.log(`  ${c.g}one ${(CU_CEILING / 1e6).toFixed(1)}M CU transaction fits ~${fits.toLocaleString()} steps${c.x}`);
  console.log(`  ${c.d}(${CU_RESERVED_FOR_THE_REST.toLocaleString()} CU reserved for the commit CPI and Anchor's own frame)${c.x}`);

  // THE ASSERTION THE OLD SCRIPT NEVER MADE. A number printed on a terminal is not a guarantee; the
  // guarantee is that `resolve` can always finish a fight in one transaction, and that is exactly
  // `MAX_STEPS` worth of fight.
  //
  // IT IS CHECKED AGAINST THE MEASUREMENT AT `MAX_STEPS`, NOT AGAINST THE FITTED LINE, because the
  // cost curve is not linear and the fit errs in the dangerous direction. `advance_fight` skips dead
  // fighters cheaply, and at a full lineup the fight is largely decided well before the end of the
  // sweep — so steps beyond that point cost far less than the early ones, a line drawn through 100
  // and 8,000 UNDERSTATES the marginal cost over the first few thousand, and `fits` comes out
  // optimistic. The direct reading has no such problem: it is what the transaction actually consumed.
  // The fit stays, as reporting.
  //
  // One caveat, stated because the check would otherwise look stronger than it is: MAX_STEPS is read
  // from er-demo/src/chain/constants.ts, which is a HAND-MAINTAINED mirror of lib.rs (the IDL carries
  // no constants section). This notices a change to the mirror. It does not notice lib.rs moving and
  // the mirror not following — closing that needs `#[constant]` on MAX_STEPS in the program.
  const bell = stepsPerSecond(fighters) * FIGHT_TIMEOUT_SECONDS;
  console.log(`\n  ${c.d}MAX_STEPS is ${MAX_STEPS.toLocaleString()}; the bell at ${fighters} fighters ` +
    `reaches ${bell.toLocaleString()} steps${c.x}`);

  const atMax = results.find((r) => r.steps === MAX_STEPS);
  if (!atMax || atMax.err || atMax.cu <= 0) {
    console.error(`  ${c.r}✗ no usable measurement at MAX_STEPS (${MAX_STEPS.toLocaleString()}) — ` +
      `the headroom claim cannot be made.${c.x}`);
    process.exit(1);
  }
  const worstCase = atMax.cu + CU_RESERVED_FOR_THE_REST;
  if (worstCase > CU_CEILING) {
    console.error(`  ${c.r}✗ a worst-case resolve (${MAX_STEPS.toLocaleString()} steps) does NOT fit in one ` +
      `transaction — measured ${atMax.cu.toLocaleString()} CU + ${CU_RESERVED_FOR_THE_REST.toLocaleString()} ` +
      `reserved = ${worstCase.toLocaleString()}, over the ${CU_CEILING.toLocaleString()} ceiling.${c.x}`);
    console.error(`  ${c.d}Either MAX_STEPS must come down or the fight step must get cheaper. A round that ` +
      `cannot be resolved is a round that is stuck.${c.x}`);
    process.exit(1);
  }
  console.log(`  ${c.g}✓${c.x} a worst-case resolve measured ${atMax.cu.toLocaleString()} CU — fits with ` +
    `${(CU_CEILING - worstCase).toLocaleString()} CU to spare`);
})().catch((e) => {
  console.error(`\n  ${c.r}✗ ${e.message}${c.x}`);
  if (e.logs) console.error(e.logs.slice(-8).map((l) => "    " + l).join("\n"));
  process.exitCode = 1;
});

/** The devnet payer if one is configured, a throwaway otherwise. Nothing here spends, so a missing
 *  keypair is not a reason to refuse to measure — but a fee payer that does not exist on chain makes
 *  the simulation itself fail, so say which one is in use. */
function loadPayer() {
  const path = process.env.FORK_KEYPAIR || ".devnet/fork-payer.json";
  try {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
  } catch {
    console.log(`  ${c.y}!${c.x} no payer at ${path} — simulating with a throwaway key. If devnet ` +
      `refuses the fee payer, point FORK_KEYPAIR at a funded devnet keypair.`);
    return Keypair.generate();
  }
}
