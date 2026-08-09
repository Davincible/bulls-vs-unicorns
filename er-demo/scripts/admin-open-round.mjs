#!/usr/bin/env node
// ADMIN-OPEN-ROUND — the presenter's between-demos script. Runs init_arena (idempotent) -> open_round
// -> delegate_round using the fork-payer keypair as authority, then prints the round PDA a judge's
// browser session should point at. Per snug-floating-mitten.md assumption #2, round-lifecycle admin
// actions (open_round, close_lobby_and_draw, resolve, close_round) are driven by a script/panel, not
// polished player-facing UI — players only ever connect -> enter -> watch -> extract -> verify.
//
// Mirrors engine/scripts/er-client-canary.mjs's steps 1-3 exactly (that script already proved this
// exact sequence against real devnet) — trimmed to just those three steps, nothing past open_round's
// lobby being live and delegated.
//
//   cd er-demo && bun run scripts/admin-open-round.mjs

import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Connection } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import {
  ConnectionMagicRouter,
  delegateBufferPdaFromDelegatedAccountAndOwnerProgram,
  delegationRecordPdaFromDelegatedAccount,
  delegationMetadataPdaFromDelegatedAccount,
  DELEGATION_PROGRAM_ID,
} from "@magicblock-labs/ephemeral-rollups-sdk";

const { AnchorProvider, Program, Wallet, BN } = anchor;
const __dirname = dirname(fileURLToPath(import.meta.url));

// Same devnet-only assertion shape as scripts/fund-wallet.mjs — see that file's own comment on why
// this is inlined rather than imported.
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

// How long the lobby this script opens stays open, in seconds — `open_round`'s third argument, which
// the chain turns into `Round.lobby_closes_at` and then ENFORCES: `enter` refuses past it and
// `close_lobby_and_draw` refuses before it. So this is no longer a presenter's private intention, it
// is the entry window every player and every keeper is held to, which is why the summary below prints
// the deadline the chain came back with rather than echoing this number.
//
// 60 mirrors DEFAULT_LOBBY_SECONDS in src/chain/constants.ts — the same product choice, not a second
// opinion. Its reasoning, in short: the off-chain engine ran a 20-second online lobby ("shorter = less
// dead air"), and on-chain three things that did not exist there sit inside the same window — the ER
// delegation hand-off before anyone can enter at all (~2s, measured against real devnet; this script
// waits on exactly that hand-off in step 3 below), a session-key approval, and a router round-trip per
// entry. 60 leaves ~58 seconds of genuine entry window, roughly three times the proven 20, while
// keeping the whole round near two minutes.
//
// The chain clamps into [20, 3600], so an env override that is out of range opens a clamped lobby
// rather than failing — another reason to print what the round actually recorded.
const LOBBY_SECONDS = Number(process.env.LOBBY_SECONDS || 60);

const c = { r: "\x1b[31m", g: "\x1b[32m", y: "\x1b[33m", d: "\x1b[2m", b: "\x1b[1m", x: "\x1b[0m" };
const ok = (s) => console.log(`  ${c.g}✓${c.x} ${s}`);
const info = (s) => console.log(`  ${c.d}${s}${c.x}`);
const heading = (s) => console.log(`\n${c.b}${s}${c.x}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function describeError(e) {
  if (e instanceof anchor.AnchorError) {
    return `${e.error.errorCode.code} (${e.error.errorCode.number}): ${e.error.errorMessage}`;
  }
  if (e?.logs) return `${e.message}\n${e.logs.slice(-12).map((l) => "      " + l).join("\n")}`;
  return e?.message || String(e);
}

const load = (p) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8"))));
const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };

// Router-bypass send path — same logic as chain/sendTx.ts / er-client-canary.mjs. Only close_lobby_
// and_draw needs the direct-endpoint bypass (SDK SURPRISE #2 in chain/sendTx.ts's own comment); none
// of the three instructions this script runs do, so `endpoint` is never used here, but the shape is
// kept identical to every other script in this project for one less thing to think about.
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
  console.log(`${c.d}ADMIN-OPEN-ROUND — init_arena -> open_round -> delegate_round, DEVNET${c.x}`);

  const idl = JSON.parse(readFileSync(join(__dirname, "..", "public", "idl", "bulls_arena.json"), "utf8"));
  const PROGRAM_ID = new PublicKey(idl.address);

  const router = new ConnectionMagicRouter(ROUTER_URL, "confirmed");
  const base = new Connection(BASE_RPC, "confirmed");

  const forkPayer = load(join(__dirname, "..", "..", ".devnet", "fork-payer.json"));
  const startBalance = await base.getBalance(forkPayer.publicKey);
  info(`fork-payer  ${forkPayer.publicKey.toBase58()}  ${(startBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);

  const opts = { commitment: "confirmed", preflightCommitment: "confirmed" };
  const authority = new Program(idl, new AnchorProvider(router, new Wallet(forkPayer), opts));
  const authorityBase = new Program(idl, new AnchorProvider(base, new Wallet(forkPayer), opts));

  const [arenaPda] = PublicKey.findProgramAddressSync([Buffer.from("arena")], PROGRAM_ID);
  info(`arena pda ${arenaPda.toBase58()}`);

  try {
    // ---- init_arena (idempotent) --------------------------------------------------------------
    heading("1. init_arena");
    let arena = await authorityBase.account.arena.fetchNullable(arenaPda);
    if (!arena) {
      const builder = authority.methods
        .initArena(20, PublicKey.default, PublicKey.default)
        .accounts({ arena: arenaPda, authority: forkPayer.publicKey, systemProgram: SystemProgram.programId });
      await sendTx(router, builder, forkPayer, "init_arena");
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
    const seedCommit = randomBytes(32); // vestigial since ER-060, any 32 bytes satisfies the on-chain format
    {
      const builder = authority.methods
        .openRound(new BN(roundNo.toString()), Array.from(seedCommit), LOBBY_SECONDS)
        .accounts({ arena: arenaPda, round: roundPda, authority: forkPayer.publicKey, systemProgram: SystemProgram.programId });
      await sendTx(router, builder, forkPayer, `open_round #${roundNo}`);
    }
    // Read the deadline back off the account rather than computing it from LOBBY_SECONDS and the local
    // clock. Two reasons, both of which have bitten this repo before: the chain clamps the duration
    // into [20, 3600] so the stored window can differ from what was asked for, and the timestamp comes
    // from the base layer's `Clock`, not this machine's. Fetched on the BASE layer because that is
    // where open_round ran and the round is not delegated yet — after step 3 the account is owned by
    // the Delegation Program and Anchor's decoder refuses it.
    const opened = await authorityBase.account.round.fetch(roundPda);
    const lobbyOpenedAt = Number(opened.lobbyOpenedAt);
    const lobbyClosesAt = Number(opened.lobbyClosesAt);
    const lobbyWindowSeconds = lobbyClosesAt - lobbyOpenedAt;
    ok(`lobby window ${lobbyWindowSeconds}s${lobbyWindowSeconds === LOBBY_SECONDS ? "" : ` ${c.y}(clamped from the requested ${LOBBY_SECONDS}s)${c.x}`}`);

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
      await sendTx(router, builder, forkPayer, "delegate_round");
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
      ok(`round owner is now the Delegation Program — ER-delegated and ready for players`);
    }

    // The remaining window, not the configured one: the delegation hand-off above runs INSIDE the
    // countdown (the clock started when open_round landed, several seconds ago), so the number a
    // presenter needs is how long players actually have from this moment — which is also the number
    // that shrinks if the hand-off was slow. Recomputed here rather than reused from above for that
    // reason. Negative would mean the hand-off outlasted the whole lobby; say so plainly instead of
    // printing a cheerful "-3s left".
    const secondsLeft = lobbyClosesAt - Math.floor(Date.now() / 1000);
    const deadlineLocal = new Date(lobbyClosesAt * 1000).toLocaleTimeString();

    console.log(`\n${c.g}${c.b}LOBBY OPEN${c.x} — round #${roundNo} is delegated and accepting enter().`);
    console.log(`  round pda: ${c.b}${roundPda.toBase58()}${c.x}`);
    console.log(`  entries close: ${c.b}${deadlineLocal}${c.x} ${c.d}(unix ${lobbyClosesAt}, a ${lobbyWindowSeconds}s window)${c.x}`);
    if (secondsLeft > 0) {
      console.log(`  players have ${c.b}${secondsLeft}s${c.x} left to enter; close_lobby_and_draw is refused until then`);
      console.log(`  ${c.d}(unless the round fills to 16 fighters, which may be drawn immediately)${c.x}`);
    } else {
      console.log(`  ${c.y}the lobby is ALREADY CLOSED — the delegation hand-off outlasted the ${lobbyWindowSeconds}s window.${c.x}`);
      console.log(`  ${c.y}Nobody can enter this round; it can only be abandon_round()ed. Re-run with a larger LOBBY_SECONDS.${c.x}`);
    }
    console.log(`  point the demo UI's roundPda at this address.`);
    process.exit(0);
  } catch (e) {
    console.error(`\n${c.r}${c.b}ADMIN-OPEN-ROUND FAILED${c.x}`);
    console.error(`  ${c.r}${describeError(e)}${c.x}`);
    process.exitCode = 1;
  }
})();
