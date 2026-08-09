// THE RATE PLAYERS ARE CHARGED, and what six surfaces say about it.
//
// WHY THIS FILE EXISTS, stated plainly: the arena's entry fee was moved 20 -> 100 basis points on
// devnet — a five-fold change to the one number every player pays — and 1,352 tests did not notice.
// Nothing pinned the displayed figure to anything, because the figure was a build-time constant and
// every assertion about it was written against that same constant. A test that folds the code's own
// constant into its expectation agrees with the code; it does not check it.
//
// So everything below drives the DERIVATION with rates the chain can actually hold, and the rates are
// literals: 20 (what the arena was created with), 100 (what it charges today), 0, and 1,000 — the
// program's `MAX_FEE_BPS` in `programs/bulls-arena/src/lib.rs`, mirrored in `scripts/admin-set-fee.mjs`
// and checked there before a transaction is spent. If someone reintroduces `FEE_BPS` into a display
// path, these fail.

import { describe, expect, it } from "vitest";
import { FEE_BPS, REFERRAL_SHARE_PCT, feeOn, feeRate, usdToUnits } from "../contract.ts";
import { feeFigure, feeNote, feePhrase, referralExample } from "./feeCopy.ts";

/** Every rate this arena can be in. `MAX_FEE_BPS` is 1,000 (10%) in lib.rs and the program rejects
 *  anything above it, so this is the whole legal range at its interesting points. */
const RATES = [0, 20, 100, 1_000] as const;

describe("the displayed rate is the chain's, not the constant's", () => {
  it("prints whatever the arena said, across the program's whole legal range", () => {
    expect(feePhrase(feeRate(0))).toBe("0%");
    expect(feePhrase(feeRate(20))).toBe("0.2%");
    expect(feePhrase(feeRate(100))).toBe("1%");
    expect(feePhrase(feeRate(1_000))).toBe("10%");
  });

  it("moves when the chain moves, which is the change that shipped unnoticed", () => {
    // The actual incident, as a test: the arena went from 20 bps to 100 bps and every surface kept
    // saying 0.20%. Two different chain values must never format to the same sentence.
    expect(feePhrase(feeRate(20))).not.toBe(feePhrase(feeRate(100)));
    expect(feeFigure(feeRate(20))).not.toBe(feeFigure(feeRate(100)));
  });

  it("ignores the fallback entirely once the account has answered", () => {
    // Widened deliberately: `FEE_BPS` is a literal type, and the claim being made is that this path
    // treats it as nothing more than a number — so the test has to pick a rate that differs from it
    // whatever it currently is, and keep meaning that after somebody next edits the constant.
    const fallback: number = FEE_BPS;
    const other = fallback === 20 ? 100 : 20;
    expect(feePhrase(feeRate(other))).not.toBe(feePhrase(feeRate(fallback)));
  });

  it("prices a stake off the chain's rate, so what reaches the ring tracks it too", () => {
    // `split_entry` in lib.rs: `stake * fee_bps / BPS`, floor. $100 at the peg.
    const stake = usdToUnits(100);
    expect(feeOn(stake, feeRate(20))).toBe(200_000n);
    expect(feeOn(stake, feeRate(100))).toBe(1_000_000n);
    expect(feeOn(stake, feeRate(1_000))).toBe(10_000_000n);
    // The figure a deploy panel prints as "in the ring" is the difference, and it moves with the rate.
    expect(stake - feeOn(stake, feeRate(20))).not.toBe(stake - feeOn(stake, feeRate(100)));
  });

  it("truncates the fee the way the program does, rather than rounding up into the house's favour", () => {
    // 1 unit at 100 bps is 0.01 of a unit. The chain floors; so must the figure quoted beside it, or
    // the panel promises a net stake the program will not credit.
    expect(feeOn(1n, feeRate(100))).toBe(0n);
    expect(feeOn(199n, feeRate(100))).toBe(1n);
  });
});

describe("a rate nobody has read", () => {
  const unread = feeRate(null);

  it("is not silently the fallback", () => {
    expect(unread.known).toBe(false);
    // The figure is present — the takeover has to finish its sentence — but never on its own.
    expect(feePhrase(unread)).toContain("not yet read");
  });

  it("renders nothing at all where the figure would stand alone", () => {
    // The dashboard tile and the referrals KV render `<Dash/>` on null, exactly as "Rounds opened"
    // does off the same unread account.
    expect(feeFigure(unread)).toBeNull();
    for (const bps of RATES) expect(feeFigure(feeRate(bps))).not.toBeNull();
  });

  it("says which figure it is showing and why, rather than hedging vaguely", () => {
    expect(feeNote(unread)).toContain("has not been read");
    expect(feeNote(unread)).toContain(feePhrase(feeRate(FEE_BPS)));
  });

  it("stops claiming anything the moment the account answers", () => {
    const known = feeRate(100);
    expect(feePhrase(known)).toBe("1%");
    expect(feePhrase(known)).not.toContain("not yet read");
    expect(feeNote(known)).not.toContain("has not been read");
    // The note is what licenses the bare figure — it has to say the rate is live, or the reader has
    // no way to know this page follows `set_fee_bps` at all.
    expect(feeNote(known)).toContain("set_fee_bps");
  });

  it("falls back to the constant and to nothing else", () => {
    expect(unread.bps).toBe(FEE_BPS);
  });
});

describe("a zero fee", () => {
  // 0 is a legal rate — `admin-set-fee.mjs` accepts it and the program's only bound is at the top —
  // and a free door must render as free, not as a broken figure. Nothing on this path divides BY the
  // rate, and these are the assertions that keep it that way.
  const free = feeRate(0);

  it("is a rate that WAS read, not the absence of one — the falsy-zero trap", () => {
    // `chainFeeBps || FEE_BPS` reads perfectly well and turns a genuinely free door into the
    // fallback's rate, permanently, with the page insisting it read the account. `feeRate` branches
    // on null and on nothing else.
    expect(free.known).toBe(true);
    expect(free.bps).toBe(0);
    expect(feeFigure(free)).not.toBeNull();
    expect(feeRate(null).bps).not.toBe(0);
  });

  it("never produces NaN, at any resolution", () => {
    expect(feePhrase(free)).toBe("0%");
    expect(feeFigure(free)).toBe("0%");
    for (const s of [feePhrase(free), feeFigure(free) ?? "", feeNote(free)]) {
      expect(s).not.toContain("NaN");
      expect(s).not.toContain("Infinity");
    }
  });

  it("takes nothing off a stake and leaves the whole thing in the ring", () => {
    const stake = usdToUnits(100);
    expect(feeOn(stake, free)).toBe(0n);
    expect(stake - feeOn(stake, free)).toBe(stake);
  });

  it("carries through the referral example as two honest zeros", () => {
    const e = referralExample(free, 100);
    expect(e.houseFeeUsd).toBe(0);
    expect(e.shareUsd).toBe(0);
    expect(Number.isFinite(e.shareUsd)).toBe(true);
  });
});

describe("the referrals worked example", () => {
  // The screen prints "10% of a 1% fee is $0.10 on a $100 deploy". Both dollar figures used to be
  // module constants folded against `FEE_BPS`, beside prose that spelled out the answer for a rate
  // the arena had already stopped charging.
  it("recomputes from the live rate rather than from the fallback", () => {
    expect(referralExample(feeRate(20), 100)).toEqual({ houseFeeUsd: 0.2, shareUsd: 0.02 });
    expect(referralExample(feeRate(100), 100)).toEqual({ houseFeeUsd: 1, shareUsd: 0.1 });
    expect(referralExample(feeRate(1_000), 100)).toEqual({ houseFeeUsd: 10, shareUsd: 1 });
  });

  it("keeps the share a tenth of the house fee at every rate", () => {
    for (const bps of RATES) {
      const e = referralExample(feeRate(bps), 100);
      expect(e.shareUsd).toBeCloseTo((e.houseFeeUsd * REFERRAL_SHARE_PCT) / 100, 12);
    }
  });

  it("scales with the deploy, so the example can be re-priced without touching the arithmetic", () => {
    expect(referralExample(feeRate(100), 50).shareUsd).toBeCloseTo(0.05, 12);
  });

  it("prices to something a reader can actually see in dollars", () => {
    // The whole reason the example exists: two percentages of each other come to almost nothing, and
    // a reader who is told "10% of the house fee" and nothing else walks away with the wrong number.
    // At the rate the arena charges today it is ten cents on a hundred dollars — which must survive
    // the trip through `usdToUnits`, where a value below a cent would round away to zero.
    expect(usdToUnits(referralExample(feeRate(100), 100).shareUsd)).toBe(100_000n);
  });
});
