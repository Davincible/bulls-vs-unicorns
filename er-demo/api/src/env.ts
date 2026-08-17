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

import { attestationKeyFrom, type AttestationKey } from "../../src/v2/data/xLinkSign.js";
import { PublicKey } from "@solana/web3.js";

/** The 32-byte ed25519 secret that signs attestations. Generated offline by
 *  `er-demo/scripts/xlink-keygen.ts`, pasted into Vercel, never in the repo. */
export const SECRET_ENV = "XLINK_ATTESTATION_SECRET";

/** The Neon connection string. `DATABASE_URL` rather than a bespoke name because that is what
 *  Neon's own Vercel integration provisions, and a variable an integration sets for you is a
 *  variable nobody has to remember to rotate by hand. */
export const DATABASE_URL_ENV = "DATABASE_URL";

/**
 * Where the SERVER reads the house wallet list from. Deliberately WITHOUT the `VITE_` prefix,
 * because `VITE_` is exactly the mechanism that inlines a value into the public bundle and this one
 * has no business there.
 *
 * That was already the rule when this pointed at the public status file; it is MORE true now. The
 * house list used to be published to every browser, so the worst a `VITE_`-prefixed URL could have
 * leaked was the address of a public document. The list is now internal — served only to a caller
 * holding `KEEPER_HOUSE_TOKEN` — so the endpoint's address is one half of a private channel, and
 * shipping either half in the bundle is the whole point of what changed.
 */
export const KEEPER_HOUSE_URL_ENV = "KEEPER_HOUSE_URL";

/** The keeper's authenticated house-list endpoint. NOT `er-demo/public/keeper-status.json`, and no
 *  longer even a candidate: the committed snapshot is a build artefact that goes stale the moment a
 *  wallet is added, and as of `KEEPER_STATUS_SCHEMA` 5 it does not carry the list at all. */
export const DEFAULT_KEEPER_HOUSE_URL = "https://bulls-arena-keeper-devnet.fly.dev/house-wallets.json";

/**
 * The bearer token for the endpoint above. Must be byte-identical to the keeper's
 * `KEEPER_HOUSE_TOKEN` fly secret, which enforces a 32-character minimum — a token short enough to
 * guess is a list that is only nominally private.
 *
 * NOT defaulted, unlike the URL. The URL is an address; this is the credential.
 */
export const HOUSE_TOKEN_ENV = "KEEPER_HOUSE_TOKEN";

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
 *
 * IT NAMED A VARIABLE THAT DOES NOT EXIST UNTIL 2026-08-15, and the failure was the exact one the
 * paragraph above describes. This said `VITE_XLINK_TRUSTED_KEYS`; the browser reads
 * `VITE_LINK_ATTESTATION_KEYS` (`src/v2/data/linkSource.ts`, `PRODUCTION_KEYS_RAW`). Nothing caught
 * it because nothing in this directory consumes the constant and `env.test.ts` only asserted that it
 * starts with `VITE_` — so the one place the two names had to agree was a string literal compared
 * against nothing.
 *
 * The cost was not hypothetical: `xlink-keygen.ts` INTERPOLATES this constant into the setup
 * instructions it prints, so following those instructions to the letter set a variable no code reads,
 * Vite did not inline it (it inlines only referenced `VITE_*`), and the site rendered as though
 * nobody had linked — silently, which is what the keygen script warns about four lines from here.
 */
export const CLIENT_TRUSTED_KEYS_ENV = "VITE_LINK_ATTESTATION_KEYS";

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

/** The keeper's house-list endpoint. The only value here with a default, because the default is an
 *  address rather than a secret — knowing where the door is buys nothing without the key below. */
export function keeperHouseUrl(env: Record<string, string | undefined>): string {
  const raw = env[KEEPER_HOUSE_URL_ENV];
  return raw !== undefined && raw.trim() !== "" ? raw.trim() : DEFAULT_KEEPER_HOUSE_URL;
}

/**
 * The house-list bearer token, or a thrown cold start.
 *
 * EXACTLY THE ARGUMENT `loadAttestationKey` MAKES, arriving by a different road. Without the token
 * every fetch of the list comes back 401, `HouseListCache` fails closed as it is designed to, and
 * `/api/links` withholds every row — so the leaderboard renders exactly as it does when nobody has
 * linked. No screen anywhere shows that as broken: not the player's (§8 says the unlinked page is
 * the ordinary page), not an uptime check (the route still 200s), not the logs of anything that
 * looks at status codes. A silent, indefinite, total loss of the feature.
 *
 * So it must be a 500 at the origin, on the first request after the deploy, where somebody is
 * looking. Called at MODULE SCOPE in the entry points, like every other loader in this file.
 *
 * The value must match the keeper's `KEEPER_HOUSE_TOKEN` fly secret, which enforces a 32-character
 * minimum. This function does NOT re-check that length: a token this side believes is fine and the
 * keeper rejects is a 401, and a 401 is diagnosed loudly by `houseWallets.ts` — duplicating the rule
 * here would give two places to change it and one of them would be missed.
 */
export function requireHouseToken(env: Record<string, string | undefined>): string {
  const raw = env[HOUSE_TOKEN_ENV];
  if (raw === undefined || raw.trim() === "") {
    throw new Error(
      `${HOUSE_TOKEN_ENV} is not set. It must match the keeper's \`${HOUSE_TOKEN_ENV}\` fly secret ` +
        `(minimum 32 characters, enforced there). Refusing to start: without it every house-list read ` +
        `is a 401, the fail-closed path withholds every attestation, and the result is ` +
        `indistinguishable from "nobody has linked".`,
    );
  }
  return raw.trim();
}
