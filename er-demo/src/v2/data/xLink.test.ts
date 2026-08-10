// THE DEFECT THIS FILE EXISTS TO PREVENT IS A FACE ON THE WRONG WALLET.
//
// `web/index.html` shipped one. Its OAuth was real and its wallet auth was real, and beside them sat
// a `prompt("Your X handle")` fallback that wrote an indistinguishable record — so typing `blknoiz06`
// put Ansem's actual name and actual photograph on your fighter, in front of everyone, and nothing
// downstream could tell that record from a proven one. The whole of `xLink.ts` is the answer to that,
// and almost none of the answer is visible at runtime: a forged attestation and a genuine one look
// identical until something checks the signature, and a canonical encoding that can be shifted by a
// display name looks perfectly correct until somebody puts a comma in their name.
//
// So every test below pins one property that has no visible symptom when it breaks:
//
//   * the signature actually covers every field (tamper each one, watch it fail);
//   * the canonical encoding cannot be shifted by user-controlled text (the netstring property);
//   * a correctly-signed record still cannot point an `<img>` off-origin;
//   * the trusted key set is consulted, and the attestation cannot nominate its own trust anchor;
//   * expiry is enforced, and clock skew is tolerated in exactly one direction;
//   * everything that fails collapses to "unlinked" rather than to an error.
//
// The signing side is exercised through `xLinkSign.ts` rather than through hand-built fixtures,
// because a fixture built by the test is a second implementation of the format and would agree with
// itself while both disagreed with the server.

import { describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha256";
import {
  ATTESTATION_TTL_SECONDS,
  avatarPathFor,
  canonicalBytes,
  identityText,
  isVerifiedRecord,
  linkMapFrom,
  MAX_WALLETS_PER_QUERY,
  NO_LINKS,
  profileUrl,
  verifyAttestation,
  type LinkAttestation,
} from "./xLink.ts";
import { attestationKeyFrom, signAttestation, type AttestationPayload } from "./xLinkSign.ts";

const KEY = attestationKeyFrom(sha256(new TextEncoder().encode("xLink.test key")));
const OTHER_KEY = attestationKeyFrom(sha256(new TextEncoder().encode("a key we do not trust")));
const TRUSTED = [KEY.publicKey];

const NOW = 1_800_000_000;
const WALLET = "F49CkYiWVNFpPxWe9fptXVNcbwnVs1hxBjFtFL2w5nZf";
const X_ID = "1234567890123456789";

function payload(over: Partial<AttestationPayload> = {}): AttestationPayload {
  return {
    wallet: WALLET,
    xId: X_ID,
    handle: "someone",
    displayName: "Someone",
    avatarPath: avatarPathFor(X_ID, "a".repeat(64)),
    linkedAt: NOW - 86_400,
    ...over,
  };
}

function signed(over: Partial<AttestationPayload> = {}, nowSec = NOW): LinkAttestation {
  return signAttestation(payload(over), KEY, nowSec);
}

/** Verify and demand success, so the happy path in a test reads as one line. */
function accept(a: LinkAttestation, nowSec = NOW) {
  const v = verifyAttestation(a, TRUSTED, nowSec);
  if (v.kind !== "ok") throw new Error(`expected acceptance, got ${v.reason}`);
  return v.record;
}

/** Verify and demand a specific refusal. */
function refuse(a: unknown, nowSec = NOW) {
  const v = verifyAttestation(a, TRUSTED, nowSec);
  if (v.kind === "ok") throw new Error("expected refusal, got a record");
  return v.reason;
}

describe("the round trip", () => {
  it("signs and verifies, and every field survives intact", () => {
    const r = accept(signed());
    expect(r.wallet).toBe(WALLET);
    expect(r.xId).toBe(X_ID);
    expect(r.handle).toBe("someone");
    expect(r.avatarPath).toBe(avatarPathFor(X_ID, "a".repeat(64)));
    expect(r.linkedAt).toBe(NOW - 86_400);
    expect(r.expiresAt).toBe(NOW + ATTESTATION_TTL_SECONDS);
  });

  it("turns the wire's empty strings into the nulls the renderer branches on", () => {
    // `""` is the wire's only spelling of absence — there is no null on the wire, because the
    // canonical encoding has to be total. Both of these are ORDINARY states, not failures: an X
    // account with no display name is common, and "linked but the picture has not arrived" is a real
    // rung on the failure ladder that renders as the flat side-coloured disc.
    const r = accept(signed({ displayName: "", avatarPath: "" }));
    expect(r.displayName).toBeNull();
    expect(r.avatarPath).toBeNull();
  });
});

describe("the signature covers every field", () => {
  // The defect: a canonical encoding that omits a field. Everything works, the signature verifies,
  // and that one field is attacker-controlled forever. One case per field, no exceptions — a field
  // added to the format without a case here is a field nobody proved was covered.
  const tampers: ReadonlyArray<[string, (a: LinkAttestation) => LinkAttestation]> = [
    ["wallet", (a) => ({ ...a, wallet: "2Q3FutR7QVzVTGro7XV4rJFy2ua8g8r7x12UbH1MGMEM" })],
    // The avatar path is rewritten to match, deliberately. Changing `xId` alone is caught earlier and
    // more cheaply by the path-consistency check (the path would still name the old account), which
    // is correct behaviour but proves nothing about the signature. Moving both together is the
    // attacker's best effort, and it is what the signature has to stop.
    [
      "xId",
      (a) => ({ ...a, xId: "9876543210987654321", avatarPath: avatarPathFor("9876543210987654321", "a".repeat(64)) }),
    ],
    ["handle", (a) => ({ ...a, handle: "someoneelse" })],
    ["displayName", (a) => ({ ...a, displayName: "Someone Else" })],
    ["avatarPath", (a) => ({ ...a, avatarPath: avatarPathFor(X_ID, "b".repeat(64)) })],
    ["linkedAt", (a) => ({ ...a, linkedAt: a.linkedAt + 1 })],
    ["issuedAt", (a) => ({ ...a, issuedAt: a.issuedAt + 1 })],
    ["expiresAt", (a) => ({ ...a, expiresAt: a.expiresAt + 1 })],
  ];

  for (const [field, tamper] of tampers) {
    it(`rejects a record whose ${field} was changed after signing`, () => {
      expect(refuse(tamper(signed()))).toBe("bad-signature");
    });
  }
});

describe("the canonical encoding cannot be shifted by user-controlled text", () => {
  // THE ATTACK THIS PREVENTS, concretely. Under a delimiter-joined encoding, a display name is the
  // one field an attacker types freely, so a name containing the delimiter lets its owner move the
  // field boundaries and produce one signature that reads as a different record. That is a forgery
  // with a legitimate signature, obtained by typing into a text box.
  //
  // The netstring form has no such reading, because the length is decided before the content is
  // looked at. These two payloads differ only in where one boundary falls; their canonical bytes must
  // differ, and neither signature may verify against the other's bytes.
  it("distinguishes two payloads that a delimiter-joined encoding would confuse", () => {
    const a = signed({ displayName: "evil", handle: "victim" });
    const b = signed({ displayName: "evil,7:victim", handle: "someone" });
    expect(Array.from(canonicalBytes(a))).not.toEqual(Array.from(canonicalBytes(b)));
    // Cross-verification must fail in both directions: neither record's signature is valid for the
    // other's bytes.
    expect(refuse({ ...a, sig: b.sig })).toBe("bad-signature");
    expect(refuse({ ...b, sig: a.sig })).toBe("bad-signature");
  });

  it("survives a display name of astral-plane characters", () => {
    // The length prefix counts UTF-8 BYTES. Computed from `String.length` it would count UTF-16 code
    // units instead, and the two disagree for every emoji — which is to say for a large fraction of
    // real X display names. The signature would then verify on the signer's machine and fail on the
    // verifier's, intermittently, by name.
    const name = "𝕊𝕠𝕞𝕖𝕠𝕟𝕖 🦦🏴‍☠️";
    const r = accept(signed({ displayName: name }));
    expect(identityText(r).displayName).toBe(name);
  });

  it("commits to the UTF-8 bytes rather than to the JS string, and that has one harmless collision", () => {
    // An unpaired surrogate encodes to U+FFFD, so these two payloads have IDENTICAL canonical bytes
    // and one signature covers both. Pinned rather than fixed: it is only reachable through
    // `displayName` (every other field is regex-constrained to ASCII before it gets here), and both
    // inputs render as the same replacement glyph, so it buys an attacker nothing. Recorded here so
    // the next reader finds a documented decision instead of rediscovering it as a scare.
    const lone = signed({ displayName: "\uD800" });
    const replacement = signed({ displayName: "\uFFFD" });
    expect(Array.from(canonicalBytes(lone))).toEqual(Array.from(canonicalBytes(replacement)));
    expect(accept({ ...lone, sig: replacement.sig }).handle).toBe("someone");
  });

  it("survives a display name that is only delimiters", () => {
    const r = accept(signed({ displayName: ":,:,:,," }));
    expect(identityText(r).displayName).toBe(":,:,:,,");
  });
});

describe("same-origin is enforced, not trusted", () => {
  // THE POINT OF THESE CASES: every one of them is CORRECTLY SIGNED by a key we trust. They are
  // rejected anyway. `faces.ts` carries a standing rule that the field makes no off-origin request,
  // and a signing key that leaked must not become a way to turn every player's browser into a beacon.
  // A signature proves origin; it does not confer trust.
  it("refuses a protocol-relative path, which an <img> resolves to another origin", () => {
    expect(refuse(signed({ avatarPath: "//evil.example/x.webp" }))).toBe("bad-avatar-path");
  });

  it("refuses an absolute URL", () => {
    expect(refuse(signed({ avatarPath: "https://pbs.twimg.com/profile_images/1.webp" })))
      .toBe("bad-avatar-path");
  });

  it("refuses path traversal out of the avatar route", () => {
    expect(refuse(signed({ avatarPath: "/api/avatar/../../evil.webp" }))).toBe("bad-avatar-path");
  });

  it("refuses a path belonging to a different X account", () => {
    // The subtle one. The path is well-formed and same-origin, and it points at somebody else's
    // picture — which is the impersonation this whole feature exists to prevent, arriving through
    // the one field nobody reads.
    expect(refuse(signed({ avatarPath: avatarPathFor("9999999999999999999", "c".repeat(64)) })))
      .toBe("bad-avatar-path");
  });

  it("refuses a hash that is not a hash", () => {
    expect(refuse(signed({ avatarPath: `/api/avatar/${X_ID}/not-a-hash.webp` }))).toBe("bad-avatar-path");
  });
});

describe("the trusted key set", () => {
  it("refuses a record signed by a key that is not in the set", () => {
    const a = signAttestation(payload(), OTHER_KEY, NOW);
    expect(refuse(a)).toBe("untrusted-key");
  });

  it("refuses a record that nominates a key it was not signed with", () => {
    // `keyId` INDEXES INTO the trusted set; it must never SELECT the trust anchor. This is the JWT
    // `alg`/`kid` confusion bug in its Solana clothes: an attestation signed by a key we do not hold,
    // relabelled as one we do, must fail on the curve rather than on the label.
    const a = signAttestation(payload(), OTHER_KEY, NOW);
    expect(refuse({ ...a, keyId: KEY.publicKey })).toBe("bad-signature");
  });

  it("refuses everything when the trusted set is empty", () => {
    // The production failure mode worth pinning: `VITE_LINK_ATTESTATION_KEYS` unset means no keys,
    // which must mean no links — never a fallback to some other key.
    const v = verifyAttestation(signed(), [], NOW);
    expect(v.kind === "rejected" && v.reason).toBe("untrusted-key");
  });

  it("accepts against a set holding several keys, so rotation is not a flag day", () => {
    const v = verifyAttestation(signed(), [OTHER_KEY.publicKey, KEY.publicKey], NOW);
    expect(v.kind).toBe("ok");
  });

  it("refuses a keyId swapped between two keys we both trust", () => {
    // The other half of the `alg`/`kid` confusion case above. With BOTH keys trusted, the label check
    // passes and only the curve can catch it — so this is the case that proves the signature is
    // actually evaluated against the key the record names, rather than against whichever key happened
    // to be first in the set.
    const both = [KEY.publicKey, OTHER_KEY.publicKey];
    const a = signAttestation(payload(), KEY, NOW);
    const swapped = { ...a, keyId: OTHER_KEY.publicKey };
    const v = verifyAttestation(swapped, both, NOW);
    expect(v.kind === "rejected" && v.reason).toBe("bad-signature");
  });

  it("does not throw on a keyId that is not a key at all", () => {
    // Noble throws on a malformed point rather than returning false, and a throw here would take out
    // a whole poll — 47 good records lost to one bad one.
    expect(refuse({ ...signed(), keyId: "not-a-key" })).toBe("untrusted-key");
    expect(() => verifyAttestation({ ...signed(), keyId: "!!!" }, ["!!!"], NOW)).not.toThrow();
  });
});

describe("expiry", () => {
  it("accepts inside its seven days and refuses one second past them", () => {
    const a = signed();
    expect(verifyAttestation(a, TRUSTED, NOW + ATTESTATION_TTL_SECONDS - 1).kind).toBe("ok");
    expect(refuse(a, NOW + ATTESTATION_TTL_SECONDS)).toBe("expired");
  });

  it("tolerates a browser clock that is behind, but not one that is far behind", () => {
    // Asymmetric on purpose. Browser clocks are wrong routinely by minutes, and a client that refused
    // a fresh attestation because its own clock ran slow would turn a wrong wall clock into "X
    // connect is broken". Expiry gets NO grace in the other direction, because erring towards showing
    // a revoked face has a person on the other end of it.
    const a = signed({}, NOW + 240);
    expect(verifyAttestation(a, TRUSTED, NOW).kind).toBe("ok");
    expect(refuse(signed({}, NOW + 400))).toBe("not-yet-valid");
  });
});

describe("field shapes", () => {
  const bad: ReadonlyArray<[string, Partial<AttestationPayload>, string]> = [
    ["a handle carrying its own @", { handle: "@someone" }, "bad-handle"],
    ["a handle longer than X allows", { handle: "a".repeat(16) }, "bad-handle"],
    ["a handle with a newline", { handle: "some\none" }, "bad-handle"],
    ["an empty handle", { handle: "" }, "bad-handle"],
    ["a non-numeric x id", { xId: "not-a-number" }, "bad-x-id"],
    ["a wallet with a non-base58 character", { wallet: `${WALLET.slice(0, 43)}0` }, "bad-wallet"],
    ["a wallet far too short", { wallet: "abc" }, "bad-wallet"],
  ];

  for (const [what, over, reason] of bad) {
    it(`refuses ${what}`, () => {
      expect(refuse(signed(over))).toBe(reason);
    });
  }

  it("refuses anything that is not an object at all", () => {
    for (const junk of [null, undefined, 42, "a string", [], true]) {
      expect(refuse(junk)).toBe("malformed");
    }
  });

  it("refuses a record missing a field, rather than reading it as undefined", () => {
    const { handle: _drop, ...rest } = signed();
    expect(refuse(rest)).toBe("malformed");
  });

  it("refuses a non-integer timestamp", () => {
    expect(refuse({ ...signed(), expiresAt: 1.5 })).toBe("malformed");
  });

  it("refuses a signature of the wrong length before doing any curve work", () => {
    expect(refuse({ ...signed(), sig: "AAAA" })).toBe("bad-signature");
  });
});

describe("linkMapFrom", () => {
  const other = "7wkgd4GDGXBYu9GLHPbuJwrdfLU2ByUHSJrHzWTpsCZL";

  it("builds a map from a well-formed response", () => {
    const { links, rejected } = linkMapFrom({ links: [signed()] }, TRUSTED, NOW);
    expect(links.size).toBe(1);
    expect(links.get(WALLET)?.handle).toBe("someone");
    expect(rejected).toEqual([]);
  });

  it("drops a house wallet even though it verified", () => {
    // Client guard three. The durable guards are the server refusing to create the link and refusing
    // to serve it; this one keys off the same published list the rest of the page renders from. A
    // house wallet wearing a person's photograph is an actual misrepresentation — the failure mode
    // that costs the most trust, because a fan believes they beat a person.
    const { links, rejected } = linkMapFrom({ links: [signed()] }, TRUSTED, NOW, [WALLET]);
    expect(links.size).toBe(0);
    expect(rejected).toEqual(["house-wallet"]);
  });

  it("keeps the first of two records claiming one wallet", () => {
    // Two rows for one wallet is a server bug or a replay and there is no honest way to choose
    // between them. Taking the last would let a later row overwrite an earlier one, which is exactly
    // the shape of a successful injection.
    const first = signed({ handle: "first" });
    const second = signed({ handle: "second" });
    const { links, rejected } = linkMapFrom({ links: [first, second] }, TRUSTED, NOW);
    expect(links.get(WALLET)?.handle).toBe("first");
    expect(rejected).toEqual(["malformed"]);
  });

  it("keeps the good records when one in the batch is bad", () => {
    // One malformed row must not cost a whole round its faces.
    const good = signAttestation(payload({ wallet: other, handle: "good" }), KEY, NOW);
    const { links } = linkMapFrom({ links: [{ nonsense: true }, good] }, TRUSTED, NOW);
    expect(links.size).toBe(1);
    expect(links.get(other)?.handle).toBe("good");
  });

  it("returns the shared empty map when nothing survives, so memos do not churn", () => {
    // Identity matters: consumers memoise against this value and a fresh `new Map()` per poll would
    // invalidate the canvas, the extract terms and the combat feed four times a second for nothing.
    expect(linkMapFrom({ links: [] }, TRUSTED, NOW).links).toBe(NO_LINKS);
    expect(linkMapFrom("garbage", TRUSTED, NOW).links).toBe(NO_LINKS);
    expect(linkMapFrom({ links: "not an array" }, TRUSTED, NOW).links).toBe(NO_LINKS);
  });
});

describe("rendering", () => {
  it("always produces the @handle, which is the only unforgeable part of an X identity", () => {
    // Display names are free text — `Ansem` costs nothing to type, `@blknoiz06` cannot be taken — so
    // the handle is both the anti-impersonation measure and X's own display requirement. There is no
    // arrangement of this return value that yields a display name without a handle beside it.
    const t = identityText(accept(signed({ displayName: "Ansem" })));
    expect(t.handle).toBe("@someone");
    expect(t.displayName).toBe("Ansem");
  });

  it("still produces a handle when there is no display name", () => {
    expect(identityText(accept(signed({ displayName: "" })))).toEqual({
      handle: "@someone",
      displayName: null,
    });
  });

  it("builds the profile link from the validated handle", () => {
    expect(profileUrl(accept(signed()))).toBe("https://x.com/someone");
  });
});

describe("the mint register — the half of the brand that actually holds", () => {
  // THE CENTREPIECE, AND IT WAS THE ONE PROPERTY THE HEADER CLAIMED AND NOTHING TESTED. The
  // compile-time brand blocks an object literal, which is the accidental route. It does NOT block a
  // spread — TypeScript keeps unique-symbol properties through `...` — nor an `any` widening, so
  // `{ ...someoneElsesRecord, handle: "blknoiz06" }` type-checks with no cast to grep for. That is
  // §1.3's defect exactly: somebody else's handle on your fighter, in one line.
  it("does not recognise a spread copy of a verified record", () => {
    const real = accept(signed());
    const forged = { ...real, handle: "blknoiz06" };
    expect(isVerifiedRecord(real)).toBe(true);
    expect(isVerifiedRecord(forged)).toBe(false);
  });

  it("does not recognise a record that came through JSON", () => {
    // `JSON.parse` returns `any`, which is assignable to `LinkRecord` with no error at all. Round
    // tripping a genuine record through JSON is the closest thing to a legitimate-looking forgery.
    const real = accept(signed());
    const revived = JSON.parse(JSON.stringify(real)) as typeof real;
    expect(isVerifiedRecord(revived)).toBe(false);
  });

  it("recognises only the object it minted, not an identical one", () => {
    // Two verifications of the same bytes produce two records that are deeply equal and separately
    // minted — set membership is per-object, which is the property a copy cannot fake.
    const a = accept(signed());
    const b = accept(signed());
    expect(a).not.toBe(b);
    expect(isVerifiedRecord(a) && isVerifiedRecord(b)).toBe(true);
  });
});

describe("the constants the server shares", () => {
  it("caps a query at a full lobby plus slack", () => {
    // 48 is `MAX_FIGHTERS`; the cap has to clear a full round plus the asker in one request, or the
    // client starts paginating and the server grows an enumeration route.
    expect(MAX_WALLETS_PER_QUERY).toBeGreaterThan(48);
  });

  it("expires attestations at seven days", () => {
    expect(ATTESTATION_TTL_SECONDS).toBe(604_800);
  });
});
