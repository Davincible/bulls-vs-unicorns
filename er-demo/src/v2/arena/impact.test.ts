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

/** `advance_fight`: `let roll = (h[8] as u64) % 24 + 4;` — the program's inclusive roll range. */
const ROLL_MIN = 4n;
const ROLL_MAX = 27n;

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
