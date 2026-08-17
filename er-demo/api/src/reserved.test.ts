import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertNotReserved,
  isReservedHandle,
  isReservedXId,
  RESERVED_HANDLES,
  RESERVED_MOCK_X_IDS,
  ReservedXIdError,
} from "./reserved.ts";

/** The fixture the deny list exists because of. Read at test time only — a serverless function has
 *  no `public/` and a deny list that depends on a file being present is a deny list that fails open
 *  when the file is not. */
const FIXTURE = new URL("../../public/links.mock.json", import.meta.url);

describe("the reserved fixture ids", () => {
  it("covers every identity in public/links.mock.json", () => {
    // THE SYNC MECHANISM, and the reason the list can be a hardcoded constant without rotting. If
    // somebody adds a seventh mock identity, this goes red on their commit — not on the day a real X
    // account happens to collide with a demo one.
    const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as { identities: Array<{ xId: string }> };
    expect(fixture.identities.length).toBeGreaterThan(0);
    for (const { xId } of fixture.identities) {
      expect(RESERVED_MOCK_X_IDS.has(xId), `fixture x_id ${xId} is not in RESERVED_MOCK_X_IDS`).toBe(true);
    }
  });

  it("does not deny anything that is not a fixture id", () => {
    // A deny list that is too broad denies a real X account for no reason — a bug wearing the
    // costume of a safety measure.
    expect(isReservedXId("1234567890")).toBe(false);
    expect(isReservedXId("9990000000000007")).toBe(false);
    expect(isReservedXId("")).toBe(false);
  });
});

describe("enforcement", () => {
  it("throws on the write path rather than returning a boolean", () => {
    // Every caller's only correct response is to stop, and a boolean is a thing a caller can forget
    // to look at.
    const reserved = new Set(["42"]);
    expect(() => assertNotReserved("42", reserved)).toThrow(ReservedXIdError);
    expect(() => assertNotReserved("43", reserved)).not.toThrow();
  });

  it("answers with a plain boolean on the read path", () => {
    // The serve path must 404, and a 404 is what every other "we will not serve this" answer looks
    // like — a reserved id must not be distinguishable from an unknown one.
    expect(isReservedXId("42", new Set(["42"]))).toBe(true);
  });

  it("carries the offending id on the error for a log line", () => {
    const e = (() => {
      try {
        assertNotReserved("42", new Set(["42"]));
      } catch (err) {
        return err as ReservedXIdError;
      }
      throw new Error("expected a throw");
    })();
    expect(e.xId).toBe("42");
    expect(e.name).toBe("ReservedXIdError");
  });
});

describe("isReservedHandle", () => {
  it("refuses the site's own names", () => {
    // A fighter called `@bullsvsunicorns`, with a real avatar, on our own leaderboard, reads as US. That
    // is the same class of misrepresentation as §6.3's house-wallet rule.
    expect(isReservedHandle("bullsvsunicorns")).toBe(true);
    expect(isReservedHandle("bullsvunicorns")).toBe(true);
  });

  it("refuses handles that carry the operator's authority", () => {
    for (const handle of ["support", "admin", "moderator", "staff", "official", "security", "team", "help"]) {
      expect(isReservedHandle(handle)).toBe(true);
    }
  });

  it("folds case, because that is not a different identity", () => {
    // X handles are case-insensitive for the purposes of who you appear to be: `@Support` and `@support`
    // are different strings and the same impersonation.
    expect(isReservedHandle("SUPPORT")).toBe(true);
    expect(isReservedHandle("Admin")).toBe(true);
    expect(isReservedHandle("  support  ")).toBe(true);
  });

  it("is an EXACT match and not a substring test", () => {
    // The rejected alternative, asserted so nobody helpfully "improves" it: a shape rule would refuse
    // `@supporter`, `@teammate` and every other ordinary account belonging to the people this feature
    // exists for. Those refusals would be unexplainable to the player and invisible to us. The answer to
    // a creative impersonator is `scripts/xlink-suppress.ts`, which exists and is tested.
    for (const ordinary of ["supporter", "adminx", "teammate", "helpful", "unicorns", "bulls"]) {
      expect(isReservedHandle(ordinary)).toBe(false);
    }
  });

  it("is overridable for tests, like the id list", () => {
    expect(isReservedHandle("nobody", new Set(["nobody"]))).toBe(true);
    expect(isReservedHandle("support", new Set(["nobody"]))).toBe(false);
  });

  it("holds only lowercase entries, or the fold above would miss them", () => {
    // A capital letter in the list is an entry that can never match, and nothing would say so.
    for (const entry of RESERVED_HANDLES) expect(entry).toBe(entry.toLowerCase());
  });

  it("holds only handles X could actually issue", () => {
    // An entry longer than 15 characters or carrying a `-` is an entry no account can have, which is a
    // rule protecting nothing while looking like protection.
    for (const entry of RESERVED_HANDLES) expect(entry).toMatch(/^[a-z0-9_]{1,15}$/);
  });
});
