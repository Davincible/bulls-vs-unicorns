// THE PROOF THAT THE TWO HALVES AGREE.
//
// Everything else in this directory can be right and the feature still renders nobody, if what the
// server signs is not byte-identical to what the browser verifies. That failure is silent by
// construction: `linkMapFrom()` drops a bad signature as `bad-signature` and the leaderboard shows
// the ordinary unlinked page, which is what it shows for ninety percent of players anyway. There is
// no screen that could reveal it and no log the player generates.
//
// So this file runs the REAL signer over the REAL row shape and hands the result to the REAL
// `verifyAttestation()` — the same function the bundle calls, imported from the same module, not a
// re-implementation. If the two ever disagree about field order, about number formatting, about how
// a length prefix is counted, or about what an empty display name is, one of these goes red.

import { describe, expect, it } from "vitest";
import {
  avatarPathFor,
  canonicalBytes,
  verifyAttestation,
  type LinkAttestation,
} from "../../src/v2/data/xLink.ts";
import { attestRow } from "./attest.ts";
import type { LinkRow } from "./store.ts";
import { hash, NOW, OTHER_KEY, TEST_KEY, wallet } from "./testKit.ts";

const row = (over: Partial<LinkRow> = {}): LinkRow => ({
  xId: "1234567890",
  wallet: wallet(1),
  handle: "someone",
  displayName: "Someone",
  avatarHash: hash("a"),
  linkedAt: NOW - 86_400,
  ...over,
});

/** Re-sign a tampered copy is NOT what these do — they mutate the SIGNED object, which is exactly
 *  what a man-in-the-middle or a compromised CDN can do and a signature exists to detect. */
const tamper = (a: LinkAttestation, over: Partial<LinkAttestation>): LinkAttestation => ({ ...a, ...over });

describe("attestRow", () => {
  it("produces an attestation the client's own verifyAttestation accepts", () => {
    // THE LOAD-BEARING TEST OF THIS DIRECTORY. Prevents: a server whose output no browser accepts,
    // which renders as "nobody has linked" and cannot be seen from any screen.
    const a = attestRow(row(), TEST_KEY, NOW);
    const v = verifyAttestation(a, [TEST_KEY.publicKey], NOW);
    expect(v.kind).toBe("ok");
    if (v.kind !== "ok") return;
    expect(v.record.handle).toBe("someone");
    expect(v.record.xId).toBe("1234567890");
    expect(v.record.wallet).toBe(wallet(1));
    expect(v.record.displayName?.unsafeText).toBe("Someone");
    expect(v.record.avatarPath).toBe(avatarPathFor("1234567890", hash("a")));
    expect(v.record.linkedAt).toBe(NOW - 86_400);
  });

  it("sets expiresAt seven days out and issuedAt to the instant it was given", () => {
    // Prevents: a signer that lets its caller choose its own expiry, which is a signer that has not
    // made a claim. Also pins the 7-day policy number to one place (`ATTESTATION_TTL_SECONDS`).
    const a = attestRow(row(), TEST_KEY, NOW);
    expect(a.issuedAt).toBe(NOW);
    expect(a.expiresAt).toBe(NOW + 7 * 24 * 60 * 60);
  });

  it("emits an empty avatarPath — not a null, not a placeholder — when no bytes are ingested yet", () => {
    // Prevents: a fresh link rendering as broken. §7.3's "linked + avatar in flight" rung must reach
    // the client as `avatarPath: ""`, which `verifyAttestation` turns into `avatarPath: null`, which
    // `faces.ts` already draws as the ordinary flat disc.
    const a = attestRow(row({ avatarHash: null }), TEST_KEY, NOW);
    expect(a.avatarPath).toBe("");
    const v = verifyAttestation(a, [TEST_KEY.publicKey], NOW);
    expect(v.kind).toBe("ok");
    if (v.kind === "ok") expect(v.record.avatarPath).toBeNull();
  });

  it("emits an empty displayName — never a null — for an account with no display name", () => {
    // Prevents: two representations of absence on one wire, which is one more thing for the signer
    // and the verifier to disagree about. `LinkAttestation` says the wire has no null.
    const a = attestRow(row({ displayName: "" }), TEST_KEY, NOW);
    expect(a.displayName).toBe("");
    const v = verifyAttestation(a, [TEST_KEY.publicKey], NOW);
    expect(v.kind === "ok" && v.record.displayName).toBeNull();
  });

  it("names the signing key in keyId so a client holding several keys knows which to check", () => {
    // Prevents: key rotation becoming a flag day. The client accepts a SET; `keyId` indexes into it.
    const a = attestRow(row(), TEST_KEY, NOW);
    expect(a.keyId).toBe(TEST_KEY.publicKey);
    // And the index cannot become a selection: an attestation naming an untrusted key is refused.
    expect(verifyAttestation(a, [OTHER_KEY.publicKey], NOW)).toEqual({ kind: "rejected", reason: "untrusted-key" });
  });
});

describe("a tampered attestation does not verify", () => {
  // Prevents, collectively: a compromised or misbehaving API inventing a link. This is the property
  // §5 buys — the API is trusted for AVAILABILITY, not for correctness — and it is worth nothing
  // unless every field is actually inside the signature.
  const signed = attestRow(row(), TEST_KEY, NOW);

  it("rejects a swapped handle", () => {
    // The attack: put a real, proven identity's wallet behind somebody else's @handle.
    const v = verifyAttestation(tamper(signed, { handle: "ansem" }), [TEST_KEY.publicKey], NOW);
    expect(v).toEqual({ kind: "rejected", reason: "bad-signature" });
  });

  it("rejects a swapped wallet", () => {
    // The attack: move a proven identity onto a whale's wallet. The substitute is a perfectly valid
    // pubkey, so this can only be caught by the signature — which is the point of asserting the
    // reason rather than merely `ok: false`.
    const v = verifyAttestation(tamper(signed, { wallet: wallet(2) }), [TEST_KEY.publicKey], NOW);
    expect(v).toEqual({ kind: "rejected", reason: "bad-signature" });
  });

  it("rejects a swapped xId", () => {
    // Signed without an avatar so the substitution is isolated to `xId` — otherwise the path/id
    // cross-check fires first and this would prove something weaker than it claims.
    const noAvatar = attestRow(row({ avatarHash: null }), TEST_KEY, NOW);
    const v = verifyAttestation(tamper(noAvatar, { xId: "9" }), [TEST_KEY.publicKey], NOW);
    expect(v).toEqual({ kind: "rejected", reason: "bad-signature" });
  });

  it("rejects a swapped avatarPath", () => {
    // The attack: keep the handle honest and serve a different picture under it. Shape and xId
    // prefix both still valid, so again only the signature can catch it.
    const other = avatarPathFor("1234567890", hash("b"));
    const v = verifyAttestation(tamper(signed, { avatarPath: other }), [TEST_KEY.publicKey], NOW);
    expect(v).toEqual({ kind: "rejected", reason: "bad-signature" });
  });

  it("rejects an extended expiresAt", () => {
    // The attack: make a revoked link outlive its revocation. `expiresAt` is the ceiling on a stale
    // unlink, so a mutable one is no ceiling at all.
    const v = verifyAttestation(tamper(signed, { expiresAt: signed.expiresAt + 86_400 }), [TEST_KEY.publicKey], NOW);
    expect(v).toEqual({ kind: "rejected", reason: "bad-signature" });
  });

  it("rejects a signature produced by a key the caller does not trust", () => {
    // Prevents: a leaked or rogue signer being accepted because the payload looked fine. The trusted
    // set is the caller's; the attestation only says which member.
    const forged = attestRow(row(), OTHER_KEY, NOW);
    expect(verifyAttestation(forged, [TEST_KEY.publicKey], NOW)).toEqual({ kind: "rejected", reason: "untrusted-key" });
  });
});

describe("the canonical encoding cannot have its field boundaries shifted", () => {
  it("round-trips a display name containing the netstring delimiters ':' and ','", () => {
    // THE FORGERY THIS ENCODING EXISTS TO PREVENT. `displayName` is arbitrary user-controlled text.
    // Under any separator-joined encoding, a name containing the separator lets its owner sign one
    // payload that reads as another — a forgery produced with a legitimate signature, by typing into
    // a text box. A netstring's length is decided before the content is looked at, so no content can
    // be structure.
    const nasty = '9:9999999,7:hijack,,,::,';
    const a = attestRow(row({ displayName: nasty }), TEST_KEY, NOW);
    const v = verifyAttestation(a, [TEST_KEY.publicKey], NOW);
    expect(v.kind).toBe("ok");
    if (v.kind === "ok") expect(v.record.displayName?.unsafeText).toBe(nasty);
  });

  it("round-trips multi-byte UTF-8 and counts the prefix in BYTES, not UTF-16 code units", () => {
    // Prevents the emoji bug named in `canonicalBytes`'s own comment: a length prefix computed from
    // `s.length` counts UTF-16 code units while the payload counts UTF-8 bytes, and the two disagree
    // for every emoji and every accented character — which is to say, for a large fraction of real X
    // display names. Everything works until the day somebody with an emoji links.
    const name = "Ötter 🦦 日本";
    const a = attestRow(row({ displayName: name }), TEST_KEY, NOW);
    expect(verifyAttestation(a, [TEST_KEY.publicKey], NOW).kind).toBe("ok");

    const bytes = canonicalBytes(a);
    const utf8Len = new TextEncoder().encode(name).length;
    expect(utf8Len).not.toBe(name.length); // the two really do disagree for this string
    expect(new TextDecoder().decode(bytes)).toContain(`${utf8Len}:${name},`);
  });

  it("distinguishes two records whose concatenated contents are identical but split differently", () => {
    // The classic length-extension/ambiguity family, stated concretely: ("ab","cd") and ("abc","d")
    // concatenate to the same bytes. If a signature over one verified against the other, a handle
    // could be lengthened at the display name's expense. Netstrings make the two encodings different
    // and the signature non-transferable.
    const a = attestRow(row({ handle: "ab", displayName: "cd", avatarHash: null }), TEST_KEY, NOW);
    const b = attestRow(row({ handle: "abc", displayName: "d", avatarHash: null }), TEST_KEY, NOW);
    expect(canonicalBytes(a)).not.toEqual(canonicalBytes(b));
    // And a's signature, moved onto b's fields, does not verify.
    const moved = tamper(b, { sig: a.sig });
    expect(verifyAttestation(moved, [TEST_KEY.publicKey], NOW)).toEqual({ kind: "rejected", reason: "bad-signature" });
  });
});
