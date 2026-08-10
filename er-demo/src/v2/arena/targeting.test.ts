// THE DEFECT THIS FILE EXISTS TO PREVENT IS A STEERING ASSIGNMENT THAT IS A FUNCTION INSTEAD OF A
// MATCHING — and the reason it needs a test file rather than a reviewer is that NOTHING ON SCREEN
// CHANGES WHEN IT REGRESSES.
//
// `targeting.ts` cannot alter which blows land, on whom, for how much, or when: `run_fight()` decided
// all of that by `hash(seed, step)` before the canvas drew a frame, and `replay.ts` owns the playhead.
// All this module picks is who walks toward whom in the meantime. So a broken version of it still
// plays the correct fight, still settles to the correct numbers, still passes every parity test in
// `sim/` — it just plays it with the two named fighters ~200 units apart at the instant their blow
// lands instead of ~100. That reads as "the animation is a little loose", which is exactly why the
// previous shape survived for the whole life of `render/arena/retarget.ts` and was only found when
// somebody instrumented the gap. A canvas defect that is invisible in review has to be caught by a
// number in CI or it is not caught at all.
//
// The old `computeTargets` swept the window BACK TO FRONT writing both sides of every event, so a
// nearer event silently overwrote half of an earlier pairing: `A↔B` at +900 and `A↔C` at +400 came
// out as `A→C, B→A, C→A`, and B chased A while A ran away. Reciprocity in that shape was an accident
// — it measured 39% (n=9) / 31% (n=16) — and a one-sided chase closes at the DIFFERENCE of two
// velocities rather than their sum, which is the whole 200-unit gap. The rewrite replaced it with an
// appointment book, and every test below pins one property of that book:
//
//   RECIPROCITY is the invariant the rewrite exists to establish, so it gets measured, not asserted
//     structurally — a synthetic round-robin scores 100% under both the old and the new sweep and
//     would have proved nothing. The ratchet below drives a real seeded `runFullFight` stream at
//     60fps and fails if the field drops back toward the old regime.
//   THE TRAVEL FLOOR is what makes an appointment KEEPABLE, and its waiver is what lets a pair who
//     keep drawing each other trade several blows where they stand. Getting the floor wrong sends
//     fighters to blows they cannot reach; getting the waiver wrong marches a duelling pair back and
//     forth across the field between exchanges.
//   A FIGHTER WHO LEAVES must free both halves of its state. Freeing the hold but not the
//     appointment leaves a live fighter marked busy until a blow that will never be struck — it
//     cannot be re-booked, so it stands and drifts. `render/arena/retarget.ts` and `replay.ts` both
//     record the extracted-fighter-still-being-targeted failure from their own end.
//   A BACKGROUNDED TAB is the same event `replay.test.ts` handles from the opposite side. There, the
//     rule is that a burst still advances the whole fight and only its tail may ANNOUNCE itself;
//     here, the rule is that a `nowMs` that jumped by thirty seconds needs no catch-up branch at all,
//     because every appointment is now in the past and one ordinary sweep re-books the field. The
//     failure mode of getting either wrong is invisible until somebody switches tabs.
//
// TWO THINGS THIS FILE DELIBERATELY DOES NOT DO. It never re-implements the sweep to predict an
// answer — the same point `replay.test.ts` makes about `applyHitEvent` — so every expectation below
// is either a small fixture a reader can work out by hand or a property measured through `assign`
// itself. And it never asserts the VALUE of a tuned constant: `CROSSING_MS` is private to
// `targeting.ts`, so the floor is MEASURED through the front door and only its properties are pinned
// (it exists, it is single-valued, it clears `field.ts`'s windup, it fits inside the lookahead). A
// retune moves the measured number and the file stays green; a retune that broke the scheme does not.

import { describe, expect, it } from "vitest";
import type { HitEvent } from "../../sim/hitEvents.ts";
import { runFullFight } from "../../sim/hitEvents.ts";
import { buildLineup } from "../data/fixtureLineup.ts";
import { stepsPerSecond } from "../contract.ts";
// `lookaheadFor` used to be imported here by the two tests that asserted the lead was the NEAREST
// window blow. That behaviour is gone — the lead is now `bookedAt - nowMs`, the blow the fighter was
// actually sent to — so the tests went with it and the import stopped being read. `tsc` catches this
// where the test run does not: 1,593 tests pass either way, and only `noUnusedLocals` notices that a
// symbol nothing reads is still being pulled in.
import { CROSSING_MS, createTargetTracker } from "./targeting.ts";

/** `field.ts`: `const WINDUP_MS = 300` — how long before a blow the field starts rearing back, and
 *  the number `targeting.ts`'s `CROSSING_MS` note undertakes to stay clear of. Restated here rather
 *  than imported, the way `impact.test.ts` restates the program's roll range: this is a claim about
 *  another module that a test should notice breaking, not a dependency to inherit. */
const WINDUP_MS = 300;

/** The lookahead window measured against real streams in `lookaheadFor`'s own note: 2.0s at two
 *  fighters, 2.9s at sixteen. A travel floor at or beyond the short end of that would put every
 *  appointment outside the window and book nothing, ever. */
const SHORTEST_LOOKAHEAD_MS = 2000;

/** The chain's own pace, so a lead in milliseconds can be turned into the whole step the event
 *  stream actually carries. `stepsPerSecond(n) = 2n`, so this is 125ms at four fighters. */
function msPerStep(count: number): number {
  return 1000 / stepsPerSecond(count);
}

function evt(step: number, a: number, d: number): HitEvent {
  return { step: BigInt(step), attackerId: a, defenderId: d, amount: 1n };
}

/** An ordered stream built from LEADS IN MILLISECONDS ahead of a playhead of 0, because every rule in
 *  `targeting.ts` is expressed in milliseconds and a fixture written in steps would need the reader
 *  to do the conversion before the expectation made sense. Throws rather than rounding: a fixture
 *  that quietly lands 8ms from where it reads is worse than no fixture at all. */
function blows(count: number, list: { at: number; a: number; d: number }[]): HitEvent[] {
  const per = msPerStep(count);
  return list.map(({ at, a, d }) => {
    const step = at / per;
    if (!Number.isInteger(step)) {
      throw new Error(`a lead of ${at}ms is not a whole step at ${count} fighters (${per}ms per step)`);
    }
    return evt(step, a, d);
  });
}

/** Byte 0..31 of a seed that is not the parity fixture's, so these numbers are not a second reading
 *  of a stream some other test already fixes in place. */
const SEED = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 7) % 251));

/** THE REAL THING: the hash-picked fight the canvas is a visualisation of, at the fixture lineup this
 *  module was tuned against. Deterministic — same seed, same lineup, same stream, every run. */
function fight(count: number, steps: number): HitEvent[] {
  return runFullFight(SEED, buildLineup(count).entries, steps).events;
}

/** The loop and the replay, reduced to what the tracker can see. `nowMs` is the only input: the
 *  playhead is derived from it exactly as `arenaLoop` derives it, the cursor is where `advanceReplay`
 *  would have left it, and liveness is read off hp the events themselves have already taken down. A
 *  lead measured through this driver is therefore a lead the field would really have had.
 *
 *  Frames are ADVANCED BY CALLING IT, not by a loop inside it, because a backgrounded tab is exactly
 *  a caller that skips thirty seconds of calls while the replay catches up on wall clock. */
function replayDriver(count: number, events: HitEvent[]) {
  const per = msPerStep(count);
  const hp = buildLineup(count).entries.map((e) => e.stake);
  const tracker = createTargetTracker();
  let cursor = 0;
  return {
    leads: () => tracker.leadMs,
    cursorNow: () => cursor,
    playheadAt: (nowMs: number) => nowMs / per,
    /** Liveness as the driver has it, which is what the tracker was told on the last frame. */
    isDeadNow: (id: number) => hp[id] <= 0n,
    frameAt(nowMs: number): (number | null)[] {
      const playhead = nowMs / per;
      while (cursor < events.length && Number(events[cursor].step) <= playhead) {
        const e = events[cursor];
        hp[e.defenderId] -= e.amount;
        cursor++;
      }
      return tracker.assign(count, events, cursor, playhead, nowMs, (id) => hp[id] <= 0n);
    },
  };
}

/** How many of this frame's links are steered at from BOTH ends — the only links that close at the
 *  sum of two velocities. */
function mutualLinks(held: readonly (number | null)[]): number {
  return held.reduce<number>((n, partner, id) => (partner !== null && held[partner] === id ? n + 1 : n), 0);
}

function heldLinks(held: readonly (number | null)[]): number {
  return held.reduce<number>((n, partner) => (partner === null ? n : n + 1), 0);
}

const FRAME_MS = 1000 / 60;
const NOBODY_IS_DEAD = () => false;

describe("the appointment book", () => {
  it("books both halves of the nearest KEEPABLE blow, not the nearest blow", () => {
    // The exact configuration the old back-to-front sweep tore in half, rounded to whole steps at
    // three fighters: `A↔C` at +500ms and `A↔B` at +1000ms. The old shape produced `A→C, B→A, C→A`
    // — B chasing an A that is running away — and the assertion that matters is that A stays with B.
    //
    // C→A is not a leftover of that bug. C has no keepable appointment of its own, and the module's
    // second sweep hands a fighter with NOBODY a one-sided aim at its nearest event on purpose: a
    // fighter drifting on `WANDER_SPEED` in the middle of a brawl is a worse picture than a fighter
    // chasing somebody. It is asserted here so that a future reader does not "fix" it.
    const tracker = createTargetTracker();
    const held = tracker.assign(
      3,
      blows(3, [
        { at: 500, a: 0, d: 2 },
        { at: 1000, a: 0, d: 1 },
      ]),
      0,
      0,
      0,
      NOBODY_IS_DEAD,
    );
    expect(held).toEqual([1, 0, 0]);
  });

  it("skips an event whose fighter a sooner appointment already claimed, rather than overwriting it", () => {
    // Three overlapping blows: 0↔1 at +750, 0↔2 at +875, 2↔3 at +1000. Forward order is what makes
    // this a matching — 0 is taken by the soonest of them, so the middle event finds 0 busy and must
    // yield, which leaves 2 free for the blow after it. Every fighter ends up mutually paired.
    //
    // Under the old sweep the middle event was the LAST write for fighter 0 and won, leaving
    // `0→2, 1→0, 2→3, 3→2`: fighter 1 chasing a fighter who has gone somewhere else.
    const tracker = createTargetTracker();
    const held = tracker.assign(
      4,
      blows(4, [
        { at: 750, a: 0, d: 1 },
        { at: 875, a: 0, d: 2 },
        { at: 1000, a: 2, d: 3 },
      ]),
      0,
      0,
      0,
      NOBODY_IS_DEAD,
    );
    expect(held).toEqual([1, 0, 3, 2]);
  });

  it("lets the SOONEST keepable blow claim the pair, not the last one in the window", () => {
    // Forward order is the difference between a matching and the old overwrite, and it is worth a
    // fixture of its own because a sweep can be reversed and still produce a perfectly reciprocated
    // answer — just the wrong one. Both blows here are keepable and they share fighter 1: 1↔0 at
    // +1000 and 1↔2 at +1500.
    //
    // Fighter 1 must be steering at 0. Sweeping the other way books 1 for the LATER blow, and the
    // picture that produces is a fighter walking away from a blow landing on it in a second toward
    // one that is half a second behind that — every appointment kept at the cost of the sooner one,
    // which is the opposite of what the book is for.
    const tracker = createTargetTracker();
    const held = tracker.assign(
      3,
      blows(3, [
        { at: 1000, a: 0, d: 1 },
        { at: 1500, a: 1, d: 2 },
      ]),
      0,
      0,
      0,
      NOBODY_IS_DEAD,
    );
    expect(held).toEqual([1, 0, 1]);
  });

  it("keeps four fifths of the field's links mutual across a whole seeded fight", () => {
    // THE RATCHET, and the one test here that is a measurement rather than a hand-checked fixture.
    // It has to be: reciprocity is a property of how the sweep behaves against a HASH-PICKED stream,
    // and a tidy synthetic fixture hides it — a round-robin of perfect matchings scores 100% under
    // the old back-to-front sweep too.
    //
    // Driven on the real thing (fixture lineup, seeded `runFullFight`, 30 seconds at 60fps, fighters
    // dying out of the stream as their hp reaches zero) this measures 87.1% at nine fighters and
    // 85.4% at sixteen. The same drive against `render/arena/retarget.ts`'s `computeTargets` — the
    // shape this module replaced — scores 57.0% and 50.6%. The bar sits between the two regimes and
    // is a floor to hold, not a target to hit: a change that legitimately trades a little reciprocity
    // for something else stays green, and a change that reverts to a function-on-the-fighters does
    // not.
    for (const count of [9, 16]) {
      const events = fight(count, 1500);
      const driver = replayDriver(count, events);
      let mutual = 0;
      let links = 0;
      for (let frame = 0; frame < 1800; frame++) {
        const held = driver.frameAt(frame * FRAME_MS);
        mutual += mutualLinks(held);
        links += heldLinks(held);
      }
      // Guard the denominator first. An `assign` that returned all nulls would have a perfect
      // reciprocity ratio and steer nobody, so the field must actually be aimed at something.
      expect(links).toBeGreaterThan(1800 * count * 0.9);
      expect(mutual / links).toBeGreaterThan(0.75);
    }
  });

  it("hands back the same array every frame, and a new one only when the lineup resizes", () => {
    // Documented on `assign`, and load-bearing for every multi-frame test in this file: the returned
    // array is the tracker's own and is rewritten in place. A caller that stashed it would be reading
    // this frame's answer out of last frame's variable — and a test that forgot it would compare an
    // array against itself and pass no matter what the tracker did.
    const tracker = createTargetTracker();
    const events = blows(4, [{ at: 875, a: 0, d: 1 }]);
    const first = tracker.assign(4, events, 0, 0, 0, NOBODY_IS_DEAD);
    expect(tracker.assign(4, events, 0, 0, FRAME_MS, NOBODY_IS_DEAD)).toBe(first);
    expect(tracker.assign(3, events, 0, 0, 2 * FRAME_MS, NOBODY_IS_DEAD)).not.toBe(first);
  });
});

describe("the travel floor", () => {
  /** Does a blow `lead` ms away take a fighter who is already holding somebody else?
   *
   *  The observation has to be set up this way round because a fighter holding NOBODY is aimed by the
   *  second sweep whatever the lead is, so an empty tracker cannot tell a booking from a fallback.
   *  Fighter 0 arrives already paired with 1 and free of its appointment; a blow that can take it
   *  away is a blow that was BOOKED. */
  function booksAcross(lead: number): boolean {
    const count = 4;
    const tracker = createTargetTracker();
    tracker.assign(count, blows(count, [{ at: 875, a: 0, d: 1 }]), 0, 0, 0, NOBODY_IS_DEAD);
    // One event offering fighter 0 a different partner, `lead` ms out. The playhead carries the
    // fraction — the replay's playhead is a float too, and sits strictly between two whole steps —
    // so any lead at all is expressible without inventing a fractional step the chain cannot emit.
    const step = 40;
    const playhead = step - lead / msPerStep(count);
    const held = tracker.assign(count, [evt(step, 0, 2)], 0, playhead, 1000, NOBODY_IS_DEAD);
    return held[0] === 2;
  }

  it("has a single floor, and it clears field.ts's windup without outrunning the lookahead", () => {
    // Measured through `assign` rather than read off `CROSSING_MS`, which is private to the module.
    // What is pinned is the SHAPE, not the number: sweeping the lead from 0 to 2.5s must cross from
    // "never books" to "always books" EXACTLY ONCE. One crossing is what makes the rule a floor; two
    // would mean some band of leads behaves specially, and none would mean the floor had been lost.
    const flips: number[] = [];
    let previous = booksAcross(0);
    for (let lead = 5; lead <= 2500; lead += 5) {
      const now = booksAcross(lead);
      if (now !== previous) flips.push(lead);
      previous = now;
    }
    expect(flips).toHaveLength(1);
    expect(booksAcross(0)).toBe(false);
    const floor = flips[0];

    // Above the windup is the property `CROSSING_MS`'s note claims and `field.ts` depends on: a
    // fighter must be standing at its target before the target's run-in begins, or the canvas shows
    // somebody rearing back at a bystander a third of a second before hitting someone else.
    expect(floor).toBeGreaterThan(WINDUP_MS);
    // And inside the window, or the sweep would find nothing it was allowed to book and the field
    // would fall back to one-sided aims on every frame — i.e. silently back to the old shape.
    expect(floor).toBeLessThan(SHORTEST_LOOKAHEAD_MS);
  });

  it("waives the floor for a pair already standing together", () => {
    // The floor is a TRAVEL budget, and two fighters at their standoff have no travel left to pay
    // for. Hash-picked pairs recur, so without the waiver a pair drawn twice in quick succession
    // would be refused the second blow as unreachable and sent across the field to separate
    // appointments between two exchanges they were already in position for.
    //
    // The fixture puts both readings on the same frame: 0 and 1 are already mutual and free, a 0↔1
    // blow lands inside the floor, and a 0↔2 blow outside it is there to take 0 away if the waiver
    // is not applied. Fighter 0 staying with 1 is the waiver; 2 being left with a one-sided aim is
    // the second sweep, as above.
    for (const near of [125, 375]) {
      const tracker = createTargetTracker();
      tracker.assign(4, blows(4, [{ at: 875, a: 0, d: 1 }]), 0, 0, 0, NOBODY_IS_DEAD);
      const held = tracker.assign(
        4,
        blows(4, [
          { at: near, a: 0, d: 1 },
          { at: 875, a: 0, d: 2 },
        ]),
        0,
        0,
        1000,
        NOBODY_IS_DEAD,
      );
      expect(held).toEqual([1, 0, 0, null]);
    }
  });

  it("does not waive it for a pair that merely has an appointment coming", () => {
    // The control for the test above, and the half that keeps the waiver from swallowing the floor:
    // the SAME sub-floor lead, between fighters who are not already together, must not book. 0 keeps
    // the partner it had rather than setting off for a blow it cannot reach — the whole point being
    // that skipping an unreachable appointment costs nothing, since that blow was landing at range
    // whatever the steering did, while the next one need not.
    expect(booksAcross(125)).toBe(false);
    expect(booksAcross(375)).toBe(false);
  });
});

describe("a fighter who leaves", () => {
  // Both frames of both readings are identical except for `isDead`, so the difference between them is
  // attributable to nothing else.
  const setup = () => {
    const tracker = createTargetTracker();
    tracker.assign(4, blows(4, [{ at: 3000, a: 0, d: 1 }]), 0, 0, 0, NOBODY_IS_DEAD);
    return tracker;
  };
  const nextFrame = blows(4, [
    { at: 750, a: 0, d: 2 },
    { at: 1000, a: 2, d: 3 },
  ]);

  it("frees the corpse's hold AND the appointment that hold was keeping", () => {
    // Fighter 1 is booked against 0 for a blow three seconds out and is then extracted. Nulling 0's
    // hold without clearing its `bookedAt` would leave 0 marked BUSY until an appointment that can
    // never come due, so it could not be re-booked for three seconds — it would take a one-sided aim
    // from the fallback and stand there in the middle of a brawl.
    //
    // The tell is fighter 2, not fighter 0: the fallback would aim 0 at 2 either way. If 0's
    // appointment was really released it wins the +750 blow and 2 is booked back at it, which pushes
    // 3 out to a one-sided aim. If it was not, 0 is skipped, 2↔3 takes the +1000 blow instead, and 2
    // is holding 3.
    const held = setup().assign(4, nextFrame, 0, 0, FRAME_MS, (id) => id === 1);
    expect(held).toEqual([2, null, 0, 2]);
  });

  it("keeps the appointment when nobody has left", () => {
    // The control. Same tracker, same frame, everybody alive: 0 and 1 are still busy until +3000, so
    // the +750 blow finds 0 unavailable and 2↔3 gets the later one.
    const held = setup().assign(4, nextFrame, 0, 0, FRAME_MS, NOBODY_IS_DEAD);
    expect(held).toEqual([1, 0, 3, 2]);
  });

  it("never steers anybody at a fighter the chain has taken out, across a whole fight", () => {
    // The property the two fixtures above are instances of, checked against a real fight rather than
    // a hand-driven predicate: the fighter that dies here dies because the stream's own amounts took
    // its hp to zero, at the step the chain decided it would. A body that has been finished off is
    // removed from the canvas, so anything still steering at it is steering at a hole in the field.
    //
    // FORTY-FIVE SECONDS, not thirty, and the guard at the bottom is why. On this seed the first
    // fighter falls at 39.1s — damage is a percentage of remaining hp, so the early exchanges are
    // huge and the last of them are dust — and a shorter drive asserts the whole property against a
    // fight in which nobody has died yet, i.e. passes without ever testing anything.
    const count = 9;
    const driver = replayDriver(count, fight(count, 1500));
    let deadFrames = 0;
    for (let frame = 0; frame < 2700; frame++) {
      const held = driver.frameAt(frame * FRAME_MS);
      for (let id = 0; id < count; id++) {
        if (driver.isDeadNow(id)) {
          deadFrames++;
          expect(held[id]).toBeNull();
        }
        expect(held[id]).not.toBe(id);
        if (held[id] !== null) expect(driver.isDeadNow(held[id] as number)).toBe(false);
      }
    }
    expect(deadFrames).toBeGreaterThan(0);
  });
});

describe("a new lineup", () => {
  it("starts a differently-sized round from nothing", () => {
    // The state is flat arrays indexed by fighter id, so a round with a different count that reused
    // them would be reading the last round's pairings — including ids past the end of the new table.
    // An EMPTY window is what makes this conclusive: there is nothing for the sweep to write, so
    // anything non-null in the answer could only have survived the resize.
    const tracker = createTargetTracker();
    const opening = tracker.assign(
      4,
      blows(4, [
        { at: 875, a: 0, d: 1 },
        { at: 1000, a: 2, d: 3 },
      ]),
      0,
      0,
      0,
      NOBODY_IS_DEAD,
    );
    expect(opening).toEqual([1, 0, 3, 2]);

    const smaller = tracker.assign(3, [], 0, 0, FRAME_MS, NOBODY_IS_DEAD);
    expect(smaller).toEqual([null, null, null]);
    expect(tracker.leadMs).toEqual([Infinity, Infinity, Infinity]);

    // And growing, where the failure would be a hole rather than a stale id: the new slot has to be
    // a real `null` the loop can test, not `undefined` off the end of a short array.
    const larger = tracker.assign(5, [], 0, 0, 2 * FRAME_MS, NOBODY_IS_DEAD);
    expect(larger).toEqual([null, null, null, null, null]);
    expect(tracker.leadMs).toHaveLength(5);
  });
});

describe("a malformed stream", () => {
  it("ignores ids off the end of the table and a fighter named against itself", () => {
    // `hitEvents` comes from the chain's own `tick()` and should never contain either of these. It is
    // checked anyway because the stream is RECOMPUTED after an `extract()` against a lineup this
    // module may not have been told about yet, and the cost of being wrong is not a bad frame — an
    // id of 9 in a table of 4 indexes past the end of every flat array here and past the end of the
    // body list in `field.ts`, and a fighter booked against itself is booked forever.
    //
    // The valid blow at the end must still be found, which is the real assertion: a malformed entry
    // has to be SKIPPED, not treated as consuming the fighters it names.
    const tracker = createTargetTracker();
    const held = tracker.assign(
      4,
      blows(4, [
        { at: 625, a: 1, d: 1 },
        { at: 750, a: 0, d: 9 },
        { at: 875, a: 3, d: -1 },
        { at: 1000, a: 0, d: 1 },
      ]),
      0,
      0,
      0,
      NOBODY_IS_DEAD,
    );
    expect(held).toEqual([1, 0, null, null]);
    expect(tracker.leadMs).toEqual([1000, 1000, Infinity, Infinity]);
  });
});

describe("a backgrounded tab", () => {
  it("comes back as well matched as a tab that never slept, in one ordinary sweep", () => {
    // rAF stops while the playhead runs on wall clock, so the first frame back arrives with `nowMs`
    // jumped by however long the tab was hidden and a cursor that has crossed hundreds of events —
    // `replay.ts` describes the same instant as a thousand events on one frame. Every appointment is
    // now in the past, so every fighter is free and the ordinary sweep re-books the field against the
    // window the replay has caught up to. There is no catch-up branch here, and this is the test that
    // says none is needed.
    //
    // TWO TRACKERS, ONE STREAM, and the comparison is the whole test. Both reach 40s on the same
    // playhead, the same cursor and the same casualty list; one was called on all 2400 frames and one
    // slept through 2100 of them. The claim is NOT that they agree — a hold is history and the
    // sleeper has none for the missing 35 seconds, so their arrays differ and should — but that the
    // sleeper is no worse MATCHED, because the matching is rebuilt from the window rather than
    // carried. Measured: 6 of 9 mutual on both (one fighter is dead by then), and 14 of 16 on both.
    //
    // A per-frame mutual count is the right yardstick and an absolute floor is not: reciprocity runs
    // at 81-87% over a fight, not 100%, and a fighter whose only upcoming blow is inside the travel
    // floor, or whose partner is already booked, correctly has no mutual link on that frame.
    const count = 9;
    const events = fight(count, 1500);
    const sleeper = replayDriver(count, events);
    const awake = replayDriver(count, events);
    for (let frame = 0; frame < 300; frame++) {
      sleeper.frameAt(frame * FRAME_MS);
      awake.frameAt(frame * FRAME_MS);
    }
    const cursorBefore = sleeper.cursorNow();
    for (let frame = 300; frame <= 2400; frame++) awake.frameAt(frame * FRAME_MS);

    const jumped = [...sleeper.frameAt(2400 * FRAME_MS)];
    const continuous = [...awake.frameAt(2400 * FRAME_MS)];
    expect(sleeper.cursorNow()).toBe(awake.cursorNow());
    expect(sleeper.cursorNow()).toBeGreaterThan(cursorBefore + 100);
    // The control has to be a real matching, or "no worse than the control" would be satisfied by
    // steering nobody at all.
    expect(mutualLinks(continuous)).toBeGreaterThanOrEqual(count / 2);
    expect(mutualLinks(jumped)).toBeGreaterThanOrEqual(mutualLinks(continuous));
    // And it is SETTLED: a second call on the same frame changes nothing, so the one sweep was the
    // whole of the recovery rather than the first step of a field still shaking itself out.
    expect(jumped).toEqual([...sleeper.frameAt(2400 * FRAME_MS)]);
  });
});

describe("leadMs", () => {
  it("counts down the BOOKED blow, and says nothing at all when there is no booking", () => {
    // This is the number `field.ts` starts a windup and a lunge from, so WHICH blow it names decides
    // which blow the anticipation belongs to. It names the appointment and nothing else: `bookedAt`
    // is the instant the committed blow lands and the lead is that minus now.
    //
    // It used to be recomputed after the sweep as the nearest window blow naming the held pair, which
    // is a DIFFERENT blow whenever a pair is booked for their second exchange rather than their
    // first — see the guarantee below for what that cost. What is pinned here is what a reader of
    // `field.ts` depends on: finite exactly when this fighter has a committed blow still ahead of it,
    // `Infinity` when it does not, so a fighter holding somebody it has no appointment with walks
    // toward them without ever rearing back at them.
    const count = 9;
    const events = fight(count, 1500);
    const driver = replayDriver(count, events);
    let finite = 0;
    for (let frame = 0; frame < 1800; frame++) {
      const held = driver.frameAt(frame * FRAME_MS);
      const leads = driver.leads();
      for (let id = 0; id < count; id++) {
        if (!Number.isFinite(leads[id])) continue;
        finite++;
        // A finite lead is a real appointment: somebody is held, and the blow has not landed yet.
        expect(held[id]).not.toBeNull();
        expect(leads[id]).toBeGreaterThan(0);
      }
    }
    // The fight has to actually book things, or every assertion above passed on an empty set.
    expect(finite).toBeGreaterThan(1800);
  });

  it("never opens an appointment the pair cannot travel to — the guarantee the old shape broke", () => {
    // THE CROSS-FILE INVARIANT, and the reason `CROSSING_MS` is exported. 600 is the floor on a
    // booking's lead, `field.ts`'s `WINDUP_MS` is 300, and 600 > 300 is the whole of what makes
    // "every windup begins against a target that was already standing" true.
    //
    // The old `leadMs` broke it without touching either constant. Here is the exact shape: 0 leaves 1
    // for 2 on the strength of a keepable +875 blow, while a +125 blow between that same new pair
    // sits nearer in the window. Reporting the nearer one handed `field.ts` 125ms — inside `LUNGE_MS`
    // — for a fighter still half an arena away, so it fired a full rear-back-and-lunge at nothing and
    // arrived three quarters of a second later with the anticipation already spent. On the seeded
    // fixture that was 16 of 111 acquisitions at nine fighters, down to 25ms at sixteen.
    //
    // Kept as a regression rather than deleted with the bug: the number reported must be the blow the
    // pair is actually travelling toward.
    const tracker = createTargetTracker();
    tracker.assign(4, blows(4, [{ at: 875, a: 0, d: 1 }]), 0, 0, 0, NOBODY_IS_DEAD);
    const held = tracker.assign(
      4,
      blows(4, [
        { at: 125, a: 0, d: 2 },
        { at: 875, a: 0, d: 2 },
      ]),
      0,
      0,
      1000,
      NOBODY_IS_DEAD,
    );
    expect(held[0]).toBe(2);
    expect(tracker.leadMs[0]).toBeGreaterThanOrEqual(CROSSING_MS);
  });

  it("holds that floor at every fresh acquisition of a whole fight, at 2, 9 and 16", () => {
    // The case above proves the shape; this proves it is not a special case, and it measures the same
    // quantity the defect was originally counted in — ACQUISITIONS, the frames on which a fighter
    // starts holding somebody it was not holding before. Those are the only frames where the floor is
    // a claim: afterwards the lead counts down truthfully and MUST fall through `WINDUP_MS` and
    // `LUNGE_MS`, because that countdown is exactly how the field is told to rear back and then go.
    // Asserting a floor on every frame would forbid the anticipation this number exists to drive.
    //
    // A pair that was already mutually held is exempt, which is the book's own waiver: there is no
    // travel left to pay for, so a pair standing together may trade several blows where they are.
    for (const count of [2, 9, 16]) {
      const events = fight(count, 1500);
      const driver = replayDriver(count, events);
      let previous: (number | null)[] = new Array<number | null>(count).fill(null);
      let acquisitions = 0;
      for (let frame = 0; frame < 900; frame++) {
        const held = [...driver.frameAt(frame * FRAME_MS)];
        const leads = driver.leads();
        for (let id = 0; id < count; id++) {
          const partner = held[id];
          const fresh = partner !== null && previous[id] !== partner;
          if (fresh && Number.isFinite(leads[id])) {
            acquisitions++;
            expect(leads[id]).toBeGreaterThanOrEqual(CROSSING_MS);
          }
          // Both ends of a mutual pair report the same number, so a duel's windup and lunge begin on
          // the same frame at both ends rather than one fighter attacking a partner still walking.
          if (partner !== null && held[partner] === id) expect(leads[id]).toBe(leads[partner]);
        }
        previous = held;
      }
      expect(acquisitions).toBeGreaterThan(0);
    }
  });
});

describe("two fighters", () => {
  it("returns the one pairing there is, on every frame of a whole duel", () => {
    // The degenerate lineup, and the reason the rewrite could be landed at all: at two fighters there
    // is exactly one pair the hash can draw, so the old algorithm and the new one must agree to the
    // digit and the measured duel figures were expected to be unchanged. Anything that made a duel
    // flicker — a frame of `null` between appointments, a fighter briefly holding itself — would be
    // this file's most visible possible defect, on the one lineup where both fighters fill the
    // screen.
    const count = 2;
    const events = fight(count, 1500);
    const driver = replayDriver(count, events);
    for (let frame = 0; frame < 1500; frame++) {
      expect(driver.frameAt(frame * FRAME_MS)).toEqual([1, 0]);
    }
  });
});
