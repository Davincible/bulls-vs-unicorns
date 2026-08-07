// The mainnet kill switch for the ER fork. Every one of these is a way a fork "that only runs on
// devnet" has historically ended up touching mainnet anyway.
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertDevnetUrl, isDevnetUrl, assertForkIsDevnetOnly, refuseIfDisabled, MainnetBlocked }
  from "../devnet-guard.ts";

test("the obvious mainnet endpoints are refused", () => {
  for (const u of [
    "https://api.mainnet-beta.solana.com",
    "https://mainnet.helius-rpc.com/?api-key=abc",
    "https://some-proxy.example.com/solana/mainnet",
  ]) assert.throws(() => assertDevnetUrl(u), MainnetBlocked, `allowed ${u}`);
});

test("devnet and local endpoints pass", () => {
  for (const u of [
    "https://api.devnet.solana.com",
    "https://devnet.helius-rpc.com/?api-key=abc",
    "http://localhost:8899",
    "http://127.0.0.1:8899",
    "https://devnet.magicblock.app",
  ]) assert.ok(isDevnetUrl(u), `refused ${u}`);
});

// THE ONE THAT MATTERS. A denylist silently permits every endpoint nobody thought to ban — an
// unfamiliar proxy in front of mainnet looks like nothing on the list and sails through.
test("an unrecognised endpoint is REFUSED, not allowed — the guard fails closed", () => {
  for (const u of [
    "https://rpc.example.com",                       // could be either cluster
    "https://my-private-node.internal:8899",
    "https://xyz.helius-rpc.com/?api-key=abc",       // no cluster in the host
  ]) assert.throws(() => assertDevnetUrl(u), MainnetBlocked, `allowed unknown host ${u}`);
});

test("an empty URL is refused rather than defaulted", () => {
  assert.throws(() => assertDevnetUrl(""), MainnetBlocked);
});

test("secrets are redacted in the refusal message", () => {
  try { assertDevnetUrl("https://mainnet.helius-rpc.com/?api-key=SUPERSECRET"); assert.fail("should throw"); }
  catch (e) { assert.ok(!String((e as Error).message).includes("SUPERSECRET"), "leaked the key in the error"); }
});

test("boot refuses when any RPC env var points at mainnet", () => {
  assert.throws(() => assertForkIsDevnetOnly({ SOLANA_RPC: "https://api.mainnet-beta.solana.com" } as any),
    MainnetBlocked);
  assert.throws(() => assertForkIsDevnetOnly({
    SOLANA_RPC: "https://api.devnet.solana.com",
    RPC_FALLBACKS: "https://api.devnet.solana.com,https://api.mainnet-beta.solana.com",
  } as any), MainnetBlocked, "a mainnet FALLBACK is still mainnet");
});

test("boot passes on an all-devnet environment", () => {
  const ok = assertForkIsDevnetOnly({
    SOLANA_RPC: "https://api.devnet.solana.com",
    MAGICBLOCK_ROUTER: "https://devnet-router.magicblock.app",
  } as any);
  assert.equal(ok.length, 2);
});

// A production vault key present in the fork's env means production config was copied across, and
// the next mistake is one env var away. Refuse on PRESENCE, not on use.
test("a production vault key in the environment is refused outright", () => {
  assert.throws(() => assertForkIsDevnetOnly({
    SOLANA_RPC: "https://api.devnet.solana.com", VAULT_SECRET: "[1,2,3]",
  } as any), MainnetBlocked);
  assert.doesNotThrow(() => assertForkIsDevnetOnly({
    SOLANA_RPC: "https://api.devnet.solana.com", VAULT_SECRET: "[1,2,3]", ALLOW_FORK_VAULT: "1",
  } as any), "an explicitly acknowledged devnet vault is allowed");
});

test("mainnet-only capabilities are hard-disabled on this fork", () => {
  for (const f of ["jupiterSwaps", "mainnetMemoAnchoring", "productionDeploy"] as const)
    assert.throws(() => refuseIfDisabled(f), MainnetBlocked, `${f} was not disabled`);
});
