// A deposit is credited to the ledger on the strength of a signature having been verified once.
// The verifiers did that with a check-then-act straddling an await:
//
//     if (seenSigs.has(sig)) return 0;      // check
//     ... await getParsedTransaction(sig)   // yields
//     seenSigs.add(sig);                    // act
//
// Two concurrent calls for the same signature both cleared the check before either recorded it, so
// one on-chain deposit was credited twice. This models that exact shape rather than mocking the
// RPC, because the defect is in the ordering, not in the chain read.
import { test } from "node:test";
import assert from "node:assert/strict";

const tick = () => new Promise(r => setImmediate(r));

/** The OLD shape: record only after the await. */
function makeUnsafe() {
  const seen = new Set<string>();
  return async function verify(sig: string): Promise<number> {
    if (seen.has(sig)) return 0;
    await tick();                 // stands in for the RPC round trip
    seen.add(sig);
    return 5;                     // a positive delta = "credit this"
  };
}

/** The NEW shape: reserve before the await, release in a finally. */
function makeSafe() {
  const seen = new Set<string>(), inFlight = new Set<string>();
  const claim = (s: string) => (seen.has(s) || inFlight.has(s)) ? false : (inFlight.add(s), true);
  return async function verify(sig: string, ok = true): Promise<number> {
    if (!claim(sig)) return 0;
    try {
      await tick();
      if (!ok) return 0;          // e.g. RPC failed or tx not found
      seen.add(sig);
      return 5;
    } finally { inFlight.delete(sig); }
  };
}

test("the old shape credits one deposit twice under concurrency", async () => {
  const verify = makeUnsafe();
  const [a, b] = await Promise.all([verify("SIG"), verify("SIG")]);
  assert.equal(a + b, 10, "both calls returned a credit — this is the bug being fixed");
});

test("reserving before the await credits it exactly once", async () => {
  const verify = makeSafe();
  const [a, b] = await Promise.all([verify("SIG"), verify("SIG")]);
  assert.equal(a + b, 5, "exactly one of the two concurrent calls may credit");
  assert.ok((a === 5 && b === 0) || (a === 0 && b === 5));
});

test("ten simultaneous replays still credit exactly once", async () => {
  const verify = makeSafe();
  const out = await Promise.all(Array.from({ length: 10 }, () => verify("SIG")));
  assert.equal(out.reduce((x, y) => x + y, 0), 5);
});

test("a failed verification releases the reservation so a retry can still be credited", async () => {
  const verify = makeSafe();
  assert.equal(await verify("SIG", false), 0, "failed read credits nothing");
  assert.equal(await verify("SIG", true), 5, "and must not lock the deposit out permanently");
});

test("a signature already credited is never credited again", async () => {
  const verify = makeSafe();
  assert.equal(await verify("SIG"), 5);
  assert.equal(await verify("SIG"), 0);
});
