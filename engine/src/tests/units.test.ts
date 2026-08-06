// The sim is unit-agnostic: it just compares the numbers it is handed. That makes the CONVERSION
// BOUNDARY the place fairness is won or lost, and it is where it was lost in production.
//
// us-extraction pits UWU against SOL. Bots on the UWU side entered raw token counts (49.7 UWU) while
// the SOL side entered dollars (1.6), because `sol` is already USD-denominated. The sim read those
// as army sizes, so the UWU army was ~30x larger for a third of the money and won every single
// round. These tests pin the rule that prevents it: everything crosses into the sim in USD, and
// payouts cross back into each side's own token.
import { test } from "node:test";
import assert from "node:assert/strict";

// mirrors server.ts: `sol` is already dollars, tokens convert at their price
const PX: Record<string, number> = { uwu: 0.02953, bull: 0.1746, sol: 1 };
const toUsd = (field: string, units: number) => units * PX[field];
const fromUsd = (field: string, usd: number) => usd / PX[field];

test("equal dollars produce equal armies, whatever the token is worth", () => {
  const oneDollarOfUwu = fromUsd("uwu", 1);
  const oneDollarOfSol = fromUsd("sol", 1);
  assert.notEqual(oneDollarOfUwu, oneDollarOfSol, "the raw token counts differ wildly");
  // ...but what the sim receives must not
  assert.equal(toUsd("uwu", oneDollarOfUwu).toFixed(6), toUsd("sol", oneDollarOfSol).toFixed(6));
});

test("the production numbers: raw counts gave UWU a ~30x army for a third of the money", () => {
  const uwuUnits = 49.7, solUnits = 1.6 + 1.7;
  // what the sim used to see
  assert.ok(uwuUnits / solUnits > 14, "raw counts: UWU fields an overwhelming army");
  // what it sees now — and the SOL side is actually the bigger bet
  const uwuUsd = toUsd("uwu", uwuUnits), solUsd = toUsd("sol", solUnits);
  assert.ok(solUsd > uwuUsd, `SOL staked more money: $${solUsd.toFixed(2)} vs $${uwuUsd.toFixed(2)}`);
});

test("a stake round-trips through USD without losing value", () => {
  for (const field of ["uwu", "bull", "sol"]) {
    const units = 137.42;
    const back = fromUsd(field, toUsd(field, units));
    assert.ok(Math.abs(back - units) < 1e-9, `${field} round-trip lost value`);
  }
});

test("settlement pays each side in its own token, conserving dollars", () => {
  // two entries, equal money, different tokens; winner takes the pot
  const potUsd = toUsd("uwu", fromUsd("uwu", 5)) + toUsd("sol", 5);
  assert.equal(potUsd.toFixed(6), (10).toFixed(6));
  const paidToUwuSide = fromUsd("uwu", potUsd);
  assert.equal(toUsd("uwu", paidToUwuSide).toFixed(6), potUsd.toFixed(6),
               "converting the payout back into UWU must preserve the dollar value");
});

// A round is entered and settled ~60s apart. A feed that drops to zero in between would turn the
// payout conversion into a divide-by-zero and silently wipe the winnings.
test("a dead price feed must never convert a payout to zero or infinity", () => {
  const lastGood: Record<string, number> = { uwu: 0.02953 };
  const safePx = (live: number, field: string) => {
    if (live > 0) { lastGood[field] = live; return live; }
    return lastGood[field] || 0;
  };
  const px = safePx(0, "uwu");                       // feed is down
  assert.ok(px > 0, "falls back to the last good price");
  const paid = 10 / px;
  assert.ok(Number.isFinite(paid) && paid > 0, "payout stays finite and positive");
});
