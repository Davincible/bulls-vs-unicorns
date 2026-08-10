#!/usr/bin/env node
// PHASE 6 VERIFICATION — snug-floating-mitten.md. Phase 0's spike (spike-session-er.mjs) proved
// session keys authorize `enter()` on an ER-delegated account, against a THROWAWAY fork
// (bulls-arena-session-spike). This script proves the same property against the REAL, redeployed
// program (F59NksP2bYZhP4wD7fgR1sP729UHNPitrBiYrrKF1sYW) — and extends coverage to `extract()`,
// which the spike never touched (extract wasn't converted to session keys until this phase).
//
// WHAT IT DOES, IN ORDER:
//   open_round -> delegate_round (validator PINNED, see the note below) -> create a session for
//   player A -> enter() session-signed (positive) -> enter() forged-signer negative control ->
//   player B enters directly (no session, proves the fallback path still works) ->
//   close_lobby_and_draw -> [VRF callback, Drawing -> Fight] -> extract() session-signed (positive)
//   -> extract() forged-signer negative control -> player B extracts directly (the fallback on
//   extract, which needs proving separately from enter) -> resolve -> close_round.
//
// WHY THE VALIDATOR IS PINNED, NOT LEFT TO THE ROUTER'S DEFAULT (MEGA_QUEUE.md task #15,
// MAGICBLOCK_FEEDBACK.md's entry on it): MagicBlock's ER validators clone a program's bytecode on
// first use and do not reliably re-clone it after a base-layer upgrade. This script runs right
// after upgrading bulls-arena to add session keys — if the round landed on a validator that already
// had the OLD bytecode cached, `enter`/`extract` would fail with an account-shape mismatch that has
// nothing to do with whether session keys actually work, and everything to do with stale infra.
//
// TASK #15's ANSWER HAS EXPIRED, AND THE FAILURE GOT WORSE. #15 pinned `devnet-us` and that was
// enough at the time. It is not any more: measured on this run, THREE of the router's four devnet
// validators — devnet-us, devnet-eu and devnet-as — all still serve the PRE-session-keys bytecode
// (the marker string "Invalid session token" is absent from the program account each one executes,
// while base-layer programdata has it). So the bug is not "the router might pick a cold validator",
// it is "a validator that has ever run your program is stuck on that version" — and the more of
// them your program has touched, the fewer escape hatches remain. The symptom is a bare
// `custom program error: 0xbc2` (Anchor 3010, AccountNotSigner) from `enter`: the OLD `Enter`
// struct still declares `player: Signer`, and a session-signed call does not sign as `player`.
//
// SO THE VALIDATOR IS CHOSEN AT RUNTIME, NOT WRITTEN DOWN HERE. `selectValidator` asks the router
// for its routes and probes each one for the two properties that actually matter — is it running
// the current bytecode, and will it accept a write at all (`devnet-tee` reads fine and returns 401
// on `sendTransaction`) — then pins the first that satisfies both, via `delegate_round`'s
// `remaining_accounts[0]`. Any name hard-coded here would expire at the next upgrade exactly as
// #15's did. When nothing qualifies, the script says so in one line at startup, and names
// verify-session-base.mjs as the ER-free way to test the same program — rather than failing 200
// lines later as an unexplained 0xbc2 that reads like a broken feature.
//
//   cd er-demo && bun run scripts/verify-session-real.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL, Transaction, Connection,
} from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import {
  ConnectionMagicRouter,
  DELEGATION_PROGRAM_ID,
  delegateBufferPdaFromDelegatedAccountAndOwnerProgram,
  delegationRecordPdaFromDelegatedAccount,
  delegationMetadataPdaFromDelegatedAccount,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import { GPLSESSION_PROGRAMS } from "@magicblock-labs/gum-sdk";
import gplSessionIdl from "../node_modules/@magicblock-labs/gum-sdk/lib/idl/gpl_session.json" with { type: "json" };

const { AnchorProvider, Program, Wallet, BN } = anchor;
const __dirname = dirname(fileURLToPath(import.meta.url));

// DEVNET GUARD — same inline shape as every other script in this project (chain/devnet-guard.ts's
// logic isn't imported here for the same reason spike-session-er.mjs gives in its own comment: this
// is a plain Node/Bun script outside any bundler, importing across that boundary is the exact
// coupling the "no cross-import from engine/" rule exists to avoid, and it applies here too).
class MainnetBlocked extends Error {}
const SAFE_URL = [/\bapi\.devnet\.solana\.com\b/i, /\bdevnet\b/i, /\btestnet\b/i];
const MAINNET_URL = [/\bapi\.mainnet-beta\.solana\.com\b/i, /\bmainnet\b/i, /\bmainnet-beta\b/i];
const stripUrlNoise = (s) => s.replace(/[\x00-\x1f\x7f]/g, "");
function assertDevnetUrl(url, what = "endpoint") {
  const u = stripUrlNoise(String(url || "").trim());
  if (!u) throw new MainnetBlocked(`${what}: empty URL — refusing to guess a cluster.`);
  if (MAINNET_URL.some((re) => re.test(u))) {
    throw new MainnetBlocked(`${what} points at MAINNET (${u}). This is a devnet-only script. Refusing.`);
  }
  if (SAFE_URL.some((re) => re.test(u))) return;
  throw new MainnetBlocked(`${what} could not be positively identified as devnet: ${u}`);
}

const ROUTER_URL = "https://devnet-router.magicblock.app";
const BASE_RPC = "https://api.devnet.solana.com";
assertDevnetUrl(ROUTER_URL, "Magic Router");
assertDevnetUrl(BASE_RPC, "base devnet RPC");

/// A string present in the post-Phase-6 build and impossible in the pre-Phase-6 one: it is
/// `SessionError::InvalidToken`'s `#[msg]`, which only reaches the ELF's rodata once the program
/// actually depends on session-keys. Direct and cheap — and notably better than comparing hashes,
/// which would give false alarms: the ER serves the program as a LoaderV4 account whose bytes
/// legitimately differ from base-layer programdata (different header, padding trimmed) even when
/// the bytecode underneath is identical.
const SESSION_KEYS_MARKER = "Invalid session token";

/** Ask ONE validator the two questions that decide whether this script can use it.
 *
 *  `fresh` — is it executing the current bytecode? A validator that has never cloned this program
 *  counts as fresh: it will clone the current bytecode the first time it is asked to run it.
 *
 *  `writable` — will it accept a transaction at all? Not a given: `devnet-tee` answers reads
 *  happily and returns HTTP 401 "Missing token query param" for `sendTransaction`. The probe is a
 *  deliberately malformed `sendTransaction` — it can never do anything, and the two outcomes are
 *  unambiguous: HTTP 401 means gated, a JSON-RPC "invalid params" means open for business. */
async function probeValidator(fqdn, programId) {
  const out = { fqdn, fresh: false, writable: false, note: "" };
  try {
    const acct = await new Connection(fqdn, "confirmed").getAccountInfo(programId);
    out.fresh = !acct || acct.data.toString("latin1").includes(SESSION_KEYS_MARKER);
    out.note = acct ? `${out.fresh ? "fresh" : "STALE"} ${acct.data.length}B` : "never cloned";
  } catch (e) {
    out.note = `read failed: ${e.message.slice(0, 40)}`;
    return out;
  }
  try {
    const res = await fetch(fqdn, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendTransaction", params: [] }),
    });
    out.writable = res.status !== 401;
    if (!out.writable) out.note += ", writes GATED (401)";
  } catch (e) {
    out.note += `, write probe failed: ${e.message.slice(0, 30)}`;
  }
  return out;
}

/** Choose a validator that can actually run this test, and say plainly why the others cannot.
 *
 *  Selecting instead of hard-coding is the point. Task #15 hard-coded `devnet-us`, and that answer
 *  silently expired the moment devnet-us cached a build; a future upgrade will expire whatever this
 *  run happens to choose, in the same way, for the same reason. Re-deriving the choice each run
 *  costs four RPC round-trips and never goes stale. When nothing qualifies, the thrown message is
 *  the whole table — so the reader can see at a glance that this is an infrastructure problem and
 *  not evidence that session keys are broken. */
async function selectValidator(routerUrl, programId) {
  const res = await fetch(routerUrl, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getRoutes", params: [] }),
  });
  const { result: routes, error } = await res.json();
  if (error) throw new Error(`getRoutes: ${error.message}`);

  const probed = await Promise.all(routes.map(async (r) => {
    assertDevnetUrl(r.fqdn, `ER validator ${r.identity}`);
    return { ...r, ...(await probeValidator(r.fqdn, programId)) };
  }));
  for (const p of probed) info(`${p.fqdn.padEnd(40)} ${p.identity.slice(0, 8)}  ${p.note}`);

  const usable = probed.find((p) => p.fresh && p.writable);
  if (!usable) {
    throw new Error(
      `No devnet ER validator can run this test right now. Every route is either serving PRE-Phase-6 `
      + `bytecode (the MAGICBLOCK_FEEDBACK.md / task #15 clone-cache issue — a validator that has run `
      + `an older build of this program stays on it after a base-layer upgrade) or has writes gated:\n`
      + probed.map((p) => `    ${p.fqdn.padEnd(40)} ${p.note}`).join("\n")
      + `\n  THIS IS AN INFRASTRUCTURE FAULT, NOT A VERDICT ON SESSION KEYS. Run`
      + `\n  'bun run scripts/verify-session-base.mjs', which proves the program's session-keys`
      + `\n  authorization against the same deployed bytecode without needing the ER at all.`,
    );
  }
  ok(`using ${usable.fqdn} (${usable.identity}) — current bytecode, writes open`);
  return { identity: new PublicKey(usable.identity), fqdn: usable.fqdn };
}

const Phase = { Lobby: 0, Drawing: 1, Fight: 2, Settled: 3, Abandoned: 4 };
const PHASE_NAME = ["Lobby", "Drawing", "Fight", "Settled", "Abandoned"];

// The lobby this script opens, in seconds — the FLOOR the program clamps to (MIN_LOBBY_SECONDS in
// lib.rs and in src/chain/constants.ts; a literal here only because this file is a standalone Node
// script that deliberately imports nothing from src/), not the 60 the demo opens rounds at.
// `close_lobby_and_draw` is refused until the deadline passes (`LobbyStillOpen`, 6015), and this
// round enters two fighters rather than filling to 16, so every second of lobby is a second this
// script sits idle before it can reach the VRF draw and the assertions past it. 20 is the shortest
// wait the chain permits.
//
// It is also the tightest fit in this repo, and worth naming rather than discovering. The floor is
// sized as the 20s the off-chain engine's online lobby ran at, with the ~2s ER delegation hand-off
// (measured on devnet) coming OUT of that window rather than being added to it — so ~18s are
// genuinely enterable. This script spends those 18s on four confirmed round-trips, not the usual two:
// a `create_session`, the session-signed enter, the forged-signer negative control, and player B's
// direct enter. If devnet is slow enough to push the last of them past the deadline, `enter` fails
// with `LobbyClosed` (6014) — loud and accurately named. Read that as devnet latency and re-run; it
// is not a session-keys regression.
const LOBBY_SECONDS = 20;

/** Margin added to the deadline wait below. `lobby_closes_at` is stamped from the BASE layer's clock
 *  in `open_round` and compared against the ER's clock in `close_lobby_and_draw` (see
 *  `lobby_opened_at`'s doc comment in lib.rs), so the two can disagree by a small skew. Overshooting
 *  costs two seconds; waking early costs `LobbyStillOpen` and the whole run. */
const CLOCK_SKEW_MARGIN_MS = 2_000;
// A settling pause before `resolve`, local to this script. It is no longer named after an on-chain
// constant: `MIN_FIGHT_SECONDS` was removed when the fight became stepped (a flat floor let a
// permissionless caller settle a live fight at the moment it favoured them). `resolve` now needs the
// fight to be OVER — which it is here, because both fighters extract above — or the bell to have
// rung. The retry below still covers the case where neither is true yet.
const SETTLE_PAUSE_SECONDS = 5;

const c = { r: "\x1b[31m", g: "\x1b[32m", y: "\x1b[33m", d: "\x1b[2m", b: "\x1b[1m", x: "\x1b[0m" };
const ok = (s) => console.log(`  ${c.g}✓${c.x} ${s}`);
const info = (s) => console.log(`  ${c.d}${s}${c.x}`);
const warn = (s) => console.log(`  ${c.y}!${c.x} ${s}`);
const heading = (s) => console.log(`\n${c.b}${s}${c.x}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Sleep until the round's lobby deadline has passed, because `close_lobby_and_draw` refuses before
 *  it (`LobbyStillOpen`, 6015) on any round that is not full at 16 fighters — this one has two.
 *
 *  `lobbyClosesAt` is READ OFF THE ROUND ACCOUNT by the caller, never reconstructed as "LOBBY_SECONDS
 *  after we sent open_round": the chain clamps the requested duration into [20, 3600] and stamps the
 *  timestamp from its own clock, so only the account knows the real deadline. A script that slept a
 *  hardcoded interval would be keeping a private countdown next to the chain's — the exact thing
 *  `Round.lobby_closes_at` was added to delete. */
async function waitForLobbyDeadline(lobbyClosesAt) {
  const deadlineMs = Number(lobbyClosesAt) * 1000 + CLOCK_SKEW_MARGIN_MS;
  let remainingMs = deadlineMs - Date.now();
  if (remainingMs <= 0) {
    info(`lobby deadline already passed — close_lobby_and_draw permitted immediately`);
    return;
  }
  info(`lobby closes at ${new Date(Number(lobbyClosesAt) * 1000).toLocaleTimeString()}; close_lobby_and_draw is refused until then`);
  // Repainted once a second so a human watching sees a countdown rather than a stalled script.
  while (remainingMs > 0) {
    process.stdout.write(`  ${c.d}waiting out the lobby: ${Math.ceil(remainingMs / 1000)}s${c.x}\r`);
    await sleep(Math.min(1000, remainingMs));
    remainingMs = deadlineMs - Date.now();
  }
  process.stdout.write(`${" ".repeat(48)}\r`);
  ok("lobby deadline passed — close_lobby_and_draw is now permitted");
}

/// The program's own log lines, as one string. Every error-identity check in this file goes through
/// here rather than through `instanceof anchor.AnchorError`: `sendTx` uses a plain web3.js
/// `Connection`, so Anchor's `translateError` never runs and the errors are always
/// `SendTransactionError`. The logs are the only place the error's NAME survives.
const logsOf = (e) => {
  const logs = e?.logs ?? e?.transactionLogs ?? [];
  return Array.isArray(logs) ? logs.join("\n") : String(logs);
};

function describeError(e) {
  if (e instanceof anchor.AnchorError) {
    return `${e.error.errorCode.code} (${e.error.errorCode.number}): ${e.error.errorMessage}`;
  }
  if (e?.logs) return `${e.message}\n${e.logs.slice(-20).map((l) => "      " + l).join("\n")}`;
  return e?.message || String(e);
}

const load = (p) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8"))));
const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };

// Router-bypass send path — identical logic to chain/sendTx.ts (this script predates being able to
// import that module the same way spike-session-er.mjs's own copy does; see that file's comment).
async function blockhashForAccounts(routerUrl, accounts) {
  const res = await fetch(routerUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBlockhashForAccounts", params: [accounts.map((a) => a.toBase58())] }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`getBlockhashForAccounts: ${body.error.message}`);
  return body.result;
}
async function sendTx(router, methodsBuilder, signer, label, { endpoint } = {}) {
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
    ({ blockhash, lastValidBlockHeight } = await blockhashForAccounts(router.rpcEndpoint, accountsForBlockhash));
  }
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.sign(signer);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: "confirmed" });
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  ok(`${label}  ${c.d}${Date.now() - t0}ms  ${sig}${c.x}`);
  return sig;
}

/** Expects a rejection that is SPECIFICALLY `SessionError::InvalidToken`, and proves it from the
 *  program's own logs rather than from the numeric error code.
 *
 *  WHY THE LOGS AND NOT THE CODE — this matters, and it is not pedantry. `#[error_code]` numbers
 *  from 6000 with no cross-crate coordination, so session-keys' `SessionError::InvalidToken` is
 *  6001 and bulls-arena's OWN `ArenaError::RoundOutOfOrder` is ALSO 6001. On the wire both are
 *  `custom program error: 0x1771`, and anything decoding that number against the bulls-arena IDL
 *  reads it as `RoundOutOfOrder`. The only unambiguous evidence of which one actually fired is the
 *  `Error Code: <name>` line Anchor logs at the point of failure.
 *
 *  Matching loosely here (on "custom program error", say) would quietly accept a rejection that
 *  came from an ordinary guard like `NotInLobby` — i.e. it would report the security control as
 *  passing in a run where the session check was never reached at all. A negative control that can
 *  pass for the wrong reason is worse than no negative control. Throws if the transaction was NOT
 *  rejected, or was rejected by something other than the session check. */
async function expectInvalidToken(sendAttempt, label) {
  try {
    await sendAttempt();
  } catch (e) {
    const proof = /Error Code: InvalidToken\b/.test(logsOf(e));
    const desc = describeError(e);
    if (proof) {
      ok(`${label} — REJECTED by the session check (Error Code: InvalidToken, 6001):\n      ${desc}`);
      return;
    }
    throw new Error(
      `${label} was rejected, but NOT provably by SessionError::InvalidToken. The session check may `
      + `never have been reached — inspect before drawing any conclusion:\n${desc}`,
    );
  }
  throw new Error(`SECURITY FINDING: ${label} was NOT rejected. #[session_auth_or] is not enforcing the binding it claims to.`);
}

/** Every signature this run has managed to land, by step. Lives out here so the failure reporter can
 *  print what DID happen before the failure — on a partial run that is most of the evidence. */
const signatures = {};

(async () => {
  console.log(`${c.d}PHASE 6 VERIFICATION — session keys on enter() AND extract(), REAL redeployed program, DEVNET${c.x}`);

  try {
    const idl = JSON.parse(readFileSync(join(__dirname, "..", "public", "idl", "bulls_arena.json"), "utf8"));
    const PROGRAM_ID = new PublicKey(idl.address);
    const GPL_SESSION_PROGRAM_ID = GPLSESSION_PROGRAMS.devnet;
    info(`bulls-arena     ${PROGRAM_ID.toBase58()}`);
    info(`gpl_session     ${GPL_SESSION_PROGRAM_ID.toBase58()}`);
    heading("0. choosing an ER validator that is actually running the deployed bytecode");
    const { identity: PINNED_VALIDATOR, fqdn: PINNED_VALIDATOR_URL } = await selectValidator(ROUTER_URL, PROGRAM_ID);

    const router = new ConnectionMagicRouter(ROUTER_URL, "confirmed");
    const base = new Connection(BASE_RPC, "confirmed");

    const forkPayer = load(join(__dirname, "..", "..", ".devnet", "fork-payer.json"));
    const startBalance = await base.getBalance(forkPayer.publicKey);
    info(`fork-payer  ${forkPayer.publicKey.toBase58()}  ${(startBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);

    const opts = { commitment: "confirmed", preflightCommitment: "confirmed" };
    const authority = new Program(idl, new AnchorProvider(router, new Wallet(forkPayer), opts));
    const authorityBase = new Program(idl, new AnchorProvider(base, new Wallet(forkPayer), opts));

    // "playerA" gets a session and exercises BOTH enter and extract through it. "playerB" enters
    // directly (no session) purely so the round has >=2 fighters for close_lobby_and_draw — and, as a
    // free side effect, is itself the "no-session fallback still works" check.
    //
    // The attacker is funded HERE, in the same transaction and before delegation, even though it is
    // not used until step 5. Funding it later, on the base layer, and then immediately spending it on
    // the ER races the validator's account clone: the negative control would fail on lamports rather
    // than on the session gate, and `expectInvalidToken` would raise a security-shaped alarm for what
    // is really clone lag. A control that cries wolf is a control people learn to skip.
    const playerA = Keypair.generate();
    const playerB = Keypair.generate();
    const attacker = Keypair.generate();
    const FUND_LAMPORTS = 0.05 * LAMPORTS_PER_SOL;
    {
      const tx = new Transaction().add(
        SystemProgram.transfer({ fromPubkey: forkPayer.publicKey, toPubkey: playerA.publicKey, lamports: FUND_LAMPORTS }),
        SystemProgram.transfer({ fromPubkey: forkPayer.publicKey, toPubkey: playerB.publicKey, lamports: FUND_LAMPORTS }),
        SystemProgram.transfer({ fromPubkey: forkPayer.publicKey, toPubkey: attacker.publicKey, lamports: FUND_LAMPORTS }),
      );
      const sig = await base.sendTransaction(tx, [forkPayer]);
      await base.confirmTransaction(sig, "confirmed");
      ok(`funded player A + player B + attacker  ${c.d}${sig}${c.x}`);
      info(`  player A (session) ${playerA.publicKey.toBase58()}`);
      info(`  player B (direct)  ${playerB.publicKey.toBase58()}`);
      info(`  attacker           ${attacker.publicKey.toBase58()}`);
    }

    const [arenaPda] = PublicKey.findProgramAddressSync([Buffer.from("arena")], PROGRAM_ID);

    // ---- open_round -----------------------------------------------------------------------------
    heading("1. open_round");
    const arena = await authorityBase.account.arena.fetch(arenaPda);
    const roundNo = BigInt(arena.roundCounter.toString()) + 1n;
    const [roundPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("round"), arenaPda.toBuffer(), u64le(roundNo)], PROGRAM_ID,
    );
    info(`round #${roundNo}  pda ${roundPda.toBase58()}`);
    {
      const builder = authority.methods
        .openRound(new BN(roundNo.toString()), Array.from(new Uint8Array(32)), LOBBY_SECONDS)
        .accounts({ arena: arenaPda, round: roundPda, authority: forkPayer.publicKey, systemProgram: SystemProgram.programId });
      signatures.openRound = await sendTx(router, builder, forkPayer, `open_round #${roundNo}`);
    }

    // ---- delegate_round, validator PINNED ----------------------------------------------------------
    heading(`2. delegate_round — pinned to ${PINNED_VALIDATOR_URL}, chosen in step 0`);
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
        })
        .remainingAccounts([{ pubkey: PINNED_VALIDATOR, isSigner: false, isWritable: false }]);
      signatures.delegateRound = await sendTx(router, builder, forkPayer, "delegate_round");
    }
    {
      let acctInfo;
      for (let i = 0; i < 10; i++) {
        acctInfo = await base.getAccountInfo(roundPda);
        if (acctInfo?.owner.equals(DELEGATION_PROGRAM_ID)) break;
        await sleep(1000);
      }
      if (!acctInfo?.owner.equals(DELEGATION_PROGRAM_ID)) throw new Error(`round did not delegate — owner is ${acctInfo?.owner.toBase58() ?? "MISSING"}`);
      const status = await router.getDelegationStatus(roundPda);
      ok(`round is ER-delegated, validator fqdn: ${status?.fqdn ?? "(unknown)"}`);
    }

    // ---- create a session for player A — ONE signature from player A's real wallet -----------------
    heading("3. create_session — player A's wallet authorizes a session, ONE signature");
    const sessionKeypair = Keypair.generate();
    const [sessionTokenPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("session_token"), PROGRAM_ID.toBuffer(), sessionKeypair.publicKey.toBuffer(), playerA.publicKey.toBuffer()],
      GPL_SESSION_PROGRAM_ID,
    );
    info(`session signer  ${sessionKeypair.publicKey.toBase58()}`);
    info(`session token   ${sessionTokenPda.toBase58()}`);
    const gplSession = new Program(gplSessionIdl, new AnchorProvider(base, new Wallet(playerA), opts));
    const TOP_UP_LAMPORTS = 0.02 * LAMPORTS_PER_SOL; // funds the session key's own enter()/extract() fees below
    const validUntil = Math.ceil(Date.now() / 1000) + 60 * 60;
    {
      const builder = gplSession.methods
        .createSession(true, new BN(validUntil), new BN(TOP_UP_LAMPORTS))
        .accounts({
          sessionToken: sessionTokenPda,
          sessionSigner: sessionKeypair.publicKey,
          authority: playerA.publicKey,
          targetProgram: PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([sessionKeypair]);
      signatures.createSession = await builder.rpc();
      ok(`create_session  ${c.d}${signatures.createSession}${c.x}`);
    }

    // ---- POSITIVE: enter(), session-signed, on the ER-delegated round -------------------------------
    heading("4. enter() — session-signed (player A, side 0)");
    const STAKE_A = 500_000;
    const sessionEnterProgram = new Program(idl, new AnchorProvider(router, new Wallet(sessionKeypair), opts));
    {
      const builder = sessionEnterProgram.methods
        .enter(0, new BN(STAKE_A))
        .accounts({ arena: arenaPda, round: roundPda, player: playerA.publicKey, sessionToken: sessionTokenPda, signer: sessionKeypair.publicKey });
      signatures.enterSessionSigned = await sendTx(router, builder, sessionKeypair, "enter (session-key-signed)");
    }
    // The deadline is taken from THIS fetch rather than from one added later, and that is exact rather
    // than convenient: `lobby_closes_at` is written once by `open_round` and never touched again, so
    // every later read returns the same number. Step 7 waits against it after player B has entered.
    let lobbyClosesAt;
    {
      const round = await authority.account.round.fetch(roundPda);
      const fighter = round.fighters.slice(0, round.fighterCount).find((f) => f.wallet.equals(playerA.publicKey));
      if (!fighter) throw new Error("enter() landed but no fighter matching player A's pubkey was found");
      ok(`fighter attributed to PLAYER A's real wallet (${playerA.publicKey.toBase58()}), not the session key (${sessionKeypair.publicKey.toBase58()})`);
      info(`  side=${fighter.side} stake=${fighter.stake.toString()} hp=${fighter.hp.toString()}`);
      lobbyClosesAt = round.lobbyClosesAt;
      info(`  lobby window ${Number(round.lobbyClosesAt) - Number(round.lobbyOpenedAt)}s, closing at ${new Date(Number(round.lobbyClosesAt) * 1000).toLocaleTimeString()}`);
    }

    // ---- NEGATIVE CONTROL: enter(), forged signer presenting the real token ------------------------
    heading("5. enter() negative control — unrelated signer presenting the REAL session token, must be REJECTED");
    const attackerProgram = new Program(idl, new AnchorProvider(router, new Wallet(attacker), opts));
    await expectInvalidToken(
      () => sendTx(router, attackerProgram.methods.enter(0, new BN(STAKE_A)).accounts({
        arena: arenaPda, round: roundPda, player: playerA.publicKey, sessionToken: sessionTokenPda, signer: attacker.publicKey,
      }), attacker, "enter (FORGED)"),
      "enter() forged-signer negative control",
    );
    signatures.enterNegativeControl = "confirmed rejected — see log above";

    // ---- player B enters DIRECTLY — proves the no-session fallback path is unmodified ---------------
    heading("6. enter() — player B, DIRECT signing, no session (the pre-Phase-6 path, unmodified)");
    const STAKE_B = 400_000;
    const playerBProgram = new Program(idl, new AnchorProvider(router, new Wallet(playerB), opts));
    {
      const builder = playerBProgram.methods
        .enter(1, new BN(STAKE_B))
        .accounts({ arena: arenaPda, round: roundPda, player: playerB.publicKey, sessionToken: null, signer: playerB.publicKey });
      signatures.enterDirect = await sendTx(router, builder, playerB, "enter (direct, player B, side 1)");
    }

    // ---- close_lobby_and_draw — request randomness ---------------------------------------------------
    heading("7. close_lobby_and_draw — request randomness from the VRF oracle");
    // Both fighters are in, so the lobby holds everything it is going to; the deadline read in step 4
    // is now the only thing standing between here and the draw.
    await waitForLobbyDeadline(lobbyClosesAt);
    const DEFAULT_EPHEMERAL_QUEUE = new PublicKey("5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc");
    const VRF_PROGRAM_ID = new PublicKey("Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz");
    const SLOT_HASHES_SYSVAR = new PublicKey("SysvarS1otHashes111111111111111111111111111");
    const [programIdentityPda] = PublicKey.findProgramAddressSync([Buffer.from("identity")], PROGRAM_ID);
    const delegationStatus = await router.getDelegationStatus(roundPda);
    const erValidatorFqdn = delegationStatus?.fqdn;
    if (!erValidatorFqdn) throw new Error("getDelegationStatus(round) returned no fqdn");
    assertDevnetUrl(erValidatorFqdn, "ER validator");
    info(`sending directly to the round's own ER validator: ${erValidatorFqdn}`);
    const clientSeed = crypto.getRandomValues(new Uint8Array(32));
    {
      const builder = authority.methods
        .closeLobbyAndDraw(Array.from(clientSeed))
        .accounts({
          payer: forkPayer.publicKey, arena: arenaPda, round: roundPda,
          oracleQueue: DEFAULT_EPHEMERAL_QUEUE,
          // The PERMISSIONLESS close — the deadline has passed, so no privileged signer is needed.
          // Naming the arena authority here would bypass the deadline, which is a different path.
          authority: null,
          programIdentity: programIdentityPda, vrfProgram: VRF_PROGRAM_ID, slotHashes: SLOT_HASHES_SYSVAR,
          systemProgram: SystemProgram.programId,
        });
      signatures.closeLobbyAndDraw = await sendTx(router, builder, forkPayer, "close_lobby_and_draw", { endpoint: erValidatorFqdn });
    }

    // ---- wait for the VRF callback: Drawing -> Fight ---------------------------------------------
    heading("8. waiting for the VRF callback (Drawing -> Fight)");
    let round = await authority.account.round.fetch(roundPda);
    const drawStart = Date.now();
    const DRAW_TIMEOUT_MS = 90_000;
    while (round.phase !== Phase.Fight) {
      if (Date.now() - drawStart > DRAW_TIMEOUT_MS) throw new Error(`VRF callback never landed within ${DRAW_TIMEOUT_MS}ms — stuck in ${PHASE_NAME[round.phase]}`);
      if (round.phase !== Phase.Drawing) throw new Error(`round left Drawing for an unexpected phase: ${PHASE_NAME[round.phase]}`);
      await sleep(2000);
      round = await authority.account.round.fetch(roundPda);
    }
    const fightStartedAtWall = Date.now();
    ok(`PHASE IS NOW FIGHT — ${((fightStartedAtWall - drawStart) / 1000).toFixed(1)}s to land`);

    // ---- NEGATIVE CONTROL FIRST, WHILE PLAYER A IS STILL ALIVE --------------------------------------
    //
    // ORDER MATTERS HERE, and getting it wrong makes the control worthless. If this ran AFTER player
    // A's own extract below, A's fighter would already be `dead=1, hp=0` — so a gate that failed open
    // would be stopped by `NothingToExtract` instead, and the run would report "rejected, but not
    // provably by InvalidToken". Technically an alarm, but for the wrong reason, and it could never
    // demonstrate the outcome that actually matters: an attacker force-extracting a LIVE fighter,
    // banking their hp and pulling them out of the ring mid-fight. Run it against a live target.
    heading("9. extract() negative control — forged signer against a LIVE fighter, must be REJECTED");
    await expectInvalidToken(
      () => sendTx(router, attackerProgram.methods.extract().accounts({
        round: roundPda, player: playerA.publicKey, sessionToken: sessionTokenPda, signer: attacker.publicKey,
      }), attacker, "extract (FORGED)"),
      "extract() forged-signer negative control",
    );
    signatures.extractNegativeControl = "confirmed rejected — see log above";
    {
      const still = await authority.account.round.fetch(roundPda);
      const a = still.fighters.slice(0, still.fighterCount).find((f) => f.wallet.equals(playerA.publicKey));
      if (!a || a.dead !== 0 || a.hp.toString() === "0") {
        throw new Error(`the forged extract was reported as rejected, but player A is no longer a live fighter (dead=${a?.dead} hp=${a?.hp}). Investigate before trusting anything above.`);
      }
      ok(`player A is still live after the forged attempt (hp=${a.hp.toString()}, dead=0) — nothing was banked or removed`);
    }

    // ---- POSITIVE: extract(), session-signed --------------------------------------------------------
    heading("10. extract() — session-signed (player A)");
    const beforeExtract = (await authority.account.round.fetch(roundPda));
    const fighterBefore = beforeExtract.fighters.slice(0, beforeExtract.fighterCount)
      .find((f) => f.wallet.equals(playerA.publicKey));
    if (!fighterBefore) throw new Error("player A is not among the live fighters before extract() — cannot verify the effect");
    const hpBeforeExtract = fighterBefore.hp;
    const bankedBeforeExtract = fighterBefore.banked;
    {
      const builder = sessionEnterProgram.methods
        .extract()
        .accounts({ round: roundPda, player: playerA.publicKey, sessionToken: sessionTokenPda, signer: sessionKeypair.publicKey });
      signatures.extractSessionSigned = await sendTx(router, builder, sessionKeypair, "extract (session-key-signed)");
    }
    {
      const after = await authority.account.round.fetch(roundPda);
      const fighter = after.fighters.slice(0, after.fighterCount).find((f) => f.wallet.equals(playerA.publicKey));
      if (!fighter) throw new Error("extract() landed but player A's fighter is gone from round.fighters");
      if (fighter.dead !== 1) throw new Error(`expected dead=1 after extract, got dead=${fighter.dead}`);
      if (fighter.hp.toString() !== "0") throw new Error(`expected hp=0 after extract, got ${fighter.hp}`);
      // Stated as a MOVE of value rather than assuming banked started at zero — that assumption holds
      // today only because `banked` is written solely by run_fight, which has not run yet.
      const expectedBanked = BigInt(bankedBeforeExtract.toString()) + BigInt(hpBeforeExtract.toString());
      if (fighter.banked.toString() !== expectedBanked.toString()) {
        throw new Error(`banked should be ${expectedBanked} (was ${bankedBeforeExtract}, plus hp ${hpBeforeExtract}), got ${fighter.banked}`);
      }
      ok(`player A: hp=${fighter.hp.toString()} banked=${fighter.banked.toString()} dead=${fighter.dead} — value MOVED from ring to bank, credited to player A's real wallet`);
    }

    // ---- player B extracts DIRECTLY — the no-session fallback on extract, not just on enter ---------
    //
    // Step 6 proved the fallback for `enter`. This proves it for `extract`, which needs its own
    // check: `extract` is the instruction the spike never covered, its `Extract` struct changed
    // `player` from `Signer` to `UncheckedAccount` in this phase, and "the direct path still works"
    // is a claim about each instruction separately — `enter` passing says nothing about `extract`.
    //
    // Safe to leave both fighters extracted: `resolve` requires `fighter_count >= 2` (a count of
    // ENTRIES, which extracting does not decrement), and `run_fight` skips any step touching a dead
    // fighter, so the round still settles — on banked value, which is exactly what both players kept.
    heading("11. extract() — player B, DIRECT signing, no session (the pre-Phase-6 path, unmodified)");
    const beforeB = await authority.account.round.fetch(roundPda);
    const fighterBBefore = beforeB.fighters.slice(0, beforeB.fighterCount).find((f) => f.wallet.equals(playerB.publicKey));
    if (!fighterBBefore) throw new Error("player B is not among the live fighters before their direct extract()");
    const hpBeforeExtractB = fighterBBefore.hp;
    const bankedBeforeExtractB = fighterBBefore.banked;
    {
      const builder = playerBProgram.methods
        .extract()
        .accounts({ round: roundPda, player: playerB.publicKey, sessionToken: null, signer: playerB.publicKey });
      signatures.extractDirect = await sendTx(router, builder, playerB, "extract (direct, player B)");
    }
    {
      const after = await authority.account.round.fetch(roundPda);
      const fighter = after.fighters.slice(0, after.fighterCount).find((f) => f.wallet.equals(playerB.publicKey));
      if (!fighter) throw new Error("direct extract() landed but player B's fighter is gone from round.fighters");
      if (fighter.dead !== 1) throw new Error(`expected dead=1 after player B's direct extract, got dead=${fighter.dead}`);
      const expectedBankedB = BigInt(bankedBeforeExtractB.toString()) + BigInt(hpBeforeExtractB.toString());
      if (fighter.banked.toString() !== expectedBankedB.toString()) {
        throw new Error(`player B banked should be ${expectedBankedB} (was ${bankedBeforeExtractB}, plus hp ${hpBeforeExtractB}), got ${fighter.banked}`);
      }
      ok(`player B: hp=${fighter.hp.toString()} banked=${fighter.banked.toString()} dead=${fighter.dead} — direct-signed extract unchanged by Phase 6`);
    }

    // ---- resolve + close_round — leave the round in a clean, settled state --------------------------
    heading("12. resolve — both fighters have left the ring, so the fight is over; settling");
    const targetWaitMs = (SETTLE_PAUSE_SECONDS + 2) * 1000 - (Date.now() - fightStartedAtWall);
    if (targetWaitMs > 0) { info(`waiting ${(targetWaitMs / 1000).toFixed(1)}s more…`); await sleep(targetWaitMs); }
    // `resolve` no longer either throws FightNotOverYet or settles outright — it GRINDS, advancing
    // the fight by at most MAX_STEPS_PER_CALL (3,000) steps per call and settling only once genuinely
    // caught up. A call can come back Ok with the round STILL IN Fight, and that is a WORK problem,
    // not the TIMING problem the FightNotOverYet retry below covers — conflating the two would either
    // give up on a round that just needs another call, or wait on one that isn't behind at all. So
    // this is two loops with two budgets: the inner one is the unchanged timing retry; the outer one
    // re-sends resolve with NO sleep between grind calls, since the backlog at any lineup grows at
    // only 2*fighterCount steps/second, far below the 3,000 one call clears. `close_round` right after
    // this refuses a non-terminal round outright, so leaving without Settled here would only surface
    // as a more confusing failure one step down.
    //
    // MAX_STEPS_PER_CALL, FIGHT_TIMEOUT_SECONDS and STEPS_PER_FIGHTER_PER_SECOND are mirrored from
    // lib.rs (er-demo/src/chain/constants.ts carries the same three), literals here for the same
    // reason LOBBY_SECONDS above is one: this file deliberately imports nothing from src/.
    const MAX_STEPS_PER_CALL = 3_000;
    const FIGHT_TIMEOUT_SECONDS = 180;
    const STEPS_PER_FIGHTER_PER_SECOND = 2;
    const roundBeforeResolve = await authority.account.round.fetch(roundPda);
    // The bound: the most steps this exact lineup's fight could ever be behind by
    // (FIGHT_TIMEOUT_SECONDS * STEPS_PER_FIGHTER_PER_SECOND * fighterCount, i.e. finalCursor), ceiling-
    // divided by what one call can clear.
    const maxGrindCalls = Math.ceil(
      (FIGHT_TIMEOUT_SECONDS * STEPS_PER_FIGHTER_PER_SECOND * roundBeforeResolve.fighterCount) / MAX_STEPS_PER_CALL,
    );
    let resolvedRound = roundBeforeResolve;
    for (let grindCall = 1; grindCall <= maxGrindCalls; grindCall++) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const builder = authority.methods.resolve().accounts({ payer: forkPayer.publicKey, round: roundPda, magicProgram: new PublicKey("Magic11111111111111111111111111111111111111"), magicContext: new PublicKey("MagicContext1111111111111111111111111111111") })
            .preInstructions([anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })]);
          signatures.resolve = await sendTx(router, builder, forkPayer, `resolve (grind ${grindCall}/${maxGrindCalls})`);
          break;
        } catch (e) {
          // Matched from the LOGS, not via `instanceof anchor.AnchorError`. `sendTx` calls
          // `sendRawTransaction` on a plain web3.js Connection, so Anchor's `translateError` — which
          // only runs inside AnchorProvider's own send/simulate — never sees this error. It is always a
          // SendTransactionError. The `instanceof` form this replaced could never be true, which
          // quietly reduced a 3-attempt retry to a single attempt: a `resolve` landing one second early
          // aborted the whole run and stranded a delegated round in Fight phase.
          const tooEarly = /Error Code: FightNotOverYet\b/.test(logsOf(e));
          if (tooEarly && attempt < 3) {
            warn(`resolve() too early (attempt ${attempt}) — waiting 3s more`);
            await sleep(3000);
            continue;
          }
          throw e;
        }
      }
      resolvedRound = await authority.account.round.fetch(roundPda);
      if (resolvedRound.phase === Phase.Settled) break;
      info(`resolve() ground more steps but the round is still Fight (tick_count=${resolvedRound.tickCount.toString()}) — calling again immediately, no sleep`);
    }
    if (resolvedRound.phase !== Phase.Settled) {
      throw new Error(
        `round still in Fight after ${maxGrindCalls} grind calls (tick_count=${resolvedRound.tickCount.toString()}) — ` +
        `this is a WORK problem (resolve() kept grinding but never caught the fight up), not a timing one ` +
        `(FightNotOverYet, the bell never rang) — the two get separate retries above for exactly this reason.`,
      );
    }
    heading("13. close_round");
    {
      const builder = authority.methods.closeRound().accounts({ payer: forkPayer.publicKey, round: roundPda, magicProgram: new PublicKey("Magic11111111111111111111111111111111111111"), magicContext: new PublicKey("MagicContext1111111111111111111111111111111") });
      signatures.closeRound = await sendTx(router, builder, forkPayer, "close_round");
    }

    heading("14. signatures for every step");
    for (const [step, sig] of Object.entries(signatures)) info(`${step.padEnd(24)} ${sig}`);

    console.log(`\n${c.g}${c.b}PHASE 6 VERIFICATION COMPLETE — session keys proven on enter() AND extract() against the real, redeployed program.${c.x}`);
    process.exit(0);
  } catch (e) {
    console.error(`\n${c.r}${c.b}VERIFICATION FAILED${c.x}`);
    console.error(`  ${c.r}${describeError(e)}${c.x}`);
    console.error(`  signatures collected before failure:`, signatures);
    process.exitCode = 1;
  }
})();
