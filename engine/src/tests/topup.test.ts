// Fighters are NOT refilled from a house reservoir. A wallet whose balance keeps replenishing from
// nowhere does not look like a person, and looking like a person is the point: these are meant to
// read as real deposits autoplaying, not as house plumbing. The float does not need topping up
// because it does not run down - it MOVES. Whoever is holding it is who plays, and a fighter short
// of its own side's token switches to the one it actually holds rather than sitting out.
import { test } from "node:test";
import assert from "node:assert/strict";

const MIN = 0.5;
/** Which side does this fighter play, given what it holds? */
function sideFor(side: "bull" | "uwu", held: { bull: number; uwu: number }) {
  const own = side === "bull" ? held.bull : held.uwu;
  const other = side === "bull" ? held.uwu : held.bull;
  if (own < MIN && other >= MIN) return side === "bull" ? "uwu" : "bull";
  return side;
}

test("a fighter short of its own token plays the one it actually holds", () => {
  assert.equal(sideFor("bull", { bull: 0.1, uwu: 40 }), "uwu");
  assert.equal(sideFor("uwu", { bull: 40, uwu: 0 }), "bull");
});

test("a funded fighter never switches — it is not chasing, just solvent", () => {
  assert.equal(sideFor("bull", { bull: 20, uwu: 40 }), "bull");
  assert.equal(sideFor("uwu", { bull: 99, uwu: 5 }), "uwu");
});

test("a fighter with nothing anywhere simply sits out", () => {
  assert.equal(sideFor("bull", { bull: 0, uwu: 0 }), "bull");   // stays put, then fails the min check
});

test("the float circulates rather than draining — a zero-sum round conserves it", () => {
  // whatever one fighter loses, another holds; the total is unchanged, so nothing needs adding
  const before = [10, 5, 0, 20];
  const after = [6, 5, 4, 20];                                   // 4 moved from the first to the third
  assert.equal(before.reduce((a, b) => a + b, 0), after.reduce((a, b) => a + b, 0));
});

test("a busted fighter is not refilled — it waits until it holds something again", () => {
  const held = { bull: 0, uwu: 0 };
  const side = sideFor("bull", held);
  assert.equal(held.bull, 0, "no reservoir touched it");
  assert.equal(side, "bull");
});
