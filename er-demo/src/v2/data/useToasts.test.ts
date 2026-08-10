// A RECEIPT NOBODY CAN FINISH READING IS NOT A RECEIPT — the whole of what `dismissMs` is for.
//
// The hook itself is not exercised here: this project has no React harness (see `useAutoDeploy.ts`'s
// note on why every decision worth trusting is a plain function), and there would be nothing to learn
// from a `setTimeout` anyway. What is worth pinning is the arithmetic, because it is the difference
// between the most important sentence this page can show somebody and a glimpse of it.

import { describe, expect, it } from "vitest";
import { MAX_DISMISS_MS, MIN_DISMISS_MS, dismissMs } from "./useToasts.ts";
import { entryRefusalCopy } from "./entryWindow.ts";
import { classifyWalletError } from "./walletFault.ts";

describe("dismissMs", () => {
  it("leaves a one-line receipt at the six seconds this page has always given it", () => {
    // Nothing regresses. "Deployed $20 to ANSEM" is read in under a second, and six seconds of it was
    // already generous — a floor rather than a formula is the right answer for the common case.
    for (const short of ["Deployed $20 to ANSEM", "Extracted", "Repeat deployed $25 into round 42"]) {
      expect(dismissMs(short), short).toBe(MIN_DISMISS_MS);
    }
  });

  it("gives the copy this whole feature exists for enough time to be read", () => {
    // THE CASE THAT PUT THIS FUNCTION HERE. Roughly forty-five words, carrying what is true, what it
    // cost and what to do next — SPEC.md's three clauses, which is why it cannot be shorter. At the
    // old flat six seconds a reader got about a third of it.
    const refusal = entryRefusalCopy("round-moved-on", 42n).detail;
    expect(dismissMs(refusal)).toBeGreaterThan(MIN_DISMISS_MS * 2);
    expect(dismissMs(refusal)).toBeLessThanOrEqual(MAX_DISMISS_MS);
  });

  it("gives `walletFault.ts`'s sentences the same room, which they always needed", () => {
    // Not a new problem and not one this feature introduced — every fault in that module is forty to
    // sixty words and every one of them was being cut off. Fixing the timeout fixes all of them.
    const fault = classifyWalletError({ code: 4001 }).detail;
    expect(dismissMs(fault)).toBeGreaterThan(MIN_DISMISS_MS);
  });

  it("never parks one message in a five-slot stack for longer than the ceiling", () => {
    expect(dismissMs("word ".repeat(5000))).toBe(MAX_DISMISS_MS);
  });

  it("returns a real number for text with nothing in it", () => {
    // `push("")` is reachable — `messageOf` and the verbatim re-throw path can both produce an empty
    // string — and `NaN` here would leave a toast on screen for the life of the tab.
    for (const empty of ["", "   ", "\n"]) {
      expect(dismissMs(empty), JSON.stringify(empty)).toBe(MIN_DISMISS_MS);
    }
  });

  it("grows with the message rather than stepping between two sizes", () => {
    // BOTH SAMPLES HAVE TO SIT STRICTLY INSIDE THE CLAMPS or this asserts nothing: the ceiling bites
    // at about 56 words, so a 60-word sample would be pinned to `MAX_DISMISS_MS` and the comparison
    // would still pass for a two-step function. 20 and 40 are both in the sloped region.
    const a = dismissMs("word ".repeat(20));
    const b = dismissMs("word ".repeat(40));
    expect(a).toBeGreaterThan(MIN_DISMISS_MS);
    expect(b).toBeLessThan(MAX_DISMISS_MS);
    expect(b).toBeGreaterThan(a);
  });
});
