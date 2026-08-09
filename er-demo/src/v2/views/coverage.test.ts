// The wording is the product here — these are the sentences three screens print instead of the word
// "all-time", so the cases worth pinning are the ones where the claim changes size.

import { describe, expect, it } from "vitest";
import type { LogCoverage } from "../contract.ts";
import { coverageFigure, coverageNote, coveragePhrase } from "./coverage.ts";

const complete: LogCoverage = { rounds: 12, roundsEverOpened: 12n, complete: true };
const windowed: LogCoverage = { rounds: 250, roundsEverOpened: 613n, complete: false };
const unknown: LogCoverage = { rounds: 4, roundsEverOpened: null, complete: false };

describe("coveragePhrase", () => {
  it("says all-time only when the log actually holds every round", () => {
    expect(coveragePhrase(complete)).toBe("across all 12 rounds this arena has run");
  });

  it("names both numbers when the log is a window, so the gap is visible", () => {
    expect(coveragePhrase(windowed)).toBe("across the newest 250 of 613 rounds this arena has run");
  });

  it("claims no denominator when there is none to claim", () => {
    expect(coveragePhrase(unknown)).toBe("across 4 rounds in the log");
    expect(coveragePhrase(unknown)).not.toContain("all");
  });

  it("agrees with itself about one round", () => {
    expect(coveragePhrase({ rounds: 1, roundsEverOpened: 1n, complete: true })).toBe(
      "across all 1 round this arena has run",
    );
  });
});

describe("coverageFigure", () => {
  it("prints a bare count when there is nothing to be a fraction of", () => {
    expect(coverageFigure(complete)).toBe("12");
    expect(coverageFigure(unknown)).toBe("4");
  });

  it("prints the window against the whole when they differ", () => {
    expect(coverageFigure(windowed)).toBe("250 of 613");
  });
});

describe("coverageNote", () => {
  it("counts the rounds a reader is NOT being shown", () => {
    expect(coverageNote(windowed)).toContain("363 older rounds are still on chain");
  });

  it("uses the singular for exactly one missing round", () => {
    expect(coverageNote({ rounds: 12, roundsEverOpened: 13n, complete: false })).toContain(
      "1 older round is still on chain",
    );
  });
});
