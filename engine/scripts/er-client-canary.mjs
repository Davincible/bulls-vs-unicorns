#!/usr/bin/env node
// ER CLIENT CANARY — the full round lifecycle through the MAGIC ROUTER, for real, on devnet.
//
//   init_arena → open_round → delegate_round → enter (x2) → close_lobby_and_draw → [VRF callback]
//   → extract (mid-fight) → resolve → close_round → read the settled Round back from the base layer
//
// WHY THIS SCRIPT EXISTS. Everything up to this session proved the program COMPILES and its pure
// fight logic matches the TypeScript mirror byte-for-byte (ER-051). Neither of those exercises the
// thing this migration is actually FOR: a round living on an Ephemeral Rollup, reachable through the
// Magic Router the same way a real client would reach it, with the VRF oracle actually called and
// actually calling back. The Drawing → Fight transition specifically has never completed for real —
// ER-060's own changelog says so — because the bug that silently swallowed the callback
// (`accounts_metas: None` meant `round` was never in the callback's account list) was only fixed this
// session. This script is the first thing to run that transition to completion.
//
// WHY engine/scripts/, NOT scripts/. The brief for this canary named `scripts/er-client-canary.mjs`
// (repo root), but that directory has no node_modules of its own — the root `scripts/deploy-devnet.mjs`
// gets away with it because it imports nothing but node: builtins. This script needs
// @coral-xyz/anchor and @magicblock-labs/ephemeral-rollups-sdk, which live in engine/node_modules, and
// Node's ESM resolver walks up from the IMPORTING FILE's own directory, not from cwd — a script
// outside engine/ simply cannot see them without a symlink or NODE_PATH hack, either of which is a
// worse trade than a one-directory rename. `engine/scripts/er-roundtrip.mjs` (ER-050, the pre-VRF,
// pre-Anchor-IDL predecessor of this exact test) already established this as the place scripts like
// this one live. Naming stays faithful to the brief: `er-client-canary.mjs`.
//
// ANCHOR CAMEL-CASES THE IDL AT LOAD TIME. `new Program(idl, provider)` runs the raw (snake_case,
// Rust-shaped) IDL through `convertIdlToCamelCase` internally before building any namespace — every
// instruction name, every account key in `.accounts({...})`, and every decoded account FIELD comes
// back camelCased (`open_round` -> `openRound`, `delegation_record_round_pda` ->
// `delegationRecordRoundPda`, `round.fight_started_at` -> `round.fightStartedAt`). This is not
// documented anywhere obvious in the IDL JSON itself — it only became visible by constructing a
// throwaway Program against the committed IDL and printing `Object.keys(program.methods)` /
// `Object.keys(program.account)`. Every identifier below is the camelCase form for exactly this
// reason; matching the IDL's literal (snake_case) spelling fails with "Cannot read properties of
// undefined" pointing at the wrong layer entirely.
//
//   cd engine && node --experimental-strip-types scripts/er-client-canary.mjs

import { assertForkIsDevnetOnly, assertDevnetUrl } from "../src/devnet-guard.ts";
assertForkIsDevnetOnly();

import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL, Transaction, Connection, ComputeBudgetProgram,
} from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import {
  ConnectionMagicRouter,
  delegateBufferPdaFromDelegatedAccountAndOwnerProgram,
  delegationRecordPdaFromDelegatedAccount,
  delegationMetadataPdaFromDelegatedAccount,
  DELEGATION_PROGRAM_ID,
  MAGIC_PROGRAM_ID,
  MAGIC_CONTEXT_ID,
} from "@magicblock-labs/ephemeral-rollups-sdk";

const { AnchorProvider, Program, Wallet, BN } = anchor;
const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------------------------
// Constants. Every network endpoint gets checked by the SAME guard that gates env-configured ones
// — assertForkIsDevnetOnly() only walks process.env, so a hardcoded literal below would otherwise
// never pass through it. A literal is still a place a mainnet URL could get pasted by mistake.
// ---------------------------------------------------------------------------------------------
const ROUTER_URL = "https://devnet-router.magicblock.app";
const BASE_RPC = "https://api.devnet.solana.com";
assertDevnetUrl(ROUTER_URL, "Magic Router");
assertDevnetUrl(BASE_RPC, "base devnet RPC");

// Verified from the ephemeral-vrf-sdk crate source this session (MEGA_QUEUE.md ER-060) — the
// EPHEMERAL queue, not the base one, because by the time close_lobby_and_draw runs the round is
// already ER-delegated.
const DEFAULT_EPHEMERAL_QUEUE = new PublicKey("5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc");
// From the committed IDL (programs/bulls-arena/idl/bulls_arena.json), close_lobby_and_draw's
// vrf_program account — a fixed address, not derived.
const VRF_PROGRAM_ID = new PublicKey("Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz");
const SLOT_HASHES_SYSVAR = new PublicKey("SysvarS1otHashes111111111111111111111111111");

const Phase = { Lobby: 0, Drawing: 1, Fight: 2, Settled: 3 };
const PHASE_NAME = ["Lobby", "Drawing", "Fight", "Settled"];

const c = { r: "\x1b[31m", g: "\x1b[32m", y: "\x1b[33m", d: "\x1b[2m", b: "\x1b[1m", x: "\x1b[0m" };
const ok = (s) => console.log(`  ${c.g}✓${c.x} ${s}`);
const info = (s) => console.log(`  ${c.d}${s}${c.x}`);
const warn = (s) => console.log(`  ${c.y}!${c.x} ${s}`);
const heading = (s) => console.log(`\n${c.b}${s}${c.x}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Anchor wraps program-side custom errors in AnchorError; decode it instead of printing a stack. */
function describeError(e) {
  if (e instanceof anchor.AnchorError) {
    return `${e.error.errorCode.code} (${e.error.errorCode.number}): ${e.error.errorMessage}`;
  }
  if (e?.logs) {
    return `${e.message}\n${e.logs.slice(-12).map((l) => "      " + l).join("\n")}`;
  }
  return e?.message || String(e);
}

const load = (p) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8"))));
const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };

// SDK SURPRISE #1, FOUND BY RUNNING THIS AGAINST REAL DEVNET (not guessed from the .d.ts).
//
// `AnchorProvider.sendAndConfirm` — what `.rpc()` uses under the hood — fetches its blockhash via
// `this.connection.getLatestBlockhash(...)` and sends via a standalone `sendAndConfirmRawTransaction`
// helper. Neither of those goes through `ConnectionMagicRouter`'s OVERRIDDEN `sendTransaction` /
// `sendAndConfirmTransaction`, which are the methods that call `getLatestBlockhashForTransaction` —
// the router's account-aware blockhash lookup that decides whether a transaction is base-layer or
// belongs to a specific ER validator. `.rpc()` against the router therefore fetches a blockhash from
// whatever the router's plain `getLatestBlockhash` defaults to, which does not necessarily match
// where the transaction is about to be routed, and devnet answered every attempt with "Blockhash not
// found". `program.methods.x(...).transaction()` still builds the instruction correctly (all account
// resolution happens there); it is only the SEND path that has to bypass AnchorProvider.
//
// SDK SURPRISE #2. Fixing #1 still wasn't enough for ONE instruction: `close_lobby_and_draw`'s
// writable accounts are `payer`, `round`, AND `oracle_queue` (the ephemeral VRF queue,
// `5hBR571…FRK5Tc`). The generic router refused the transaction outright — not just the blockhash
// lookup, the actual `sendTransaction` too — with "transaction contains accounts that were delegated
// to different ER nodes". Traced (by querying `getDelegationStatus` on each account directly) to the
// queue account's own delegation record naming its authority as the SYSTEM PROGRAM
// (`11111111…1111`), which the multi-validator router cannot map to any ER node's fqdn and refuses to
// reconcile against `round`'s real delegation. The queue is a protocol-level singleton the router
// doesn't know how to place, not evidence that the transaction itself is actually misrouted — querying
// the round's OWN validator directly (`getDelegationStatus(round).fqdn`, same identity
// `getIdentity`/"closest validator" already returned) resolves both `round` and `oracle_queue` fine,
// because that validator hosts the ER `round` is actually delegated to and evidently already knows
// about the well-known VRF queue singleton. Fix: instructions that touch the queue go straight to that
// validator's own RPC, bypassing the generic router for this one call.
/** Set once the router connection exists (just below) — declared here so sendTx can close over it. */
let router;

/** Same JSON-RPC call `ConnectionMagicRouter.getLatestBlockhashForTransaction` makes internally, but
 *  against an account list WE choose rather than one derived from the transaction's writable keys —
 *  see SDK SURPRISE #2 above for why that derivation isn't safe for every instruction. */
async function blockhashForAccounts(accounts) {
  const res = await fetch(ROUTER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "getBlockhashForAccounts",
      params: [accounts.map((a) => a.toBase58())],
    }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`getBlockhashForAccounts(${accounts.map((a) => a.toBase58()).join(",")}): ${body.error.message}`);
  return body.result;
}

/**
 * @param {object} [routing]
 * @param {PublicKey[]} [routing.blockhashAccounts] override the writable-account set used to pick a
 *   blockhash through the generic router (default: derived from the tx, matching the SDK's own logic)
 * @param {string} [routing.endpoint] send DIRECTLY to this RPC endpoint (an ER validator's own fqdn)
 *   instead of through the generic router — see SDK SURPRISE #2.
 */
async function sendTx(methodsBuilder, signer, label, { blockhashAccounts, endpoint } = {}) {
  const tx = await methodsBuilder.transaction();
  tx.feePayer = signer.publicKey;
  const t0 = Date.now();
  const conn = endpoint ? new Connection(endpoint, "confirmed") : router;
  let blockhash, lastValidBlockHeight;
  if (endpoint) {
    ({ blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed"));
  } else {
    const accountsForBlockhash = blockhashAccounts ?? [tx.feePayer, ...new Set(
      tx.instructions.flatMap((ix) => ix.keys.filter((k) => k.isWritable).map((k) => k.pubkey)),
    )];
    ({ blockhash, lastValidBlockHeight } = await blockhashForAccounts(accountsForBlockhash));
  }
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.sign(signer);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: "confirmed" });
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  ok(`${label}  ${c.d}${Date.now() - t0}ms  ${sig}${c.x}`);
  return sig;
}

(async () => {
  console.log(`${c.d}ER CLIENT CANARY — full round lifecycle through the Magic Router, DEVNET${c.x}`);

  const idl = JSON.parse(
    readFileSync(join(__dirname, "..", "..", "programs", "bulls-arena", "idl", "bulls_arena.json"), "utf8"),
  );
  const PROGRAM_ID = new PublicKey(idl.address);

  router = new ConnectionMagicRouter(ROUTER_URL, "confirmed");
  // Reads/writes that are unambiguously base-layer (the arena PDA is never delegated; funding the
  // player wallets; the final settled-round read after undelegation) go through a plain devnet
  // Connection instead of the router. Not a workaround — `getAccountInfo` for an undelegated account
  // should proxy through the router fine too, but the task explicitly wants the FINAL read verified
  // "from the base layer", so this makes that verification independent of the router's own
  // correctness rather than trusting the same endpoint that did everything else.
  const base = new Connection(BASE_RPC, "confirmed");

  const forkPayer = load(join(__dirname, "..", "..", ".devnet", "fork-payer.json"));
  const startBalance = await base.getBalance(forkPayer.publicKey);
  info(`fork-payer  ${forkPayer.publicKey.toBase58()}  ${(startBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);

  const opts = { commitment: "confirmed", preflightCommitment: "confirmed" };
  const authorityProvider = new AnchorProvider(router, new Wallet(forkPayer), opts);
  const authority = new Program(idl, authorityProvider);
  // A dedicated base-layer client, used ONLY for the final post-undelegation read.
  const authorityBase = new Program(idl, new AnchorProvider(base, new Wallet(forkPayer), opts));

  // Two fresh "player" wallets. enter/extract require the PLAYER's own signature, not the authority's
  // — funded by a direct transfer from the already-funded fork-payer rather than requestAirdrop,
  // because the devnet faucet is rate-limited and shared across every dev on the cluster, and the
  // fork-payer already holds real (if worthless) devnet SOL earmarked for exactly this.
  const playerA = Keypair.generate();
  const playerB = Keypair.generate();
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
  const playerAProgram = new Program(idl, new AnchorProvider(router, new Wallet(playerA), opts));
  const playerBProgram = new Program(idl, new AnchorProvider(router, new Wallet(playerB), opts));

  const [arenaPda] = PublicKey.findProgramAddressSync([Buffer.from("arena")], PROGRAM_ID);
  info(`arena pda ${arenaPda.toBase58()}`);

  try {
    // ---- init_arena (idempotent) --------------------------------------------------------------
    heading("1. init_arena");
    let arena = await authorityBase.account.arena.fetchNullable(arenaPda);
    if (!arena) {
      const builder = authority.methods
        .initArena(20, PublicKey.default, PublicKey.default)
        .accounts({
          arena: arenaPda,
          authority: forkPayer.publicKey,
          systemProgram: SystemProgram.programId,
        });
      await sendTx(builder, forkPayer, "init_arena");
      arena = await authorityBase.account.arena.fetch(arenaPda);
    } else {
      ok(`arena already initialised — reusing (round_counter=${arena.roundCounter})`);
    }

    // ---- open_round -----------------------------------------------------------------------------
    heading("2. open_round");
    const roundNo = BigInt(arena.roundCounter.toString()) + 1n;
    const [roundPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("round"), arenaPda.toBuffer(), u64le(roundNo)], PROGRAM_ID,
    );
    info(`round #${roundNo}  pda ${roundPda.toBase58()}`);
    // Vestigial since ER-060 (the real seed now comes from the VRF oracle, not this commitment) but
    // kept for on-chain format compatibility — any 32 bytes satisfies it.
    const seedCommit = randomBytes(32);
    {
      const builder = authority.methods
        .openRound(new BN(roundNo.toString()), Array.from(seedCommit))
        .accounts({
          arena: arenaPda,
          round: roundPda,
          authority: forkPayer.publicKey,
          systemProgram: SystemProgram.programId,
        });
      await sendTx(builder, forkPayer, `open_round #${roundNo}`);
    }

    // ---- delegate_round -------------------------------------------------------------------------
    heading("3. delegate_round — hand the round to the ER validator");
    const bufferPda = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(roundPda, PROGRAM_ID);
    const recordPda = delegationRecordPdaFromDelegatedAccount(roundPda);
    const metadataPda = delegationMetadataPdaFromDelegatedAccount(roundPda);
    {
      const builder = authority.methods
        .delegateRound(new BN(roundNo.toString()))
        .accounts({
          authority: forkPayer.publicKey,
          arena: arenaPda,
          bufferRoundPda: bufferPda,
          delegationRecordRoundPda: recordPda,
          delegationMetadataRoundPda: metadataPda,
          roundPda: roundPda,
          ownerProgram: PROGRAM_ID,
          delegationProgram: DELEGATION_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        });
      await sendTx(builder, forkPayer, "delegate_round");
    }
    {
      // `base` is api.devnet.solana.com, a DIFFERENT RPC node than whichever one processed the
      // transaction above — reading it immediately after "confirmed" can still observe the
      // pre-delegation owner for a beat while that write propagates. Poll rather than assume the
      // read is instantaneous just because the send was confirmed.
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
      const builder = playerAProgram.methods
        .enter(0, new BN(1_000_000))
        .accounts({ arena: arenaPda, round: roundPda, player: playerA.publicKey });
      await sendTx(builder, playerA, "enter side 0 (player A, stake=1,000,000)");
    }
    {
      const builder = playerBProgram.methods
        .enter(1, new BN(750_000))
        .accounts({ arena: arenaPda, round: roundPda, player: playerB.publicKey });
      await sendTx(builder, playerB, "enter side 1 (player B, stake=750,000)");
    }

    // ---- close_lobby_and_draw — request VRF randomness -------------------------------------------
    heading("5. close_lobby_and_draw — request randomness from the VRF oracle");
    // Resolve the SPECIFIC ER validator our round is delegated to, and send this one instruction
    // straight there — see "SDK SURPRISE #2" above for why the generic router refuses it outright.
    const { fqdn: erValidatorFqdn } = await router.getDelegationStatus(roundPda);
    assertDevnetUrl(erValidatorFqdn, "ER validator");
    info(`round's ER validator: ${erValidatorFqdn}`);
    const [programIdentityPda] = PublicKey.findProgramAddressSync([Buffer.from("identity")], PROGRAM_ID);
    const clientSeed = randomBytes(32);
    {
      const builder = authority.methods
        .closeLobbyAndDraw(Array.from(clientSeed))
        .accounts({
          payer: forkPayer.publicKey,
          round: roundPda,
          oracleQueue: DEFAULT_EPHEMERAL_QUEUE,
          programIdentity: programIdentityPda,
          vrfProgram: VRF_PROGRAM_ID,
          slotHashes: SLOT_HASHES_SYSVAR,
          systemProgram: SystemProgram.programId,
        });
      await sendTx(builder, forkPayer, "close_lobby_and_draw", { endpoint: erValidatorFqdn });
    }

    // ---- poll for the oracle's callback: Drawing -> Fight ----------------------------------------
    // THIS is the transition ER-060's fix targeted and that has never completed before this run —
    // asynchronous, no fixed delay, so poll rather than guess.
    heading("6. waiting for the VRF callback (Drawing -> Fight) — THE untested transition until now");
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
    ok(`PHASE IS NOW FIGHT — the VRF oracle called back and callback_seed ran (${((fightStartedAtWall - drawStart) / 1000).toFixed(1)}s to land)`);
    info(`seed: ${Buffer.from(round.seed).toString("hex")}`);
    info(`fight_started_at (on-chain unix ts): ${round.fightStartedAt.toString()}`);

    // ---- extract — ONE player pulls out mid-fight, proving the mechanic works --------------------
    heading("7. extract — player A pulls out mid-fight");
    {
      const builder = playerAProgram.methods
        .extract()
        .accounts({ round: roundPda, player: playerA.publicKey });
      await sendTx(builder, playerA, "extract (player A)");
    }
    {
      const afterExtract = await authority.account.round.fetch(roundPda);
      const fa = afterExtract.fighters[0];
      ok(`player A now: hp=${fa.hp.toString()} banked=${fa.banked.toString()} dead=${fa.dead} (dead=1 is CORRECT — extracted, no longer a target)`);
    }

    // ---- resolve — must wait for the real 5s on-chain floor ---------------------------------------
    heading("8. resolve — waiting out the MIN_FIGHT_SECONDS floor, then settling");
    const MIN_FIGHT_SECONDS = 5;
    // Buffer past the 5s minimum for wall-clock/on-chain-clock drift, rather than racing the boundary
    // and eating a FightNotOverYet on the first attempt.
    const targetWaitMs = (MIN_FIGHT_SECONDS + 2) * 1000 - (Date.now() - fightStartedAtWall);
    if (targetWaitMs > 0) {
      info(`waiting ${(targetWaitMs / 1000).toFixed(1)}s more before resolve() is legal…`);
      await sleep(targetWaitMs);
    }
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        // resolve() runs the fight loop on-chain — up to MAX_STEPS=7,000 steps at ~187 CU/step
        // (ER-030's own measurement) plus the settlement pass and commit CPI, comfortably over
        // Solana's DEFAULT ~200,000 CU per-transaction budget. Without explicitly raising the ceiling
        // this failed on real devnet with "Computational budget exceeded" — the program's own comment
        // ("187.4 CU/step against a 1.4M CU ceiling") already assumes a caller requests that ceiling;
        // nothing does it automatically, so this instruction has to ask for it explicitly, matching
        // the same CU_CEILING=1,400,000 engine/scripts/er-cu-bench.mjs measured against.
        const builder = authority.methods
          .resolve()
          .accounts({
            payer: forkPayer.publicKey,
            round: roundPda,
            magicProgram: MAGIC_PROGRAM_ID,
            magicContext: MAGIC_CONTEXT_ID,
          })
          .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })]);
        await sendTx(builder, forkPayer, "resolve");
        break;
      } catch (e) {
        if (e instanceof anchor.AnchorError && e.error.errorCode.code === "FightNotOverYet" && attempt < 3) {
          warn(`resolve() too early (attempt ${attempt}), on-chain clock hadn't caught up — waiting 3s more`);
          await sleep(3000);
          continue;
        }
        throw e;
      }
    }

    // ---- close_round — commit_and_undelegate back to the base layer -------------------------------
    heading("9. close_round — commit final state, hand the round back to the base layer");
    {
      const builder = authority.methods
        .closeRound()
        .accounts({
          payer: forkPayer.publicKey,
          round: roundPda,
          magicProgram: MAGIC_PROGRAM_ID,
          magicContext: MAGIC_CONTEXT_ID,
        });
      await sendTx(builder, forkPayer, "close_round");
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
    ok(`owner reverted to our program — the round came back from the ER`);

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
      const f = final.fighters[i];
      const tag = f.wallet.equals(playerA.publicKey) ? "player A" : f.wallet.equals(playerB.publicKey) ? "player B" : "?";
      console.log(`  fighter[${i}] ${tag}  side=${f.side}  hp=${f.hp.toString()}  banked=${f.banked.toString()}  dead=${f.dead}  wallet=${f.wallet.toBase58()}`);
    }

    const endBalance = await base.getBalance(forkPayer.publicKey);
    heading("12. cost");
    info(`fork-payer spent ${((startBalance - endBalance) / LAMPORTS_PER_SOL).toFixed(6)} SOL this run`);
    info(`fork-payer balance now: ${(endBalance / LAMPORTS_PER_SOL).toFixed(6)} SOL`);

    console.log(`\n${c.g}${c.b}ER CLIENT CANARY COMPLETE${c.x} — full lifecycle through the Magic Router, VRF Drawing->Fight transition confirmed, mid-fight extract confirmed, round settled and undelegated for real.`);
    process.exit(0);
  } catch (e) {
    console.error(`\n${c.r}${c.b}CANARY FAILED${c.x}`);
    console.error(`  ${c.r}${describeError(e)}${c.x}`);
    process.exitCode = 1;
  }
})();
