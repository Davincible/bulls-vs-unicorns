#!/usr/bin/env node
// ADMIN-ABANDON-ROUND — the way out for a lobby that died under-subscribed.
//
// A round that reaches `lobby_closes_at` holding fewer than two fighters can never become a fight:
// `enter` refuses past the deadline so `fighter_count` cannot rise, and `close_lobby_and_draw` needs
// two. `abandon_round` is the only instruction such a round will accept — it flips the phase to
// `Abandoned` and commit_and_undelegates in one call, which is why this script is three steps and not
// the seven `close_round` needs after a real fight.
//
// WHY THIS EXISTS AS A SCRIPT AT ALL. Without it the terminal state has an instruction, an IDL entry
// and a builder, and no way to reach it short of hand-writing a transaction — at exactly the moment
// somebody is staring at a stuck round wondering whether the chain is broken. The instruction is
// PERMISSIONLESS (every precondition is on the account, so a round whose operator has walked away
// does not need that operator to come back), so this runs under the fork payer purely because that is
// the keypair this fork already funds, not because it holds any authority the call requires.
//
//   cd er-demo && bun run scripts/admin-abandon-round.mjs            # newest round
//   cd er-demo && bun run scripts/admin-abandon-round.mjs 7          # a specific round number

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, Connection } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import {
  ConnectionMagicRouter,
  DELEGATION_PROGRAM_ID,
  MAGIC_CONTEXT_ID,
  MAGIC_PROGRAM_ID,
} from "@magicblock-labs/ephemeral-rollups-sdk";

const { AnchorProvider, Program, Wallet } = anchor;
const __dirname = dirname(fileURLToPath(import.meta.url));

// Same devnet-only assertion shape as scripts/admin-open-round.mjs — see that file's comment on why
// this is inlined in every script rather than imported from one place.
class MainnetBlocked extends Error {}
const SAFE_URL = [/\bapi\.devnet\.solana\.com\b/i, /\bdevnet\b/i, /\btestnet\b/i];
const MAINNET_URL = [/\bapi\.mainnet-beta\.solana\.com\b/i, /\bmainnet\b/i, /\bmainnet-beta\b/i];
// eslint-disable-next-line no-control-regex
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

const c = { r: "\x1b[31m", g: "\x1b[32m", y: "\x1b[33m", d: "\x1b[2m", b: "\x1b[1m", x: "\x1b[0m" };
const ok = (s) => console.log(`  ${c.g}✓${c.x} ${s}`);
const info = (s) => console.log(`  ${c.d}${s}${c.x}`);
const warn = (s) => console.log(`  ${c.y}!${c.x} ${s}`);
const heading = (s) => console.log(`\n${c.b}${s}${c.x}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PHASE_NAME = ["Lobby", "Drawing", "Fight", "Settled", "Abandoned"];
const PHASE_LOBBY = 0;
const PHASE_ABANDONED = 4;

function describeError(e) {
  if (e instanceof anchor.AnchorError) {
    return `${e.error.errorCode.code} (${e.error.errorCode.number}): ${e.error.errorMessage}`;
  }
  if (e?.logs) return `${e.message}\n${e.logs.slice(-12).map((l) => "      " + l).join("\n")}`;
  return e?.message || String(e);
}

const load = (p) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8"))));
const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };

async function blockhashForAccounts(router, accounts) {
  const res = await fetch(router.rpcEndpoint, {
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
async function sendTx(router, methodsBuilder, signer, label) {
  const tx = await methodsBuilder.transaction();
  tx.feePayer = signer.publicKey;
  const t0 = Date.now();
  const accountsForBlockhash = [tx.feePayer, ...new Set(
    tx.instructions.flatMap((ix) => ix.keys.filter((k) => k.isWritable).map((k) => k.pubkey)),
  )];
  const { blockhash, lastValidBlockHeight } = await blockhashForAccounts(router, accountsForBlockhash);
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.sign(signer);
  const sig = await router.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: "confirmed" });
  await router.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  ok(`${label}  ${c.d}${Date.now() - t0}ms  ${sig}${c.x}`);
  return sig;
}

(async () => {
  console.log(`${c.d}ADMIN-ABANDON-ROUND — end a lobby that expired without enough fighters, DEVNET${c.x}`);

  const idl = JSON.parse(readFileSync(join(__dirname, "..", "public", "idl", "bulls_arena.json"), "utf8"));
  const PROGRAM_ID = new PublicKey(idl.address);

  const router = new ConnectionMagicRouter(ROUTER_URL, "confirmed");
  const base = new Connection(BASE_RPC, "confirmed");

  const forkPayer = load(join(__dirname, "..", "..", ".devnet", "fork-payer.json"));
  const startBalance = await base.getBalance(forkPayer.publicKey);
  info(`fork-payer  ${forkPayer.publicKey.toBase58()}  ${(startBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);

  const opts = { commitment: "confirmed", preflightCommitment: "confirmed" };
  // The ROUTER program for reading the round: it routes per account, so a delegated round comes back
  // as the ER sees it. Reading this one from the base layer would show the state the round had when
  // it was delegated — for a lobby that is every field except the ones that decide this call.
  const program = new Program(idl, new AnchorProvider(router, new Wallet(forkPayer), opts));
  const programBase = new Program(idl, new AnchorProvider(base, new Wallet(forkPayer), opts));

  const [arenaPda] = PublicKey.findProgramAddressSync([Buffer.from("arena")], PROGRAM_ID);

  try {
    // ---- pick the round --------------------------------------------------------------------------
    heading("1. round");
    const arena = await programBase.account.arena.fetchNullable(arenaPda);
    if (!arena) throw new Error(`no arena at ${arenaPda.toBase58()} — nothing has been opened on this program id`);
    const requested = process.argv[2];
    const roundNo = requested ? BigInt(requested) : BigInt(arena.roundCounter.toString());
    if (roundNo < 1n || roundNo > BigInt(arena.roundCounter.toString())) {
      throw new Error(`round #${roundNo} was never opened (arena.round_counter = ${arena.roundCounter})`);
    }
    const [roundPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("round"), arenaPda.toBuffer(), u64le(roundNo)], PROGRAM_ID,
    );
    info(`round #${roundNo}  pda ${roundPda.toBase58()}`);

    // ---- refuse locally before asking the chain to refuse ----------------------------------------
    //
    // This is the same predicate the program applies (`lobby_is_dead` in lib.rs, mirrored as
    // `lobbyIsDead` in src/chain/constants.ts), evaluated here only so an operator who runs this on
    // the wrong round gets told WHICH condition failed. The chain is still the authority — it
    // re-checks all of it and answers `LobbyNotAbandonable` — but "still 34s of lobby left" is a
    // useful thing to be told and error code 6016 is not.
    heading("2. is this round actually dead?");
    const round = await program.account.round.fetch(roundPda);
    const phase = round.phase;
    const fighterCount = round.fighterCount;
    const closesAt = Number(round.lobbyClosesAt);
    const openedAt = Number(round.lobbyOpenedAt);
    const nowSec = Math.floor(Date.now() / 1000);

    console.log(`  phase           ${PHASE_NAME[phase] ?? `UNKNOWN(${phase})`}`);
    console.log(`  fighter_count   ${fighterCount}`);
    console.log(`  lobby window    ${closesAt - openedAt}s, closed at ${new Date(closesAt * 1000).toLocaleTimeString()}`);

    if (phase === PHASE_ABANDONED) {
      ok("already abandoned — nothing to do");
      process.exit(0);
    }
    if (phase !== PHASE_LOBBY) {
      throw new Error(
        `round #${roundNo} is in ${PHASE_NAME[phase] ?? phase}, not Lobby. abandon_round is only for a lobby that ` +
        `expired under-subscribed; a round that reached Drawing/Fight is settled with resolve() + close_round().`,
      );
    }
    if (fighterCount >= 2) {
      throw new Error(
        `round #${roundNo} has ${fighterCount} fighters — it can still hold a fight. Close it with ` +
        `close_lobby_and_draw() instead; abandoning would throw away a real round.`,
      );
    }
    // The local clock is not the enforcing clock (the program compares against the ER's), so this is
    // advisory: it stops the obvious mistake and says so rather than pretending to be authoritative.
    if (nowSec < closesAt) {
      throw new Error(
        `round #${roundNo}'s lobby has ${closesAt - nowSec}s left by this machine's clock — someone can still ` +
        `enter and turn it into a fight. Wait for the deadline.`,
      );
    }
    ok(`dead lobby: past its deadline with ${fighterCount} fighter${fighterCount === 1 ? "" : "s"} — it can never fight`);

    // DELEGATION IS A PRECONDITION THE PROGRAM DOES NOT STATE, and finding that out from the raw
    // failure is miserable. `abandon_round` ends with a commit_and_undelegate CPI into the Magic
    // program, which only means anything for an account the Delegation Program owns — so a round
    // whose `delegate_round` never landed (admin-open-round.mjs throws if the hand-off does not show
    // up within ten seconds, and a lobby can expire while nobody retries) fails inside that CPI with
    // an error that says nothing about delegation. Checking the owner first turns that into one line
    // naming the actual fix.
    const ownerInfo = await base.getAccountInfo(roundPda);
    if (!ownerInfo) throw new Error(`round PDA ${roundPda.toBase58()} holds no account on the base layer`);
    if (!ownerInfo.owner.equals(DELEGATION_PROGRAM_ID)) {
      throw new Error(
        `round #${roundNo} is owned by ${ownerInfo.owner.toBase58()}, not the Delegation Program — it is not ` +
        `delegated, so abandon_round's commit_and_undelegate has nothing to undelegate and will fail inside the ` +
        `CPI. Run delegate_round for this round first, then re-run this script.`,
      );
    }
    if (fighterCount === 1) {
      warn("one wallet entered and is recorded on the round as they entered. This program custodies");
      warn("nothing (see lib.rs's header), so there is nothing on-chain to refund — the off-chain");
      warn("ledger settles that entry to zero against the round it names.");
    }

    // ---- abandon ---------------------------------------------------------------------------------
    heading("3. abandon_round — flip to Abandoned, commit and undelegate, in one call");
    {
      const builder = program.methods
        .abandonRound()
        .accounts({
          payer: forkPayer.publicKey,
          round: roundPda,
          magicProgram: MAGIC_PROGRAM_ID,
          magicContext: MAGIC_CONTEXT_ID,
        });
      await sendTx(router, builder, forkPayer, `abandon_round #${roundNo}`);
    }

    // ---- verify it came home ---------------------------------------------------------------------
    //
    // The undelegate is a commit the ER settles asynchronously, so ownership reverting is the only
    // proof the terminal state actually reached the base layer. Same check and the same patience as
    // the canary's step 10 after close_round.
    heading("4. verifying the round came back to the base layer");
    let cameHome = false;
    for (let i = 0; i < 20; i++) {
      const acctInfo = await base.getAccountInfo(roundPda);
      if (acctInfo?.owner.equals(PROGRAM_ID)) { cameHome = true; break; }
      if (!acctInfo?.owner.equals(DELEGATION_PROGRAM_ID)) {
        throw new Error(`round owner is ${acctInfo?.owner.toBase58() ?? "MISSING"} — neither our program nor the Delegation Program`);
      }
      await sleep(3000);
    }
    if (!cameHome) throw new Error("round still owned by the Delegation Program after 60s — the undelegate commit did not finalize");

    const final = await programBase.account.round.fetch(roundPda);
    if (final.phase !== PHASE_ABANDONED) {
      throw new Error(`round came home in phase ${PHASE_NAME[final.phase] ?? final.phase}, expected Abandoned(4)`);
    }
    ok("owner reverted to our program, phase is Abandoned — the round is terminal and off the rollup");

    console.log(`\n${c.g}${c.b}ROUND #${roundNo} ABANDONED${c.x} — it expired with ${fighterCount} fighter${fighterCount === 1 ? "" : "s"} and will never fight.`);
    console.log(`  round pda: ${c.b}${roundPda.toBase58()}${c.x}`);
    console.log(`  ${c.d}open the next one with scripts/admin-open-round.mjs; the arena's counter already moved past this round.${c.x}`);
    process.exit(0);
  } catch (e) {
    console.error(`\n${c.r}${c.b}ADMIN-ABANDON-ROUND FAILED${c.x}`);
    console.error(`  ${c.r}${describeError(e)}${c.x}`);
    process.exitCode = 1;
  }
})();
