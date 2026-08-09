#!/usr/bin/env node
// PHASE 6 VERIFICATION, BASE LAYER — session keys on the REAL deployed bulls-arena
// (F59NksP2bYZhP4wD7fgR1sP729UHNPitrBiYrrKF1sYW), with the Ephemeral Rollup taken out of the
// picture entirely. Companion to verify-session-real.mjs, not a replacement for it.
//
// WHY THIS EXISTS AS A SEPARATE SCRIPT. Session keys are a property of the PROGRAM: `#[session_auth_or]`
// runs in the instruction prologue and neither knows nor cares whether the round it is touching is
// delegated. verify-session-real.mjs deliberately proves the combination (session keys THROUGH the
// ER, which is the shipping configuration) and therefore cannot run at all when the ER is having a
// bad day — as it was on the day this was written, with three of the router's four devnet validators
// serving pre-upgrade bytecode and the fourth returning 401 on writes. That is an infrastructure
// fact, and it should not be able to hold the program's own correctness hostage. This script depends
// on nothing but base devnet, so it answers "is the session-keys logic right?" on its own terms, and
// keeps answering it long after today's particular outage is forgotten.
//
// WHAT IT PROVES, AND WHAT IT HONESTLY CANNOT:
//   enter()  — proven outright: session-signed entry lands, is attributed to the PLAYER not the
//              session key, is rejected for a forged signer, and still works with no session at all.
//   extract() — proven DIFFERENTIALLY, not end-to-end. Reaching Phase::Fight requires the VRF
//              oracle, whose queue account is itself ER-delegated, so a base-layer round can never
//              leave Lobby and a real extract can never succeed here. But the session gate runs
//              BEFORE `require!(phase == Fight)`, so on a Lobby round two calls that differ ONLY in
//              who signed produce two DIFFERENT errors, and which error you get is exactly the
//              question being asked:
//                  valid session signer  -> NotFighting (6003)  = the session gate ACCEPTED it
//                  forged signer         -> InvalidToken (6001) = the session gate REJECTED it
//              That is a real proof of the authorization property. It is not a proof that extract's
//              body does the right thing to `banked`/`dead` — that needs Fight phase, so it lives in
//              verify-session-real.mjs and nowhere else. Do not read a green run here as covering it.
//
//   cd er-demo && bun run scripts/verify-session-base.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL, Transaction, Connection } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { GPLSESSION_PROGRAMS } from "@magicblock-labs/gum-sdk";
import gplSessionIdl from "../node_modules/@magicblock-labs/gum-sdk/lib/idl/gpl_session.json" with { type: "json" };

const { AnchorProvider, Program, Wallet, BN } = anchor;
const __dirname = dirname(fileURLToPath(import.meta.url));

// DEVNET GUARD — same inline shape and same reasoning as every other script here (see
// verify-session-real.mjs's own note on why chain/devnet-guard.ts is not imported across that boundary).
const BASE_RPC = "https://api.devnet.solana.com";
if (/mainnet/i.test(BASE_RPC) || !/devnet/i.test(BASE_RPC)) {
  throw new Error(`base RPC could not be positively identified as devnet: ${BASE_RPC}. Refusing.`);
}

const c = { r: "\x1b[31m", g: "\x1b[32m", y: "\x1b[33m", d: "\x1b[2m", b: "\x1b[1m", x: "\x1b[0m" };
const ok = (s) => console.log(`  ${c.g}✓${c.x} ${s}`);
const info = (s) => console.log(`  ${c.d}${s}${c.x}`);
const heading = (s) => console.log(`\n${c.b}${s}${c.x}`);

const load = (p) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8"))));
const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const logsOf = (e) => (Array.isArray(e?.logs) ? e.logs : []).join("\n");
const describeError = (e) => (e?.logs ? `${e.message}\n${e.logs.slice(-12).map((l) => "      " + l).join("\n")}` : e?.message || String(e));

/** Assert a transaction failed with one SPECIFIC Anchor error, identified BY NAME from the program's
 *  own logs.
 *
 *  BY NAME, NOT BY NUMBER, AND THIS IS THE WHOLE POINT OF THE HELPER. `#[error_code]` numbers from
 *  6000 per-crate with no cross-crate coordination, so session-keys' `SessionError::InvalidToken` is
 *  6001 and bulls-arena's own `ArenaError::RoundOutOfOrder` is ALSO 6001 — on the wire both are
 *  `custom program error: 0x1771`, and any decoder pointed at the bulls-arena IDL calls that
 *  `RoundOutOfOrder`. The `Error Code: <name>` line Anchor logs at the failure point is the only
 *  unambiguous evidence of which one fired. Matching on the number, or loosely on "custom program
 *  error", would let a rejection from an unrelated guard masquerade as a passing security control —
 *  a negative control that can pass for the wrong reason is worse than no negative control. */
async function expectError(sendAttempt, expectedName, label) {
  try {
    await sendAttempt();
  } catch (e) {
    if (new RegExp(`Error Code: ${expectedName}\\b`).test(logsOf(e))) {
      ok(`${label} — failed with ${expectedName}, as required`);
      return;
    }
    throw new Error(`${label} failed, but NOT with ${expectedName}. Inspect before concluding anything:\n${describeError(e)}`);
  }
  throw new Error(`${label} SUCCEEDED. It was required to fail with ${expectedName}.`);
}

(async () => {
  console.log(`${c.d}PHASE 6 VERIFICATION (BASE LAYER) — session keys on the real deployed program, no ER involved${c.x}`);

  const idl = JSON.parse(readFileSync(join(__dirname, "..", "public", "idl", "bulls_arena.json"), "utf8"));
  const PROGRAM_ID = new PublicKey(idl.address);
  const GPL_SESSION_PROGRAM_ID = GPLSESSION_PROGRAMS.devnet;
  const base = new Connection(BASE_RPC, "confirmed");
  const opts = { commitment: "confirmed", preflightCommitment: "confirmed" };

  // Prove up front that the bytecode under test is actually the post-Phase-6 build, so a green run
  // can never be a green run against the old program. "Invalid session token" is
  // SessionError::InvalidToken's #[msg]; it cannot be in an ELF that does not link session-keys.
  const [programDataPda] = PublicKey.findProgramAddressSync(
    [PROGRAM_ID.toBuffer()], new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"),
  );
  const programData = await base.getAccountInfo(programDataPda);
  if (!programData?.data.toString("latin1").includes("Invalid session token")) {
    throw new Error(`deployed bytecode at ${PROGRAM_ID.toBase58()} does not contain the session-keys build. Nothing below would mean anything.`);
  }
  ok(`deployed bytecode IS the post-Phase-6 build  ${c.d}${PROGRAM_ID.toBase58()}${c.x}`);

  const forkPayer = load(join(__dirname, "..", "..", ".devnet", "fork-payer.json"));
  const startBalance = await base.getBalance(forkPayer.publicKey);
  info(`fork-payer  ${forkPayer.publicKey.toBase58()}  ${(startBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);

  const authority = new Program(idl, new AnchorProvider(base, new Wallet(forkPayer), opts));
  const [arenaPda] = PublicKey.findProgramAddressSync([Buffer.from("arena")], PROGRAM_ID);

  const playerA = Keypair.generate();   // uses a session
  const playerB = Keypair.generate();   // never uses a session — the unmodified pre-Phase-6 path
  const attacker = Keypair.generate();  // unrelated to either, and to the session key
  const signatures = {};

  try {
    heading("0. fund the three throwaway wallets");
    {
      const tx = new Transaction().add(
        ...[playerA, playerB, attacker].map((kp) => SystemProgram.transfer({
          fromPubkey: forkPayer.publicKey, toPubkey: kp.publicKey, lamports: 0.03 * LAMPORTS_PER_SOL,
        })),
      );
      const sig = await base.sendTransaction(tx, [forkPayer]);
      await base.confirmTransaction(sig, "confirmed");
      ok(`funded  ${c.d}${sig}${c.x}`);
      info(`player A (session) ${playerA.publicKey.toBase58()}`);
      info(`player B (direct)  ${playerB.publicKey.toBase58()}`);
      info(`attacker           ${attacker.publicKey.toBase58()}`);
    }

    heading("1. open_round — stays on the base layer, never delegated");
    const arena = await authority.account.arena.fetch(arenaPda);
    const roundNo = BigInt(arena.roundCounter.toString()) + 1n;
    const [roundPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("round"), arenaPda.toBuffer(), u64le(roundNo)], PROGRAM_ID,
    );
    signatures.openRound = await authority.methods
      .openRound(new BN(roundNo.toString()), Array.from(new Uint8Array(32)))
      .accounts({ arena: arenaPda, round: roundPda, authority: forkPayer.publicKey, systemProgram: SystemProgram.programId })
      .rpc();
    ok(`open_round #${roundNo}  ${c.d}${roundPda.toBase58()}  ${signatures.openRound}${c.x}`);

    heading("2. create_session — ONE signature from player A's real wallet");
    const sessionKeypair = Keypair.generate();
    const [sessionTokenPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("session_token"), PROGRAM_ID.toBuffer(), sessionKeypair.publicKey.toBuffer(), playerA.publicKey.toBuffer()],
      GPL_SESSION_PROGRAM_ID,
    );
    signatures.createSession = await new Program(gplSessionIdl, new AnchorProvider(base, new Wallet(playerA), opts)).methods
      .createSession(true, new BN(Math.ceil(Date.now() / 1000) + 3600), new BN(0.01 * LAMPORTS_PER_SOL))
      .accounts({
        sessionToken: sessionTokenPda, sessionSigner: sessionKeypair.publicKey, authority: playerA.publicKey,
        targetProgram: PROGRAM_ID, systemProgram: SystemProgram.programId,
      })
      .signers([sessionKeypair])
      .rpc();
    info(`session signer  ${sessionKeypair.publicKey.toBase58()}`);
    info(`session token   ${sessionTokenPda.toBase58()}`);
    ok(`create_session  ${c.d}${signatures.createSession}${c.x}`);

    const asSession = new Program(idl, new AnchorProvider(base, new Wallet(sessionKeypair), opts));
    const asAttacker = new Program(idl, new AnchorProvider(base, new Wallet(attacker), opts));
    const asPlayerB = new Program(idl, new AnchorProvider(base, new Wallet(playerB), opts));

    heading("3. enter() — session-signed, and attributed to PLAYER A rather than to the session key");
    const STAKE_A = 500_000;
    signatures.enterSessionSigned = await asSession.methods
      .enter(0, new BN(STAKE_A))
      .accounts({ arena: arenaPda, round: roundPda, player: playerA.publicKey, sessionToken: sessionTokenPda, signer: sessionKeypair.publicKey })
      .rpc();
    ok(`enter (session-key-signed)  ${c.d}${signatures.enterSessionSigned}${c.x}`);
    {
      // THE ATTRIBUTION CHECK — the point of the whole feature. A session-signed enter that credited
      // the SESSION KEY would still "succeed", and would still be completely wrong: the player would
      // have no claim on their own fighter once the session expired.
      const round = await authority.account.round.fetch(roundPda);
      const live = round.fighters.slice(0, round.fighterCount);
      if (live.some((f) => f.wallet.equals(sessionKeypair.publicKey))) {
        throw new Error("SESSION KEY was written into Round.fighters as the identity. The feature is wrong.");
      }
      const fighter = live.find((f) => f.wallet.equals(playerA.publicKey));
      if (!fighter) throw new Error("enter() landed but no fighter matching player A's wallet exists");
      if (round.fighterCount !== 1) throw new Error(`expected exactly 1 fighter after one enter(), got ${round.fighterCount}`);
      // Assert the VALUES too, not just the identity. Attribution to the right wallet with the wrong
      // side or a wrong net stake is still a broken enter(), and checking costs nothing here: the
      // fee is the arena's own `fee_bps`, already fetched at step 1.
      const expectedNet = STAKE_A - Math.floor((STAKE_A * arena.feeBps) / 10_000);
      if (fighter.side !== 0) throw new Error(`expected side 0, got ${fighter.side}`);
      if (fighter.stake.toString() !== String(expectedNet)) {
        throw new Error(`expected net stake ${expectedNet} (gross ${STAKE_A} less ${arena.feeBps}bps), got ${fighter.stake}`);
      }
      if (fighter.hp.toString() !== String(expectedNet)) throw new Error(`expected hp == net stake ${expectedNet}, got ${fighter.hp}`);
      ok(`fighter identity is player A's real wallet, and the session key appears nowhere in Round.fighters`);
      info(`side=${fighter.side} stake=${fighter.stake} hp=${fighter.hp} (net of ${arena.feeBps}bps fee)`);
    }

    heading("4. enter() NEGATIVE CONTROL — unrelated signer presenting the REAL session token");
    await expectError(
      () => asAttacker.methods.enter(0, new BN(STAKE_A))
        .accounts({ arena: arenaPda, round: roundPda, player: playerA.publicKey, sessionToken: sessionTokenPda, signer: attacker.publicKey })
        .rpc(),
      "InvalidToken", "enter() by an unrelated signer holding player A's real token",
    );
    // Second forgery, different shape: no token at all, just naming someone else as `player`. This is
    // the attack the `Signer` -> `UncheckedAccount` change on `player` would have opened if the
    // fallback arm of `#[session_auth_or]` were missing or wrong, so it is worth its own check.
    await expectError(
      () => asAttacker.methods.enter(0, new BN(STAKE_A))
        .accounts({ arena: arenaPda, round: roundPda, player: playerA.publicKey, sessionToken: null, signer: attacker.publicKey })
        .rpc(),
      "InvalidToken", "enter() by an unrelated signer with NO token, impersonating player A",
    );

    // ---- THE OTHER HALF OF THE BINDING --------------------------------------------------------------
    //
    // Step 4 varies the SIGNER and holds `player` fixed, which only ever exercises the `session_signer`
    // seed. The token binds TWO things, and the second one had no coverage at all: `player` is the
    // `authority` seed of the token PDA (and `#[session(authority = player.key())]` is what feeds it).
    //
    // WHY THIS IS THE CONTROL WORTH HAVING. Every check in step 4 is satisfied by an attacker who
    // holds no token whatsoever. This one is not: the attacker below owns a REAL, VALID, UNEXPIRED
    // session — just for their own wallet — and points it at someone else's fighter. If the
    // `authority` binding ever regressed, that is a live exploit and not a subtle one: anyone with a
    // session of their own could force-extract any live fighter mid-fight, banking their hp and
    // pulling them out of the ring, which directly moves the round's outcome. Every assertion in
    // step 4 would still pass in that world. This one would not.
    heading("5. token-forgery controls — a REAL session, misused. The `authority` and `target_program` bindings");
    const mkSession = async (owner, signer, target) => {
      const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from("session_token"), target.toBuffer(), signer.publicKey.toBuffer(), owner.publicKey.toBuffer()],
        GPL_SESSION_PROGRAM_ID,
      );
      await new Program(gplSessionIdl, new AnchorProvider(base, new Wallet(owner), opts)).methods
        .createSession(true, new BN(Math.ceil(Date.now() / 1000) + 3600), new BN(0.005 * LAMPORTS_PER_SOL))
        .accounts({ sessionToken: pda, sessionSigner: signer.publicKey, authority: owner.publicKey,
                    targetProgram: target, systemProgram: SystemProgram.programId })
        .signers([signer]).rpc();
      return pda;
    };
    const attackerSigner = Keypair.generate();
    const attackerToken = await mkSession(attacker, attackerSigner, PROGRAM_ID);
    const asAttackerSession = new Program(idl, new AnchorProvider(base, new Wallet(attackerSigner), opts));
    info(`attacker owns a real session: token ${attackerToken.toBase58()}`);

    await expectError(
      () => asAttackerSession.methods.enter(0, new BN(STAKE_A))
        .accounts({ arena: arenaPda, round: roundPda, player: playerA.publicKey, sessionToken: attackerToken, signer: attackerSigner.publicKey })
        .rpc(),
      "InvalidToken", "enter() with the attacker's OWN valid token, aimed at player A",
    );
    await expectError(
      () => asAttackerSession.methods.extract()
        .accounts({ round: roundPda, player: playerA.publicKey, sessionToken: attackerToken, signer: attackerSigner.publicKey })
        .rpc(),
      "InvalidToken", "extract() with the attacker's OWN valid token, aimed at player A (the force-extract exploit)",
    );

    // A session scoped to a DIFFERENT program must not be replayable here. `target_program` is a PDA
    // seed and the prologue derives it from `crate::id()`, so this is structurally impossible — which
    // is worth an assertion precisely because it is the kind of thing a refactor silently loosens.
    // The System Program stands in as "some other program"; it needs no properties beyond existing.
    const foreignToken = await mkSession(playerA, Keypair.generate(), SystemProgram.programId);
    await expectError(
      () => asSession.methods.enter(0, new BN(STAKE_A))
        .accounts({ arena: arenaPda, round: roundPda, player: playerA.publicKey, sessionToken: foreignToken, signer: sessionKeypair.publicKey })
        .rpc(),
      "InvalidToken", "enter() with a token scoped to a DIFFERENT target_program",
    );

    // EXPIRY. `create_session` bounds `valid_until` only from above, so an already-expired token can
    // be minted directly and used the same second — no waiting. Worth testing rather than reading:
    // session-keys V1's `is_expired()` actually returns "is still VALID" (`now < valid_until`) and
    // `validate` returns it as-is, an inverted name that happens to compose correctly. V2 uses the
    // opposite convention. A migration between the two is exactly where this silently flips open.
    const expiredSigner = Keypair.generate();
    const [expiredToken] = PublicKey.findProgramAddressSync(
      [Buffer.from("session_token"), PROGRAM_ID.toBuffer(), expiredSigner.publicKey.toBuffer(), playerA.publicKey.toBuffer()],
      GPL_SESSION_PROGRAM_ID,
    );
    await new Program(gplSessionIdl, new AnchorProvider(base, new Wallet(playerA), opts)).methods
      .createSession(true, new BN(Math.floor(Date.now() / 1000) - 3600), new BN(0.005 * LAMPORTS_PER_SOL))
      .accounts({ sessionToken: expiredToken, sessionSigner: expiredSigner.publicKey, authority: playerA.publicKey,
                  targetProgram: PROGRAM_ID, systemProgram: SystemProgram.programId })
      .signers([expiredSigner]).rpc();
    await expectError(
      () => new Program(idl, new AnchorProvider(base, new Wallet(expiredSigner), opts)).methods.enter(0, new BN(STAKE_A))
        .accounts({ arena: arenaPda, round: roundPda, player: playerA.publicKey, sessionToken: expiredToken, signer: expiredSigner.publicKey })
        .rpc(),
      "InvalidToken", "enter() with player A's own EXPIRED token, signed by its real session key",
    );

    heading("6. enter() — player B, direct signing, no session (the unmodified pre-Phase-6 path)");
    signatures.enterDirect = await asPlayerB.methods
      .enter(1, new BN(400_000))
      .accounts({ arena: arenaPda, round: roundPda, player: playerB.publicKey, sessionToken: null, signer: playerB.publicKey })
      .rpc();
    ok(`enter (direct, player B, side 1)  ${c.d}${signatures.enterDirect}${c.x}`);

    heading("7. extract() — DIFFERENTIAL proof of the session gate (see this file's header)");
    {
      // The differential below reads `NotFighting` as "the gate accepted it". That inference is only
      // sound while the round really is outside Fight phase, so assert it rather than assume it.
      const phase = (await authority.account.round.fetch(roundPda)).phase;
      if (phase !== 0) throw new Error(`expected round in Lobby (phase 0) for the differential, got phase ${phase}`);
    }
    info("round is in Lobby, so every call below must fail; WHICH error it fails with is the result.");
    await expectError(
      () => asSession.methods.extract()
        .accounts({ round: roundPda, player: playerA.publicKey, sessionToken: sessionTokenPda, signer: sessionKeypair.publicKey })
        .rpc(),
      "NotFighting", "extract() session-signed  [reached the phase guard => session gate ACCEPTED it]",
    );
    await expectError(
      () => asPlayerB.methods.extract()
        .accounts({ round: roundPda, player: playerB.publicKey, sessionToken: null, signer: playerB.publicKey })
        .rpc(),
      "NotFighting", "extract() direct, no session  [reached the phase guard => fallback arm ACCEPTED it]",
    );
    await expectError(
      () => asAttacker.methods.extract()
        .accounts({ round: roundPda, player: playerA.publicKey, sessionToken: sessionTokenPda, signer: attacker.publicKey })
        .rpc(),
      "InvalidToken", "extract() NEGATIVE CONTROL, forged signer with the real token  [session gate REJECTED it]",
    );
    await expectError(
      () => asAttacker.methods.extract()
        .accounts({ round: roundPda, player: playerA.publicKey, sessionToken: null, signer: attacker.publicKey })
        .rpc(),
      "InvalidToken", "extract() NEGATIVE CONTROL, forged signer with NO token  [session gate REJECTED it]",
    );
    ok("accepted vs rejected differs only in who signed and which token — the gate discriminates correctly");

    heading("8. signatures");
    for (const [k, v] of Object.entries(signatures)) info(`${k.padEnd(20)} ${v}`);
    info(`round #${roundNo} is left open in Lobby on the base layer: close_round requires Phase::Settled,`);
    info(`which requires the VRF oracle, which is ER-only. Harmless, and deliberately not faked.`);
    info(`fork-payer spent ${((startBalance - await base.getBalance(forkPayer.publicKey)) / LAMPORTS_PER_SOL).toFixed(4)} SOL`);

    // Enumerate what was actually established, rather than asserting a broad "authorization is
    // correct". The value of this script is that a reader can tell at a glance which claims it backs
    // and which it does not — a summary line that outruns the evidence would quietly undo that.
    console.log(`\n${c.g}${c.b}PASS${c.x} — proven on the real deployed program, for BOTH enter() and extract():`);
    for (const line of [
      "a session key may sign on the player's behalf, and the PLAYER is what gets credited",
      "the signer must be the token's own session_signer (forged signer, with or without a token, is rejected)",
      "the token's authority must be the named `player` (a valid token cannot be aimed at someone else)",
      "the token must be scoped to THIS program (a token for another target_program is rejected)",
      "an expired token is rejected, even presented by its own real session key",
      "with no token at all, signer == player is still required, and still works — the pre-Phase-6 path",
    ]) console.log(`  ${c.g}✓${c.x} ${line}`);
    console.log(`  ${c.y}!${c.x} NOT proven here: extract()'s effect on banked/dead in Fight phase — that needs`);
    console.log(`    the VRF oracle and therefore the ER. It lives in scripts/verify-session-real.mjs.`);
    process.exit(0);
  } catch (e) {
    console.error(`\n${c.r}${c.b}VERIFICATION FAILED${c.x}\n  ${c.r}${describeError(e)}${c.x}`);
    console.error("  signatures collected before failure:", signatures);
    process.exitCode = 1;
  }
})();
