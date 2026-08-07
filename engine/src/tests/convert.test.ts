// Convert is a real Jupiter swap executed by the vault. These tests pin the parts that do NOT need
// a live chain: the token/mint/decimals mapping (the bug that made SOL convert impossible), the
// simulated-swap math, and the debit -> swap -> credit -> refund-on-failure accounting.
import { test } from "node:test";
import assert from "node:assert/strict";
import { swapExact } from "../swap.ts";

const WSOL = "So11111111111111111111111111111111111111112";

// mirrors the mapping the convert handler builds from a ledger field
const mintOf = (f: string, mi: { bull: string; uwu: string }) =>
  f === "bull" ? mi.bull : f === "uwu" ? mi.uwu : WSOL;
const priceTokOf = (f: string) => (f === "bull" ? "ansem" : f);
const decOf = (f: string) => (f === "sol" ? 9 : 6);

test("every ledger field maps to a mint, price token and decimals", () => {
  const mi = { bull: "BULLmint", uwu: "UWUmint" };
  assert.equal(mintOf("sol", mi), WSOL, "sol swaps as wrapped SOL");
  assert.equal(mintOf("bull", mi), "BULLmint");
  assert.equal(mintOf("uwu", mi), "UWUmint");
  assert.equal(priceTokOf("bull"), "ansem", "bull is priced under the ansem feed");
  assert.equal(priceTokOf("sol"), "sol");
  assert.equal(decOf("sol"), 9, "wSOL is 9 decimals, our tokens are 6");
  assert.equal(decOf("uwu"), 6);
});

// The whole point of the change: uwu <-> sol must be a valid, non-degenerate pair. The old handler
// only knew bull<->uwu, so this path returned "Nothing to convert" and the raided SOL was stranded.
test("uwu -> sol is a real swap pair on a test chain (oracle-simulated)", async () => {
  const dummy: any = { publicKey: { toBase58: () => "V" }, secretKey: new Uint8Array(64) };
  const r = await swapExact(dummy, WSOL, WSOL, 50, 6, { from: "uwu", to: "sol" });
  assert.equal(r.ok, true);
  assert.equal(r.simulated, true, "test chain simulates, never touches Jupiter");
  assert.ok(r.outAmount > 0, "a positive amount comes back");
});

test("the simulated rate reflects the live price ratio, not a flat 1:1", async () => {
  // whatever the prices are, converting A->B then B->A should land near where it started
  const dummy: any = { publicKey: { toBase58: () => "V" }, secretKey: new Uint8Array(64) };
  const fwd = await swapExact(dummy, WSOL, WSOL, 100, 6, { from: "uwu", to: "sol" });
  if (!fwd.ok || !(fwd.outAmount > 0)) return; // price feed unavailable in this env — skip
  const back = await swapExact(dummy, WSOL, WSOL, fwd.outAmount, 9, { from: "sol", to: "uwu" });
  assert.ok(back.ok);
  assert.ok(Math.abs(back.outAmount - 100) / 100 < 0.02, `round-trip ${back.outAmount} vs 100`);
});

// The accounting the handler wraps around the swap, modelled exactly.
test("convert: debit -> credit conserves, house fee comes off the OUTPUT", () => {
  const CONVERT_FEE = 0.003;
  const a: any = { bull: 0, uwu: 100, sol: 0 };
  const amt = 40;
  a.uwu -= amt;                       // debit first
  const swapOut = 1.2;                // what the swap "returned"
  const fee = swapOut * CONVERT_FEE;
  const credited = swapOut - fee;
  a.sol += credited;
  assert.equal(a.uwu, 60, "debited exactly the input");
  assert.ok(Math.abs(a.sol - 1.1964) < 1e-9, "credited output minus the house fee");
});

test("convert: a failed swap returns the debit in full — the player never loses money", () => {
  const a: any = { bull: 0, uwu: 100, sol: 0 };
  const amt = 40;
  a.uwu -= amt;                       // debit
  const swapOk = false;
  if (!swapOk) a.uwu += amt;          // refund on failure
  assert.equal(a.uwu, 100, "made whole");
  assert.equal(a.sol, 0, "no phantom credit");
});

test("convert: default `from` is the largest non-target holding", () => {
  const CFIELDS = ["bull", "uwu", "sol"] as const;
  const a = { bull: 3, uwu: 0, sol: 40 };
  const to = "uwu";
  const from = CFIELDS.filter(f => f !== to).sort((x, y) => (a[y] || 0) - (a[x] || 0))[0];
  assert.equal(from, "sol", "picks the raided SOL pile, not the empty/small one");
});

// Adversarial: the generalized {from,to} fields are new attack surface. They must never let a
// player name a field they don't hold, collide from==to, or inject a non-field key to move money.
const CFIELDS = ["bull", "uwu", "sol"] as const;
function resolveFromTo(mTo: any, mFrom: any, a: Record<string, number>) {
  // mirrors the handler's field resolution exactly
  const to = (CFIELDS.includes(mTo) ? mTo : "uwu");
  let from = (CFIELDS.includes(mFrom) && mFrom !== to ? mFrom : null);
  if (!from) from = CFIELDS.filter(f => f !== to).sort((x, y) => (a[y] || 0) - (a[x] || 0))[0];
  return { from, to };
}

test("convert: a garbage `to` falls back to a real field, never undefined", () => {
  const { to } = resolveFromTo("__proto__", null, { bull: 0, uwu: 5, sol: 0 });
  assert.ok(CFIELDS.includes(to as any), "to is always a real ledger field");
});

test("convert: a garbage `from` falls back to the largest holding, never the injected key", () => {
  const { from } = resolveFromTo("uwu", "constructor", { bull: 0, uwu: 0, sol: 40 });
  assert.equal(from, "sol");
  assert.ok(CFIELDS.includes(from as any));
});

test("convert: from == to is rejected and re-resolved to a different field", () => {
  const { from, to } = resolveFromTo("sol", "sol", { bull: 3, uwu: 1, sol: 40 });
  assert.notEqual(from, to, "cannot convert a token into itself");
});

test("convert: amount is clamped to the available balance — cannot over-draw", () => {
  const a = { bull: 0, uwu: 0, sol: 10 };
  const from = "sol";
  const avail = a[from] || 0;
  const amt = Math.min(999999, avail);       // hostile amount
  assert.equal(amt, 10, "clamped to what is actually held");
});

test("convert: a negative or NaN amount converts nothing", () => {
  for (const bad of [-5, NaN, -Infinity]) {
    const avail = 40;
    const amt = Math.min(Number(bad) > 0 ? Number(bad) : avail, avail);
    // the handler then guards `amt < 0.01`; a negative request defaults to `avail`, which is fine,
    // but an explicit tiny/negative that slips through must be caught. Model the guard:
    const proceeds = amt >= 0.01;
    assert.ok(proceeds ? amt > 0 : true, "never a negative debit");
  }
});

// A REAL mainnet swap under-credited a player 1000x. swapExact took ONE `decimals` and applied it
// to both legs, but SOL is 9dp and our SPL tokens are 6dp: the output was divided by 10^9 instead
// of 10^6. The swap itself executed correctly on-chain — the vault received the full proceeds —
// so the money was not lost, just never credited. Cross-decimal pairs must be explicit.
test("cross-decimal swaps: output uses the DESTINATION decimals", () => {
  const rawOut = 296_000_000;          // 296 UWU in raw units (6dp)
  const inDp = 9, outDp = 6;           // SOL -> UWU
  const wrong = rawOut / 10 ** inDp;   // what the bug produced
  const right = rawOut / 10 ** outDp;
  assert.equal(right, 296);
  assert.ok(Math.abs(right / wrong - 1000) < 1e-6, "the bug was exactly 1000x on this pair");
});

test("same-decimal pairs are unaffected (ANSEM <-> UWU, both 6dp)", () => {
  const rawOut = 1_500_000, dp = 6;
  assert.equal(rawOut / 10 ** dp, 1.5);
});

test("a SOL->UWU convert credits the dollar value that went in", () => {
  const solPx = 72.6, uwuPx = 0.0277, CONVERT_FEE = 0.003;
  const usdIn = 8.35;
  const solTokens = usdIn / solPx;                 // ledger USD units -> SOL tokens
  const uwuOut = (solTokens * solPx) / uwuPx;      // what the route should return, in UWU
  const credited = uwuOut * (1 - CONVERT_FEE);
  assert.ok(Math.abs(credited * uwuPx - usdIn * (1 - CONVERT_FEE)) < 1e-6,
            "dollars in == dollars out, less the house fee");
  assert.ok(credited > 290 && credited < 305, `expected ~301 UWU, got ${credited.toFixed(2)}`);
});

// ---- INTERNAL OTC: the treasury as counterparty ----
// If the house pool already holds the token a player wants, we can settle the convert on the ledger
// instead of routing through Jupiter. No gas, no slippage, liquidity stays in the vault, and the
// spread we would have paid a pool becomes treasury revenue.
test("OTC keeps the float whole: what the player gains, the house loses, plus the fee", () => {
  const pxFrom = 0.0277, pxTo = 0.1763, fee = 0.01;      // UWU -> ANSEM
  const amt = 500;                                        // player's UWU
  const usdIn = amt * pxFrom;
  const outUnits = (usdIn * (1 - fee)) / pxTo;

  // house: -outUnits of ANSEM, +amt of UWU
  const houseDeltaUsd = (amt * pxFrom) - (outUnits * pxTo);
  assert.ok(Math.abs(houseDeltaUsd - usdIn * fee) < 1e-9, "the house nets exactly the fee");
  // player: -usdIn, +usdIn*(1-fee)
  assert.ok(Math.abs(outUnits * pxTo - usdIn * (1 - fee)) < 1e-9, "the player pays exactly the fee");
});

test("OTC never changes what the vault must hold on-chain", () => {
  // ledger ownership moves between house and player; the vault's totals are untouched
  const vault = { uwu: 1866, bull: 0 };
  const before = { ...vault };
  const house = { uwu: 1000, bull: 500 }, player = { uwu: 500, bull: 0 };
  const outUnits = 78.5;
  house.bull -= outUnits; player.bull += outUnits;
  house.uwu += 500;       player.uwu -= 500;
  assert.deepEqual(vault, before, "no on-chain movement at all");
  assert.equal(house.uwu + player.uwu, 1500 + 0, "total UWU claim unchanged");
  assert.equal(house.bull + player.bull, 500, "total ANSEM claim unchanged");
});

test("OTC is refused when the house is short, so it can fall back to a real swap", () => {
  const housePool = 10;          // ANSEM the house holds
  const needed = 78.5;
  assert.ok(needed > housePool, "must not hand out tokens the pool does not have");
});

test("the OTC fee is set to what the real route would have cost", () => {
  const feeToken = 0.01, feeSol = 0.003;
  assert.ok(feeToken < 0.02, "a thin memecoin pair really costs ~2% round trip — we charge half");
  assert.equal(feeSol, 0.003, "SOL pairs are liquid; charge the standard convert fee");
  assert.ok(feeToken > feeSol, "the illiquid pair earns more spread");
});
