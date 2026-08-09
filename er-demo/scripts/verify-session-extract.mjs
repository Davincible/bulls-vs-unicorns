#!/usr/bin/env bun
// THE LAST UNPROVEN CLAIM: a session-signed `extract()` LANDING in real Fight phase.
//
// verify-session-base.mjs proves all 8 authorization properties on the base layer (with log-line
// assertions, because base-layer RPC returns logs). verify-session-real.mjs proves session-signed
// `enter()` through a real ER validator. Neither lands an `extract()` in Fight, because reaching
// Fight needs the VRF oracle, which needs the ER — and until the v2 program id sidestepped the ER
// validators' stale bytecode cache (see lib.rs's declare_id! note), no route ran current code.
//
// Self-contained on purpose: it opens its own round and owns every keypair, rather than resuming one
// the other scripts left behind (they generate players/session keys in memory and never persist
// them, so their rounds cannot be picked up afterward).
//
//   bun scripts/verify-session-extract.mjs [erValidatorUrl]

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, ComputeBudgetProgram, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { ConnectionMagicRouter } from "@magicblock-labs/ephemeral-rollups-sdk";
import { GPLSESSION_PROGRAMS } from "@magicblock-labs/gum-sdk";
import gplSessionIdl from "../node_modules/@magicblock-labs/gum-sdk/lib/idl/gpl_session.json" with { type: "json" };

const { AnchorProvider, BN, Program, Wallet } = anchor;
const __dirname = dirname(fileURLToPath(import.meta.url));
const c = { g: "\x1b[32m", r: "\x1b[31m", d: "\x1b[2m", b: "\x1b[1m", x: "\x1b[0m" };
const ok = (s) => console.log(`  ${c.g}✓${c.x} ${s}`);
const info = (s) => console.log(`  ${c.d}${s}${c.x}`);
const head = (s) => console.log(`\n${c.b}${s}${c.x}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ER_URL = process.argv[2] || "https://devnet-eu.magicblock.app/";
const idl = JSON.parse(readFileSync(join(__dirname, "..", "public", "idl", "bulls_arena.json"), "utf8"));
const PROGRAM_ID = new PublicKey(idl.address);
const EPHEMERAL_QUEUE = new PublicKey("5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc");
const VRF_PROGRAM = new PublicKey("Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz");
const SLOT_HASHES = new PublicKey("SysvarS1otHashes111111111111111111111111111");
const MAGIC_PROGRAM = new PublicKey("Magic11111111111111111111111111111111111111");
const MAGIC_CONTEXT = new PublicKey("MagicContext1111111111111111111111111111111");
const DELEGATION_PROGRAM = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
const PHASE = ["Lobby", "Drawing", "Fight", "Settled", "Abandoned"];

// The lobby this script opens, in seconds. The FLOOR the program clamps to (MIN_LOBBY_SECONDS in
// lib.rs and in src/chain/constants.ts — a literal here only because this file is a standalone Node
// script that deliberately imports nothing from src/), not the 60 the demo opens rounds at:
// `close_lobby_and_draw` is refused until the deadline passes, and this round enters two fighters
// rather than filling to 16, so every second of lobby is a second this script sits waiting before it
// can reach the thing it actually verifies. 20 is the shortest wait the chain permits.
const LOBBY_SECONDS = 20;

/** Margin added to every deadline wait. The deadline is stamped from the BASE layer's clock in
 *  `open_round` and compared against the ER's clock in `close_lobby_and_draw` (see
 *  `lobby_opened_at`'s doc comment in lib.rs), so the two can disagree by a small skew. Waiting past
 *  the deadline by more than that skew costs a couple of seconds; waking a moment early costs a
 *  LobbyStillOpen failure and the whole run. */
const CLOCK_SKEW_MARGIN_MS = 2_000;
const opts = { commitment: "confirmed", preflightCommitment: "confirmed" };

const load = (p) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8"))));
const forkPayer = load(join(__dirname, "..", "..", ".devnet", "fork-payer.json"));
const base = new Connection("https://api.devnet.solana.com", "confirmed");
// Round-touching calls go through the MAGIC ROUTER, not straight at the validator: `signer` is a
// writable BASE-layer account (it pays the fee) while `round` is ER-delegated, and only the router
// reconciles a transaction spanning both. Sending direct gets "loads a writable account that cannot
// be written" — found by doing exactly that.
const er = new Connection(ER_URL, "confirmed");   // reads only
const router = new ConnectionMagicRouter("https://devnet-router.magicblock.app", "confirmed");
const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };

async function send(conn, ixs, signers, label) {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = signers[0].publicKey;
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.sign(...signers);
  const sig = await conn.sendRawTransaction(tx.serialize(), { preflightCommitment: "confirmed" });
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  ok(`${label}  ${c.d}${sig}${c.x}`);
  return sig;
}

/** Reads Round straight off whichever layer is asked — Anchor's own decoder expects the program to
 *  own the account, and a delegated account is owned by the Delegation Program. */
async function readRound(conn, roundPda) {
  const acc = await conn.getAccountInfo(roundPda);
  if (!acc) throw new Error(`round not found on ${conn.rpcEndpoint}`);
  const d = acc.data;
  let o = 8 + 32 + 8;
  const phase = d[o]; o += 3;
  const fighterCount = d.readUInt16LE(o); o += 2 + 8;
  const pot = d.readBigUInt64LE(o); o += 8;
  // `penalties_collected` sits here, between `pot` and `seed_commit` — the house's cumulative take
  // from extract penalties. A hand-rolled decoder is exactly the thing a new field breaks silently:
  // skip it without reading it and every fighter below is decoded 8 bytes early, which produces
  // plausible-looking nonsense rather than an error.
  const penaltiesCollected = d.readBigUInt64LE(o); o += 8 + 32 + 32;
  // ...and it happened again, exactly as predicted above: `lobby_opened_at` and `lobby_closes_at`
  // landed HERE, between `seed` and `fight_started_at`, and this decoder read every fighter 16 bytes
  // early until these two lines existed. Read rather than skipped, because `lobby_closes_at` is not
  // incidental to this script — step 4 waits on it.
  const lobbyOpenedAt = d.readBigInt64LE(o); o += 8;
  const lobbyClosesAt = d.readBigInt64LE(o); o += 8 + 8;   // + fight_started_at, still unused here
  const fighters = [];
  for (let i = 0; i < fighterCount; i++) {
    const b = o + i * 58;
    fighters.push({
      wallet: new PublicKey(d.subarray(b, b + 32)), side: d[b + 32], dead: d[b + 33],
      stake: d.readBigUInt64LE(b + 34), hp: d.readBigUInt64LE(b + 42), banked: d.readBigUInt64LE(b + 50),
    });
  }
  return { phase, fighterCount, pot, penaltiesCollected, lobbyOpenedAt, lobbyClosesAt, fighters };
}

/** Sleep until the round's own `lobby_closes_at` has passed, because `close_lobby_and_draw` refuses
 *  before it (`LobbyStillOpen`, 6015). The deadline is READ OFF THE FETCHED ACCOUNT rather than
 *  reconstructed as "LOBBY_SECONDS after we sent open_round": the chain clamps the duration and
 *  stamps the timestamp from its own clock, so the account is the only thing that knows the real
 *  deadline — and a script that hardcodes the number is the invented countdown that `lobby_closes_at`
 *  exists to delete. A full round is 16 fighters, which may be drawn immediately; this script enters
 *  two, so it always waits. */
async function waitForLobbyDeadline(round) {
  const deadlineMs = Number(round.lobbyClosesAt) * 1000 + CLOCK_SKEW_MARGIN_MS;
  const windowSeconds = Number(round.lobbyClosesAt - round.lobbyOpenedAt);
  let remainingMs = deadlineMs - Date.now();
  if (remainingMs <= 0) {
    info(`lobby deadline already passed (${windowSeconds}s window) — drawing immediately`);
    return;
  }
  info(`lobby closes at ${new Date(Number(round.lobbyClosesAt) * 1000).toLocaleTimeString()} ` +
    `(${windowSeconds}s window) — close_lobby_and_draw is refused until then`);
  // Ticked once a second so a human watching can see it counting rather than wondering if it hung.
  while (remainingMs > 0) {
    process.stdout.write(`  ${c.d}waiting out the lobby: ${Math.ceil(remainingMs / 1000)}s${c.x}\r`);
    await sleep(Math.min(1000, remainingMs));
    remainingMs = deadlineMs - Date.now();
  }
  process.stdout.write(`${" ".repeat(48)}\r`);
  ok(`lobby deadline passed — close_lobby_and_draw is now permitted`);
}

(async () => {
  console.log(`${c.d}SESSION-SIGNED extract() IN REAL FIGHT PHASE — the last unproven claim${c.x}`);
  info(`program ${PROGRAM_ID.toBase58()}`);
  info(`ER      ${ER_URL}`);
  const sigs = {};

  const authorityProg = new Program(idl, new AnchorProvider(base, new Wallet(forkPayer), opts));
  const [arenaPda] = PublicKey.findProgramAddressSync([Buffer.from("arena")], PROGRAM_ID);
  const arena = await authorityProg.account.arena.fetch(arenaPda);
  const roundNo = BigInt(arena.roundCounter.toString()) + 1n;
  const [roundPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("round"), arenaPda.toBuffer(), u64le(roundNo)], PROGRAM_ID);

  head(`1. open_round #${roundNo} + delegate`);
  sigs.openRound = await send(base, [await authorityProg.methods
    .openRound(new BN(roundNo.toString()), Array.from(randomBytes(32)), LOBBY_SECONDS)
    .accounts({ arena: arenaPda, round: roundPda, authority: forkPayer.publicKey, systemProgram: SystemProgram.programId })
    .instruction()], [forkPayer], `open_round #${roundNo}`);

  const seeds = (pfx, acc) => PublicKey.findProgramAddressSync([Buffer.from(pfx), acc.toBuffer()], DELEGATION_PROGRAM)[0];
  sigs.delegateRound = await send(base, [await authorityProg.methods
    .delegateRound(new BN(roundNo.toString()))
    .accounts({
      authority: forkPayer.publicKey, arena: arenaPda,
      bufferRoundPda: PublicKey.findProgramAddressSync([Buffer.from("buffer"), roundPda.toBuffer()], PROGRAM_ID)[0],
      delegationRecordRoundPda: seeds("delegation", roundPda),
      delegationMetadataRoundPda: seeds("delegation-metadata", roundPda),
      roundPda, ownerProgram: PROGRAM_ID, delegationProgram: DELEGATION_PROGRAM,
      systemProgram: SystemProgram.programId,
    })
    // No validator pin: the whole point of the v2 program id is that NO validator holds a stale
    // clone of it, so the router's own default choice is safe here — pinning is what you need when
    // an id already has poisoned caches (task #15), not when it's fresh.
    .instruction()], [forkPayer], "delegate_round");

  // ---- players + a real session for A -----------------------------------------------------------
  head("2. fund two players, and create ONE session for player A");
  const playerA = Keypair.generate(), playerB = Keypair.generate(), sessionKp = Keypair.generate();
  await send(base, [
    SystemProgram.transfer({ fromPubkey: forkPayer.publicKey, toPubkey: playerA.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL }),
    SystemProgram.transfer({ fromPubkey: forkPayer.publicKey, toPubkey: playerB.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL }),
  ], [forkPayer], "fund players A and B");

  const [sessionToken] = PublicKey.findProgramAddressSync(
    [Buffer.from("session_token"), PROGRAM_ID.toBuffer(), sessionKp.publicKey.toBuffer(), playerA.publicKey.toBuffer()],
    GPLSESSION_PROGRAMS.devnet);
  info(`player A       ${playerA.publicKey.toBase58()}`);
  info(`session signer ${sessionKp.publicKey.toBase58()}`);
  const gplSession = new Program(gplSessionIdl, new AnchorProvider(base, new Wallet(playerA), opts));
  sigs.createSession = await gplSession.methods
    .createSession(true, new BN(Math.ceil(Date.now() / 1000) + 3600), new BN(0.02 * LAMPORTS_PER_SOL))
    .accounts({
      sessionToken, sessionSigner: sessionKp.publicKey, authority: playerA.publicKey,
      targetProgram: PROGRAM_ID, systemProgram: SystemProgram.programId,
    }).signers([sessionKp]).rpc();
  ok(`create_session  ${c.d}${sigs.createSession}${c.x}  ${c.b}(player A's ONLY signature)${c.x}`);

  head("3. both fighters enter");
  const erProg = new Program(idl, new AnchorProvider(router, new Wallet(forkPayer), opts));
  sigs.enterA = await send(router, [await erProg.methods.enter(0, new BN(500_000))
    .accounts({ arena: arenaPda, round: roundPda, player: playerA.publicKey, sessionToken, signer: sessionKp.publicKey })
    .instruction()], [sessionKp], "enter A (SESSION-signed, side 0)");
  sigs.enterB = await send(router, [await erProg.methods.enter(1, new BN(400_000))
    .accounts({ arena: arenaPda, round: roundPda, player: playerB.publicKey, sessionToken: null, signer: playerB.publicKey })
    .instruction()], [playerB], "enter B (direct, side 1)");

  head("4. close_lobby_and_draw — real VRF request");
  // Known, already-documented (MEGA_QUEUE.md ER-040 finding #3): the GENERIC router refuses this one
  // instruction, because its writable set mixes the ER-delegated `round` with the VRF queue singleton
  // whose own delegation record names the System Program as authority — the router can't reconcile
  // those and rejects with "accounts delegated to different ER nodes". It must go straight to the
  // validator actually hosting this round. Reproduced here exactly as documented.
  const { fqdn } = await router.getDelegationStatus(roundPda);
  const roundValidator = new Connection(fqdn, "confirmed");
  info(`round's own validator: ${fqdn}`);

  // Both entries have landed, so the lobby holds everything it is going to. Read the round back from
  // the validator that hosts it — the same node whose clock will judge the deadline — and wait the
  // lobby out before asking it to draw.
  await waitForLobbyDeadline(await readRound(roundValidator, roundPda));

  const [programIdentity] = PublicKey.findProgramAddressSync([Buffer.from("identity")], PROGRAM_ID);
  sigs.closeLobby = await send(roundValidator, [await erProg.methods
    .closeLobbyAndDraw(Array.from(randomBytes(32)))
    .accounts({
      payer: forkPayer.publicKey, round: roundPda, oracleQueue: EPHEMERAL_QUEUE, programIdentity,
      vrfProgram: VRF_PROGRAM, slotHashes: SLOT_HASHES, systemProgram: SystemProgram.programId,
    }).instruction()], [forkPayer], "close_lobby_and_draw");

  head("5. waiting for the VRF oracle callback (Drawing -> Fight)");
  const t0 = Date.now(); let r;
  while (Date.now() - t0 < 120_000) {
    r = await readRound(roundValidator, roundPda);
    if (r.phase === 2) break;
    if (r.phase !== 1) throw new Error(`unexpected phase ${PHASE[r.phase]}`);
    await sleep(2000);
  }
  if (r.phase !== 2) throw new Error("VRF callback never landed within 120s");
  ok(`phase is FIGHT — real VRF callback landed (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  // ---- THE POINT OF THIS SCRIPT ----------------------------------------------------------------
  head("6. session-signed extract(), in real Fight phase");
  const roundBefore = await readRound(roundValidator, roundPda);
  const before = roundBefore.fighters.find((f) => f.wallet.equals(playerA.publicKey));
  info(`player A before: hp=${before.hp} banked=${before.banked} dead=${before.dead}`);
  sigs.extractSessionSigned = await send(router, [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    await erProg.methods.extract()
      .accounts({ round: roundPda, player: playerA.publicKey, sessionToken, signer: sessionKp.publicKey })
      .instruction(),
  ], [sessionKp], "extract (SESSION-KEY-SIGNED, Fight phase)");

  const roundAfter = await readRound(roundValidator, roundPda);
  const after = roundAfter.fighters.find((f) => f.wallet.equals(playerA.publicKey));
  info(`player A after:  hp=${after.hp} banked=${after.banked} dead=${after.dead}`);
  if (after.hp !== 0n) throw new Error(`hp should be 0, got ${after.hp}`);
  if (after.dead !== 1) throw new Error(`dead should be 1, got ${after.dead}`);

  // WHAT THIS SCRIPT IS ABOUT is the SIGNATURE, not the payout — the claim under test is that a
  // session key can land `extract()` in real Fight phase. So the assertion is the one that stays
  // true whatever the payout turns out to be.
  //
  // `after.banked === before.banked + before.hp` used to say that, and no longer can, for two
  // independent reasons: `extract()` catches the fight up to the current on-chain second before it
  // pays anyone, so `before.hp` read a moment earlier is already stale; and the payout is now split,
  // with a decaying penalty going to the house. Conservation is the invariant that survives both —
  // and it is the stronger statement anyway, because it covers the whole round rather than one
  // fighter.
  const held = (r) => r.fighters.reduce((n, f) => n + f.hp + f.banked, 0n);
  for (const [label, r] of [["before", roundBefore], ["after", roundAfter]]) {
    const total = held(r) + r.penaltiesCollected;
    if (total !== r.pot) {
      throw new Error(`value not conserved ${label} the extract: sum(hp+banked)=${held(r)} + penalties=${r.penaltiesCollected} vs pot=${r.pot}`);
    }
  }
  if (after.banked <= before.banked) throw new Error(`extract banked nothing: ${before.banked} -> ${after.banked}`);
  const penalty = roundAfter.penaltiesCollected - roundBefore.penaltiesCollected;
  ok(`hp left the ring, ${after.banked - before.banked} banked and ${penalty} to the house; conservation exact on both sides`);
  ok(`player A's wallet signed ONCE (create_session) — never this transaction`);

  console.log(`\n${c.g}${c.b}PASS${c.x} — session-signed extract() lands in real Fight phase, on a real ER validator.`);
  console.log(JSON.stringify(sigs, null, 2));
})().catch((e) => {
  console.error(`\n${c.r}${c.b}FAILED${c.x}\n  ${c.r}${e.message}${c.x}`);
  if (e.logs) console.error(e.logs.slice(-15).map((l) => "    " + l).join("\n"));
  process.exit(1);
});
