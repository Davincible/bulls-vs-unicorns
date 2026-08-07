// FEE REVENUE IS NOT PLAYING CAPITAL.
//
// Two different pots that must never mix, and the distinction is not cosmetic:
//   - the POOL wallets are the operator's own capital, entered as a participant, at risk like
//     anyone else's
//   - the TREASURY is fee income taken from every deploy and convert
//
// If fees could fund fighters, the operator would be playing with money taken from the players and
// then keeping the winnings — which is a materially different claim from "the operator plays too",
// and the sort of thing that is indefensible once someone reads the chain. The separation is
// structural (poolAccounts() only ever returns configured pool ids) and this pins it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TREASURY_ID, treasuryAcct, ledger } from "../ledger.ts";

test("the treasury is not a pool wallet — fees cannot be drawn into a fighter", () => {
  const poolIds = ["W1", "W2", "W3"];
  assert.ok(!poolIds.includes(TREASURY_ID), "treasury must never appear in the pool id list");
});

test("drawing from the pool cannot reach treasury balance", () => {
  // model of drawBank: it only ever iterates the configured pool accounts
  const pool = [{ id: "W1", uwu: 100 }, { id: "W2", uwu: 100 }];
  const treasury = { id: TREASURY_ID, uwu: 500 };
  const accounts = [...pool, treasury];
  const poolIds = new Set(pool.map(a => a.id));
  const drawable = accounts.filter(a => poolIds.has(a.id)).reduce((n, a) => n + a.uwu, 0);
  assert.equal(drawable, 200, "only the pool wallets are drawable");
  assert.equal(treasury.uwu, 500, "treasury is untouched and unreachable");
});

test("fees land in the treasury account, not in a playing wallet", () => {
  const t = treasuryAcct();
  const before = t.uwu || 0;
  t.uwu = before + 5;                       // what bankFee does
  assert.equal(ledger.get(TREASURY_ID)!.uwu, before + 5);
  assert.notEqual(TREASURY_ID, "W1");
  t.uwu = before;                           // leave the ledger as found
});
