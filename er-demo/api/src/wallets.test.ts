import { describe, expect, it } from "vitest";
import { MAX_WALLETS_PER_QUERY } from "../../src/v2/data/xLink.ts";
import { parseWalletList } from "./wallets.ts";
import { wallet } from "./testKit.ts";

describe("parseWalletList", () => {
  it("accepts a single valid wallet", () => {
    expect(parseWalletList(wallet(1))).toEqual({ kind: "ok", wallets: [wallet(1)] });
  });

  it("accepts a comma-separated list and de-duplicates it", () => {
    // De-duplication is not politeness: a repeated wallet would produce a repeated attestation, and
    // `linkMapFrom`'s "last writer loses" rule counts the second one as `malformed`. Sending one
    // makes the client's rejection list mean something.
    const p = parseWalletList(`${wallet(1)},${wallet(2)},${wallet(1)}`);
    expect(p).toEqual({ kind: "ok", wallets: [wallet(1), wallet(2)] });
  });

  it("tolerates whitespace around entries", () => {
    // A trailing newline off a shell or a `join(", ")` on the client is not an attack, and there is
    // no boundary whitespace could shift — the split already happened.
    expect(parseWalletList(` ${wallet(3)} , ${wallet(4)} `)).toEqual({
      kind: "ok",
      wallets: [wallet(3), wallet(4)],
    });
  });

  it("REFUSES AN ABSENT PARAMETER — there is no enumeration route", () => {
    // THE MOST IMPORTANT TEST IN THIS FILE. §6.4: an absent `wallets` must be an error, not "return
    // everything". A bulk export nobody meant to build is one missing guard away, it never looks
    // like a bug, and by the time anybody notices the register has been scraped.
    expect(parseWalletList(undefined)).toEqual({
      kind: "rejected",
      reason: "missing",
      detail: "wallets is required",
    });
    expect(parseWalletList(null).kind).toBe("rejected");
  });

  it("refuses an empty parameter", () => {
    // `?wallets=` is the same intent as no parameter and must not become "everything" either.
    expect(parseWalletList("")).toEqual({ kind: "rejected", reason: "empty", detail: "wallets is empty" });
  });

  it("refuses a repeated parameter rather than guessing which copy was meant", () => {
    // `?wallets=a&wallets=b` reaches the parser as an array. Picking one would answer about half the
    // board and look like a working request.
    expect(parseWalletList([wallet(1), wallet(2)]).kind).toBe("rejected");
  });

  it(`refuses more than ${MAX_WALLETS_PER_QUERY} wallets`, () => {
    // Prevents one HTTP request costing an arbitrary amount of database. The limit is imported from
    // `xLink.ts`, not restated, so the client and the server cannot disagree about it.
    const many = Array.from({ length: MAX_WALLETS_PER_QUERY + 1 }, (_, i) => wallet(i + 1)).join(",");
    expect(parseWalletList(many)).toEqual({
      kind: "rejected",
      reason: "too-many",
      detail: `at most ${MAX_WALLETS_PER_QUERY} wallets`,
    });
  });

  it(`accepts exactly ${MAX_WALLETS_PER_QUERY} wallets`, () => {
    // The boundary in the other direction. A round holds 48 fighters, so an off-by-one here would
    // silently truncate a full lobby.
    const exact = Array.from({ length: MAX_WALLETS_PER_QUERY }, (_, i) => wallet(i + 1)).join(",");
    const p = parseWalletList(exact);
    expect(p.kind).toBe("ok");
    if (p.kind === "ok") expect(p.wallets).toHaveLength(MAX_WALLETS_PER_QUERY);
  });

  it("counts the raw list, not the de-duplicated one, against the limit", () => {
    // Otherwise ten thousand copies of one wallet pass a limit that exists to bound the REQUEST.
    const dupes = Array.from({ length: MAX_WALLETS_PER_QUERY + 1 }, () => wallet(1)).join(",");
    expect(parseWalletList(dupes)).toMatchObject({ kind: "rejected", reason: "too-many" });
  });

  it("refuses anything that is not a base58 ed25519 pubkey", () => {
    // Through `PublicKey`, so the ALPHABET and the decoded LENGTH are both checked. A character
    // class alone passes "1111", which would put a four-byte "pubkey" into a SQL parameter.
    for (const bad of [
      "not-base58!",           // outside the alphabet
      "0OIl",                  // the four characters base58 deliberately omits
      "1111",                  // valid alphabet, wrong length — the case a regex misses
      `${wallet(1)}extra`,     // valid prefix, too long
      "../../etc/passwd",      // path traversal, in case anyone ever interpolates one
      `${wallet(1)}\n${wallet(2)}`, // a newline smuggled into one entry
    ]) {
      expect(parseWalletList(bad), bad).toMatchObject({ kind: "rejected", reason: "not-base58" });
    }
  });

  it("refuses an empty element inside an otherwise valid list", () => {
    // `a,,b` is a client bug. Skipping it silently means the client keeps shipping it.
    expect(parseWalletList(`${wallet(1)},,${wallet(2)}`)).toMatchObject({ kind: "rejected", reason: "not-base58" });
  });
});
