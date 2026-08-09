#!/usr/bin/env node
// PHASE 0 SPIKE — snug-floating-mitten.md. The one real unknown this whole plan front-loads:
//
//   does a MagicBlock session key actually authorize an instruction on an account that is
//   ALREADY DELEGATED to an Ephemeral Rollup?
//
// Nobody had verified this combination before this script — not MagicBlock's own examples, not
// any project. If it fails structurally, Session Keys gets cut from the er-demo plan in writing
// and the rest proceeds with direct wallet/burner signing (a small popup per enter/extract),
// which is still a fully functional demo. This script is the whole answer, not a UI.
//
// WHAT IT DOES, IN ORDER:
//   init_arena -> open_round -> delegate_round   (round now owned by the Delegation Program, ER-routed)
//   -> create a session token (gpl_session's on-chain create_session, base layer, player's real
//      wallet as authority, a fresh ephemeral keypair as the session signer)
//   -> enter() on the ER-delegated round, signed ONLY by the session key — never by the player's
//      own wallet — and read the round back to confirm the fighter landed under the PLAYER's
//      identity despite the session key being the one that actually signed.
//
// Runs against the SPIKE program (programs/bulls-arena-session-spike, deployed at a FRESH devnet
// keypair, EJ8dAm3HnBY9UL4mYBUyDzLTvgkDGAp8cT3e2mgaLxQP) — never the proven bulls-arena program
// (F59NksP2bYZhP4wD7fgR1sP729UHNPitrBiYrrKF1sYW), which this script never touches.
//
//   cd er-demo && bun run scripts/spike-session-er.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL, Transaction, Connection,
} from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import {
  ConnectionMagicRouter,
  delegateBufferPdaFromDelegatedAccountAndOwnerProgram,
  delegationRecordPdaFromDelegatedAccount,
  delegationMetadataPdaFromDelegatedAccount,
  DELEGATION_PROGRAM_ID,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import { GPLSESSION_PROGRAMS } from "@magicblock-labs/gum-sdk";
import gplSessionIdl from "../node_modules/@magicblock-labs/gum-sdk/lib/idl/gpl_session.json" with { type: "json" };

const { AnchorProvider, Program, Wallet, BN } = anchor;
const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------------------------
// DEVNET GUARD — inline equivalent of engine/src/devnet-guard.ts's assertDevnetUrl/MainnetBlocked
// (ported logic, not a cross-package import: er-demo/scripts/ is a plain Node script outside any
// bundler, and engine/src/devnet-guard.ts is a .ts file inside a DIFFERENT package's src tree with
// its own module resolution — importing across that boundary is exactly the kind of coupling the
// plan's "no cross-import from engine/" rule for the real app exists to avoid, and it applies just
// as much to a one-off script). Same allowlist-not-denylist shape, same fail-closed default.
// ---------------------------------------------------------------------------------------------
class MainnetBlocked extends Error {}
const SAFE_URL = [/\bapi\.devnet\.solana\.com\b/i, /\bdevnet\b/i, /\btestnet\b/i];
const MAINNET_URL = [/\bapi\.mainnet-beta\.solana\.com\b/i, /\bmainnet\b/i, /\bmainnet-beta\b/i];
const stripUrlNoise = (s) => s.replace(/[\x00-\x1f\x7f]/g, "");
function assertDevnetUrl(url, what = "endpoint") {
  const u = stripUrlNoise(String(url || "").trim());
  if (!u) throw new MainnetBlocked(`${what}: empty URL — refusing to guess a cluster.`);
  if (MAINNET_URL.some((re) => re.test(u))) {
    throw new MainnetBlocked(`${what} points at MAINNET (${u}). This is a devnet-only spike. Refusing.`);
  }
  if (SAFE_URL.some((re) => re.test(u))) return;
  throw new MainnetBlocked(`${what} could not be positively identified as devnet: ${u}`);
}

const ROUTER_URL = "https://devnet-router.magicblock.app";
const BASE_RPC = "https://api.devnet.solana.com";
assertDevnetUrl(ROUTER_URL, "Magic Router");
assertDevnetUrl(BASE_RPC, "base devnet RPC");

const Phase = { Lobby: 0, Drawing: 1, Fight: 2, Settled: 3 };

const c = { r: "\x1b[31m", g: "\x1b[32m", y: "\x1b[33m", d: "\x1b[2m", b: "\x1b[1m", x: "\x1b[0m" };
const ok = (s) => console.log(`  ${c.g}✓${c.x} ${s}`);
const info = (s) => console.log(`  ${c.d}${s}${c.x}`);
const heading = (s) => console.log(`\n${c.b}${s}${c.x}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function describeError(e) {
  if (e instanceof anchor.AnchorError) {
    return `${e.error.errorCode.code} (${e.error.errorCode.number}): ${e.error.errorMessage}`;
  }
  if (e?.logs) return `${e.message}\n${e.logs.slice(-20).map((l) => "      " + l).join("\n")}`;
  return e?.message || String(e);
}

const load = (p) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8"))));
const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };

// Same router-bypass logic as engine/scripts/er-client-canary.mjs's sendTx/blockhashForAccounts —
// AnchorProvider's .rpc() fetches its blockhash via a path the Magic Router doesn't intercept, so
// account-aware routing has to be done by hand. See that file's own "SDK SURPRISE #1" comment.
let router;
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
  if (body.error) throw new Error(`getBlockhashForAccounts: ${body.error.message}`);
  return body.result;
}
async function sendTx(methodsBuilder, signer, label, { endpoint } = {}) {
  const tx = await methodsBuilder.transaction();
  tx.feePayer = signer.publicKey;
  const t0 = Date.now();
  const conn = endpoint ? new Connection(endpoint, "confirmed") : router;
  let blockhash, lastValidBlockHeight;
  if (endpoint) {
    ({ blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed"));
  } else {
    const accountsForBlockhash = [tx.feePayer, ...new Set(
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
  console.log(`${c.d}PHASE 0 SPIKE — session key signing enter() on an ER-delegated round, DEVNET${c.x}`);

  const idl = JSON.parse(
    readFileSync(join(__dirname, "..", "..", "programs", "bulls-arena-session-spike", "idl", "bulls_arena_session_spike.json"), "utf8"),
  );
  const PROGRAM_ID = new PublicKey(idl.address);
  const GPL_SESSION_PROGRAM_ID = GPLSESSION_PROGRAMS.devnet;
  info(`spike program  ${PROGRAM_ID.toBase58()}`);
  info(`gpl_session     ${GPL_SESSION_PROGRAM_ID.toBase58()}  (MagicBlock's deployed session-token program, same address every cluster)`);

  router = new ConnectionMagicRouter(ROUTER_URL, "confirmed");
  const base = new Connection(BASE_RPC, "confirmed");

  const forkPayer = load(join(__dirname, "..", "..", ".devnet", "fork-payer.json"));
  const startBalance = await base.getBalance(forkPayer.publicKey);
  info(`fork-payer  ${forkPayer.publicKey.toBase58()}  ${(startBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);

  const opts = { commitment: "confirmed", preflightCommitment: "confirmed" };
  const authority = new Program(idl, new AnchorProvider(router, new Wallet(forkPayer), opts));
  const authorityBase = new Program(idl, new AnchorProvider(base, new Wallet(forkPayer), opts));

  // "player" is the identity the session is being created FOR — the wallet that would otherwise
  // have to sign enter() itself every time. It signs exactly ONCE in this whole script: the
  // create_session transaction below. It never signs enter().
  const player = Keypair.generate();
  const FUND_LAMPORTS = 0.05 * LAMPORTS_PER_SOL;
  {
    const tx = new Transaction().add(
      SystemProgram.transfer({ fromPubkey: forkPayer.publicKey, toPubkey: player.publicKey, lamports: FUND_LAMPORTS }),
    );
    const sig = await base.sendTransaction(tx, [forkPayer]);
    await base.confirmTransaction(sig, "confirmed");
    ok(`funded player wallet  ${c.d}${sig}${c.x}`);
    info(`  player ${player.publicKey.toBase58()}`);
  }

  const [arenaPda] = PublicKey.findProgramAddressSync([Buffer.from("arena")], PROGRAM_ID);
  info(`arena pda ${arenaPda.toBase58()}`);

  try {
    // ---- init_arena (idempotent) ---------------------------------------------------------------
    heading("1. init_arena");
    let arena = await authorityBase.account.arena.fetchNullable(arenaPda);
    if (!arena) {
      const builder = authority.methods
        .initArena(20, PublicKey.default, PublicKey.default)
        .accounts({ arena: arenaPda, authority: forkPayer.publicKey, systemProgram: SystemProgram.programId });
      await sendTx(builder, forkPayer, "init_arena");
      arena = await authorityBase.account.arena.fetch(arenaPda);
    } else {
      ok(`arena already initialised — reusing (round_counter=${arena.roundCounter})`);
    }

    // ---- open_round -------------------------------------------------------------------------------
    heading("2. open_round");
    const roundNo = BigInt(arena.roundCounter.toString()) + 1n;
    const [roundPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("round"), arenaPda.toBuffer(), u64le(roundNo)], PROGRAM_ID,
    );
    info(`round #${roundNo}  pda ${roundPda.toBase58()}`);
    {
      const builder = authority.methods
        .openRound(new BN(roundNo.toString()), Array.from(new Uint8Array(32)))
        .accounts({ arena: arenaPda, round: roundPda, authority: forkPayer.publicKey, systemProgram: SystemProgram.programId });
      await sendTx(builder, forkPayer, `open_round #${roundNo}`);
    }

    // ---- delegate_round — hand the round to the ER validator --------------------------------------
    heading("3. delegate_round");
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
      let acctInfo;
      for (let i = 0; i < 10; i++) {
        acctInfo = await base.getAccountInfo(roundPda);
        if (acctInfo?.owner.equals(DELEGATION_PROGRAM_ID)) break;
        await sleep(1000);
      }
      if (!acctInfo?.owner.equals(DELEGATION_PROGRAM_ID)) {
        throw new Error(`round did not delegate — owner is ${acctInfo?.owner.toBase58() ?? "MISSING"}`);
      }
      ok(`round is now owned by the Delegation Program — ER-delegated, THE precondition this whole spike is testing against`);
    }

    // ---- create a session token — base layer, player's real wallet signs ONCE ---------------------
    heading("4. create_session — player's wallet authorizes a session, ONE signature");
    const sessionKeypair = Keypair.generate();
    const [sessionTokenPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("session_token"), PROGRAM_ID.toBuffer(), sessionKeypair.publicKey.toBuffer(), player.publicKey.toBuffer()],
      GPL_SESSION_PROGRAM_ID,
    );
    info(`session signer (ephemeral, never funded except via top-up below) ${sessionKeypair.publicKey.toBase58()}`);
    info(`session token PDA  ${sessionTokenPda.toBase58()}`);
    const gplSession = new Program(gplSessionIdl, new AnchorProvider(base, new Wallet(player), opts));
    const TOP_UP_LAMPORTS = 0.01 * LAMPORTS_PER_SOL; // funds the session key to pay its OWN enter() tx fee below
    const validUntil = Math.ceil(Date.now() / 1000) + 60 * 60; // 1 hour, gpl_session's own ceiling is 7 days
    {
      const builder = gplSession.methods
        .createSession(true, new BN(validUntil), new BN(TOP_UP_LAMPORTS))
        .accounts({
          sessionToken: sessionTokenPda,
          sessionSigner: sessionKeypair.publicKey,
          authority: player.publicKey,
          targetProgram: PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([sessionKeypair]);
      const sig = await builder.rpc();
      ok(`create_session  ${c.d}${sig}${c.x}`);
    }
    {
      const balance = await base.getBalance(sessionKeypair.publicKey);
      ok(`session signer topped up to ${(balance / LAMPORTS_PER_SOL).toFixed(6)} SOL — it, not player, pays for enter() next`);
      const tokenAcct = await gplSession.account.sessionToken.fetch(sessionTokenPda);
      info(`on-chain session_token: authority=${tokenAcct.authority.toBase58()} target_program=${tokenAcct.targetProgram.toBase58()} session_signer=${tokenAcct.sessionSigner.toBase58()} valid_until=${tokenAcct.validUntil.toString()}`);
    }

    // ---- THE SPIKE: enter() on the ER-delegated round, signed ONLY by the session key -------------
    heading("5. enter() — session-key-signed, round is ER-delegated. player's wallet does NOT sign this.");
    const STAKE = 500_000;
    const roundBefore = await authority.account.round.fetch(roundPda);
    info(`fighter_count before: ${roundBefore.fighterCount}`);
    const sessionEnterProgram = new Program(idl, new AnchorProvider(router, new Wallet(sessionKeypair), opts));
    const builder = sessionEnterProgram.methods
      .enter(0, new BN(STAKE))
      .accounts({
        arena: arenaPda,
        round: roundPda,
        player: player.publicKey,      // the credited identity — does NOT sign
        sessionToken: sessionTokenPda, // proves the session key may act for `player`
        signer: sessionKeypair.publicKey, // the ACTUAL signer of this transaction
      });
    const enterSig = await sendTx(builder, sessionKeypair, "enter (session-key-signed)");

    // ---- verify: did the fighter land under PLAYER's identity? ------------------------------------
    heading("6. verifying the round account");
    const roundAfter = await authority.account.round.fetch(roundPda);
    info(`fighter_count after: ${roundAfter.fighterCount}`);
    const fighter = roundAfter.fighters
      .slice(0, roundAfter.fighterCount)
      .find((f) => f.wallet.equals(player.publicKey));
    if (!fighter) {
      throw new Error("enter() landed but no fighter matching player's pubkey was found in round.fighters");
    }
    ok(`fighter found under PLAYER's identity: side=${fighter.side} stake=${fighter.stake.toString()} hp=${fighter.hp.toString()} wallet=${fighter.wallet.toBase58()}`);
    if (fighter.stake.toString() !== String(STAKE - Math.floor((STAKE * 20) / 10_000))) {
      throw new Error(`stake mismatch: expected net-of-fee stake, got ${fighter.stake.toString()}`);
    }

    console.log(`\n${c.g}${c.b}PHASE 0 SPIKE RESULT: SESSION KEYS WORK ON AN ER-DELEGATED ACCOUNT.${c.x}`);
    console.log(`  enter() signature: ${enterSig}`);
    console.log(`  signed by the SESSION KEY (${sessionKeypair.publicKey.toBase58()}), not player's wallet (${player.publicKey.toBase58()})`);
    console.log(`  round pda: ${roundPda.toBase58()}  (owned by the Delegation Program at the time enter() ran)`);

    // ---- NEGATIVE CONTROL — does the check mean anything, or does enter() just accept any signer? --
    // A transaction landing proves session keys aren't REJECTED outright by ER delegation; it proves
    // nothing about whether `#[session_auth_or]` is actually doing its job rather than being silently
    // bypassed (e.g. by account resolution quirks specific to a delegated account). This attempts
    // enter() again on the SAME still-Lobby round, presenting the REAL session_token PDA from step 4
    // but signed by an unrelated attacker keypair instead of the real session key. If the check is
    // real, `is_valid()`'s PDA re-derivation (seeds include `session_signer` = whoever actually
    // signed) won't match the real token's address, and this must fail with SessionError::InvalidToken.
    heading("7. negative control — an unrelated signer presenting the REAL session token, must be REJECTED");
    const attacker = Keypair.generate();
    {
      const tx = new Transaction().add(
        SystemProgram.transfer({ fromPubkey: forkPayer.publicKey, toPubkey: attacker.publicKey, lamports: 0.01 * LAMPORTS_PER_SOL }),
      );
      const sig = await base.sendTransaction(tx, [forkPayer]);
      await base.confirmTransaction(sig, "confirmed");
      info(`funded attacker wallet ${attacker.publicKey.toBase58()} (unrelated to player or the session key)`);
    }
    const attackerProgram = new Program(idl, new AnchorProvider(router, new Wallet(attacker), opts));
    const forgedBuilder = attackerProgram.methods
      .enter(1, new BN(STAKE))
      .accounts({
        arena: arenaPda,
        round: roundPda,
        player: player.publicKey,       // claiming to act on the real player's behalf
        sessionToken: sessionTokenPda,  // the REAL token PDA — but it was minted for a DIFFERENT session_signer
        signer: attacker.publicKey,     // attacker signs, not the real session key
      });
    let rejected = false;
    try {
      await sendTx(forgedBuilder, attacker, "enter (FORGED — attacker signing with real player's session token)");
    } catch (e) {
      rejected = true;
      const desc = describeError(e);
      const isExpectedRejection = e instanceof anchor.AnchorError
        ? e.error.errorCode.code === "InvalidToken"
        : /InvalidToken|custom program error/i.test(desc);
      if (isExpectedRejection) {
        ok(`REJECTED as expected:\n${desc}`);
      } else {
        console.log(`  ${c.y}!${c.x} rejected, but not with the expected error — inspect: ${desc}`);
      }
    }
    if (!rejected) {
      console.log(`  ${c.r}${c.b}SECURITY FINDING: the forged enter() was NOT rejected. #[session_auth_or] is not enforcing the binding it claims to.${c.x}`);
    }

    const endBalance = await base.getBalance(forkPayer.publicKey);
    heading("8. cost");
    info(`fork-payer spent ${((startBalance - endBalance) / LAMPORTS_PER_SOL).toFixed(6)} SOL this run`);
    process.exit(0);
  } catch (e) {
    console.error(`\n${c.r}${c.b}SPIKE FAILED${c.x}`);
    console.error(`  ${c.r}${describeError(e)}${c.x}`);
    process.exitCode = 1;
  }
})();
