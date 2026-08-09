// The money formatters.
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
import { UNITS_PER_USD, unitsToUsd, usd, usdSigned, usdToUnits } from "./contract.ts";

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
