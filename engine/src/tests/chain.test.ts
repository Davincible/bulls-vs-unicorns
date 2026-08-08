// Vault-key loading invariants. A production deploy loads the vault key from a secret manager via
// VAULT_SECRET_KEY; a malformed value must fail loud, not silently mint a wrong/new vault.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { loadVaultKeypair, isTestChainUrl } from "../chain.ts";

// SEC-L5. The old check was `/localhost|127\.0\.0\.1|devnet|testnet/i.test(fullUrl)`, duplicated in
// six files. It decides whether faucets, BOT_FAKE_BANK and vault auto-generation are available, so
// a substring match anywhere in the URL — a path segment, an API key — was a real-money mistake
// waiting to happen. Pinned here so a future edit can't quietly widen it back to a full-URL match.
test("test-chain detection matches the hostname only, not an API key or path segment", () => {
  assert.equal(isTestChainUrl("https://api.devnet.solana.com"), true);
  assert.equal(isTestChainUrl("https://devnet.helius-rpc.com/?api-key=abc"), true);
  assert.equal(isTestChainUrl("http://127.0.0.1:8899"), true);
  assert.equal(isTestChainUrl("http://localhost:8899"), true);
  // a mainnet host must NOT be flipped by "devnet"/"testnet" appearing outside the hostname
  assert.equal(isTestChainUrl("https://mainnet.helius-rpc.com/?api-key=devnet-proxy-token"), false);
  assert.equal(isTestChainUrl("https://mainnet.helius-rpc.com/devnet-legacy-path"), false);
  assert.equal(isTestChainUrl("https://api.mainnet-beta.solana.com"), false);
});

test("an unparseable RPC url is treated as NOT a test chain (fails toward production-safe)", () => {
  assert.equal(isTestChainUrl(""), false);
  assert.equal(isTestChainUrl("not a url"), false);
});

test("VAULT_SECRET_KEY (JSON byte array) loads that exact keypair", () => {
  const kp = Keypair.generate();
  process.env.VAULT_SECRET_KEY = JSON.stringify(Array.from(kp.secretKey));
  try {
    const loaded = loadVaultKeypair();
    assert.equal(loaded.publicKey.toBase58(), kp.publicKey.toBase58());
  } finally { delete process.env.VAULT_SECRET_KEY; }
});

test("a malformed VAULT_SECRET_KEY throws instead of falling through", () => {
  process.env.VAULT_SECRET_KEY = "not-a-json-array";
  try {
    assert.throws(() => loadVaultKeypair(), /not a valid JSON byte array/);
  } finally { delete process.env.VAULT_SECRET_KEY; }
});
