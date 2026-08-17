// GENERATE THE ATTESTATION SIGNING KEY. Offline, once, on a machine you trust.
//
//     bun run scripts/xlink-keygen.ts
//
// RUN WITH BUN, which is this repo's runtime for TypeScript scripts (`er-demo/scripts/keeper/` runs
// the same way). Node's built-in type stripping handles only a subset of TypeScript and the shared
// modules under `er-demo/src/v2/data/` are not written to that subset.
//
// TOUCHES NOTHING. No network, no database, no filesystem. It prints and exits. That is deliberate:
// a generator that writes a key to disk is a generator that leaves a key on disk, and the one place
// this secret is allowed to live is a Vercel environment variable.
//
// ------------------------------------------------------------------------------------------------
// THE INVARIANT NOBODY WILL BE WARNED ABOUT BY ANY ERROR, which is why both halves print together:
//
//     the public key must be in the CLIENT's trusted set, or nothing works and nothing says so.
//
// If `VITE_LINK_ATTESTATION_KEYS` does not contain the public half of `XLINK_ATTESTATION_SECRET`, every
// attestation the API signs is rejected by `verifyAttestation()` as `untrusted-key`, `linkMapFrom`
// drops all of them, and the leaderboard renders exactly as it does when nobody has linked — which
// is what it renders for most players anyway. There is no screen that could show the difference and
// no error a player generates. Copy both lines below, together, in one sitting.
//
// ROTATION IS A DEPLOY, NOT A FLAG DAY, and that is the whole reason the client takes a SET. Add the
// new public key to `VITE_LINK_ATTESTATION_KEYS` alongside the old one and deploy; THEN switch
// `XLINK_ATTESTATION_SECRET` to the new secret and deploy again; then remove the old public key on a
// third deploy, once nothing is signing with it. At no point is there a window in which a live
// attestation fails to verify. With a single key there is no such ordering — every cached bundle in
// every open tab breaks at once.

import { webcrypto } from "node:crypto";
import { attestationKeyFrom } from "../er-demo/src/v2/data/xLinkSign.ts";
import { CLIENT_TRUSTED_KEYS_ENV, SECRET_ENV } from "../er-demo/api/src/env.ts";

// `crypto.getRandomValues`, not `Math.random` and not a passphrase. This is the key that stands
// between the register and somebody putting a stranger's face on a wallet.
const secret = webcrypto.getRandomValues(new Uint8Array(32));
const key = attestationKeyFrom(secret);

const base64 = Buffer.from(secret).toString("base64");

process.stdout.write(`
A FRESH ed25519 ATTESTATION KEYPAIR. Both halves are needed. Neither belongs in the repo.

  SERVER — Vercel Environment Variables, all environments, "Sensitive" if offered:

    ${SECRET_ENV}=${base64}

  CLIENT — Vercel Environment Variables, all environments. It is inlined into the public bundle at
  build time, which is correct: it is a PUBLIC key. Comma-separate to hold several during a
  rotation.

    ${CLIENT_TRUSTED_KEYS_ENV}=${key.publicKey}

The public key above must be a member of ${CLIENT_TRUSTED_KEYS_ENV}, or every attestation is
rejected client-side and the site renders as though nobody has linked — silently, with no error
anywhere. Set both, then redeploy so the client half is rebuilt into the bundle.

This output has not been written to disk. Close the terminal when you are done.
`);
