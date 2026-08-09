// Unit tests for the one piece of gameLoop.ts that's pure and load-bearing for correctness (not just
// presentation): the wall-clock-to-step math. A silent divergence here from the on-chain pacing
// constants would mean the render layer plays events at the wrong pace relative to the fight the
// chain is actually running — worth a real assertion, not just "should work" from reading the code.
// That is not hypothetical: this file previously asserted against gameLoop's OWN copies of those
// constants, so it stayed green while both had gone stale against the deployed program. It now
// asserts against chain/constants.ts, the same values the instruction builders use.
import { describe, expect, test } from "vitest";
import { MAX_STEPS, stepsPerSecond, canonicalCursor } from "../chain/constants.ts";
import { playheadStep } from "./gameLoop.ts";

describe("playheadStep", () => {
  test("returns 0 before the fight has started (fightStartedAtMs === null)", () => {
    expect(playheadStep(null, Date.now(), 4)).toBe(0);
  });

  test("matches the on-chain canonical_cursor() at whole-second boundaries", () => {
    const start = 1_000_000;
    for (const fighters of [2, 4, 8, 16]) {
      expect(playheadStep(start, start, fighters)).toBe(0);
      for (const seconds of [1, 4, 17]) {
        expect(playheadStep(start, start + seconds * 1_000, fighters))
          .toBe(canonicalCursor(start / 1000, fighters, start / 1000 + seconds));
      }
    }
  });

  test("paces per fighter, not flat — a bigger lineup fights faster", () => {
    const start = 0;
    expect(playheadStep(start, 1_000, 2)).toBe(stepsPerSecond(2));
    expect(playheadStep(start, 1_000, 16)).toBe(stepsPerSecond(16));
    expect(playheadStep(start, 1_000, 16)).toBeGreaterThan(playheadStep(start, 1_000, 2));
  });

  test("interpolates smoothly between whole seconds (sub-step precision for animation only)", () => {
    const step = playheadStep(0, 500, 4); // half a second in
    expect(step).toBeCloseTo(stepsPerSecond(4) / 2, 5);
  });

  test("caps at MAX_STEPS no matter how much wall-clock time has elapsed — mirrors the chain's .min()", () => {
    const farInFuture = ((MAX_STEPS / stepsPerSecond(2)) + 60) * 1000;
    expect(playheadStep(0, farInFuture, 2)).toBe(MAX_STEPS);
  });

  test("never goes negative if nowMs is somehow before fightStartedAtMs (clock skew)", () => {
    expect(playheadStep(10_000, 0, 4)).toBe(0);
  });
});
