// Unit tests for computeTargets — the pure half of the retarget() pattern (see this file's header
// comment). No Matter, no Pixi: just "given the cursor position and a lookahead window, who should
// each fighter be steering toward." Worth testing directly because a bug here (e.g. an off-by-one on
// the lookahead window, or the "nearer event wins" overwrite order) would silently make fighters
// steer toward the WRONG upcoming opponent — visually plausible but not actually matching what's
// about to happen, which defeats the entire point of this architecture.
import { describe, expect, test } from "vitest";
import { computeTargets } from "./retarget.ts";
import type { HitEvent } from "../../sim/hitEvents.ts";

function evt(step: number, attackerId: number, defenderId: number): HitEvent {
  return { step: BigInt(step), attackerId, defenderId, amount: 1n };
}

describe("computeTargets", () => {
  test("assigns both attacker and defender a target pointing at each other", () => {
    const events = [evt(0, 0, 2)];
    const targets = computeTargets(4, events, 0, 4);
    expect(targets[0]).toBe(2);
    expect(targets[2]).toBe(0);
    expect(targets[1]).toBeNull();
    expect(targets[3]).toBeNull();
  });

  test("only looks within [cursor, cursor + lookahead) — ignores events already resolved or too far ahead", () => {
    const events = [evt(0, 0, 1), evt(1, 2, 3), evt(2, 0, 3)];
    // cursor = 1, lookahead = 1: only events[1] (2 vs 3) is in the window.
    const targets = computeTargets(4, events, 1, 1);
    expect(targets).toEqual([null, null, 3, 2]);
  });

  test("a fighter with multiple upcoming events targets whoever's event is nearest the cursor", () => {
    // Fighter 0 fights 1 first (nearer), then 2 (further out) — within the lookahead window, the
    // nearer one should win, not the last one seen.
    const events = [evt(0, 0, 1), evt(1, 0, 2)];
    const targets = computeTargets(3, events, 0, 2);
    expect(targets[0]).toBe(1);
  });

  test("returns an all-null array when the lookahead window is empty (cursor at the end)", () => {
    const events = [evt(0, 0, 1)];
    const targets = computeTargets(3, events, 1, 4);
    expect(targets).toEqual([null, null, null]);
  });

  test("ignores an out-of-range id defensively rather than throwing", () => {
    const events = [evt(0, 0, 99)];
    expect(() => computeTargets(2, events, 0, 4)).not.toThrow();
    const targets = computeTargets(2, events, 0, 4);
    expect(targets[0]).toBe(99); // recorded as-is; steer() is what skips a target with no live body
    expect(targets[1]).toBeNull();
  });
});
