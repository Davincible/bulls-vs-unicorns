// CAPITAL FRAGMENTATION. Bots policed their own numbers by busting; once funding was fixed they
// stopped dying and nothing culled them. The count reached 77 accounts holding ~$1.04 each while
// only 10 could enter a round — 67 wallets sitting out holding ~$70 of idle float, and per-fighter
// stake pinned to the MINIMUM because no bank was big enough for the commit fraction to bind.
// More accounts is not more depth; past a couple of rotations it is the same money in thinner cuts.
import { test } from "node:test";
import assert from "node:assert/strict";

const target = (perSideCap: number, rotations = 3) => Math.max(6, perSideCap * 2 * rotations);

/** Retire the poorest first, returning their capital to the pool. */
function cull(banks: number[], perSideCap: number, rotations = 3) {
  const t = target(perSideCap, rotations);
  if (banks.length <= t) return { kept: [...banks], freed: 0 };
  const sorted = [...banks].sort((a, b) => a - b);
  const drop = sorted.slice(0, banks.length - t);
  return { kept: sorted.slice(banks.length - t), freed: drop.reduce((a, b) => a + b, 0) };
}

test("a population far above the entrant cap is culled back", () => {
  const banks = Array(77).fill(1.04);
  const r = cull(banks, 9);
  assert.equal(r.kept.length, 54, "9 per side x 2 sides x 3 rotations");
  assert.ok(r.freed > 23, `only $${r.freed.toFixed(2)} freed`);
});

test("the poorest go first — thin banks cannot field real size", () => {
  const r = cull([0.1, 0.2, 8, 9, 10, 11, 12, 13], 1);   // target = max(6, 6) = 6
  assert.equal(r.kept.length, 6);
  assert.ok(!r.kept.includes(0.1) && !r.kept.includes(0.2), "the two thinnest should be retired");
  assert.ok(r.kept.includes(13), "the richest is always kept");
});

test("conserves — retired capital is returned, never destroyed", () => {
  const banks = [1, 2, 3, 4, 5, 6, 7, 8];
  const r = cull(banks, 1);
  const after = r.kept.reduce((a, b) => a + b, 0) + r.freed;
  assert.equal(after, banks.reduce((a, b) => a + b, 0));
});

test("a healthy population is left completely alone", () => {
  const banks = Array(12).fill(5);
  const r = cull(banks, 9);
  assert.equal(r.freed, 0);
  assert.equal(r.kept.length, 12);
});

test("never culls below a playable floor", () => {
  const r = cull(Array(50).fill(2), 0 as any);
  assert.ok(r.kept.length >= 6, "must always leave enough to field a round");
});
