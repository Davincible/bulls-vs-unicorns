// Float recovery is the one tool in the codebase that CREATES ledger balance out of nothing but a
// deposit record. These tests pin the three things that stop it becoming a money printer:
// it never exceeds what a wallet deposited, it refuses when the vault cannot back the result,
// and it runs exactly once — because a bot losing a round looks identical to the damage it repairs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { recoverInPlace } from "../recover-float.ts";

const acct = (id: string, o: Record<string, number> = {}) =>
  ({ id, uwu: 0, sol: 0, bull: 0, depIn: 0, wOut: 0, depInSol: 0, wOutSol: 0, ...o });

function ledgerOf(...as: any[]) {
  const m = new Map<string, any>();
  for (const a of as) m.set(a.id, a);
  return m;
}

test("credits a wiped pool wallet back to exactly what it deposited", async () => {
  const a = acct("W1", { depIn: 100, uwu: 0 });
  const r = await recoverInPlace(ledgerOf(a), new Set(["W1"]), { uwu: 500, solUsd: 0 });
  assert.equal(r.credited, 1);
  assert.equal(a.uwu, 100, "restored to the deposit, not more");
});

test("a wallet still holding most of its deposit is not topped up to the deposit", async () => {
  const a = acct("W1", { depIn: 100, uwu: 90 });
  await recoverInPlace(ledgerOf(a), new Set(["W1"]), { uwu: 500, solUsd: 0 });
  assert.equal(a.uwu, 90, "a 10% shortfall is play, not damage — recovery repairs wipes only");
});

test("withdrawals reduce what is owed", async () => {
  const a = acct("W1", { depIn: 100, wOut: 40, uwu: 0 });
  await recoverInPlace(ledgerOf(a), new Set(["W1"]), { uwu: 500, solUsd: 0 });
  assert.equal(a.uwu, 60, "deposited 100, took 40 back out — owed 60");
});

test("refuses when the vault cannot back the restored balance", async () => {
  const a = acct("W1", { depIn: 100, uwu: 0 });
  const r = await recoverInPlace(ledgerOf(a), new Set(["W1"]), { uwu: 10, solUsd: 0 });
  assert.equal(r.credited, 0);
  assert.match(r.reason!, /would owe/);
  assert.equal(a.uwu, 0, "nothing credited on refusal");
});

test("a real player's balance counts against the vault before any bot is topped up", async () => {
  const bot = acct("W1", { depIn: 100, uwu: 0 });
  const player = acct("P1", { uwu: 450 });
  const r = await recoverInPlace(ledgerOf(bot, player), new Set(["W1"]), { uwu: 500, solUsd: 0 });
  assert.equal(r.credited, 0, "player's 450 + bot's 100 exceeds the 500 held");
  assert.equal(bot.uwu, 0);
});

test("the SOL leg refuses outright when the price feed is down", async () => {
  const a = acct("W1", { depIn: 50, depInSol: 50, uwu: 0, sol: 0 });
  const r = await recoverInPlace(ledgerOf(a), new Set(["W1"]), { uwu: 999, solUsd: 0 });
  assert.equal(r.credited, 0);
  assert.match(r.reason!, /price unavailable/);
});

test("non-pool accounts are never touched", async () => {
  const player = acct("P1", { depIn: 100, uwu: 0 });
  const r = await recoverInPlace(ledgerOf(player), new Set(["W1"]), { uwu: 500, solUsd: 0 });
  assert.equal(r.credited, 0);
  assert.equal(player.uwu, 0);
});

// The one that matters most in production. Losing a round moves a bot's balance below its deposit
// record, which is indistinguishable from the bug this tool repairs. Without the marker, every
// restart would refund the pool its losses and the vault would fall short of the ledger.
test("refuses a second run — a bot's LOSSES must not be re-credited", async () => {
  const a = acct("W1", { depIn: 100, uwu: 100 });
  a.uwu = 20; // lost 80 in honest play after recovery already ran once
  const r = await recoverInPlace(ledgerOf(a), new Set(["W1"]), { uwu: 500, solUsd: 0 }, true);
  assert.equal(r.credited, 0);
  assert.match(r.reason!, /already recovered/);
  assert.equal(a.uwu, 20, "losses stand");
});

// Second, independent guard: even with the one-shot marker absent (fresh volume, manual re-run),
// recovery must not read ordinary losses as damage. It repairs wallets that were WIPED, nothing else.
test("a bot that merely lost a round is left alone, marker or not", async () => {
  const a = acct("W1", { depIn: 100, uwu: 62 }); // down 38% from honest play
  const r = await recoverInPlace(ledgerOf(a), new Set(["W1"]), { uwu: 500, solUsd: 0 });
  assert.equal(r.credited, 0);
  assert.equal(a.uwu, 62, "losses are not damage");
});

test("a wiped wallet is still repaired (dust below 1% counts as wiped)", async () => {
  const a = acct("W1", { depIn: 100, uwu: 0.4 });
  const r = await recoverInPlace(ledgerOf(a), new Set(["W1"]), { uwu: 500, solUsd: 0 });
  assert.equal(r.credited, 1);
  assert.equal(a.uwu, 100);
});

// ---- resyncPoolToChain: re-anchor the HOUSE float to the vault's real contents ----
import { resyncPoolToChain } from "../recover-float.ts";

test("credits the house up to what the chain actually holds", () => {
  const p1 = acct("W1", { uwu: 100 }), p2 = acct("W2", { uwu: 100 });
  const r = resyncPoolToChain(ledgerOf(p1, p2), new Set(["W1", "W2"]), "uwu", 500);
  assert.equal(r.moved, 300);
  assert.equal(p1.uwu + p2.uwu, 500, "house now matches the vault");
});

test("player balances are subtracted first and never touched", () => {
  const pool = acct("W1", { uwu: 0 });
  const player = acct("P1", { uwu: 200 });
  const r = resyncPoolToChain(ledgerOf(pool, player), new Set(["W1"]), "uwu", 500);
  assert.equal(r.moved, 300, "only the 300 left after the player's 200 is house money");
  assert.equal(pool.uwu, 300);
  assert.equal(player.uwu, 200, "player untouched");
});

// The critical one. Writing balances DOWN to match the chain would conceal a genuine shortfall,
// so an over-claiming ledger must be reported, not silently corrected.
test("refuses to write down an over-claiming ledger — that is insolvency, not drift", () => {
  const pool = acct("W1", { uwu: 900 });
  const r = resyncPoolToChain(ledgerOf(pool), new Set(["W1"]), "uwu", 500);
  assert.equal(r.moved, 0);
  assert.match(r.reason!, /INSOLVENT/);
  assert.equal(pool.uwu, 900, "the shortfall stays visible");
});

test("refuses when players alone are owed more than the vault holds", () => {
  const pool = acct("W1", { uwu: 0 });
  const player = acct("P1", { uwu: 600 });
  const r = resyncPoolToChain(ledgerOf(pool, player), new Set(["W1"]), "uwu", 500);
  assert.equal(r.moved, 0);
  assert.equal(pool.uwu, 0);
});

test("in-sync books are left exactly alone", () => {
  const pool = acct("W1", { uwu: 500 });
  const r = resyncPoolToChain(ledgerOf(pool), new Set(["W1"]), "uwu", 500);
  assert.equal(r.moved, 0);
  assert.equal(pool.uwu, 500);
});

test("bot holdings count as house money, so they are not double-credited", () => {
  const pool = acct("W1", { uwu: 100 });
  const bot: any = acct("us-extraction:bot:1", { uwu: 150 }); bot.isBot = true;
  const r = resyncPoolToChain(ledgerOf(pool, bot), new Set(["W1"]), "uwu", 500);
  assert.equal(r.moved, 250, "100 pool + 150 already in bots = 250 held; 250 to go");
  assert.equal(pool.uwu, 350);
  assert.equal(bot.uwu, 150, "money in play is not moved");
});
