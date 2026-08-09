// The simulated ledger's arithmetic and, just as importantly, its refusal to die on bad input: it is
// the one module here whose state outlives the page, so a value written by an older build (or by
// somebody poking at devtools) has to degrade to a fresh ledger rather than white-screening the app.

import { describe, expect, it } from "vitest";
import { CONVERT_BPS, FEE_BPS, type SimLedger } from "../contract.ts";
import {
  INITIAL_LEDGER,
  convert,
  deposit,
  recordDeploy,
  registerReferral,
  sanitize,
  topUp,
  withdraw,
} from "./simLedger.ts";

const START: SimLedger = INITIAL_LEDGER;

describe("deposit / withdraw", () => {
  it("credits the balance and the all-time deposited total", () => {
    const l = deposit(START, "ansem", 50);
    expect(l.balances.ansem).toBe(START.balances.ansem + 50);
    expect(l.deposited).toBe(50);
  });

  it("books only what was actually there when a withdrawal overdraws", () => {
    const l = withdraw({ ...START, balances: { ...START.balances, sol: 10 } }, "sol", 25);
    expect(l.balances.sol).toBe(0);
    expect(l.withdrawn).toBe(10);
  });

  it("ignores amounts that aren't a positive finite number", () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(deposit(START, "uwu", bad)).toBe(START);
      expect(withdraw(START, "uwu", bad)).toBe(START);
    }
  });

  it("leaves the ledger untouched rather than mutating it in place", () => {
    const before = START.balances.ansem;
    deposit(START, "ansem", 100);
    expect(START.balances.ansem).toBe(before);
  });
});

describe("convert", () => {
  it("moves value 1:1 minus CONVERT_BPS and books the fee as house revenue", () => {
    const l = convert(START, "ansem", "uwu", 100);
    const fee = (100 * CONVERT_BPS) / 10_000;
    expect(l.balances.ansem).toBe(START.balances.ansem - 100);
    expect(l.balances.uwu).toBe(START.balances.uwu + (100 - fee));
    expect(l.treasury.uwu).toBe(fee);
  });

  it("refuses to convert a token into itself", () => {
    expect(convert(START, "sol", "sol", 10)).toBe(START);
  });
});

describe("recordDeploy", () => {
  it("debits the stake and accrues the arena fee to the treasury", () => {
    const l = recordDeploy(START, "ansem", 100);
    expect(l.balances.ansem).toBe(START.balances.ansem - 100);
    expect(l.treasury.ansem).toBe((100 * FEE_BPS) / 10_000);
    expect(l.referralEarned).toBe(0);
  });

  it("never blocks or negates a deploy the chain already accepted", () => {
    const broke = { ...START, balances: { ...START.balances, uwu: 5 } };
    const l = recordDeploy(broke, "uwu", 100);
    expect(l.balances.uwu).toBe(0);
    expect(l.treasury.uwu).toBeGreaterThan(0);
  });

  it("splits the referral share out of the house fee once a referral is registered", () => {
    const referred = registerReferral(START, true);
    expect(referred.referralCount).toBe(1);
    const l = recordDeploy(referred, "ansem", 100);
    const fee = (100 * FEE_BPS) / 10_000;
    expect(l.referralEarned).toBeCloseTo(fee * 0.1, 12);
    // The referral share comes OUT of the house's take — it is not minted alongside it.
    expect(l.treasury.ansem + l.referralEarned).toBeCloseTo(fee, 12);
  });

  it("counts a reload as the same referral, not a new one", () => {
    expect(registerReferral(registerReferral(START, true), true).referralCount).toBe(1);
  });
});

describe("topUp", () => {
  it("adds the original's $100 & $100 of test money", () => {
    const l = topUp(START);
    expect(l.balances.ansem).toBe(START.balances.ansem + 100);
    expect(l.balances.uwu).toBe(START.balances.uwu + 100);
    expect(l.balances.sol).toBe(START.balances.sol);
  });
});

describe("sanitize", () => {
  it("rebuilds a whole ledger from nothing at all", () => {
    for (const junk of [null, undefined, 42, "nope", []]) {
      expect(sanitize(junk)).toEqual(INITIAL_LEDGER);
    }
  });

  it("keeps the fields that are real and replaces the ones that aren't", () => {
    const l = sanitize({ balances: { ansem: 7, uwu: "twelve" }, deposited: Number.NaN, withdrawn: 3 });
    expect(l.balances.ansem).toBe(7);
    expect(l.balances.uwu).toBe(INITIAL_LEDGER.balances.uwu);
    expect(l.deposited).toBe(0);
    expect(l.withdrawn).toBe(3);
  });
});
