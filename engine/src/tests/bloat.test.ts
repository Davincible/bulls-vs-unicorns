// Free-account-creation guard. Anyone can authenticate a freshly generated keypair at no cost, so
// zero-activity accounts must stay ephemeral: out of the leaderboard walk (which runs ~8x/second
// and is broadcast to every client) and out of the persisted ledger.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ledger, acct, leadersFor, hasActivity, type Account } from "../ledger.ts";

const reset = () => ledger.clear();

test("a freshly created account has no activity", () => {
  reset();
  const a = acct("wallet-fresh", "bull");
  assert.equal(hasActivity(a), false);
});

test("any money touch marks an account active", () => {
  reset();
  const cases: Array<(a: Account) => void> = [
    a => { a.bull = 1; }, a => { a.uwu = 1; }, a => { a.sol = 1; },
    a => { a.dep = 1; }, a => { a.ret = 1; }, a => { a.games = 1; },
    a => { a.depIn = 1; }, a => { a.wOut = 1; }, a => { a.refEarned = 1; },
  ];
  cases.forEach((mut, i) => {
    const a = acct("w" + i, "bull");
    assert.equal(hasActivity(a), false);
    mut(a);
    assert.equal(hasActivity(a), true, `case ${i} should count as activity`);
  });
});

test("junk accounts never reach the leaderboard, real players still do", () => {
  reset();
  for (let i = 0; i < 500; i++) acct("junk" + i, "bull");     // free, zero-balance accounts
  const real = acct("real-player", "bull");
  real.bull = 25; real.dep = 25; real.games = 1;

  const board = leadersFor("au-normal");
  assert.equal(board.some(r => r.id === "real-player"), true, "an active player must appear");
  assert.equal(board.some(r => String(r.id).startsWith("junk")), false, "zero-activity accounts must not appear");
  assert.ok(board.length < 50, `board should stay small, got ${board.length}`);
});

test("bots remain scoped to their own arena", () => {
  reset();
  const mk = (id: string) => { const a = acct(id, "bull"); a.isBot = true; a.bull = 10; return a; };
  mk("au-normal:bot:1"); mk("us-extraction:bot:1");
  const board = leadersFor("au-normal");
  assert.equal(board.some(r => r.id === "au-normal:bot:1"), true);
  assert.equal(board.some(r => r.id === "us-extraction:bot:1"), false, "another arena's bots must not leak in");
});
