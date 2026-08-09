// The money formatters, and the one that counts things.
//
// `usd()` acquired a cache of `Intl.NumberFormat` instances because it is called from inside the
// arena's 60Hz loop — `toLocaleString(locale, options)` rebuilds a formatter on every call, which
// profiled at 2.7% of all samples during a sixteen-fighter fight. A cache is the correct fix and
// also exactly the kind of change that silently alters output at a rounding boundary, in a function
// whose entire job is rendering other people's money.
//
// So the central test here is an EQUIVALENCE PROPERTY, not a table of expected strings: the cached
// implementation is compared against a literal transcription of the code it replaced, across the
// full range of magnitudes and every decimal-place count in use. A table of hand-written expectations
// would only prove that someone typed the same string twice; this proves the optimisation is
// invisible, which is the actual claim being made.

import { describe, expect, it } from "vitest";
import {
  ONE_CENT_UNITS,
  UNITS_PER_USD,
  counted,
  unitsToUsd,
  usd,
  usdCompact,
  usdCompactSigned,
  usdSigned,
  usdToUnits,
} from "./contract.ts";

/** The implementation as it stood before the cache — the oracle. Do not "fix" this to call `usd`. */
function usdReference(units: bigint, dp?: number): string {
  const v = Number(units) / Number(UNITS_PER_USD);
  const places = dp ?? (Math.abs(v) >= 1000 ? 0 : 2);
  return `$${v.toLocaleString("en-US", {
    minimumFractionDigits: places,
    maximumFractionDigits: places,
  })}`;
}

/** Magnitudes worth crossing: sub-cent, the cent, the dp-switching $1,000 boundary, a whole pot, and
 *  a figure past the point where a double stops representing units exactly. */
const INTERESTING_UNITS: bigint[] = [
  0n, 1n, 4n, 5n, 6n, 9n, 10n, 499n, 500n, 501n, 999n, 1_000n, 5_000n, 9_999n,
  10_000n, 999_999n, 1_000_000n, 1_000_001n, 4_999_999n, 5_000_000n,
  999_499_999n, 999_500_000n, 999_999_999n, 1_000_000_000n, 1_000_000_001n,
  1_234_560_000n, 99_999_999_999n, 100_000_000_000n, 8_675_309_000_000n,
];

describe("usd", () => {
  it("is byte-identical to the uncached implementation it replaced", () => {
    for (const dp of [undefined, 0, 1, 2, 3, 4] as const) {
      for (const u of INTERESTING_UNITS) {
        expect(usd(u, dp), `usd(${u}n, ${dp})`).toBe(usdReference(u, dp));
        expect(usd(-u, dp), `usd(${-u}n, ${dp})`).toBe(usdReference(-u, dp));
      }
    }
  });

  it("is byte-identical across a dense sweep, where a rounding boundary would hide", () => {
    // Every 137 units from 0 to 2,000,000 — a stride chosen to be coprime with 10, 100 and 1000 so
    // it lands on and between every rounding boundary rather than marching in step with one.
    for (let u = 0n; u <= 2_000_000n; u += 137n) {
      for (const dp of [undefined, 2, 3] as const) {
        if (usd(u, dp) !== usdReference(u, dp)) {
          // Assert inside the guard so a failure names the input instead of printing 43,000 passes.
          expect(usd(u, dp), `usd(${u}n, ${dp})`).toBe(usdReference(u, dp));
        }
      }
    }
  });

  it("returns the same string for a repeated call — the cache is not stateful across calls", () => {
    // The failure this guards is a formatter that carries state between `format()` calls. It does
    // not, but "we reused an object" is precisely the change that would make it matter.
    const seen = new Map<string, string>();
    for (let i = 0; i < 3; i++) {
      for (const u of INTERESTING_UNITS) {
        for (const dp of [0, 2, 3]) {
          const key = `${u}/${dp}`;
          const got = usd(u, dp);
          if (seen.has(key)) expect(got, key).toBe(seen.get(key));
          else seen.set(key, got);
        }
      }
    }
  });

  it("interleaves decimal-place counts without cross-contamination", () => {
    // One formatter per `dp`, so asking for 3dp between two 2dp calls must not leak into them.
    const two = usd(1_234_567n, 2);
    expect(usd(1_234_567n, 3)).not.toBe(two);
    expect(usd(1_234_567n, 0)).not.toBe(two);
    expect(usd(1_234_567n, 2)).toBe(two);
  });

  it("switches to whole dollars at $1,000 and keeps cents below it", () => {
    expect(usd(999_990_000n)).toBe("$999.99");
    expect(usd(1_000_000_000n)).toBe("$1,000");
    expect(usd(1_234_560_000n)).toBe("$1,235");
    expect(usd(1_234_560_000n, 2)).toBe("$1,234.56");
  });

  it("groups thousands and prefixes a dollar sign", () => {
    expect(usd(0n)).toBe("$0.00");
    expect(usd(5_000_000n)).toBe("$5.00");
    expect(usd(100_000_000_000n)).toBe("$100,000");
  });
});

describe("usdSigned", () => {
  it("is byte-identical to the composition of the uncached formatter", () => {
    const ref = (units: bigint, dp?: number) => {
      const s = usdReference(units < 0n ? -units : units, dp);
      if (units === 0n) return s;
      return units < 0n ? `−${s}` : `+${s}`;
    };
    for (const dp of [undefined, 0, 2, 3] as const) {
      for (const u of INTERESTING_UNITS) {
        expect(usdSigned(u, dp), `usdSigned(${u}n, ${dp})`).toBe(ref(u, dp));
        expect(usdSigned(-u, dp), `usdSigned(${-u}n, ${dp})`).toBe(ref(-u, dp));
      }
    }
  });

  it("gives exactly zero no sign — it is a fact, not a win of nothing", () => {
    expect(usdSigned(0n)).toBe("$0.00");
    expect(usdSigned(0n, 2)).toBe("$0.00");
  });

  it("uses a real minus sign for losses and a plus for gains", () => {
    expect(usdSigned(5_000_000n, 2)).toBe("+$5.00");
    expect(usdSigned(-5_000_000n, 2)).toBe("−$5.00");
  });
});

// `usdCompact` gets a TABLE of expectations rather than an equivalence property, and deliberately so
// — unlike `usd()` it replaces nothing, so there is no oracle to compare against. What it does have
// is a contract with a layout: every output must fit an eight-character mono cell, and every
// threshold is a place where a reader's understanding of a figure changes. Those are the cases.
describe("usdCompact", () => {
  const M = 1_000_000n; // units in one dollar, restated for readability in the table below

  it("keeps two decimals below $1,000, where cents are load-bearing", () => {
    // The per-side cap is $100 and real fighters sit at $8-$100, so this is the whole live range of
    // an actual stake. A $12.40 fighter and a $12.90 one must never both read "$12".
    expect(usdCompact(0n)).toBe("$0.00");
    expect(usdCompact(2n * M)).toBe("$2.00");
    expect(usdCompact(12_400_000n)).toBe("$12.40");
    expect(usdCompact(980_500_000n)).toBe("$980.50");
    expect(usdCompact(999_990_000n)).toBe("$999.99");
    expect(usdCompact(20_000n)).toBe("$0.02");
  });

  it("switches to k once the two-decimal reading would carry to $1,000", () => {
    expect(usdCompact(999_994_999n)).toBe("$999.99"); // rounds to 999.99 — still the exact path
    // …and one unit later it rounds to 1,000.00, which as a full string is "$1,000.00": nine
    // characters with a separator in it. The ladder takes it instead.
    expect(usdCompact(999_995_000n)).toBe("$1k");
    expect(usdCompact(1_000n * M)).toBe("$1k");
    expect(usdCompact(1_000n * M + 1n)).toBe("$1k");
  });

  it("scales through k, M, B and T — a u64 tops out at $18.4T, so T is the last rung needed", () => {
    expect(usdCompact(13_215n * M)).toBe("$13.2k");
    expect(usdCompact(1_400_000n * M)).toBe("$1.4M");
    expect(usdCompact(2_500_000_000n * M)).toBe("$2.5B");
    expect(usdCompact(13_487_910_540_099n * M)).toBe("$13.5T");
    // The largest figure the chain can hold at all: u64::MAX units.
    expect(usdCompact(18_446_744_073_709_551_615n)).toBe("$18.4T");
  });

  it("strips a trailing .0 — `$13k`, never `$13.0k`", () => {
    expect(usdCompact(13_000n * M)).toBe("$13k");
    expect(usdCompact(5_000_000n * M)).toBe("$5M");
    expect(usdCompact(13_050n * M)).toBe("$13.1k"); // .05 rounds up into a digit worth keeping
  });

  it("carries a rounded tier ceiling up a rung instead of printing $1000.0k", () => {
    // The bug a naive divide-then-round has at the top of EVERY tier: 999,999 / 1,000 is 999.999,
    // which renders "1000.0k". The tier is chosen from the rounded figure, so it steps up.
    expect(usdCompact(999_999n * M)).toBe("$1M");
    expect(usdCompact(999_999_999n * M)).toBe("$1B");
    expect(usdCompact(999_950n * M)).toBe("$1M");
    expect(usdCompact(999_940n * M)).toBe("$999.9k"); // just below the carry, stays in k
  });

  it("floors a real sub-cent amount at a bound, never at $0.00", () => {
    // The bug caught on a live devnet round: a fighter whittled down to dust was still extractable
    // and the button offered to bank "$0.00". A player being paid something must not be told they
    // are being paid nothing.
    expect(usdCompact(1n)).toBe("<$0.01");
    expect(usdCompact(9_999n)).toBe("<$0.01");
    expect(usdCompact(10_000n)).toBe("$0.01"); // exactly one cent is a cent
    expect(usdCompact(-1n)).toBe("−<$0.01");
  });

  it("puts the minus outside the dollar sign, as every other figure on the page does", () => {
    expect(usdCompact(-13_215n * M)).toBe("−$13.2k");
    expect(usdCompact(-5n * M)).toBe("−$5.00");
  });

  it("never exceeds the eight characters the narrowest money column can hold", () => {
    // The layout claim the thresholds exist to make good on. The narrowest money track on the page
    // is 66px (`.roster` at <=560px) against ~7px per mono glyph at 12px.
    for (const u of [
      0n, 1n, 10_000n, 999_990_000n, 999_995_000n, 1_000n * M, 999_940n * M, 999_999n * M,
      13_487_910_540_099n * M, 18_446_744_073_709_551_615n,
    ]) {
      expect(usdCompact(u).length, `usdCompact(${u}n)`).toBeLessThanOrEqual(8);
      expect(usdCompact(-u).length, `usdCompact(${-u}n)`).toBeLessThanOrEqual(8);
    }
  });

  it("holds the eight-character bound across a sweep of every magnitude", () => {
    // The spot cases above are the ones a reader would think of. This is the one that would actually
    // catch a regression: every tier boundary, every carry, every sign, walked densely. The stride
    // is coprime with the powers of ten so it lands on and between rounding boundaries rather than
    // marching in step with one.
    for (let u = 1n; u < 10n ** 20n; u = (u * 13n) / 7n + 1n) {
      for (const v of [u, -u]) {
        const s = usdCompact(v);
        if (s.length > 8 || s.includes(",")) {
          // Assert inside the guard so a failure names the input instead of printing 200 passes.
          expect(s, `usdCompact(${v}n)`).toBe("<= 8 chars, no separator");
        }
      }
    }
  });
});

describe("usdCompactSigned", () => {
  it("gives exactly zero no sign, exactly as usdSigned does", () => {
    expect(usdCompactSigned(0n)).toBe("$0.00");
  });

  it("signs both directions and agrees with usdCompact on the magnitude", () => {
    expect(usdCompactSigned(13_215_000_000n)).toBe("+$13.2k");
    expect(usdCompactSigned(-13_215_000_000n)).toBe("−$13.2k");
    expect(usdCompactSigned(-13_215_000_000n)).toBe(usdCompact(-13_215_000_000n));
  });

  it("carries the sub-cent floor through the sign", () => {
    expect(usdCompactSigned(1n)).toBe("+<$0.01");
    expect(usdCompactSigned(-1n)).toBe("−<$0.01");
  });

  it("is the compact reading of the same value usdSigned prints in full", () => {
    // Not a redundant assertion: it pins that the two formatters never disagree about SIGN, which is
    // the one thing a reader compares between a table cell and the panel it links to.
    for (const u of [0n, 1n, 5_000_000n, -5_000_000n, 13_215_000_000n, -999_999_000_000n]) {
      const compact = usdCompactSigned(u);
      const full = usdSigned(u, 2);
      expect(compact.startsWith("+"), `${u}n`).toBe(full.startsWith("+"));
      expect(compact.startsWith("−"), `${u}n`).toBe(full.startsWith("−"));
    }
  });
});

describe("ONE_CENT_UNITS", () => {
  it("is exactly one cent, derived from the peg rather than typed twice", () => {
    expect(ONE_CENT_UNITS).toBe(10_000n);
    expect(ONE_CENT_UNITS).toBe(usdToUnits(0.01));
    expect(unitsToUsd(ONE_CENT_UNITS)).toBe(0.01);
  });
});

describe("unit conversion", () => {
  it("round-trips whole cents", () => {
    for (let c = 0; c <= 20_000; c += 7) {
      const dollars = c / 100;
      expect(unitsToUsd(usdToUnits(dollars))).toBeCloseTo(dollars, 9);
    }
  });

  it("keeps cents rather than flooring them away", () => {
    expect(unitsToUsd(1_500_000n)).toBe(1.5);
    expect(unitsToUsd(1n)).toBe(0.000001);
  });
});

// -------------------------------------------------------------------------------------------
// `counted` — a count and its noun, agreeing.
//
// It exists because `POT ON THE TABLE · 1 FIGHTERS · 1 HOUSE · 1 STILL ALIVE` shipped to production.
// A one-entrant lobby is not an edge case in this arena: the keeper holds a lobby open with a single
// house fighter in it until a real player arrives, so the singular is the reading a visitor is MOST
// likely to get, and it was the only one nobody had written.

describe("counted", () => {
  it("agrees at one, which is the case that shipped wrong", () => {
    expect(counted(1, "fighter")).toBe("1 fighter");
    expect(counted(1, "round")).toBe("1 round");
  });

  it("pluralises everything else, zero included", () => {
    // Zero takes the plural in English — "0 fighters", not "0 fighter" — and zero is a real state
    // here: an empty lobby before anybody has entered.
    expect(counted(0, "fighter")).toBe("0 fighters");
    expect(counted(2, "fighter")).toBe("2 fighters");
    expect(counted(250, "round")).toBe("250 rounds");
  });

  it("counts a bigint the same way, because half this page's counts are chain-shaped", () => {
    // `LogCoverage.roundsEverOpened` is a `u64`. A caller forced to convert would eventually convert
    // one of them wrong, and `1n === 1` is false — which is the bug this test exists to pin.
    expect(counted(1n, "round")).toBe("1 round");
    expect(counted(0n, "round")).toBe("0 rounds");
    expect(counted(613n, "round")).toBe("613 rounds");
  });

  it("takes an irregular plural rather than guessing at one", () => {
    expect(counted(1, "entry", "entries")).toBe("1 entry");
    expect(counted(3, "entry", "entries")).toBe("3 entries");
  });

  it("does not group thousands, so it never disagrees with a figure beside it", () => {
    // Every noun this counts is a small population. A caller that genuinely needs grouping passes the
    // grouped string it already built — see the step figures, which do.
    expect(counted(4000, "step")).toBe("4000 steps");
  });
});
