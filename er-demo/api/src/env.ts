// COLD-START CONFIGURATION, AND IT FAILS LOUDLY OR NOT AT ALL.
//
// "A server that silently signs with a zero key is worse than one that 500s" is the whole design
// note. A missing secret must not be recoverable into a default, must not be logged and continued
// past, and must not produce a signature — because the failure it produces downstream is invisible:
// every attestation verifies against nothing, `linkMapFrom()` drops all of them as
// `bad-signature`, and the leaderboard renders exactly as it does when nobody has linked. There is
// no screen anywhere that would show the difference. So the difference has to be a 500 at the
// origin, on the first request after the deploy, where somebody is looking.
//
// Every loader below is called at MODULE SCOPE in the entry points, so the throw happens during cold
// start rather than inside a request. Vercel surfaces that as a function-level error with the
// message intact.

import { attestationKeyFrom, type AttestationKey } from "../../src/v2/data/xLinkSign.ts";
import { PublicKey } from "@solana/web3.js";

/** The 32-byte ed25519 secret that signs attestations. Generated offline by
 *  `er-demo/scripts/xlink-keygen.ts`, pasted into Vercel, never in the repo. */
export const SECRET_ENV = "XLINK_ATTESTATION_SECRET";

/** The Neon connection string. `DATABASE_URL` rather than a bespoke name because that is what
 *  Neon's own Vercel integration provisions, and a variable an integration sets for you is a
 *  variable nobody has to remember to rotate by hand. */
export const DATABASE_URL_ENV = "DATABASE_URL";

/** Where the SERVER reads the house wallet disclosure from. Distinct from the browser's
 *  `VITE_KEEPER_STATUS_URL` and deliberately WITHOUT the `VITE_` prefix, because `VITE_` is exactly
 *  the mechanism that inlines a value into the public bundle and this one has no business there. */
export const KEEPER_STATUS_URL_ENV = "KEEPER_STATUS_URL";

/** The keeper's live endpoint. NOT `er-demo/public/keeper-status.json`, which is a committed
 *  snapshot that goes stale the moment a house wallet is added or rotated — and a stale house list
 *  is precisely a house wallet that can wear a face. */
export const DEFAULT_KEEPER_STATUS_URL = "https://bulls-arena-keeper-devnet.fly.dev/keeper-status.json";

/**
 * THE CLIENT'S HALF, published here so the two names live in one file.
 *
 * Comma-separated base58 public keys, `VITE_`-prefixed so Vite inlines it into the bundle at build
 * time (the same mechanism `VITE_BASE_RPC` uses; see `src/chain/constants.ts`). A SET, not a key,
 * from day one — with one key, rotation is a flag day: there is no window in which both the old and
 * the new signature verify, so every cached bundle in every open tab breaks at once. Two entries
 * make a rotation two deploys and no incident.
 *
 * THE INVARIANT NOBODY IS WARNED ABOUT BY ANY ERROR: the public half of `XLINK_ATTESTATION_SECRET`
 * must be a member of this set. If it is not, every attestation verifies against nothing and the
 * page renders exactly as it does when nobody has linked. `xlink-keygen.ts` prints both halves
 * together for this reason.
 *
 * Nothing in this directory reads it — it is the browser's. The constant is here so that a search
 * for either name finds both.
 */
export const CLIENT_TRUSTED_KEYS_ENV = "VITE_XLINK_TRUSTED_KEYS";

/** Base64 of exactly 32 bytes: 43 payload characters and one `=`. Anchored, so a longer secret with
 *  a valid prefix is a failure rather than a truncation. */
const B64_32 = /^[A-Za-z0-9+/]{43}=$/;

function decodeBase64(v: string): Uint8Array {
  const bin = atob(v);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * 32 bytes from base64 or base58, WITH NO GUESSING.
 *
 * The two encodings are distinguishable for this length without ambiguity, which is the only reason
 * accepting both is safe rather than merely convenient:
 *
 *   - base64 of 32 bytes is ALWAYS 44 characters ending in exactly one `=`;
 *   - base58 of 32 bytes is 43-44 characters and can never contain `=`, `+` or `/`.
 *
 * So `=` decides it, and nothing that is valid under one rule is valid under the other. base64url
 * (`-`/`_`) is normalised first because it is the form most command-line tools emit and pasting it
 * would otherwise fail with a message about base58.
 *
 * Throws with the LENGTH IT ACTUALLY GOT, because "wrong length" without the number sends the next
 * person to re-read the generator instead of counting their paste.
 */
export function decodeSecret(raw: string, envName: string): Uint8Array {
  const v = raw.trim().replace(/-/g, "+").replace(/_/g, "/");
  if (v === "") throw new Error(`${envName} is empty`);

  let bytes: Uint8Array;
  if (v.endsWith("=")) {
    if (!B64_32.test(v)) {
      throw new Error(`${envName} looks like base64 but is not 32 bytes' worth (44 chars ending in "=")`);
    }
    bytes = decodeBase64(v);
  } else {
    try {
      bytes = new PublicKey(v).toBytes();
    } catch {
      throw new Error(`${envName} is neither valid base64 (44 chars, one "=") nor valid base58`);
    }
  }
  if (bytes.length !== 32) {
    throw new Error(`${envName} must decode to 32 bytes, got ${bytes.length}`);
  }
  return bytes;
}

/**
 * The signing key, or a thrown cold start.
 *
 * @param env normally `process.env`. Injected so the failure modes are testable without mutating
 *   the process — a test that sets and unsets `process.env` leaks into whatever runs next in the
 *   same worker.
 */
export function loadAttestationKey(env: Record<string, string | undefined>): AttestationKey {
  const raw = env[SECRET_ENV];
  if (raw === undefined || raw.trim() === "") {
    throw new Error(
      `${SECRET_ENV} is not set. Generate one offline with \`bun run er-demo/scripts/xlink-keygen.ts\` ` +
        `and set it in the Vercel project. Refusing to start: an unsigned or zero-signed attestation ` +
        `fails verification silently and is indistinguishable from "nobody has linked".`,
    );
  }
  return attestationKeyFrom(decodeSecret(raw, SECRET_ENV));
}

/** The Neon connection string, or a thrown cold start. Same argument: a store that cannot connect
 *  degrades to "nobody has linked", which no screen can show as broken. */
export function requireDatabaseUrl(env: Record<string, string | undefined>): string {
  const raw = env[DATABASE_URL_ENV];
  if (raw === undefined || raw.trim() === "") {
    throw new Error(`${DATABASE_URL_ENV} is not set. Point it at the Neon Postgres connection string.`);
  }
  return raw.trim();
}

/** The keeper status endpoint. The only value here with a default, because the default is a public
 *  URL that is already hardcoded in two other places in this repo and is not a secret. */
export function keeperStatusUrl(env: Record<string, string | undefined>): string {
  const raw = env[KEEPER_STATUS_URL_ENV];
  return raw !== undefined && raw.trim() !== "" ? raw.trim() : DEFAULT_KEEPER_STATUS_URL;
}
