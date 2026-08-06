// Vault-key loading invariants. A production deploy loads the vault key from a secret manager via
// VAULT_SECRET_KEY; a malformed value must fail loud, not silently mint a wrong/new vault.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { loadVaultKeypair } from "../chain.ts";

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
