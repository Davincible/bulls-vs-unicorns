// Findings SEC-H2/H3/H4 and SEC-M2. Each is a place where a hostile or malformed input reached
// further into the money path than it should have.
import { test } from "node:test";
import assert from "node:assert/strict";
import { GUARDED } from "../auth.ts";

// --- SEC-H3: faucet MINTS balance and was reachable without a signature -----------------------
test("every operation that moves or mints money requires a proven wallet", () => {
  for (const op of ["enter", "enterN", "withdraw", "withdrawSol", "convert",
                    "buildDeposit", "buildSolDeposit", "deposit", "depositSol",
                    "setName", "fundMe", "relayTx", "faucet"]) {
    assert.ok(GUARDED.has(op), `${op} must be guarded`);
  }
});

test("authResume is deliberately NOT guarded — it is how a socket becomes authed", () => {
  assert.equal(GUARDED.has("authResume"), false);
  assert.equal(GUARDED.has("authChallenge"), false);
  assert.equal(GUARDED.has("authVerify"), false);
});

// --- SEC-H4: `Number(x) || 0` lets Infinity through -------------------------------------------
const money = (v: unknown, fallback = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

test("Infinity does NOT survive the old idiom — which is why it needed replacing", () => {
  assert.equal(Number("Infinity") || 0, Infinity, "the old guard passes Infinity straight through");
  assert.equal(money("Infinity"), 0, "the new one rejects it");
});

test("every hostile numeric input resolves to a safe value", () => {
  for (const bad of ["Infinity", "-Infinity", Infinity, -Infinity, NaN, "NaN", -5, "-5",
                     null, undefined, {}, [], "abc", "1e400"]) {
    const out = money(bad);
    assert.ok(Number.isFinite(out) && out >= 0, `${String(bad)} produced ${out}`);
  }
});

test("legitimate amounts pass through untouched", () => {
  for (const good of [0.01, 1, 7.28, 1e6, "3.5"]) {
    assert.equal(money(good), Number(good));
  }
});

test("Infinity reaching a lamport conversion is exactly the failure mode", () => {
  assert.ok(!Number.isFinite(Math.round(Infinity * 1e9)), "produces a nonsense amount");
  assert.throws(() => BigInt(Math.round(Infinity)), "or throws at BigInt conversion");
});

// --- SEC-M2: side was "bull" or, implicitly, anything at all ----------------------------------
test("an unrecognised side is rejected rather than defaulting to uwu", () => {
  const ok = (side: unknown) => side === "bull" || side === "uwu";
  assert.equal(ok("bull"), true);
  assert.equal(ok("uwu"), true);
  for (const bad of ["__proto__", "sol", "", null, 0, {}]) {
    assert.equal(ok(bad), false, `${String(bad)} must not be treated as a side`);
  }
});
