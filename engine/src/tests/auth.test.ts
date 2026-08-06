// Auth primitive invariants — the security logic that closed "the engine trusted any wallet id".
// challenge/verify/isAuthed use the socket only as a Map key, so a plain object stands in for a
// real ws. Deterministic (real ed25519 signatures), no network. This is the money-guard's core.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import { GUARDED, isAuthed, challenge, verify, forget } from "../auth.ts";

const fakeWs = () => ({}) as any;                        // only identity matters
const sign = (nonce: string, secret: Uint8Array) => Buffer.from(nacl.sign.detached(new TextEncoder().encode(nonce), secret)).toString("base64");

test("every money operation is in the GUARDED set", () => {
  for (const op of ["enter", "enterN", "withdraw", "withdrawSol", "convert",
                     "buildDeposit", "buildSolDeposit", "deposit", "depositSol", "setName", "fundMe"]) {
    assert.ok(GUARDED.has(op), `${op} must be guarded`);
  }
});

test("a valid signature over the challenge authenticates the wallet", () => {
  const ws = fakeWs(), kp = Keypair.generate(), wallet = kp.publicKey.toBase58();
  assert.equal(isAuthed(ws, wallet), false, "not authed before signing");
  const nonce = challenge(ws);
  const res = verify(ws, wallet, sign(nonce, kp.secretKey));
  assert.equal(res.ok, true);
  assert.equal(isAuthed(ws, wallet), true, "authed after a valid signature");
});

test("a signature from the WRONG key is rejected", () => {
  const ws = fakeWs(), kp = Keypair.generate(), wallet = kp.publicKey.toBase58();
  const nonce = challenge(ws);
  const res = verify(ws, wallet, sign(nonce, Keypair.generate().secretKey));   // someone else's key
  assert.equal(res.ok, false);
  assert.equal(isAuthed(ws, wallet), false);
});

test("verify without a prior challenge is refused", () => {
  const ws = fakeWs(), kp = Keypair.generate();
  const res = verify(ws, kp.publicKey.toBase58(), "AAAA");
  assert.equal(res.ok, false);
  assert.match(res.msg || "", /no challenge/);
});

test("the nonce is single-use — a replay after success does not re-auth a new socket", () => {
  const ws = fakeWs(), kp = Keypair.generate(), wallet = kp.publicKey.toBase58();
  const nonce = challenge(ws);
  const sig = sign(nonce, kp.secretKey);
  assert.equal(verify(ws, wallet, sig).ok, true);
  // same signature replayed on a DIFFERENT socket that never got a challenge → refused
  const ws2 = fakeWs();
  assert.equal(verify(ws2, wallet, sig).ok, false, "replay on a fresh socket must fail (no challenge)");
});

test("auth is per-socket and cleared on forget", () => {
  const ws = fakeWs(), kp = Keypair.generate(), wallet = kp.publicKey.toBase58();
  verify(ws, wallet, sign(challenge(ws), kp.secretKey));
  assert.equal(isAuthed(ws, wallet), true);
  assert.equal(isAuthed(fakeWs(), wallet), false, "a different socket is not authed for the same wallet");
  forget(ws);
  assert.equal(isAuthed(ws, wallet), false, "forget clears the socket's auth");
});

test("a garbage (non-base64 / wrong-length) signature is refused, not thrown", () => {
  const ws = fakeWs(), kp = Keypair.generate(), wallet = kp.publicKey.toBase58();
  challenge(ws);
  assert.doesNotThrow(() => {
    const res = verify(ws, wallet, "!!!not-base64!!!");
    assert.equal(res.ok, false);
  });
});
