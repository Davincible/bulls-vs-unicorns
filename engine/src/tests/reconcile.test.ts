// Solvency-guard invariants. `evaluate` is the pure core of the reconciliation daemon: given
// per-asset liabilities vs on-chain holdings, it decides whether the book is solvent. A breach on
// ANY asset makes the whole report not-ok (which freezes withdrawals in the live daemon).
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "../reconcile.ts";

test("solvent when every asset is fully backed", () => {
  const r = evaluate([
    { asset: "bull", liability: 100, holdings: 100 },
    { asset: "uwu", liability: 40, holdings: 55 },
    { asset: "sol", liability: 3.2, holdings: 5.0 },
  ]);
  assert.equal(r.ok, true);
  assert.ok(r.assets.every(a => a.ok && a.shortfall === 0));
});

test("a shortfall on one asset fails the whole report", () => {
  const r = evaluate([
    { asset: "bull", liability: 100, holdings: 100 },
    { asset: "uwu", liability: 40, holdings: 39.5 },   // 0.5 short
  ]);
  assert.equal(r.ok, false);
  const uwu = r.assets.find(a => a.asset === "uwu")!;
  assert.equal(uwu.ok, false);
  assert.ok(Math.abs(uwu.shortfall - 0.5) < 1e-9);
});

test("float dust within tolerance does NOT trip a breach", () => {
  const r = evaluate([{ asset: "bull", liability: 100.00005, holdings: 100 }]);
  assert.equal(r.ok, true, "sub-1e-4 dust must not freeze the book");
});

test("exactly equal holdings are solvent (boundary)", () => {
  const r = evaluate([{ asset: "sol", liability: 12.5, holdings: 12.5 }]);
  assert.equal(r.ok, true);
});

test("an unpriced asset is indeterminate — never a breach, never null", () => {
  // SOL owed but price feed down: must not read as insolvency, must not freeze, must not emit null
  const r = evaluate([{ asset: "sol", liability: 900, holdings: 5, unpriced: true }]);
  assert.equal(r.ok, true, "a price outage must not trip the freeze");
  const sol = r.assets[0];
  assert.equal(sol.unpriced, true);
  assert.equal(sol.liability, 0);
  assert.equal(sol.shortfall, 0);
});

test("non-finite liability/holdings are coerced to 0, not emitted as null", () => {
  const r = evaluate([{ asset: "sol", liability: NaN, holdings: 5 }, { asset: "bull", liability: 10, holdings: undefined as any }]);
  const sol = r.assets[0], bull = r.assets[1];
  assert.equal(sol.liability, 0);        // NaN -> 0 (was surfacing as null in JSON)
  assert.equal(sol.ok, true);
  assert.equal(bull.holdings, 0);        // undefined -> 0
  assert.equal(bull.ok, false);          // owe 10, hold 0 -> real shortfall still caught
  assert.ok(Number.isFinite(bull.shortfall));
});
