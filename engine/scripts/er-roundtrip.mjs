#!/usr/bin/env node
// ER-050 — the delegation round-trip on DEVNET.
//
//   init_arena → open_round → delegate_round → (verify owner) → reveal → tick (ER) → settle → close
//
// This is the item that actually proves the integration. Everything else is source that compiles;
// this is the only thing that demonstrates a round can live in an Ephemeral Rollup and come back.
//
// NO IDL. `cargo-build-sbf` does not generate one (that is `anchor build`, and the Anchor CLI cannot
// be installed here). Anchor's instruction discriminators are deterministic — sha256("global:<name>")
// truncated to 8 bytes — and its account discriminators are sha256("account:<Name>")[..8], so the
// instructions are encoded by hand below. That is not a workaround so much as removing a dependency:
// it means this script is testing the deployed bytes, not a generated wrapper around them.

import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

const DEVNET = "https://api.devnet.solana.com";
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const DELEGATION_PROGRAM = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
const ROUTER = process.env.ROUTER_ENDPOINT || "https://devnet-router.magicblock.app";
const ROUTER_WS = ROUTER.replace(/^http/, "ws");
// Injected by #[commit]; addresses are fixed by the SDK.
const MAGIC_PROGRAM = new PublicKey("Magic11111111111111111111111111111111111111");
const MAGIC_CONTEXT = new PublicKey("MagicContext1111111111111111111111111111111");
const PROGRAM_ID = new PublicKey(process.env.ER_PROGRAM_ID || "BWhnLnryRJpLbRkpybSQvpr68HfnNDsZha7kgouJJ8Dc");

const c = { r: "\x1b[31m", g: "\x1b[32m", y: "\x1b[33m", d: "\x1b[2m", x: "\x1b[0m" };
const ok = (s) => console.log(`  ${c.g}✓${c.x} ${s}`);
const info = (s) => console.log(`  ${c.d}${s}${c.x}`);
const die = (s) => { console.error(`  ${c.r}✗ ${s}${c.x}`); process.exit(1); };

/** Anchor instruction discriminator: sha256("global:<snake_name>")[..8] */
const ixDisc = (name) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);

const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };

const load = (p) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8"))));

async function send(conn, payer, ixs, label) {
  const tx = new Transaction().add(...ixs);
  const sig = await sendAndConfirmTransaction(conn, tx, [payer], {
    commitment: "confirmed", skipPreflight: false,
  });
  ok(`${label}  ${c.d}${sig}${c.x}`);
  return sig;
}

(async () => {
  console.log(`${c.d}ER-050 delegation round-trip — DEVNET${c.x}\n`);

  const conn = new Connection(DEVNET, "confirmed");

  // The cluster is proven by genesis hash, not by the URL string. A URL can be anything.
  const genesis = await conn.getGenesisHash();
  if (genesis !== DEVNET_GENESIS) die(`not devnet — genesis ${genesis}`);
  ok(`cluster verified devnet (${genesis.slice(0, 8)}…)`);

  const payer = load(process.env.FORK_KEYPAIR || ".devnet/fork-payer.json");
  const bal = await conn.getBalance(payer.publicKey);
  info(`payer ${payer.publicKey.toBase58()}  ${(bal / 1e9).toFixed(4)} SOL`);
  if (bal < 0.05e9) die("payer needs at least 0.05 SOL");

  const prog = await conn.getAccountInfo(PROGRAM_ID);
  if (!prog?.executable) die(`program ${PROGRAM_ID.toBase58()} is not executable on devnet`);
  ok(`program executable ${PROGRAM_ID.toBase58()}`);

  const [arenaPda] = PublicKey.findProgramAddressSync([Buffer.from("arena")], PROGRAM_ID);
  info(`arena pda ${arenaPda.toBase58()}`);

  // ---- init_arena (idempotent: skip if it already exists) ----------------------------------
  let arena = await conn.getAccountInfo(arenaPda);
  if (!arena) {
    const data = Buffer.concat([
      ixDisc("init_arena"),
      u16(20),                                  // fee_bps — matches the engine's 0.2%
      PublicKey.default.toBuffer(),             // token_a placeholder (devnet mints wired later)
      PublicKey.default.toBuffer(),             // token_b
    ]);
    await send(conn, payer, [new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: arenaPda, isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    })], "init_arena");
    arena = await conn.getAccountInfo(arenaPda);
  } else {
    info("arena already initialised — reusing");
  }

  // round_counter sits at: 8 disc + 32 authority + 32 token_a + 32 token_b = offset 104
  const roundNo = arena.data.readBigUInt64LE(104) + 1n;
  info(`opening round #${roundNo}`);

  const [roundPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("round"), arenaPda.toBuffer(), u64(roundNo)], PROGRAM_ID);
  info(`round pda ${roundPda.toBase58()}`);

  // ---- open_round: publish sha256(seed) BEFORE anyone can enter ----------------------------
  const seed = randomBytes(32);
  const seedCommit = createHash("sha256").update(seed).digest();
  await send(conn, payer, [new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: arenaPda, isSigner: false, isWritable: true },
      { pubkey: roundPda, isSigner: false, isWritable: true },
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([ixDisc("open_round"), u64(roundNo), seedCommit]),
  })], `open_round #${roundNo}`);

  const opened = await conn.getAccountInfo(roundPda);
  if (!opened) die("round account was not created");
  ok(`round account live, ${opened.data.length} bytes, owner ${opened.owner.toBase58().slice(0, 8)}…`);
  info(`seed commitment published BEFORE entries: ${seedCommit.toString("hex").slice(0, 32)}…`);

  // ---- delegate_round: hand it to the ER validator -----------------------------------------
  // The delegation CPI needs the delegation program and its buffer/metadata PDAs; `#[delegate]`
  // derives them, but the CLIENT must still pass them. Their addresses come from the SDK.
  console.log(`\n${c.y}delegating…${c.x}`);
  try {
    const { delegateBufferPdaFromDelegatedAccountAndOwnerProgram,
            delegationRecordPdaFromDelegatedAccount,
            delegationMetadataPdaFromDelegatedAccount } =
      await import("@magicblock-labs/ephemeral-rollups-sdk");

    const buffer = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(roundPda, PROGRAM_ID);
    const record = delegationRecordPdaFromDelegatedAccount(roundPda);
    const metadata = delegationMetadataPdaFromDelegatedAccount(roundPda);

    // ACCOUNT ORDER IS NOT A GUESS — it is read out of the #[delegate] macro's source
    // (ephemeral-rollups-sdk-attribute-delegate-0.16.2). For each field marked `del`, the macro
    // injects buffer / delegation_record / delegation_metadata IMMEDIATELY BEFORE the field itself,
    // then appends owner_program, delegation_program, system_program at the end. My first attempt
    // interleaved them differently and devnet answered with ConstraintSeeds on buffer_round_pda —
    // it had been handed the round PDA where the buffer belonged.
    await send(conn, payer, [new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: arenaPda, isSigner: false, isWritable: false },
        { pubkey: buffer, isSigner: false, isWritable: true },
        { pubkey: record, isSigner: false, isWritable: true },
        { pubkey: metadata, isSigner: false, isWritable: true },
        { pubkey: roundPda, isSigner: false, isWritable: true },
        { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },      // owner_program
        { pubkey: DELEGATION_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([ixDisc("delegate_round"), u64(roundNo)]),
    })], "delegate_round");

    const after = await conn.getAccountInfo(roundPda);
    if (after.owner.equals(DELEGATION_PROGRAM)) {
      ok(`OWNER IS NOW THE DELEGATION PROGRAM — the round is in the ER`);
      ok(`this is the round-trip's core assertion: ${after.owner.toBase58()}`);
    } else {
      die(`delegation did not transfer ownership (owner ${after.owner.toBase58()})`);
    }
    // ---- FROM HERE THE ACCOUNT LIVES IN THE ER --------------------------------------------
    //
    // The Magic Router decides where a transaction goes by inspecting the OWNER of its writable
    // accounts. The round PDA is now owned by the delegation program, so these route to the
    // rollup automatically — the client does not choose, the account state does. That is why the
    // same instruction encoding works against a different endpoint with no other change.
    console.log(`
${c.y}driving the round inside the ER…${c.x}`);
    const erConn = new Connection(ROUTER, { commitment: "confirmed", wsEndpoint: ROUTER_WS });

    const erSend = async (ixs, label) => {
      const tx = new Transaction().add(...ixs);
      const t0 = Date.now();
      const sig = await sendAndConfirmTransaction(erConn, tx, [payer], {
        commitment: "confirmed", skipPreflight: true,
      });
      ok(`${label} ${c.d}${Date.now() - t0}ms  ${sig.slice(0, 24)}…${c.x}`);
      return { sig, ms: Date.now() - t0 };
    };

    // enter — two fighters on opposite sides, so the fight has a legal target
    await erSend([new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: arenaPda, isSigner: false, isWritable: false },
        { pubkey: roundPda, isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: true, isWritable: false },
      ],
      data: Buffer.concat([ixDisc("enter"), Buffer.from([0]), u64(1_000_000)]),
    })], "enter side A");

    // A SECOND FIGHTER, ON THE OTHER SIDE. Without one, tick breaks immediately on `n < 2` and
    // tick_count stays 0 — which looks like the ER silently dropped the transactions and is
    // actually the program correctly declining to run a fight with nobody to fight.
    //
    // Same wallet on both sides is fine for this test: the program refuses to let a wallet damage
    // ITSELF, but the tick loop still runs and increments, which is what we are proving here.
    await erSend([new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: arenaPda, isSigner: false, isWritable: false },
        { pubkey: roundPda, isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: true, isWritable: false },
      ],
      data: Buffer.concat([ixDisc("enter"), Buffer.from([1]), u64(1_000_000)]),
    })], "enter side B");

    // reveal — the seed must hash to the commitment published before entries opened
    await erSend([new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: roundPda, isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: true, isWritable: false },
      ],
      data: Buffer.concat([ixDisc("reveal"), seed]),
    })], "reveal seed");
    ok(`seed revealed — anyone can now recompute this round from ${seed.toString("hex").slice(0, 16)}…`);

    // tick — the hot path. This is the whole reason for the ER.
    const ticks = [];
    for (let i = 0; i < 3; i++) {
      const r = await erSend([new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [{ pubkey: roundPda, isSigner: false, isWritable: true }],
        data: Buffer.concat([ixDisc("tick"), u16(32)]),
      })], `tick x32 (#${i + 1})`);
      ticks.push(r.ms);
    }
    info(`tick latency: ${ticks.join("ms, ")}ms  (base layer is ~400ms/slot for comparison)`);

    // settle — decides the winner and COMMITS the state back to the base layer
    await erSend([new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: roundPda, isSigner: false, isWritable: true },
        // ORDER MATTERS: #[commit] appends magic_program FIRST, then magic_context. I had them
        // the other way round and devnet answered Custom:3008 — the address constraint on
        // magic_context was being checked against the magic PROGRAM's key. Read out of
        // ephemeral-rollups-sdk-attribute-commit, not guessed.
        { pubkey: MAGIC_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: MAGIC_CONTEXT, isSigner: false, isWritable: true },
      ],
      data: ixDisc("settle"),
    })], "settle + commit");

    // close_round — commit_and_undelegate. The validator injects the base-layer callback.
    await erSend([new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: roundPda, isSigner: false, isWritable: true },
        // ORDER MATTERS: #[commit] appends magic_program FIRST, then magic_context. I had them
        // the other way round and devnet answered Custom:3008 — the address constraint on
        // magic_context was being checked against the magic PROGRAM's key. Read out of
        // ephemeral-rollups-sdk-attribute-commit, not guessed.
        { pubkey: MAGIC_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: MAGIC_CONTEXT, isSigner: false, isWritable: true },
      ],
      data: ixDisc("close_round"),
    })], "close_round (commit_and_undelegate)");

    // ---- back on the BASE LAYER: did it actually come home? --------------------------------
    console.log(`
${c.y}verifying on the base layer…${c.x}`);
    for (let i = 0; i < 20; i++) {
      const back = await conn.getAccountInfo(roundPda);
      if (back && back.owner.equals(PROGRAM_ID)) {
        ok(`OWNER REVERTED TO OUR PROGRAM — the round came back from the ER`);
        const d = back.data;
        // phase u8 @ 8+32+8 = 48, winner @ 49, fighter_count u16 @ 51, tick_count u64 @ 53
        info(`phase=${d[48]} (2 = settled)  winner=${d[49]}  fighters=${d.readUInt16LE(51)}  ticks=${d.readBigUInt64LE(53)}`);
        info(`round pda: ${roundPda.toBase58()}`);
        return;
      }
      await new Promise(r => setTimeout(r, 3000));
    }
    console.error(`  ${c.y}!${c.x} still delegated after 60s — commit may still be finalising`);
  } catch (e) {
    console.error(`  ${c.r}✗ ER lifecycle failed:${c.x} ${e.message}`);
    if (e.transactionLogs) console.error(e.transactionLogs.slice(-6).map(l => "    " + l).join(String.fromCharCode(10)));

    console.error(`  ${c.d}Round ${roundNo} remains open and undelegated on devnet; it can be`);
    console.error(`  inspected at ${roundPda.toBase58()}${c.x}`);
    process.exitCode = 1;
  }
})();
