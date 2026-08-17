// Shared fixtures for the api tests. Not a test file (no `.test.ts`), so vitest does not collect it.
//
// Everything here is DETERMINISTIC. No random keys, no `Date.now()`, no network. A test that fails
// once in fifty is a test the next person deletes.

import { ed25519 } from "@noble/curves/ed25519";
import { PublicKey } from "@solana/web3.js";
import { attestationKeyFrom, type AttestationKey } from "../../src/v2/data/xLinkSign.ts";
import type { HouseList, HouseListSource } from "./houseWallets.ts";

/** A fixed 32-byte secret. Test-only, and it is in the repo on purpose: it signs nothing anyone
 *  trusts, and a test key generated at run time makes a failing signature test unreproducible. */
export const TEST_SECRET = new Uint8Array(32).fill(7);

export const TEST_KEY: AttestationKey = attestationKeyFrom(TEST_SECRET);

/** A different key, for "signed by somebody we do not trust". */
export const OTHER_KEY: AttestationKey = attestationKeyFrom(new Uint8Array(32).fill(9));

/** A valid base58 ed25519 pubkey, derived from a byte so tests can name wallets by number rather
 *  than by an unreadable literal. Every one of these decodes to exactly 32 bytes, which is what
 *  `isBase58Pubkey` actually checks. */
export function wallet(n: number): string {
  return new PublicKey(new Uint8Array(32).fill(n)).toBase58();
}

/** A fixed instant, well clear of any real clock, so `expiresAt` arithmetic is readable. */
export const NOW = 1_800_000_000;

/** A `HouseListSource` that answers immediately with whatever the test says. */
export function houseSource(wallets: readonly string[], unknown = false): HouseListSource {
  const list: HouseList = { wallets: new Set(wallets), unknown };
  return { get: async () => list };
}

/**
 * A REAL ed25519 KEYPAIR, which `wallet(n)` above deliberately is not.
 *
 * `wallet(n)` builds a base58 string out of 32 identical bytes: a valid pubkey SHAPE, which is all the
 * read path ever needs, and something nobody can sign for. The write path verifies signatures, so it
 * needs the other thing — a public key that is genuinely the public half of a secret we hold.
 *
 * Derived from a filled byte array rather than randomly, for `testKit.ts`'s standing reason: a test
 * that fails once in fifty is a test the next person deletes, and a failing signature test with a
 * random key is unreproducible.
 */
export function walletKeypair(seed: number): { readonly secret: Uint8Array; readonly address: string } {
  const secret = new Uint8Array(32).fill(seed);
  return { secret, address: new PublicKey(ed25519.getPublicKey(secret)).toBase58() };
}

/** Sign a message string the way a wallet would: detached ed25519 over its UTF-8 bytes, base64 — the
 *  encoding `LinkRequest.signature` specifies and `writeHttp.ts#signatureBytes` accepts. */
export function signMessageBase64(secret: Uint8Array, message: string): string {
  const sig = ed25519.sign(new TextEncoder().encode(message), secret);
  let bin = "";
  for (const b of sig) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** A deterministic 32-byte-nonce source for `newNonce`. Each call fills the buffer with a different
 *  byte, so successive nonces differ and every one of them is predictable from the test. */
export function countingRandom(start = 1): (out: Uint8Array) => void {
  let n = start;
  return (out: Uint8Array) => {
    out.fill(n & 0xff);
    n += 1;
  };
}

/** A 64-character lowercase hex string, which is the only thing `avatarPathFor` and the proxy route
 *  will accept as a content hash. */
export function hash(seed: string): string {
  let out = "";
  for (let i = 0; out.length < 64; i += 1) {
    out += (seed.charCodeAt(i % seed.length) + i).toString(16).padStart(2, "0");
  }
  return out.slice(0, 64);
}
