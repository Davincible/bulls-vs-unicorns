import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertNotReserved, isReservedXId, RESERVED_MOCK_X_IDS, ReservedXIdError } from "./reserved.ts";

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
