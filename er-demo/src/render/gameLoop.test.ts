// Unit tests for the one piece of gameLoop.ts that's pure and load-bearing for correctness (not just
// presentation): the wall-clock-to-step math. A silent divergence here from the on-chain
// `STEPS_PER_SECOND`/`MAX_STEPS` constants would mean the render layer plays events at the wrong
// pace relative to what a real `resolve()` call would actually settle — worth a real assertion, not
// just "should work" from reading the code.
import { describe, expect, test } from "vitest";
import { MAX_STEPS, playheadStep, STEPS_PER_SECOND } from "./gameLoop.ts";

describe("playheadStep", () => {
  test("returns 0 before the fight has started (fightStartedAtMs === null)", () => {
    expect(playheadStep(null, Date.now())).toBe(0);
  });

  test("matches the on-chain resolve() formula at whole-second boundaries: elapsed_seconds * STEPS_PER_SECOND", () => {
    const start = 1_000_000;
    expect(playheadStep(start, start)).toBe(0);
    expect(playheadStep(start, start + 1_000)).toBe(1 * STEPS_PER_SECOND);
    expect(playheadStep(start, start + 4_000)).toBe(4 * STEPS_PER_SECOND);
  });

  test("interpolates smoothly between whole seconds (sub-step precision for animation only)", () => {
    const start = 0;
    const step = playheadStep(start, 500); // half a second in
    expect(step).toBeCloseTo(STEPS_PER_SECOND / 2, 5);
  });

  test("caps at MAX_STEPS no matter how much wall-clock time has elapsed — mirrors resolve()'s .min()", () => {
    const start = 0;
    const farInFuture = ((MAX_STEPS / STEPS_PER_SECOND) + 60) * 1000; // 60s past when MAX_STEPS is reached
    expect(playheadStep(start, farInFuture)).toBe(MAX_STEPS);
  });

  test("never goes negative if nowMs is somehow before fightStartedAtMs (clock skew)", () => {
    expect(playheadStep(10_000, 0)).toBe(0);
  });
});
