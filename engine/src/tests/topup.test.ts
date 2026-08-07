// levelBots skims a bot ABOVE a ceiling back to the pool. Nothing filled one UP TO a floor, because
// the pool only ever reached a bot at CREATION — so a bot that lost a few rounds stayed poor
// forever, and since a routine stake is a fraction of the bank, poor bots field dust indefinitely.
// Measured live: bots holding ~$6 while the pool sat on $43, i.e. ~90% of the float idle.
import { test } from "node:test";
import assert from "node:assert/strict";

const FLOOR = 6, CEIL = 12;

function topUp(bots: number[], pool: number, floor = FLOOR) {
  const out = [...bots]; let left = pool;
  for (let i = 0; i < out.length; i++) {
    if (out[i] >= floor) continue;
    const want = floor - out[i];
    const drawn = Math.min(want, left);       // capped by what the pool really holds
    out[i] += drawn; left -= drawn;
  }
  return { bots: out, pool: left };
}

test("starved bots are refilled from the idle float", () => {
  const r = topUp([0.5, 1, 0.2], 43);
  assert.deepEqual(r.bots, [6, 6, 6]);
  assert.ok(Math.abs(r.pool - (43 - (5.5 + 5 + 5.8))) < 1e-9);
});

test("conserves value — every token comes out of the pool, none is created", () => {
  const before = [1, 2, 0], pool = 20;
  const r = topUp(before, pool);
  const sumBefore = before.reduce((a, b) => a + b, 0) + pool;
  const sumAfter = r.bots.reduce((a, b) => a + b, 0) + r.pool;
  assert.ok(Math.abs(sumBefore - sumAfter) < 1e-9, "top-up must not mint balance");
});

test("a thin pool fills who it can and stops — never goes negative", () => {
  const r = topUp([0, 0, 0], 7);
  assert.equal(r.pool, 0);
  assert.ok(r.bots.every(b => b >= 0));
  assert.equal(r.bots.reduce((a, b) => a + b, 0), 7, "exactly the pool, no more");
});

test("bots already at or above the floor are left alone", () => {
  const r = topUp([6, 9, 20], 50);
  assert.deepEqual(r.bots, [6, 9, 20]);
  assert.equal(r.pool, 50, "nothing drawn");
});

test("the floor sits below levelBots' ceiling, so the two cannot fight", () => {
  assert.ok(FLOOR < CEIL, "a floor above the ceiling would top up and skim forever");
});

// ── the reservoir ────────────────────────────────────────────────────────────────────────────
// Filling every fighter to the floor drained the pool to $0 in live testing. The pool is exactly
// what matchPlayerStake draws on to ANSWER a human bet, so a full routine top-up would starve the
// one behaviour the player actually notices — the house going quiet when they deploy.
const RESERVE = 0.35;
function topUpReserved(bots: number[], pool: number, floor = FLOOR, frac = RESERVE) {
  const out = [...bots]; let left = pool;
  for (let i = 0; i < out.length; i++) {
    if (out[i] >= floor) continue;
    const spendable = Math.max(0, left - pool * frac);   // never touch the reserve
    if (spendable <= 0) break;
    const drawn = Math.min(floor - out[i], spendable);
    out[i] += drawn; left -= drawn;
  }
  return { bots: out, pool: left };
}

test("routine top-up never spends the reserve the house answers bets with", () => {
  const r = topUpReserved([0, 0, 0, 0, 0, 0], 43);
  assert.ok(r.pool >= 43 * RESERVE - 1e-9, `pool fell to ${r.pool}, below the reserve`);
});

test("it still funds fighters properly — the reserve is a floor, not a freeze", () => {
  const r = topUpReserved([0, 0], 43);
  assert.deepEqual(r.bots, [FLOOR, FLOOR], "two starved bots should still fill");
});

test("still conserves — the reserve does not create or destroy value", () => {
  const before = [1, 0, 2], pool = 30;
  const r = topUpReserved(before, pool);
  const a = before.reduce((x, y) => x + y, 0) + pool;
  const b = r.bots.reduce((x, y) => x + y, 0) + r.pool;
  assert.ok(Math.abs(a - b) < 1e-9);
});
