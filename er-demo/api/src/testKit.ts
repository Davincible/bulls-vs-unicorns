// Shared fixtures for the api tests. Not a test file (no `.test.ts`), so vitest does not collect it.
//
// Everything here is DETERMINISTIC. No random keys, no `Date.now()`, no network. A test that fails
// once in fifty is a test the next person deletes.

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

/** A 64-character lowercase hex string, which is the only thing `avatarPathFor` and the proxy route
 *  will accept as a content hash. */
export function hash(seed: string): string {
  let out = "";
  for (let i = 0; out.length < 64; i += 1) {
    out += (seed.charCodeAt(i % seed.length) + i).toString(16).padStart(2, "0");
  }
  return out.slice(0, 64);
}
