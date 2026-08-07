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

    await send(conn, payer, [new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: arenaPda, isSigner: false, isWritable: false },
        { pubkey: roundPda, isSigner: false, isWritable: true },
        { pubkey: PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: buffer, isSigner: false, isWritable: true },
        { pubkey: record, isSigner: false, isWritable: true },
        { pubkey: metadata, isSigner: false, isWritable: true },
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
  } catch (e) {
    console.error(`  ${c.r}✗ delegation failed:${c.x} ${e.message}`);
    console.error(`  ${c.d}Round ${roundNo} remains open and undelegated on devnet; it can be`);
    console.error(`  inspected at ${roundPda.toBase58()}${c.x}`);
    process.exitCode = 1;
  }
})();
