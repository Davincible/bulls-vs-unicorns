// WHAT IS TESTED HERE IS ONLY WHAT THE THREE CONSUMERS CANNOT TEST FOR THEMSELVES.
//
// `entryWindow.test.ts`, `useActions.test.ts` and `walletFault.test.ts` already drive `failedWith`
// hard, through their own classifiers, against both captured shapes — and a duplicate of that here
// would be three assertions saying the same thing in a place further from the decision. What is left
// is the seam underneath them: WHICH FIELDS of a thrown object are read at all, and what happens when
// the IDL is not there to be read. Both are invisible from a consumer's tests (a fixture that
// populates every field passes whatever subset the reader actually looks at) and both are exactly
// where this module's history of failure is: `isFightBehind` read `logs` and `message` and missed
// `transactionMessage`, which on the rollup is the ONLY populated field.

import { describe, expect, it } from "vitest";
import { errorCodeOf, errorText, failedWith } from "./programError.ts";
import { routerError } from "./chainErrorShapes.ts";

describe("errorText — which fields of a throw are read at all", () => {
  it("reads each of the four fields on its own, because each one alone really happens", () => {
    // ONE FIELD AT A TIME, and that is the point. A fixture with all four populated cannot tell a
    // reader that looks at one from a reader that looks at four — and the difference between those
    // two readers is the difference between working in a test and working in the browser.
    expect(errorText({ message: "a" })).toContain("a");
    expect(errorText({ transactionMessage: "b" })).toContain("b");
    expect(errorText({ logs: ["c"] })).toContain("c");
    expect(errorText({ transactionLogs: ["d"] })).toContain("d");
  });

  it("finds the rollup's only signal, which lives in the two message fields and nowhere else", () => {
    // The regression that would put us back where we started: `transactionLogs` is `undefined` on
    // this shape, so a reader keyed on logs sees an empty string and every classifier answers "no".
    const text = errorText(routerError("0x1786"));
    expect(text).toContain("custom program error: 0x1786");
  });

  it("takes a thrown string as itself, since not everything that throws builds an Error", () => {
    expect(errorText("Error Code: FightBehind.")).toBe("Error Code: FightBehind.");
  });

  it("yields an empty string for anything with no text in it, rather than inventing one", () => {
    // `String(e)` here would hand back `"[object Object]"` or `"Error"` and every matcher downstream
    // would be reading a value nobody produced — the failure `walletFault.ts`'s `readThrown` records
    // at length. Empty is the honest answer.
    for (const junk of [null, undefined, 0, false, {}, [], Symbol("x")]) {
      expect(errorText(junk), String(junk)).toBe("");
    }
    expect(errorText({ logs: "not an array" })).toBe("");
    expect(errorText({ logs: [1, 2, null] })).toBe("");
  });
});

describe("errorCodeOf — reading the number off the deploy instead of writing it down", () => {
  const ERRORS = [
    { code: 6002, name: "NotInLobby" },
    { code: 6022, name: "FightBehind" },
  ];

  it("finds a name the IDL carries", () => {
    expect(errorCodeOf(ERRORS, "FightBehind")).toBe(6022);
  });

  it("gives up rather than guessing, in all three ways the IDL can fail to answer", () => {
    // ALL THREE ARE REAL AND ONE OF THEM IS PERMANENT. No IDL at all (`loadIdl()` rejected); an IDL
    // whose `errors` array does not name this error (a program revision behind the client); and — the
    // permanent one — an error that belongs to a DIFFERENT crate, which is `SessionError::InvalidToken`
    // and is why `walletFault.ts` has to write its number down and pin it in its own test instead.
    expect(errorCodeOf(undefined, "FightBehind")).toBeUndefined();
    expect(errorCodeOf(ERRORS, "LobbyClosed")).toBeUndefined();
    expect(errorCodeOf(ERRORS, "InvalidToken")).toBeUndefined();
  });
});

describe("failedWith — the part every consumer depends on and none of them can prove alone", () => {
  it("refuses the hex form when the code is unknown, instead of matching some other error", () => {
    // THE DEGRADATION RULE, and it is a safety property rather than a nicety. With no number, the
    // only honest reading of a bare `custom program error: 0x1786` is "I do not know what this is" —
    // guessing would have the page act on whatever variant happens to sit at that index today.
    expect(failedWith(errorText(routerError("0x1786")), "FightBehind", undefined)).toBe(false);
    expect(failedWith("Error Code: FightBehind.", "FightBehind", undefined)).toBe(true);
  });

  it("anchors every form, so a number loose in unrelated text is not a program error", () => {
    // A signature, a slot and a lamport figure all contain digits. `entryWindow.ts` learned this as a
    // near miss; it is pinned here so all three consumers inherit it.
    expect(failedWith("Transaction 3n6022Kq failed after 6022 slots", "FightBehind", 6022)).toBe(false);
    expect(failedWith("balance 1786 lamports", "FightBehind", 6022)).toBe(false);
  });

  it("matches the whole variant name and not a prefix of it", () => {
    expect(failedWith("Error Code: FightBehindBy.", "FightBehind", 6022)).toBe(false);
    expect(failedWith("Error Code: FightBehind.", "FightBehind", 6022)).toBe(true);
  });

  it("lets a name that IS there OVERRULE a colliding number, which is the base layer's whole value", () => {
    // THE HOLE AN UNCONDITIONAL OR WOULD LEAVE, and the reason this function is not three `test`s
    // joined by `||`. On the base layer all three forms are in ONE text: Anchor's log line carries
    // the name AND the number, and the RPC's sentence carries the hex. The numbers collide across
    // crates — `SessionError::InvalidToken` and `ArenaError::RoundOutOfOrder` are BOTH 6001 and both
    // `0x1771` — so a number-first reading would call a `RoundOutOfOrder` refusal a lapsed session
    // while the very same line says otherwise two words earlier. `verify-session-base.mjs` calls the
    // name "the only unambiguous evidence of which one fired"; this is that, enforced.
    const roundOutOfOrder =
      "Program log: AnchorError thrown in lib.rs:1558. Error Code: RoundOutOfOrder. " +
      "Error Number: 6001. Error Message: rounds must open in sequence.\n" +
      "Program ECD1dX2fUSGVY25y2cHWHWXYUQr9XzfFdTxcMzHj7zKe failed: custom program error: 0x1771";
    expect(failedWith(roundOutOfOrder, "InvalidToken", 6001)).toBe(false);
    // And the same text still answers YES to the error it actually names.
    expect(failedWith(roundOutOfOrder, "RoundOutOfOrder", 6001)).toBe(true);
  });

  it("consults the number only where there is NO name, which is the rollup and nowhere else", () => {
    // The `Error Number:` branch, isolated. Every other test in this repo that reaches it also
    // carries the name or the hex, so this is the one place it is exercised on its own — and it is
    // the branch the collision above lives in.
    expect(failedWith("Error Number: 6022.", "FightBehind", 6022)).toBe(true);
    expect(failedWith("Error Number: 6013.", "FightBehind", 6022)).toBe(false);
  });

  it("reads the hex case-insensitively, because nothing guarantees which case an RPC uses", () => {
    expect(failedWith("custom program error: 0X1786", "FightBehind", 6022)).toBe(true);
  });

  it("does not read one hex code as a prefix of a longer one", () => {
    // THE SINGLE PROPERTY THE WHOLE HEX MATCH HANGS ON, and it was untested. `\b` sits between a word
    // character and a non-word one, and every hex digit is a word character — so `0x1786` cannot
    // match inside `0x17860` or `0x1786a`. If that ever stopped being true, `FightBehind` would start
    // claiming errors numbered sixteen times higher and the page would grind fights it should not.
    expect(failedWith("custom program error: 0x17860", "FightBehind", 6022)).toBe(false);
    expect(failedWith("custom program error: 0x1786a", "FightBehind", 6022)).toBe(false);
    expect(failedWith("custom program error: 0x1786", "FightBehind", 6022)).toBe(true);
  });
});
