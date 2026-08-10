// THE SIGNING HALF of the wire contract. Separated from `xLink.ts` on purpose.
//
// `xLink.ts` is imported by the browser bundle and only ever VERIFIES. This file only ever SIGNS,
// and the two callers that need it are both outside the app: the serverless function that publishes
// attestations, and the script that regenerates the `?links=mock` fixture. Keeping them apart means
// the bundle has no import path to a function that takes a secret key, so "how did a signing routine
// end up shipped to the client" is a question nobody has to answer later.
//
// It shares `canonicalBytes()` with the verifier rather than restating the format. A signer and a
// verifier holding two copies of one encoding is a format that drifts, and it drifts silently:
// everything works until the day a display name contains an emoji.

import { ed25519 } from "@noble/curves/ed25519";
import { PublicKey } from "@solana/web3.js";
import {
  ATTESTATION_TTL_SECONDS,
  canonicalBytes,
  type LinkAttestation,
} from "./xLink.ts";

/** Everything an attestation says except the parts the signer decides. */
export interface AttestationPayload {
  readonly wallet: string;
  readonly xId: string;
  readonly handle: string;
  /** `""` for none — the wire has no null, see `LinkAttestation`. */
  readonly displayName: string;
  /** `""` for none. Build it with `avatarPathFor()`; never by hand. */
  readonly avatarPath: string;
  /** Unix SECONDS. */
  readonly linkedAt: number;
}

/** The ed25519 keypair that signs attestations, in the only two forms anyone needs it. */
export interface AttestationKey {
  /** 32 raw bytes. In production this comes from a Vercel env var, is generated offline, and is
   *  never written to the repo. */
  readonly secret: Uint8Array;
  /** base58, and the value that goes in `keyId` and in the client's trusted set. */
  readonly publicKey: string;
}

function base64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Derive the public half of a 32-byte ed25519 secret, as base58. */
export function attestationKeyFrom(secret: Uint8Array): AttestationKey {
  if (secret.length !== 32) {
    throw new Error(`attestation secret must be 32 bytes, got ${secret.length}`);
  }
  const pub = ed25519.getPublicKey(secret);
  return { secret, publicKey: new PublicKey(pub).toBase58() };
}

/**
 * Sign one record. The result is exactly what `verifyAttestation()` accepts and nothing more.
 *
 * `issuedAt`/`expiresAt` are set HERE rather than accepted from a caller, because they are claims
 * about the signer and a signer that lets its caller choose its own expiry has not made a claim at
 * all. `ATTESTATION_TTL_SECONDS` is the one policy number, in one file, shared with the verifier.
 *
 * @param nowSec unix SECONDS, injected so the fixture generator can produce a stable, reproducible
 *   artifact and so tests can sign something already expired.
 */
export function signAttestation(
  payload: AttestationPayload,
  key: AttestationKey,
  nowSec: number,
): LinkAttestation {
  const unsigned = {
    ...payload,
    issuedAt: nowSec,
    expiresAt: nowSec + ATTESTATION_TTL_SECONDS,
    keyId: key.publicKey,
    sig: "",
  } satisfies LinkAttestation;
  // The signature covers `canonicalBytes`, which does not include `sig` or `keyId` — so the empty
  // placeholder above is not part of what is signed and cannot be. See `canonicalBytes`'s field list.
  const sig = ed25519.sign(canonicalBytes(unsigned), key.secret);
  return { ...unsigned, sig: base64(sig) };
}
