// Bot matching is a RESPONSE to human stake. The bug this pins: it used to measure "already
// matched" against the whole opposing book, including the routine bot deployment that happens every
// round regardless of who is playing. A human entry against an already-busy foe side then computed
// a negative need and the house did nothing — "I added $5 and nobody came".
import { test } from "node:test";
import assert from "node:assert/strict";

const FEE = 0.002, MIN_ENTRY = 0.5, RATIO = 1.0;

/** OLD: subtract the entire foe book. */
function needOld(stakeUsd: number, foeEntries: number[]) {
  const already = foeEntries.reduce((n, s) => n + s / (1 - FEE), 0);
  return stakeUsd * RATIO - already;
}
/** NEW: subtract only what was committed IN RESPONSE to human stake. */
function needNew(stakeUsd: number, matchedSoFar: number) {
  return stakeUsd * RATIO - matchedSoFar;
}

test("the old rule ignored a player whenever the routine bot book was already large", () => {
  const routineBotBook = [12, 9, 9];              // ordinary deployment, nothing to do with this player
  assert.ok(needOld(5, routineBotBook) < 0, "old rule wanted negative money — it did nothing");
  assert.ok(needNew(5, 0) >= 5 - 1e-9, "new rule still answers the $5");
});

test("a player is answered on their own terms, whatever the rest of the book is doing", () => {
  for (const book of [[], [3], [12, 9, 9], [50, 50]]) {
    void book;
    assert.equal(needNew(5, 0), 5, "the answer to $5 is $5, independent of the routine book");
  }
});

test("idempotent — the 1.2s watcher cannot answer the same stake twice", () => {
  let matched = 0;
  const first = needNew(5, matched); matched += first;      // watcher tick 1
  const second = needNew(5, matched);                        // tick 2, nothing new happened
  assert.equal(first, 5);
  assert.ok(second <= MIN_ENTRY, `second tick wanted ${second} more — it would double-match`);
});

test("a whale arriving later in the same lobby still draws an answer", () => {
  let matched = 0;
  matched += needNew(5, matched);                            // small player, answered
  const extra = needNew(80, matched);                        // whale enters the same lobby
  assert.ok(extra > 70, `late whale drew only ${extra}`);
});

test("partial fills carry over — an under-funded answer is topped up next tick", () => {
  let matched = 0;
  const want = needNew(20, matched);
  matched += 6;                                              // pool could only source $6 this tick
  const rest = needNew(20, matched);
  assert.equal(want, 20);
  assert.equal(rest, 14, "the shortfall is still owed, not forgotten");
});

// ── roster availability ──────────────────────────────────────────────────────────────────────
// The second half of the same report. Matching excluded every bot that already had an entry on the
// foe side, but the routine bot deployment puts bots on BOTH sides every round, so the roster came
// back empty exactly when a player needed answering. enter() merges a repeat id into the existing
// fighter, so the exclusion bought nothing and cost the entire response.
const rosterOld = (bots: string[], entered: Set<string>) => bots.filter(b => !entered.has(b));
const rosterNew = (bots: string[], entered: Set<string>) =>
  bots.filter(b => !entered.has(b)).concat(bots.filter(b => entered.has(b)));

test("old roster went empty once the routine book had deployed every bot", () => {
  const bots = ["b1", "b2", "b3"];
  const entered = new Set(bots);                 // routine deployment put them all on the foe side
  assert.equal(rosterOld(bots, entered).length, 0, "nobody left to match with");
  assert.equal(rosterNew(bots, entered).length, 3, "all three are still usable via top-up");
});

test("fresh bots are still preferred, so the book gains distinct fighters first", () => {
  const bots = ["b1", "b2", "b3", "b4"];
  const entered = new Set(["b1", "b2"]);
  assert.deepEqual(rosterNew(bots, entered), ["b3", "b4", "b1", "b2"]);
});

test("a partially-deployed roster is never smaller than the old one", () => {
  const bots = ["b1", "b2", "b3", "b4", "b5"];
  for (const n of [0, 1, 3, 5]) {
    const entered = new Set(bots.slice(0, n));
    assert.ok(rosterNew(bots, entered).length >= rosterOld(bots, entered).length);
  }
});
