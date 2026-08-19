// THE CATCH-UP BURST, which is the one input to this canvas that nothing on screen can prepare you
// for and nothing in normal play produces.
//
// Background the tab during a fight and rAF stops while the playhead keeps running on wall clock, so
// the first frame back crosses the entire backlog in one callback — every event carrying the same
// `nowMs`, which defeats every millisecond-spaced throttle downstream, and every one of them firing
// a recoil and a flinch into bodies that then ricochet off the walls for a second.
//
// The rule is that the fight state still advances for all of them and only the tail is allowed to
// ANNOUNCE itself. These tests pin both halves of that, because the failure mode of getting the
// first half wrong is a desynced fight — a real defect that this file's whole design exists to
// prevent — and the failure mode of getting the second half wrong is invisible until somebody
// switches tabs.

import { describe, expect, it } from "vitest";
import type { HitEvent } from "../../sim/hitEvents.ts";
import { stepsPerSecond, type FighterView } from "../contract.ts";
import { MAX_FIGHTERS } from "../../sim/erSim.ts";
import { advanceReplay, createReplay } from "./replay.ts";

function fighters(n: number): FighterView[] {
  // No cast. It used to carry one, which is what let this fixture drift out of `FighterView`'s shape
  // — it was short two fields by the time the pseudonym was removed, and the cast is why nothing said
  // so. Every field is spelled out instead, so a change to the type breaks here loudly.
  return Array.from({ length: n }, (_, i): FighterView => ({
    id: i,
    wallet: `w${i}`,
    short: `w${i}`,
    side: (i % 2) as 0 | 1,
    avatarSrc: null,
    isYou: i === 0,
    stake: 1_000_000n,
    hp: 1_000_000n,
    banked: 0n,
    dead: false,
  }));
}

/** `count` exchanges, one per step, each moving one unit between two fighters on opposite sides. */
function stream(count: number): HitEvent[] {
  return Array.from({ length: count }, (_, i) => ({
    step: BigInt(i),
    attackerId: i % 2,
    defenderId: (i % 2) + 1,
    amount: 1n,
  }));
}

describe("advanceReplay", () => {
  it("applies EVERY event of a burst, however many it announces", () => {
    // The half that must never bend. A thousand events crossed in one frame have to leave the shadow
    // in exactly the state a thousand separate frames would have, or the canvas is showing a
    // different fight from the one the chain settles.
    const cast = fighters(4);
    const events = stream(1000);
    const state = createReplay(cast);
    advanceReplay(state, events, 9999, () => {});

    expect(state.cursor).toBe(1000);
    // 500 blows from slot 0 onto slot 1, and 500 from slot 1 onto slot 2.
    expect(state.shadow[0].banked).toBe(500n);
    expect(state.shadow[1].banked).toBe(500n);
    expect(state.shadow[1].hp).toBe(1_000_000n - 500n);
    expect(state.shadow[2].hp).toBe(1_000_000n - 500n);
    // Conservation, restated here rather than trusted: a burst must not create or destroy value.
    const total = state.shadow.reduce((a, f) => a + f.hp + f.banked, 0n);
    expect(total).toBe(4_000_000n);
  });

  it("announces only the tail of a burst", () => {
    const state = createReplay(fighters(4));
    const events = stream(1000);
    const announced: number[] = [];
    advanceReplay(state, events, 9999, (event, announce) => {
      if (announce) announced.push(Number(event.step));
    });
    // A handful, and they are the LAST ones — the fighters' positions are current as of this frame,
    // so the marks that survive are the ones whose geometry is still true.
    expect(announced).toEqual([997, 998, 999]);
  });

  // The guard against over-correcting. A throttle that fired in NORMAL play would silently delete the
  // flourish this whole pass exists to add, so the threshold is checked against the real pace rather
  // than against a comfortable one.
  //
  // SWEPT ACROSS THE LINEUP RANGE, AND THE RATE IS DERIVED, because the pace is `2n` steps a second
  // and `n` now goes to 48. This used to be a single case at sixteen fighters with `32` written out
  // beside it; sixteen is no longer the ceiling, and the ceiling is precisely where a per-frame
  // throttle is most likely to start biting — 48 fighters is 96 steps a second, i.e. 1.6 steps per
  // 60Hz frame against sixteen's 0.53, so some frames genuinely cross two events. That is the case
  // worth pinning, and it was the one not being run.
  // The sweep starts at 4, not at the program's floor of 2: `stream()` addresses fighter ids 1 and 2
  // as defenders, so a duel has nobody for it to hit. The floor is a property of this fixture, not of
  // the code under test, and the burst tests above already drive a 4-fighter cast.
  for (const count of [4, 16, MAX_FIGHTERS]) {
    it(`announces every event at the rate the chain produces them for ${count} fighters`, () => {
      const rate = stepsPerSecond(count);
      const state = createReplay(fighters(count));
      const events = stream(400);
      let announced = 0;
      let crossed = 0;
      // Enough frames for the playhead to pass the last event at every rate in the sweep.
      const frames = Math.ceil((400 * 60) / rate) + 60;
      for (let frame = 1; frame <= frames; frame++) {
        advanceReplay(state, events, (frame * rate) / 60, (_event, announce) => {
          crossed++;
          if (announce) announced++;
        });
      }
      expect(crossed).toBe(400);
      expect(announced).toBe(400);
    });
  }

  it("still announces a modest hitch in full", () => {
    // Three events in one frame is a ~200ms stall at the program's cap. That is a dropped frame or
    // two, not a backgrounded tab, and it should look like a busy moment rather than lose anything.
    const state = createReplay(fighters(4));
    let announced = 0;
    advanceReplay(state, stream(3), 9999, (_event, announce) => {
      if (announce) announced++;
    });
    expect(announced).toBe(3);
  });

  it("leaves the cursor where a later call can resume from", () => {
    const state = createReplay(fighters(4));
    const events = stream(20);
    advanceReplay(state, events, 4, () => {});
    expect(state.cursor).toBe(5);
    const seen: number[] = [];
    advanceReplay(state, events, 7, (event) => seen.push(Number(event.step)));
    expect(seen).toEqual([5, 6, 7]);
    expect(state.cursor).toBe(8);
  });
});
