// LOBBY SIZE FOLLOWS THE ROOM. A dead lobby running a full arena is house money paying house fees
// to entertain nobody, and it makes the arena look busier than it is. Scale on human STAKE, not
// headcount: one player deploying $50 deserves a bigger room than five deploying a dollar between
// them, and headcount alone lets a few dust entries pull the whole arena open.
import { test } from "node:test";
import assert from "node:assert/strict";

const PLAY_MIN = 5, PLAY_MAX = 9, IDLE_MAX = 3, SCALE = 10;

function caps(humanUsd: number) {
  const opened = humanUsd > 0 ? IDLE_MAX + Math.ceil(humanUsd / SCALE) : IDLE_MAX;
  const hi = Math.min(PLAY_MAX, Math.max(IDLE_MAX, opened));
  const lo = Math.min(PLAY_MIN, hi);
  return { lo, hi };
}

test("an empty lobby stays small", () => {
  const c = caps(0);
  assert.equal(c.hi, IDLE_MAX, "no humans, no crowd");
  assert.ok(c.lo <= c.hi, "the floor can never exceed the cap");
});

test("the room opens as real money arrives", () => {
  assert.ok(caps(25).hi > caps(0).hi, "$25 should draw a bigger room than an empty lobby");
  assert.ok(caps(60).hi >= caps(25).hi, "and more money never shrinks it");
});

test("it never exceeds the hard cap however big the entry", () => {
  assert.equal(caps(100000).hi, PLAY_MAX, "PLAY_MAX is still the ceiling");
});

test("dust cannot pull the arena open", () => {
  // five $0.20 entries — headcount says 'busy', money says otherwise
  assert.ok(caps(1).hi <= IDLE_MAX + 1, `a dollar opened the room to ${caps(1).hi}`);
});

test("the floor never rises above the cap — an inverted range would break the picker", () => {
  for (const usd of [0, 0.5, 5, 20, 80, 5000]) {
    const c = caps(usd);
    assert.ok(c.lo <= c.hi, `inverted at $${usd}: ${c.lo} > ${c.hi}`);
    assert.ok(c.lo >= 1, "never zero — a lobby with no fighters is not a round");
  }
});
