// ONE ROW -> ONE SIGNED ATTESTATION. The seam between the database and the wire.
//
// It is four lines of code and it exists as its own module for one reason: `signAttestation()` and
// `avatarPathFor()` both live in `er-demo/src/v2/data/`, on the client's side of the fence, and this
// is the only place on the server that reaches across it. `canonicalBytes` is deliberately NOT
// reimplemented here — a signer and a verifier holding two copies of one encoding is a format that
// drifts, and it drifts silently: everything works until the day a display name contains an emoji.
// Importing the client's own module means the round-trip test in `attest.test.ts` is a genuine proof
// that the two halves agree, rather than a proof that two copies of my own opinion agree.

import { avatarPathFor, type LinkAttestation } from "../../src/v2/data/xLink.js";
import { signAttestation, type AttestationKey } from "../../src/v2/data/xLinkSign.js";
import type { LinkRow } from "./store.js";

/**
 * Sign one row.
 *
 * `avatarPath` is `""` — the wire's "no avatar yet" — whenever the row has no ingested bytes. That
 * is §7.3's "linked + avatar in flight" rung and it is the ORDINARY state of a freshly linked
 * account, not a degradation: the client renders the flat side-coloured disc it already draws for
 * every fighter, and nothing anywhere shows a hole.
 *
 * `displayName` is `""` for absent, matching `LinkAttestation`'s rule that the wire has no null.
 * The row's own column is `NOT NULL DEFAULT ''`, so the two representations of absence are already
 * one representation by the time it gets here.
 *
 * @param nowSec unix SECONDS. One instant for a whole batch, passed in rather than read per row, so
 *   that 48 attestations signed in one request cannot carry 48 different `issuedAt` values and so a
 *   test can sign something already expired.
 */
export function attestRow(row: LinkRow, key: AttestationKey, nowSec: number): LinkAttestation {
  return signAttestation(
    {
      wallet: row.wallet,
      xId: row.xId,
      handle: row.handle,
      displayName: row.displayName,
      avatarPath: row.avatarHash === null ? "" : avatarPathFor(row.xId, row.avatarHash),
      linkedAt: row.linkedAt,
    },
    key,
    nowSec,
  );
}
