// A write-down is the one operation that can hide a loss, so every guard gets a test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeDownOverclaim } from "../recover-float.ts";

const acct = (id: string, uwu: number, extra: Record<string, any> = {}) => ({ id, uwu, ...extra });
const led = (...as: any[]) => new Map(as.map(a => [a.id, a]));

test("writes phantom house float off the pool wallets only", () => {
  const l = led(acct("P1", 500), acct("P2", 500), acct("bot", 100, { isBot: true }), acct("alice", 200));
  const r = writeDownOverclaim(l, new Set(["P1", "P2"]), "uwu", 1200);   // claimed 1300 vs 1200
  assert.equal(Math.round(r.wrote), 100);
  assert.equal((l.get("alice") as any).uwu, 200, "a player is never touched");
  assert.equal((l.get("bot") as any).uwu, 100, "a bot's own winnings are never touched");
  assert.equal(Math.round((l.get("P1") as any).uwu + (l.get("P2") as any).uwu), 900);
});

test("REFUSES when players are not backed — that is a shortfall, not phantom float", () => {
  const l = led(acct("P1", 100), acct("alice", 900));
  const r = writeDownOverclaim(l, new Set(["P1"]), "uwu", 500);   // chain 500 < player 900
  assert.equal(r.wrote, 0);
  assert.match(String(r.reason), /real shortfall/);
  assert.equal((l.get("alice") as any).uwu, 900);
});

test("counts open stakes, so live money on the table is not mistaken for phantom", () => {
  const l = led(acct("P1", 400), acct("alice", 100));
  // 500 in accounts + 500 staked = 1000 claimed, chain holds 1000 -> nothing is phantom
  const r = writeDownOverclaim(l, new Set(["P1"]), "uwu", 1000, 500);
  assert.equal(r.wrote, 0);
  assert.match(String(r.reason), /no excess/);
  assert.equal((l.get("P1") as any).uwu, 400, "an open stake must not be written off");
});

test("REFUSES an implausibly large excess — a bad chain read must not zero the book", () => {
  const l = led(acct("P1", 1000), acct("alice", 10));
  const r = writeDownOverclaim(l, new Set(["P1"]), "uwu", 100);   // pretend RPC returned near-zero
  assert.equal(r.wrote, 0);
  assert.match(String(r.reason), /too large/);
  assert.equal((l.get("P1") as any).uwu, 1000);
});

test("never drives a pool wallet negative", () => {
  const l = led(acct("P1", 10), acct("P2", 90), acct("alice", 0));
  const r = writeDownOverclaim(l, new Set(["P1", "P2"]), "uwu", 80, 0, { maxFrac: 1 });
  assert.ok(r.wrote > 0);
  for (const id of ["P1", "P2"]) assert.ok((l.get(id) as any).uwu >= 0, `${id} went negative`);
});

test("is idempotent — running it twice does not write down twice", () => {
  const l = led(acct("P1", 500), acct("P2", 500), acct("alice", 200));
  writeDownOverclaim(l, new Set(["P1", "P2"]), "uwu", 1100);
  const after = (l.get("P1") as any).uwu + (l.get("P2") as any).uwu;
  const r2 = writeDownOverclaim(l, new Set(["P1", "P2"]), "uwu", 1100);
  assert.equal(r2.wrote, 0);
  assert.equal((l.get("P1") as any).uwu + (l.get("P2") as any).uwu, after);
});
