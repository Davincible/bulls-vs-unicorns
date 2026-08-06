// Closed-beta gate invariants. On a live chain only whitelisted wallets may play; on a test
// chain the gate is open. `enforced` is computed from env at import time, so each case does a
// FRESH import (unique query string) after setting the relevant env.
import { test } from "node:test";
import assert from "node:assert/strict";

async function freshAllowlist(env: Record<string, string | undefined>) {
  for (const k of ["ALLOWLIST_OFF", "ALLOWLIST_ENFORCE", "WHITELIST"]) delete process.env[k];
  for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;
  return import("../allowlist.ts?t=" + Date.now() + Math.random());
}

test("test chain: gate is open — every wallet allowed", async () => {
  const a = await freshAllowlist({ ALLOWLIST_OFF: "1" });
  assert.equal(a.enforced, false);
  assert.equal(a.isAllowed("anyRandomWalletPubkey"), true);
});

test("live chain, empty whitelist: nobody gets in", async () => {
  const a = await freshAllowlist({ ALLOWLIST_ENFORCE: "1" });
  assert.equal(a.enforced, true);
  assert.equal(a.isAllowed("someWallet"), false);
});

test("live chain, whitelist set: only listed wallets get in", async () => {
  const a = await freshAllowlist({ ALLOWLIST_ENFORCE: "1", WHITELIST: "WALLET_A, WALLET_B" });
  assert.equal(a.isAllowed("WALLET_A"), true);
  assert.equal(a.isAllowed("WALLET_B"), true);
  assert.equal(a.isAllowed("WALLET_C"), false);
});
