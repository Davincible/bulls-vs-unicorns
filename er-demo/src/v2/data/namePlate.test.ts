// THE NAME SLOT'S ONE DECISION, pinned.
//
// The interesting failures here are all SILENT ON SCREEN, which is why they are asserted rather than
// looked at:
//
//   · An unverified record rendering as a handle looks exactly like a verified one. That is the
//     defect the whole X-link feature exists to delete, and `linkFor` is the guard — this file
//     asserts that `namePlate` goes through it rather than reading the map itself.
//   · A pseudonym creeping back into the `none` case looks FINE. It looks like a populated column.
//     The property test at the bottom is the assertion form of the rule that forbids it, and it is
//     written over the whole plate rather than over one field, because a leak arriving through some
//     future field nobody thought to check is the only kind that gets in.
//
// The `LinkMap` is minted by `verifyAttestation` through `linkMapFrom`, never hand-built —
// `LinkRecord` is branded precisely so no test can invent one, and a fixture that cast its way past
// the brand would be a second implementation of the wire format agreeing with itself.

import { describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha256";
import { namePlate, plateText, type NamePlate } from "./namePlate.ts";
import { linkMapFrom, NO_LINKS, type LinkMap, type LinkRecord } from "./xLink.ts";
import { attestationKeyFrom, signAttestation } from "./xLinkSign.ts";
import { shortKey } from "../contract.ts";

const KEY = attestationKeyFrom(sha256(new TextEncoder().encode("namePlate.test key")));
const NOW = 1_800_000_000;

/** 44 base58 characters. The alphabet excludes `0`, `O`, `I` and `l` and `verifyAttestation` checks
 *  it, so a readable prefix is padded rather than spelled with the four ambiguous glyphs. */
const wallet = (prefix: string) => prefix.padEnd(44, "x");

const LINKED = wallet("LinkedWa11et");
const UNLINKED = wallet("Un1inkedWa11et");

/** A verified `LinkMap`, minted the only way one can be: signed, then put through the real verifier. */
function linksOf(...claims: readonly { wallet: string; xId: string; handle: string }[]): LinkMap {
  const attestations = claims.map((c) =>
    signAttestation(
      { wallet: c.wallet, xId: c.xId, handle: c.handle, displayName: "", avatarPath: "", linkedAt: NOW - 86_400 },
      KEY,
      NOW,
    ),
  );
  const { links, rejected } = linkMapFrom({ links: attestations }, [KEY.publicKey], NOW);
  // A fixture that quietly failed verification would make the `none` assertions below pass for the
  // wrong reason: a correctly-unlinked wallet and a silently rejected record look identical, and
  // only one of them is what a given test meant to set up.
  if (rejected.length > 0) throw new Error(`fixture did not verify: ${rejected.join(", ")}`);
  if (links.size !== claims.length) throw new Error("fixture lost a record");
  return links;
}

const LINKED_MAP = linksOf({ wallet: LINKED, xId: "111000000000000001", handle: "blknoiz06" });

/** THE FORGERY, in the exact shape that gets past the compiler. A spread produces a value TypeScript
 *  accepts as a `LinkRecord` — the brand is a phantom property and copies carry it — but the runtime
 *  mint register is keyed on object identity, so the copy is not in it. This is `{ ...record, handle:
 *  "someoneElse" }` with the rename left off; the rename is what an attacker wants and the copy is
 *  what makes it possible. */
const FORGED_MAP: LinkMap = new Map<string, LinkRecord>([
  [LINKED, { ...(LINKED_MAP.get(LINKED) as LinkRecord) }],
]);

describe("namePlate", () => {
  it("gives an unlinked wallet no username at all", () => {
    expect(namePlate(NO_LINKS, UNLINKED, "unmarked")).toEqual({ kind: "none" });
  });

  it("gives a wallet absent from a non-empty map no username either", () => {
    // The ordinary state of most of a real board: the map has entries, just not this one.
    expect(namePlate(LINKED_MAP, UNLINKED, "unmarked")).toEqual({ kind: "none" });
  });

  it("gives a verified link its handle", () => {
    const plate = namePlate(LINKED_MAP, LINKED, "unmarked");
    expect(plate.kind).toBe("handle");
    expect(plateText(plate, shortKey(LINKED))).toBe("@blknoiz06");
  });

  it("renders a record that fails the verification guard as unlinked, never as a handle", () => {
    // The whole point: a copy is not a verified record, and the failure mode of getting this wrong is
    // an unearned identity that looks identical to an earned one.
    expect(namePlate(FORGED_MAP, LINKED, "unmarked")).toEqual({ kind: "none" });
  });

  describe("the reader's own row", () => {
    it("takes the name slot on a surface whose only orientation cue is that slot", () => {
      expect(namePlate(NO_LINKS, UNLINKED, "name-slot")).toEqual({ kind: "you" });
    });

    it("outranks the reader's OWN handle in that convention", () => {
      // Deliberate, and the one ranking decision this module makes. A linked reader looking for
      // their row in the arena roster is looking for `YOU`; their own handle is the single identity
      // on the page that tells them nothing they did not already know.
      expect(namePlate(LINKED_MAP, LINKED, "name-slot")).toEqual({ kind: "you" });
    });

    it("yields to the handle where the surface prints its own marker beside the slot", () => {
      // The leaderboards, the history table and the fighter inspector. Orientation is already paid
      // for by the `you` marker on the row, so the slot spends itself on identity instead.
      expect(namePlate(LINKED_MAP, LINKED, "beside").kind).toBe("handle");
    });

    it("still shows no username in that convention when the reader has not linked", () => {
      // `beside` is not a licence to invent something for the reader either — the rule is about
      // linked versus unlinked and applies to the reader's own row exactly as to everyone else's.
      expect(namePlate(NO_LINKS, UNLINKED, "beside")).toEqual({ kind: "none" });
    });
  });
});

describe("plateText", () => {
  it("falls back to the address rather than to an empty slot", () => {
    expect(plateText({ kind: "none" }, "7xKq…4ab")).toBe("7xKq…4ab");
  });

  it("says YOU", () => {
    expect(plateText({ kind: "you" }, "7xKq…4ab")).toBe("YOU");
  });

  it("never returns an empty string, for any plate", () => {
    // A text surface handed `""` prints a gap where an identity goes, which is the placeholder this
    // module exists to refuse. Asserted over every variant so a fourth one cannot be added without
    // answering the question.
    const plates: NamePlate[] = [
      { kind: "you" },
      { kind: "none" },
      { kind: "handle", link: LINKED_MAP.get(LINKED) as LinkRecord },
    ];
    for (const plate of plates) expect(plateText(plate, shortKey(UNLINKED))).not.toBe("");
  });
});

/* ------------------------------------------------------------------------------------------------
   THE ANONYMITY RULE, IN ASSERTION FORM.

   THIS IS THE TEST THE OPERATOR'S COMPLAINT PRODUCED, and it is deliberately stated as a property
   over arbitrary wallets rather than as an example, because an example only ever pins the pseudonym
   somebody already thought of. The property is the actual requirement:

       NOTHING WALLET-DERIVED SURVIVES INTO THE NAME SLOT OF AN UNLINKED ROW.

   If that holds, then no arrangement of wallets on a board can be told apart by their name slots —
   which is what makes it safe for the arena to field its own wallets alongside players'. The browser
   is not given that list and must not be able to reconstruct it, and a name slot that varied with
   the wallet is precisely a channel it could be reconstructed through. `linkFighters.ts`'s header
   carries the argument; this is the assertion.

   IT COMPARES SERIALISED BYTES, NOT FIELDS, for the reason `statusFile.test.ts` gives about the
   keeper's payload: a field-by-field check only catches a leak arriving through a field somebody
   thought to check, and the interesting leak is always the other kind.

   A DETERMINISTIC GENERATOR RATHER THAN A PROPERTY-TESTING DEPENDENCY. The repo has none, and one
   test does not justify one; a seeded LCG over the base58 alphabet gives the same coverage with a
   failure that reproduces exactly. The seed is fixed so a red run is a red run forever.
   ------------------------------------------------------------------------------------------------ */

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** A stream of distinct 44-character base58 wallets. Not `Math.random`: a property test that cannot
 *  be re-run on the input that failed it is a flake generator, not a test. */
function* wallets(seed: number, count: number): Generator<string> {
  let s = seed >>> 0;
  const next = () => (s = (s * 1_664_525 + 1_013_904_223) >>> 0);
  for (let i = 0; i < count; i++) {
    let w = "";
    for (let c = 0; c < 44; c++) w += BASE58[next() % BASE58.length];
    yield w;
  }
}

describe("the anonymity rule", () => {
  it("gives every unlinked wallet a byte-identical plate", () => {
    const reference = JSON.stringify(namePlate(NO_LINKS, UNLINKED, "unmarked"));
    for (const w of wallets(0x5eed_1234, 500)) {
      expect(JSON.stringify(namePlate(NO_LINKS, w, "unmarked")), w).toBe(reference);
    }
  });

  it("holds with a populated link map, so a linked board tells nothing about the unlinked rows", () => {
    // The realistic shape of a live round: a handful of identities in the map, and everyone else in
    // the state most of the board is always in. Their plates must still be indistinguishable from
    // each other and from the empty-map case.
    const reference = JSON.stringify(namePlate(NO_LINKS, UNLINKED, "unmarked"));
    for (const w of wallets(0x5eed_9876, 500)) {
      expect(JSON.stringify(namePlate(LINKED_MAP, w, "unmarked")), w).toBe(reference);
    }
  });

  it("holds in every convention", () => {
    // A surface's own layout must not become a side channel either: whatever `youCue` a caller
    // passes, two unlinked wallets still agree.
    for (const cue of ["unmarked", "name-slot", "beside"] as const) {
      const reference = JSON.stringify(namePlate(NO_LINKS, UNLINKED, cue));
      for (const w of wallets(0x5eed_abcd, 200)) {
        expect(JSON.stringify(namePlate(NO_LINKS, w, cue)), `${cue} · ${w}`).toBe(reference);
      }
    }
  });
});
