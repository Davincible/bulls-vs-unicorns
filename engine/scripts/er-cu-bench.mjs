#!/usr/bin/env node
// ER-030 — measure what a whole fight actually COSTS, on devnet.
//
// The design decision this settles: can one transaction resolve an entire match? That depends on
// compute units per simulation step, and I had only estimated it (~250 CU from "one sha256 plus a
// few ops"). Estimating compute is how you end up with a program that works at 500 steps and dies
// at 2,000 in front of players.
//
// Method: open a real round, put fighters in it, then SIMULATE `resolve` at increasing step counts
// and read `unitsConsumed` back. Simulation returns real CU without spending anything or mutating
// state, so this can sweep freely.

import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  ComputeBudgetProgram, sendAndConfirmTransaction,
} from "@solana/web3.js";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

const DEVNET = "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey(process.env.ER_PROGRAM_ID || "GNDbhEBwFFS1B4Zff51xEhiJ2ftLeiJmYQH6pkLKMS2L");
const MAGIC_PROGRAM = new PublicKey("Magic11111111111111111111111111111111111111");
const MAGIC_CONTEXT = new PublicKey("MagicContext1111111111111111111111111111111");
const CU_CEILING = 1_400_000;

const c = { g: "\x1b[32m", y: "\x1b[33m", r: "\x1b[31m", d: "\x1b[2m", x: "\x1b[0m" };
const ixDisc = (n) => createHash("sha256").update(`global:${n}`).digest().subarray(0, 8);
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const load = (p) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8"))));

(async () => {
  const conn = new Connection(DEVNET, "confirmed");
  const payer = load(process.env.FORK_KEYPAIR || ".devnet/fork-payer.json");
  console.log(`${c.d}ER-030 compute benchmark — devnet, program ${PROGRAM_ID.toBase58().slice(0, 8)}…${c.x}\n`);

  const [arenaPda] = PublicKey.findProgramAddressSync([Buffer.from("arena")], PROGRAM_ID);
  let arena = await conn.getAccountInfo(arenaPda);
  if (!arena) {
    await sendAndConfirmTransaction(conn, new Transaction().add(new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: arenaPda, isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([ixDisc("init_arena"), u16(20), PublicKey.default.toBuffer(), PublicKey.default.toBuffer()]),
    })), [payer], { commitment: "confirmed" });
    arena = await conn.getAccountInfo(arenaPda);
    console.log("  arena initialised");
  }

  const roundNo = arena.data.readBigUInt64LE(104) + 1n;
  const [roundPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("round"), arenaPda.toBuffer(), u64(roundNo)], PROGRAM_ID);

  const seed = randomBytes(32);
  await sendAndConfirmTransaction(conn, new Transaction().add(new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: arenaPda, isSigner: false, isWritable: true },
      { pubkey: roundPda, isSigner: false, isWritable: true },
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([ixDisc("open_round"), u64(roundNo), createHash("sha256").update(seed).digest()]),
  })), [payer], { commitment: "confirmed" });
  console.log(`  round #${roundNo} open on the base layer (undelegated — we only need to SIMULATE)`);

  // Two fighters is enough to exercise the damage path; more fighters change the modulo, not the
  // per-step cost, because every step touches exactly two of them regardless of how many exist.
  for (const side of [0, 1]) {
    await sendAndConfirmTransaction(conn, new Transaction().add(new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: arenaPda, isSigner: false, isWritable: false },
        { pubkey: roundPda, isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: true, isWritable: false },
      ],
      data: Buffer.concat([ixDisc("enter"), Buffer.from([side]), u64(1_000_000_000)]),
    })), [payer], { commitment: "confirmed" });
  }
  console.log(`  2 fighters entered\n`);

  console.log(`  ${"steps".padStart(7)} ${"CU".padStart(11)} ${"CU/step".padStart(9)}   verdict`);
  console.log(`  ${"-".repeat(48)}`);

  // bench_fight writes nothing, so it runs regardless of round phase — this measures the FIGHT,
  // not the guard in front of it.
  const results = [];
  for (const steps of [100, 250, 500, 1000, 2000, 4000, 8000]) {
    const tx = new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: CU_CEILING }))
      .add(new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [{ pubkey: payer.publicKey, isSigner: true, isWritable: false }],
        data: Buffer.concat([ixDisc("bench_fight"), u32(steps), Buffer.from([16])]),
      }));
    tx.feePayer = payer.publicKey;
    tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
    const sim = await conn.simulateTransaction(tx);
    const cu = sim.value.unitsConsumed ?? 0;
    const err = sim.value.err ? JSON.stringify(sim.value.err).slice(0, 34) : null;
    results.push({ steps, cu, err });
    console.log(`  ${String(steps).padStart(7)} ${String(cu).padStart(11)} ${
      (cu / steps).toFixed(1).padStart(9)}   ${
      err ? `${c.r}${err}${c.x}` : cu < CU_CEILING ? `${c.g}fits${c.x}` : `${c.r}OVER${c.x}`}`);
  }

  const ok = results.filter(r => !r.err && r.cu > 0);
  if (ok.length >= 2) {
    const a = ok[0], b = ok[ok.length - 1];
    const per = (b.cu - a.cu) / (b.steps - a.steps);
    const overhead = a.cu - per * a.steps;
    console.log(`
  marginal cost   ${per.toFixed(1)} CU per step`);
    console.log(`  fixed overhead  ${Math.round(overhead).toLocaleString()} CU`);
    const maxSteps = Math.floor((CU_CEILING - overhead - 30000) / per);
    console.log(`  ${c.g}one 1.4M CU transaction fits ~${maxSteps.toLocaleString()} steps${c.x}`);
    console.log(`  ${c.d}(30k CU reserved for the commit CPI and Anchor's own frame)${c.x}`);
  }
})();
