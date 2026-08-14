// The two numbers every mark on the field is now sized from, and the reason they get a test.
//
// `hitForce` and `hitToll` are the only place in the canvas that RE-DERIVES something the program
// computed rather than reading it. `advance_fight` publishes the damage and keeps the roll, so the
// roll has to be recovered by inverting `dmg = min(hp_a, hp_d) * roll / 100` — and the failure mode
// of getting that wrong is not an exception, it is every hit in the game quietly drawing at the same
// size again, which is exactly the state this pass was called in to fix and is invisible in review.
//
// So the arithmetic is pinned against `programs/bulls-arena/src/lib.rs`'s own constants, at both ends
// of the roll range and on the two branches that do not go through the multiply at all.

import { describe, expect, it } from "vitest";
import { hitForce, hitToll } from "./impact.ts";

/** `advance_fight`'s `roll_of` — the program's inclusive roll range. It was a flat `h[8] % 24 + 4`
 *  (4..27); it is now a body of `ROLL_BODY_LO..22` out of `h[20..24]` plus a spike of `CRIT_ROLL`
 *  one time in `CRIT_ONE_IN` out of `h[24..28]`. See `roll_of` in lib.rs for why.
 *
 *  The endpoints are what this file pins, because they are what `hitForce` normalises against and
 *  getting them wrong is invisible in review — the whole canvas simply loses its dynamic range. The
 *  SHAPE between them is pinned too, one describe() down: the mapping is piecewise now, and a
 *  regression to a straight line would put 31 blows in 32 at the bottom of the scale. */
const ROLL_MIN = 1n;
const ROLL_BODY_MAX = 22n;
const CRIT_ROLL = 90n;
const ROLL_MAX = CRIT_ROLL;

/** The chain's own line, so a test vector is produced the way the program produces it rather than by
 *  a second reading of the same sentence. */
function damage(attackerHp: bigint, defenderHp: bigint, roll: bigint): bigint {
  const basis = attackerHp < defenderHp ? attackerHp : defenderHp;
  return (basis * roll) / 100n;
}

describe("hitForce", () => {
  it("puts the program's weakest roll at the bottom of the scale and its strongest at the top", () => {
    const a = 1_000_000n;
    const d = 4_000_000n;
    expect(hitForce(damage(a, d, ROLL_MIN), a, d)).toBeCloseTo(0, 2);
    expect(hitForce(damage(a, d, ROLL_MAX), a, d)).toBeCloseTo(1, 2);
  });

  it("is monotone across the whole roll range", () => {
    const a = 8_000_000n;
    const d = 3_000_000n;
    let previous = -1;
    for (let roll = ROLL_MIN; roll <= ROLL_MAX; roll++) {
      const force = hitForce(damage(a, d, roll), a, d);
      expect(force).toBeGreaterThan(previous);
      previous = force;
    }
    expect(previous).toBeCloseTo(1, 2);
  });

  it("keeps the whole body of the die apart from the crit, and the crit alone at the top", () => {
    // THE REGRESSION THIS GUARDS IS A ONE-LINE REVERT. `hitForce` used to be a straight line, which
    // was right for a flat 4..27 die and is wrong for a die of 1..22-plus-90: linearly, EVERY
    // ordinary blow lands under force 0.24 and only the crit is visible, so the canvas draws 31 hits
    // in 32 at the bottom of every curve — the "every hit reads the same size" failure this module
    // was written to fix, reached from the other end. The mapping is piecewise for that reason and
    // this pins the three properties that make it worth the extra constant.
    const a = 8_000_000n;
    const d = 3_000_000n;
    const force = (roll: bigint) => hitForce(damage(a, d, roll), a, d);

    // 1. The body spans a real range rather than a sliver — the bottom of the die and the top of its
    //    body must be far apart, or nothing an ordinary exchange does is legible.
    expect(force(ROLL_BODY_MAX) - force(ROLL_MIN)).toBeGreaterThan(0.5);

    // 2. The crit is strictly above everything the body can reach, with a visible gap. The die has no
    //    mass between them, so this discontinuity is honest rather than an artefact.
    expect(force(CRIT_ROLL)).toBeGreaterThan(force(ROLL_BODY_MAX) + 0.3);

    // 3. URGENT_FORCE = 0.8 is the throttle bypass, and the rule it now encodes is "only a crit may
    //    barge the queue". A body roll that could reach it would let a merely-heavy ordinary blow
    //    skip the cap, which is what the cap exists to prevent.
    expect(force(ROLL_BODY_MAX)).toBeLessThan(0.8);
    expect(force(CRIT_ROLL)).toBeGreaterThanOrEqual(0.8);
  });

  it("reads the SMALLER ring as the basis, which is what the program does", () => {
    // A whale hitting a minnow and a minnow hitting a whale swing equally hard for the same roll —
    // the size-neutrality that `min(ring_a, ring_d)` exists for. If this used the defender's ring
    // alone, the first of these would come out at maximum force for a middling roll.
    const whale = 500_000_000n;
    const minnow = 2_000_000n;
    const roll = 15n;
    expect(hitForce(damage(whale, minnow, roll), whale, minnow)).toBeCloseTo(
      hitForce(damage(minnow, whale, roll), minnow, whale),
      6,
    );
  });

  it("reads a dust finish as full force", () => {
    // `if fighters[d].hp <= DUST { dmg = fighters[d].hp; }` hands over the whole remaining ring, so
    // the implied roll is 100 and the clamp takes it. That IS a fighter being finished off.
    expect(hitForce(900n, 50_000_000n, 900n)).toBe(1);
  });

  it("never goes negative when integer truncation puts the recovered roll under the floor", () => {
    // The chain divides by 100 in u64. On the smallest rings that loses enough that the recovered
    // roll lands below ROLL_MIN, and an unclamped normalisation would hand back a negative width to
    // every stroke downstream.
    const tiny = 30n;
    expect(hitForce(damage(tiny, tiny, ROLL_MIN), tiny, tiny)).toBe(0);
  });

  it("does not divide by an empty ring", () => {
    expect(hitForce(0n, 0n, 0n)).toBe(1);
  });
});

describe("hitToll", () => {
  it("is zero for a hit that costs nothing and saturates once it costs a sixth of the fighter", () => {
    expect(hitToll(0n, 100_000_000n)).toBe(0);
    // TOLL_FULL is 15% of worth: measured against the fixture, that is the size of an opening
    // exchange and roughly ten times the size of anything past t=20s.
    expect(hitToll(15_000_000n, 100_000_000n)).toBeCloseTo(1, 6);
    expect(hitToll(60_000_000n, 100_000_000n)).toBe(1);
  });

  it("is a SHARE, so the same dollar hit tolls a small fighter more than a large one", () => {
    // The whole reason toll exists alongside force: identical damage is a catastrophe for one
    // fighter and a scratch for another, and the mark should say which.
    expect(hitToll(1_000_000n, 10_000_000n)).toBeGreaterThan(hitToll(1_000_000n, 200_000_000n));
  });

  it("reads a hit on a fighter already worth nothing as total", () => {
    expect(hitToll(1n, 0n)).toBe(1);
  });
});
