// SEC-M7. A vault reading is a claim about a MOMENT. The arena settles rounds continuously, so an
// hour-old reading is not a slightly worse answer to the same question - it is the answer to a
// different one. Two failure shapes are pinned here.
import { test } from "node:test";
import assert from "node:assert/strict";

const MAX_AGE = 5 * 60_000;

/** The OLD shape: assign each balance as it arrives. */
function makeTearing() {
  const last = { uwu: 0, bull: 0, sol: 0, at: 0 };
  return {
    last,
    async refresh(reads: Array<() => Promise<number>>) {
      try {
        last.uwu = await reads[0]();
        last.bull = await reads[1]();
        last.sol = await reads[2]();
        last.at = Date.now();
      } catch { /* keep the last good reading */ }
    },
  };
}

/** The NEW shape: read into locals, commit as one snapshot. */
function makeAtomic() {
  const last = { uwu: 0, bull: 0, sol: 0, at: 0 };
  return {
    last,
    async refresh(reads: Array<() => Promise<number>>) {
      try {
        const uwu = await reads[0](), bull = await reads[1](), sol = await reads[2]();
        last.uwu = uwu; last.bull = bull; last.sol = sol; last.at = Date.now();
      } catch { /* keep the last good reading, and its real age */ }
    },
  };
}

const ok = (v: number) => async () => v;
const boom = async () => { throw new Error("rpc down"); };

test("the old shape tears: a mid-sequence failure leaves a mixed snapshot", async () => {
  const c = makeTearing();
  await c.refresh([ok(100), ok(200), ok(2)]);          // a good cycle
  await c.refresh([ok(999), boom, ok(2)]);             // uwu updates, then it fails
  assert.equal(c.last.uwu, 999, "uwu took the new value");
  assert.equal(c.last.bull, 200, "bull kept the old one — two different moments in one record");
});

test("committing as one snapshot cannot tear", async () => {
  const c = makeAtomic();
  await c.refresh([ok(100), ok(200), ok(2)]);
  const before = { ...c.last };
  await c.refresh([ok(999), boom, ok(2)]);
  assert.deepEqual(c.last, before, "a failed cycle changes nothing at all");
});

test("a failed cycle must not refresh the timestamp — the age has to stay honest", async () => {
  const c = makeAtomic();
  await c.refresh([ok(100), ok(200), ok(2)]);
  const at = c.last.at;
  await new Promise(r => setTimeout(r, 5));
  await c.refresh([boom, ok(1), ok(1)]);
  assert.equal(c.last.at, at, "still reporting when the data was actually read");
});

test("staleness is judged on age, so a spender can refuse to act on it", () => {
  const stale = (at: number, now: number) => !at || (now - at) > MAX_AGE;
  const now = 10_000_000;
  assert.equal(stale(now - 1000, now), false, "a fresh reading is usable");
  assert.equal(stale(now - MAX_AGE - 1, now), true, "an old one is not");
  assert.equal(stale(0, now), true, "and never-read counts as stale, not as zero holdings");
});
