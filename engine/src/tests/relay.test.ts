// relayTx broadcasts caller-supplied signed bytes through our PAID RPC. Crediting was always safe —
// the verify* path checks the vault really received the money — but broadcasting is a separate
// capability, and unconstrained it makes the engine an open relay: spam, MEV, arbitrage, all at our
// cost and under our endpoint's reputation. The allowlist limits WHO, not WHAT.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, Transaction, SystemProgram, PublicKey, ComputeBudgetProgram } from "@solana/web3.js";
import { inspectRelayTx, vaultPubkey } from "../chain-ops.ts";

const BLOCKHASH = "11111111111111111111111111111111";
const b64 = (tx: Transaction) => tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");

function tx(payer: Keypair, ixs: any[]) {
  const t = new Transaction().add(...ixs);
  t.feePayer = payer.publicKey;
  t.recentBlockhash = BLOCKHASH;
  return t;
}

test("a genuine SOL deposit into the vault is allowed", async () => {
  const me = Keypair.generate();
  const t = tx(me, [SystemProgram.transfer({
    fromPubkey: me.publicKey, toPubkey: new PublicKey(vaultPubkey()), lamports: 1_000_000 })]);
  assert.equal(await inspectRelayTx(b64(t), me.publicKey.toBase58()), null);
});

test("a transfer to somewhere OTHER than the vault is refused", async () => {
  const me = Keypair.generate(), stranger = Keypair.generate();
  const t = tx(me, [SystemProgram.transfer({
    fromPubkey: me.publicKey, toPubkey: stranger.publicKey, lamports: 1_000_000 })]);
  const why = await inspectRelayTx(b64(t), me.publicKey.toBase58());
  assert.match(String(why), /does not pay the vault/);
});

test("relaying someone ELSE'S transaction is refused", async () => {
  const me = Keypair.generate(), other = Keypair.generate();
  const t = tx(other, [SystemProgram.transfer({
    fromPubkey: other.publicKey, toPubkey: new PublicKey(vaultPubkey()), lamports: 1_000_000 })]);
  // authenticated as `me`, but the tx is paid by `other`
  const why = await inspectRelayTx(b64(t), me.publicKey.toBase58());
  assert.match(String(why), /fee payer is not the authenticated wallet/);
});

test("an unexpected program is refused — this is what blocks MEV and arbitrage", async () => {
  const me = Keypair.generate();
  const jupiter = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
  const t = tx(me, [{ programId: jupiter, keys: [{ pubkey: new PublicKey(vaultPubkey()), isSigner: false, isWritable: true }], data: Buffer.alloc(8) } as any]);
  const why = await inspectRelayTx(b64(t), me.publicKey.toBase58());
  assert.match(String(why), /unexpected program/);
});

test("a compute-budget instruction alongside a real deposit is still fine", async () => {
  const me = Keypair.generate();
  const t = tx(me, [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    SystemProgram.transfer({ fromPubkey: me.publicKey, toPubkey: new PublicKey(vaultPubkey()), lamports: 5_000 }),
  ]);
  assert.equal(await inspectRelayTx(b64(t), me.publicKey.toBase58()), null);
});

test("garbage and oversized payloads are refused rather than thrown at the RPC", async () => {
  const me = Keypair.generate().publicKey.toBase58();
  assert.match(String(await inspectRelayTx("", me)), /empty/);
  assert.ok(await inspectRelayTx("bm90LWEtdHJhbnNhY3Rpb24=", me), "garbage must be refused");
  assert.match(String(await inspectRelayTx(Buffer.alloc(2000).toString("base64"), me)), /too large/);
});
