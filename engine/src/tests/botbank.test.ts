// Bot bankroll invariants. Bots play with REAL deposited money, so drawing must conserve value and
// must spread the float across the population — the first version let ~20 bots swallow the entire
// pool (3000 -> 0 in 16 minutes), which left every later bot with a zero bank and emptied arenas.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ledger, acct } from "../ledger.ts";
import { initBotBank, drawBank, returnBank, poolBalance, botBankReady } from "../bot-bank.ts";

const POOL = ["poolA", "poolB", "poolC"];
function seedPool(perAccount = 1000) {
  ledger.clear();
  process.env.BOT_POOL = POOL.join(",");
  for (const id of POOL) { const a = acct(id, "bull"); a.bull = perAccount; a.uwu = perAccount; }
  return initBotBank();
}

test("pool initialises from the configured addresses and marks them house accounts", () => {
  const p = seedPool(1000);
  assert.equal(p.wallets, 3);
  assert.equal(p.bull, 3000);
  assert.equal(botBankReady(), true);
  for (const id of POOL) assert.equal(ledger.get(id)!.isBot, true, "pool wallets are house money, not player liabilities");
});

test("drawing conserves value — what leaves the pool is exactly what the bot receives", () => {
  seedPool(1000);
  const before = poolBalance("bull");
  const got = drawBank("bull", 120);
  assert.ok(got > 0);
  assert.ok(Math.abs((before - poolBalance("bull")) - got) < 1e-9, "pool must fall by exactly the granted amount");
});

test("no single bot can swallow the float — draws are capped to a share", () => {
  seedPool(1000);                       // 3000 total
  const got = drawBank("bull", 99999);  // greedy request
  assert.ok(got < 3000, `a single draw must not take the whole pool, took ${got}`);
  assert.ok(poolBalance("bull") > 2000, "most of the float must remain for other bots");
});

test("a large population still gets funded instead of the first few taking everything", () => {
  seedPool(1000);                       // 3000 total
  const grants: number[] = [];
  for (let i = 0; i < 200; i++) grants.push(drawBank("bull", 150));
  const funded = grants.filter(g => g > 0.01).length;
  assert.ok(funded > 150, `most bots should get something, only ${funded}/200 did`);
  assert.ok(poolBalance("bull") >= -1e-9, "pool never goes negative");
  const total = grants.reduce((a, b) => a + b, 0);
  assert.ok(total <= 3000 + 1e-6, `cannot hand out more than the float (${total} of 3000)`);
});

test("returnBank puts money back (a pruned bot's remainder is recycled)", () => {
  seedPool(1000);
  const got = drawBank("uwu", 100);
  const after = poolBalance("uwu");
  returnBank("uwu", got);
  assert.ok(Math.abs(poolBalance("uwu") - (after + got)) < 1e-9);
});

test("an empty pool grants nothing rather than inventing money", () => {
  seedPool(0);
  assert.equal(drawBank("bull", 100), 0);
  assert.equal(botBankReady(), false, "no float means bots simply cannot deploy");
});
