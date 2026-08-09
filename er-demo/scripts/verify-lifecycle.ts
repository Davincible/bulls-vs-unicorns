#!/usr/bin/env bun
// PHASE 1 VERIFICATION — the same full round lifecycle engine/scripts/er-client-canary.mjs already
// proved against real devnet, run again here through the PORTED module structure
// (src/chain/{constants,idl,sendTx,round,program,useSigner}.ts + src/devnet-guard.ts) instead of the
// canary's own inline logic. This is what "Phase 1 is done" means per snug-floating-mitten.md: not
// that the port LOOKS right, but that it produces the same real signatures, the same VRF
// Drawing->Fight transition, the same mid-fight extract, the same settled/undelegated final state —
// through code a React component could actually import.
//
//   init_arena -> open_round -> delegate_round -> enter (x2) -> close_lobby_and_draw
//   -> [VRF callback, Drawing -> Fight] -> extract (player A, mid-fight) -> resolve -> close_round
//   -> read the settled Round back from the base layer
//
// Deliberately does NOT use chain/useSigner.ts's `useSigner()` REACT HOOK (no React runtime here) —
// it DOES use useSigner.ts's plain, non-hook `loadOrCreateBurnerKeypair`/`createBurnerWallet`
// functions, which is the actual logic under test; the hook itself is just those two functions plus
// `useMemo`, exercised for real once this app has a UI (Phase 3).
//
//   cd er-demo && bun run scripts/verify-lifecycle.ts

import { assertDevnetUrl } from "../src/devnet-guard.ts";
import {
  BASE_RPC, MIN_FIGHT_SECONDS, PHASE_NAME, Phase, PROGRAM_ID, ROUTER_URL,
} from "../src/chain/constants.ts";
import { createProgram } from "../src/chain/program.ts";
import { sendTx } from "../src/chain/sendTx.ts";
import { createBurnerWallet, loadOrCreateBurnerKeypair } from "../src/chain/useSigner.ts";
import * as roundIx from "../src/chain/round.ts";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  Connection, Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction,
} from "@solana/web3.js";
import { AnchorError } from "@coral-xyz/anchor";
import { ConnectionMagicRouter, DELEGATION_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));
const c = { r: "\x1b[31m", g: "\x1b[32m", y: "\x1b[33m", d: "\x1b[2m", b: "\x1b[1m", x: "\x1b[0m" };
const ok = (s: string) => console.log(`  ${c.g}✓${c.x} ${s}`);
const info = (s: string) => console.log(`  ${c.d}${s}${c.x}`);
const warn = (s: string) => console.log(`  ${c.y}!${c.x} ${s}`);
const heading = (s: string) => console.log(`\n${c.b}${s}${c.x}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function describeError(e: unknown): string {
  if (e instanceof AnchorError) return `${e.error.errorCode.code} (${e.error.errorCode.number}): ${e.error.errorMessage}`;
  const withLogs = e as { logs?: string[]; message?: string };
  if (withLogs?.logs) return `${withLogs.message}\n${withLogs.logs.slice(-12).map((l) => "      " + l).join("\n")}`;
  return e instanceof Error ? e.message : String(e);
}

const load = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8"))));

(async () => {
  console.log(`${c.d}PHASE 1 VERIFICATION — full round lifecycle through the ported chain/ module structure, DEVNET${c.x}`);

  const router = new ConnectionMagicRouter(ROUTER_URL, "confirmed");
  // Reads/writes that are unambiguously base-layer go through a plain devnet Connection, matching
  // er-client-canary.mjs's own reasoning: the final settled-round read should be verified "from the
  // base layer", independent of the router's own correctness.
  const base = new Connection(BASE_RPC, "confirmed");

  const forkPayer = load(join(__dirname, "..", "..", ".devnet", "fork-payer.json"));
  const startBalance = await base.getBalance(forkPayer.publicKey);
  info(`fork-payer  ${forkPayer.publicKey.toBase58()}  ${(startBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);

  const forkPayerWallet = createBurnerWallet(forkPayer);
  const authority = await createProgram(router, forkPayerWallet);
  const authorityBase = await createProgram(base, forkPayerWallet);

  // Two fresh "player" wallets — `loadOrCreateBurnerKeypair()` falls back to an unpersisted fresh
  // keypair when there's no `localStorage` (true in this Bun process), so two calls here produce two
  // distinct disposable keypairs, exactly like the canary's own `Keypair.generate()` x2.
  const playerA = loadOrCreateBurnerKeypair();
  const playerB = loadOrCreateBurnerKeypair();
  const FUND_LAMPORTS = 0.05 * LAMPORTS_PER_SOL;
  {
    const tx = new Transaction().add(
      SystemProgram.transfer({ fromPubkey: forkPayer.publicKey, toPubkey: playerA.publicKey, lamports: FUND_LAMPORTS }),
      SystemProgram.transfer({ fromPubkey: forkPayer.publicKey, toPubkey: playerB.publicKey, lamports: FUND_LAMPORTS }),
    );
    const sig = await base.sendTransaction(tx, [forkPayer]);
    await base.confirmTransaction(sig, "confirmed");
    ok(`funded 2 player wallets  ${c.d}${sig}${c.x}`);
    info(`  player A ${playerA.publicKey.toBase58()}`);
    info(`  player B ${playerB.publicKey.toBase58()}`);
  }
  const playerAProgram = await createProgram(router, createBurnerWallet(playerA));
  const playerBProgram = await createProgram(router, createBurnerWallet(playerB));

  const arenaPda = roundIx.arenaPda();
  info(`arena pda ${arenaPda.toBase58()}  (program ${PROGRAM_ID.toBase58()})`);

  const signatures: Record<string, string> = {};

  try {
    // ---- init_arena (idempotent) --------------------------------------------------------------
    heading("1. init_arena");
    let arena = await authorityBase.account.arena.fetchNullable(arenaPda);
    if (!arena) {
      const { signature } = await sendTx(
        router,
        roundIx.initArena(authority, { arena: arenaPda, authority: forkPayer.publicKey, feeBps: 20 }),
        forkPayer,
        "init_arena",
      );
      signatures.initArena = signature;
      arena = await authorityBase.account.arena.fetch(arenaPda);
    } else {
      ok(`arena already initialised — reusing (round_counter=${arena.roundCounter})`);
    }

    // ---- open_round -----------------------------------------------------------------------------
    heading("2. open_round");
    const roundNo = BigInt(arena.roundCounter.toString()) + 1n;
    const roundPda = roundIx.roundPdaForRoundNo(roundNo, arenaPda);
    info(`round #${roundNo}  pda ${roundPda.toBase58()}`);
    const seedCommit = crypto.getRandomValues(new Uint8Array(32));
    {
      const { signature } = await sendTx(
        router,
        roundIx.openRound(authority, { arena: arenaPda, round: roundPda, authority: forkPayer.publicKey, roundNo, seedCommit }),
        forkPayer,
        `open_round #${roundNo}`,
      );
      signatures.openRound = signature;
    }

    // ---- delegate_round -------------------------------------------------------------------------
    heading("3. delegate_round — hand the round to the ER validator");
    {
      const { signature } = await sendTx(
        router,
        roundIx.delegateRound(authority, { arena: arenaPda, round: roundPda, authority: forkPayer.publicKey, roundNo }),
        forkPayer,
        "delegate_round",
      );
      signatures.delegateRound = signature;
    }
    {
      let acctInfo;
      for (let i = 0; i < 10; i++) {
        acctInfo = await base.getAccountInfo(roundPda);
        if (acctInfo?.owner.equals(DELEGATION_PROGRAM_ID)) break;
        await sleep(1000);
      }
      if (!acctInfo?.owner.equals(DELEGATION_PROGRAM_ID)) {
        throw new Error(`round did not delegate — owner is ${acctInfo?.owner.toBase58() ?? "MISSING"}, expected ${DELEGATION_PROGRAM_ID.toBase58()}`);
      }
      ok(`round owner is now the Delegation Program — routing to the ER is now automatic`);
    }

    // ---- enter x2, through the router (should land on the ER) -----------------------------------
    heading("4. enter — two fighters, opposite sides, via the ROUTER");
    {
      const { signature } = await sendTx(
        router,
        roundIx.enter(playerAProgram, { arena: arenaPda, round: roundPda, player: playerA.publicKey, side: 0, stake: 1_000_000 }),
        playerA,
        "enter side 0 (player A, stake=1,000,000)",
      );
      signatures.enterA = signature;
    }
    {
      const { signature } = await sendTx(
        router,
        roundIx.enter(playerBProgram, { arena: arenaPda, round: roundPda, player: playerB.publicKey, side: 1, stake: 750_000 }),
        playerB,
        "enter side 1 (player B, stake=750,000)",
      );
      signatures.enterB = signature;
    }

    // ---- close_lobby_and_draw — request VRF randomness -------------------------------------------
    heading("5. close_lobby_and_draw — request randomness from the VRF oracle");
    // Resolve the SPECIFIC ER validator our round is delegated to, and send this one instruction
    // straight there — see chain/sendTx.ts's own "SDK SURPRISE #2" comment for why the generic
    // router refuses it outright.
    const delegationStatus = (await router.getDelegationStatus(roundPda)) as { isDelegated: boolean; fqdn?: string };
    const erValidatorFqdn = delegationStatus.fqdn;
    if (!erValidatorFqdn) throw new Error("getDelegationStatus(round) returned no fqdn — cannot resolve the ER validator");
    assertDevnetUrl(erValidatorFqdn, "ER validator");
    info(`round's ER validator: ${erValidatorFqdn}`);
    const clientSeed = crypto.getRandomValues(new Uint8Array(32));
    {
      const { signature } = await sendTx(
        router,
        roundIx.closeLobbyAndDraw(authority, { payer: forkPayer.publicKey, round: roundPda, clientSeed }),
        forkPayer,
        "close_lobby_and_draw",
        { endpoint: erValidatorFqdn },
      );
      signatures.closeLobbyAndDraw = signature;
    }

    // ---- poll for the oracle's callback: Drawing -> Fight ----------------------------------------
    heading("6. waiting for the VRF callback (Drawing -> Fight)");
    let round = await authority.account.round.fetch(roundPda);
    info(`phase immediately after close_lobby_and_draw: ${PHASE_NAME[round.phase]} (${round.phase})`);
    const drawStart = Date.now();
    const DRAW_TIMEOUT_MS = 90_000;
    while (round.phase !== Phase.Fight) {
      if (Date.now() - drawStart > DRAW_TIMEOUT_MS) {
        throw new Error(`VRF callback never landed within ${DRAW_TIMEOUT_MS}ms — round stuck in phase ${PHASE_NAME[round.phase]}`);
      }
      if (round.phase !== Phase.Drawing) {
        throw new Error(`round left Drawing for an unexpected phase: ${PHASE_NAME[round.phase]}`);
      }
      await sleep(2000);
      round = await authority.account.round.fetch(roundPda);
    }
    const fightStartedAtWall = Date.now();
    ok(`PHASE IS NOW FIGHT — VRF callback landed (${((fightStartedAtWall - drawStart) / 1000).toFixed(1)}s to land)`);
    info(`seed: ${Buffer.from(round.seed).toString("hex")}`);
    info(`fight_started_at (on-chain unix ts): ${round.fightStartedAt.toString()}`);

    // ---- extract — ONE player pulls out mid-fight --------------------------------------------------
    heading("7. extract — player A pulls out mid-fight");
    {
      const { signature } = await sendTx(
        router,
        roundIx.extract(playerAProgram, { round: roundPda, player: playerA.publicKey }),
        playerA,
        "extract (player A)",
      );
      signatures.extract = signature;
    }
    {
      const afterExtract = await authority.account.round.fetch(roundPda);
      const fa = afterExtract.fighters[0];
      ok(`player A now: hp=${fa.hp.toString()} banked=${fa.banked.toString()} dead=${fa.dead} (dead=1 is CORRECT — extracted)`);
    }

    // ---- resolve — must wait for the real on-chain floor ---------------------------------------------
    heading("8. resolve — waiting out MIN_FIGHT_SECONDS, then settling");
    const targetWaitMs = (MIN_FIGHT_SECONDS + 2) * 1000 - (Date.now() - fightStartedAtWall);
    if (targetWaitMs > 0) {
      info(`waiting ${(targetWaitMs / 1000).toFixed(1)}s more before resolve() is legal…`);
      await sleep(targetWaitMs);
    }
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const { signature } = await sendTx(
          router,
          roundIx.resolve(authority, { payer: forkPayer.publicKey, round: roundPda }),
          forkPayer,
          "resolve",
        );
        signatures.resolve = signature;
        break;
      } catch (e) {
        if (e instanceof AnchorError && e.error.errorCode.code === "FightNotOverYet" && attempt < 3) {
          warn(`resolve() too early (attempt ${attempt}) — waiting 3s more`);
          await sleep(3000);
          continue;
        }
        throw e;
      }
    }

    // ---- close_round — commit_and_undelegate back to the base layer -------------------------------
    heading("9. close_round — commit final state, hand the round back to the base layer");
    {
      const { signature } = await sendTx(
        router,
        roundIx.closeRound(authority, { payer: forkPayer.publicKey, round: roundPda }),
        forkPayer,
        "close_round",
      );
      signatures.closeRound = signature;
    }

    // ---- verify on the BASE layer: did it actually come home? -------------------------------------
    heading("10. verifying ownership reverted on the base layer");
    let cameHome = false;
    for (let i = 0; i < 20; i++) {
      const acctInfo = await base.getAccountInfo(roundPda);
      if (acctInfo?.owner.equals(PROGRAM_ID)) { cameHome = true; break; }
      await sleep(3000);
    }
    if (!cameHome) throw new Error("round still owned by the Delegation Program after 60s — undelegate commit did not finalize");
    ok("owner reverted to our program — the round came back from the ER");

    // ---- final state, read from the BASE layer, not the router ------------------------------------
    heading("11. FINAL ROUND STATE (read from the base layer)");
    const final = await authorityBase.account.round.fetch(roundPda);
    console.log(`
  round_no        ${final.roundNo.toString()}
  phase           ${PHASE_NAME[final.phase]} (${final.phase})${final.phase === Phase.Settled ? "" : `  ${c.r}EXPECTED Settled=3${c.x}`}
  winner          side ${final.winner}
  pot             ${final.pot.toString()}
  fighter_count   ${final.fighterCount}
  tick_count      ${final.tickCount.toString()}  (steps run by resolve())
  fight_started_at ${final.fightStartedAt.toString()}`);
    for (let i = 0; i < final.fighterCount; i++) {
      const f = final.fighters[i]!;
      const tag = f.wallet.equals(playerA.publicKey) ? "player A" : f.wallet.equals(playerB.publicKey) ? "player B" : "?";
      console.log(`  fighter[${i}] ${tag}  side=${f.side}  hp=${f.hp.toString()}  banked=${f.banked.toString()}  dead=${f.dead}  wallet=${f.wallet.toBase58()}`);
    }

    const endBalance = await base.getBalance(forkPayer.publicKey);
    heading("12. cost");
    info(`fork-payer spent ${((startBalance - endBalance) / LAMPORTS_PER_SOL).toFixed(6)} SOL this run`);
    info(`fork-payer balance now: ${(endBalance / LAMPORTS_PER_SOL).toFixed(6)} SOL`);

    heading("13. signatures for every step");
    for (const [step, sig] of Object.entries(signatures)) info(`${step.padEnd(16)} ${sig}`);

    console.log(`\n${c.g}${c.b}PHASE 1 VERIFICATION COMPLETE${c.x} — the ported chain/ module structure reproduces the canary's full lifecycle, real signatures for every step.`);
    process.exit(0);
  } catch (e) {
    console.error(`\n${c.r}${c.b}VERIFICATION FAILED${c.x}`);
    console.error(`  ${c.r}${describeError(e)}${c.x}`);
    console.error(`  signatures collected before failure:`, signatures);
    process.exitCode = 1;
  }
})();
