// The URL flags, parsed.
//
// These decide the SHAPE of the provider tree (`?fixture=1` picks which hooks run at all) and the
// size of the fixture's round, so a parse that quietly returns the wrong thing is not a cosmetic
// bug — it is the wrong application. All three parsers are total functions over a query string,
// which is the only kind of input a user can hand-edit, so the cases here are the ones a person
// actually types.

import { describe, expect, it } from "vitest";
import { parseFightersFlag, parseFixtureFlag, parseRefFlag } from "./flags.ts";
import { DEFAULT_LINEUP, MAX_LINEUP, MIN_LINEUP } from "./fixtureLineup.ts";

describe("parseFixtureFlag", () => {
  it("is off unless asked for", () => {
    expect(parseFixtureFlag("")).toBe(false);
    expect(parseFixtureFlag("?ref=abc")).toBe(false);
  });

  it("is on for any value except the explicit off-switches", () => {
    // PRESENCE is the signal, per this parser's stated contract ("`0`/`false` are treated as off").
    // A bare `?fixture` and an empty `?fixture=` both parse to "" and are therefore ON — someone who
    // typed the parameter at all meant to turn it on, and the two explicit off-spellings are there
    // for the case where they meant otherwise.
    for (const s of ["?fixture=1", "?fixture=true", "?fixture=", "?fixture=yes", "?fixture"]) {
      expect(parseFixtureFlag(s), s).toBe(true);
    }
  });

  it("honours an explicit off, so a bookmarked link can turn itself back off", () => {
    expect(parseFixtureFlag("?fixture=0")).toBe(false);
    expect(parseFixtureFlag("?fixture=false")).toBe(false);
    expect(parseFixtureFlag("?fixture=FALSE")).toBe(false);
  });
});

describe("parseRefFlag", () => {
  it("needs a non-empty code", () => {
    expect(parseRefFlag("")).toBe(false);
    expect(parseRefFlag("?ref=")).toBe(false);
    expect(parseRefFlag("?ref=abc")).toBe(true);
  });
});

describe("parseFightersFlag", () => {
  it("defaults to the fixture's long-standing nine when unasked", () => {
    expect(parseFightersFlag("")).toBe(DEFAULT_LINEUP);
    expect(parseFightersFlag("?fixture=1")).toBe(DEFAULT_LINEUP);
    // The documented invocation for everyone else's screenshots — it must keep meaning nine.
    expect(parseFightersFlag("?fixture=1&ref=abc")).toBe(DEFAULT_LINEUP);
  });

  it("reads the program's ceiling off the documented URL", () => {
    expect(parseFightersFlag("?fixture=1&fighters=16")).toBe(MAX_LINEUP);
    expect(parseFightersFlag("?fighters=16&fixture=1")).toBe(MAX_LINEUP);
  });

  it("clamps out-of-range and falls back on junk", () => {
    expect(parseFightersFlag("?fighters=99")).toBe(MAX_LINEUP);
    expect(parseFightersFlag("?fighters=1")).toBe(MIN_LINEUP);
    expect(parseFightersFlag("?fighters=abc")).toBe(DEFAULT_LINEUP);
    expect(parseFightersFlag("?fighters=")).toBe(DEFAULT_LINEUP);
  });

  it("survives the parameter being repeated — first wins, and it is still a legal size", () => {
    const n = parseFightersFlag("?fighters=16&fighters=3");
    expect(n).toBeGreaterThanOrEqual(MIN_LINEUP);
    expect(n).toBeLessThanOrEqual(MAX_LINEUP);
    expect(n).toBe(16);
  });
});
