// Hall of Fame and per-wallet history, derived from the permanent round log rather than from
// whatever a browser happened to witness. The client versions lived in localStorage: they reset on
// reload, carried local-sim rounds from before the engine existed, and could never include a round
// the tab was closed for. These are the endpoints that let that client ledger be deleted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { hallOfFame, walletHistory, roundLog, pushRound, standingsFromLog } from "../ledger.ts";

const mk = (round: number, winner: string, players: any[], arena = "us-extraction") =>
  ({ arena, round, winner, at: 1_700_000_000_000 + round * 1000, players });

function seed() {
  roundLog.length = 0;
  // pushRound UNSHIFTS (newest first), so seed in ascending round order
  pushRound(mk(1, "uwu", [{ id: "bob", side: "uwu", inUsd: 20, outUsd: 44 }]) as any);   // 2.2x
  pushRound(mk(2, "bull", [
    { id: "alice", name: "alice", side: "bull", inUsd: 5, outUsd: 6 },      // 1.2x
    { id: "dust", side: "uwu", inUsd: 0.01, outUsd: 0.05 },                 // 5x but meaningless
  ]) as any);
  pushRound(mk(3, "uwu", [
    { id: "alice", name: "alice", side: "uwu", inUsd: 10, outUsd: 25 },     // 2.5x
    { id: "bob", side: "bull", inUsd: 10, outUsd: 2 },
  ]) as any);
}

test("hall ranks by return multiple, best first", () => {
  seed();
  const h = hallOfFame();
  assert.equal(h[0].id, "alice");
  assert.ok(Math.abs(h[0].roi - 2.5) < 1e-9);
  assert.equal(h[1].id, "bob");
});

test("dust cannot outrank a real round", () => {
  seed();
  const h = hallOfFame();
  assert.ok(!h.some(x => x.id === "dust"), "a $0.01 entry returning $0.05 is a 5x that means nothing");
});

test("losing rounds never appear", () => {
  seed();
  assert.ok(hallOfFame().every(x => x.outAmt > x.inAmt));
});

test("history returns only that wallet's rounds, newest first, with P/L and result", () => {
  seed();
  const h = walletHistory("alice");
  assert.equal(h.length, 2);
  assert.equal(h[0].round, 3);
  assert.equal(h[0].pnl, 15);
  assert.equal(h[0].won, true, "alice was on uwu and uwu won round 3");
  assert.equal(h[1].won, true, "alice was on bull and bull won round 2");
});

test("a losing round is recorded as lost, not omitted", () => {
  seed();
  const h = walletHistory("bob");
  const r2 = h.find(x => x.round === 3)!;
  assert.equal(r2.won, false);
  assert.equal(r2.pnl, -8);
});

test("an unknown wallet gets an empty history, not an error", () => {
  seed();
  assert.deepEqual(walletHistory("nobody"), []);
});

// THE ONE THAT WOULD HAVE CAUGHT MY BUG. I wrote these readers against `in`/`out` when the record
// actually carries `inUsd`/`outUsd`, so they matched nothing and served a silently empty hall. The
// unit tests passed anyway, because my fixtures used the same wrong names — the test mirrored the
// mistake instead of catching it. Cross-checking against standingsFromLog, which reads the same log
// through the same fields, makes a divergence impossible to miss: both must see the same money.
test("hall and history agree with the leaderboard — same log, same fields", () => {
  seed();
  const st = standingsFromLog();
  const alice = st.find(r => r.id === "alice")!;
  assert.ok(alice, "standings must see alice at all");
  assert.equal(alice.rounds, 2);
  assert.equal(alice.staked, 15, "5 + 10");
  assert.equal(alice.returned, 31, "6 + 25");

  const hist = walletHistory("alice");
  assert.equal(hist.length, alice.rounds, "history and standings must count the same rounds");
  assert.equal(hist.reduce((n, h) => n + h.in, 0), alice.staked, "and the same staked total");
  assert.equal(hist.reduce((n, h) => n + h.out, 0), alice.returned, "and the same returned total");

  const best = hallOfFame().filter(h => h.id === "alice")[0];
  assert.ok(best, "alice's winning round must appear in the hall");
  assert.ok(best.outAmt > 0 && best.inAmt > 0, "a hall row reading zeroes means the fields are wrong");
});

test("a non-empty log cannot produce an empty hall — the failure that shipped", () => {
  seed();
  assert.ok(roundLog.length > 0);
  assert.ok(hallOfFame().length > 0, "profitable rounds exist in the log; an empty hall means broken field names");
});
