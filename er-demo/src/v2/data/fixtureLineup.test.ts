// The fixture's lineup builder, and the clamp that stands between a URL and it.
//
// TWO THINGS THIS SUITE IS ACTUALLY FOR, beyond the obvious:
//
//   1. THE DEFAULT MUST NOT MOVE. `?fighters=n` was added while other people were mid-review against
//      screenshots of the nine-fighter fixture. `the_original_nine_are_frozen` pins the exact wallet
//      strings the hand-written fixture produced, so any future change to the generator, the draw
//      order, or the alphabet fails here rather than silently recasting a fixture that design work
//      is being compared against.
//   2. THE CLAMP IS A PARSER, NOT AN ASSERTION. It reads a query string, so its input is whatever
//      someone typed in an address bar. Every one of the cases below is a string a human plausibly
//      produces, and none of them may reach `runFullFight` as a NaN or a zero — an arena with NaN
//      fighters is an empty canvas and a division by zero in `stepsPerSecond`.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_LINEUP,
  MAX_LINEUP,
  MIN_LINEUP,
  buildLineup,
  clampLineup,
  lcg,
} from "./fixtureLineup.ts";
import { unitsToUsd } from "../contract.ts";

/** The nine wallets the hand-written fixture emitted, captured from it before it was generalised. */
const ORIGINAL_NINE = [
  "MwMBwgKpfYVJawFqxv6bv7x3pJmG3gyXK3Hpdkpt9KJ2",
  "3Z2Vz2wge5n5RdDmWgZ1r4FANsT2ymG6u2PiUnSuNH5H",
  "ypaZTUqDSTYidzFAkRZCXwYffuFFx8qH6vd9uKFJgihX",
  "CRh6cL497heyxAFQcDZYzWqAhFBnDMQKBdkXL5MteSqb",
  "mHVftU8VSeNNY1zcosaU3So2CjiWz5Bvf4Ewe4xPow8f",
  "uAx5EqMzasg68u8EpJhgDHyq4QqR1Uh8A3MuRk4XsGj5",
  "ahGRdZM57mNZfD4eatNvThNCKCDNMCfFdkYcj46c8KJx",
  "KSM2bL8PmzASznYRoWimtC3SKmpE6nrYBLuQjSezxXrW",
  "a4zHHKYeZjZiMRLHv1KTkNNVFPNMefVgFggAFzFpUVaL",
];

/** The original's literal stake table, in dollars. */
const ORIGINAL_STAKES = [25, 60, 12, 100, 40, 8, 75, 33, 55];

describe("clampLineup", () => {
  it("defaults when the flag is absent", () => {
    expect(clampLineup(null)).toBe(DEFAULT_LINEUP);
    expect(clampLineup(undefined)).toBe(DEFAULT_LINEUP);
    expect(clampLineup("")).toBe(DEFAULT_LINEUP);
  });

  it("defaults on anything that is not a number, rather than producing NaN", () => {
    for (const junk of ["abc", "sixteen", "1,6", "16px", "--4", "NaN", "Infinity", "-Infinity"]) {
      const n = clampLineup(junk);
      expect(Number.isInteger(n), `clampLineup(${JSON.stringify(junk)}) = ${n}`).toBe(true);
      expect(n).toBe(DEFAULT_LINEUP);
    }
  });

  it("accepts the other numeric spellings `Number` understands, since all of them land in range", () => {
    // Documented rather than defended against. `Number()` reads hex, exponents, signs and surrounding
    // whitespace, and every one of those still passes through the same clamp — so the worst a clever
    // spelling can do is name a legal lineup size. Rejecting them would be extra code buying nothing.
    expect(clampLineup("0x10")).toBe(16);
    expect(clampLineup(" 16 ")).toBe(16);
    expect(clampLineup("+16")).toBe(16);
    expect(clampLineup("1e3")).toBe(MAX_LINEUP); // 1000, clamped
  });

  it("accepts every size the program itself accepts", () => {
    for (let n = MIN_LINEUP; n <= MAX_LINEUP; n++) expect(clampLineup(String(n))).toBe(n);
  });

  it("clamps out-of-range requests to the program's own bounds instead of rejecting them", () => {
    // Above the ceiling reads as "as many as possible" — 16 is that answer, and it is `MAX_FIGHTERS`
    // in lib.rs. Below the floor reads as "as few as possible": 2, the minimum for a fight.
    expect(clampLineup("40")).toBe(MAX_LINEUP);
    expect(clampLineup("999999")).toBe(MAX_LINEUP);
    expect(clampLineup("1")).toBe(MIN_LINEUP);
    expect(clampLineup("0")).toBe(MIN_LINEUP);
    expect(clampLineup("-7")).toBe(MIN_LINEUP);
  });

  it("truncates fractions toward zero rather than rounding into a half fighter", () => {
    expect(clampLineup("9.9")).toBe(9);
    expect(clampLineup("2.5")).toBe(2);
    // Truncation happens BEFORE the clamp, so 1.9 is 1 and then floors to the minimum — not 2 by
    // luck of rounding.
    expect(clampLineup("1.9")).toBe(MIN_LINEUP);
  });

  it("accepts numbers as well as strings, on the same terms", () => {
    expect(clampLineup(16)).toBe(16);
    expect(clampLineup(40)).toBe(MAX_LINEUP);
    expect(clampLineup(Number.NaN)).toBe(DEFAULT_LINEUP);
    expect(clampLineup(Number.POSITIVE_INFINITY)).toBe(DEFAULT_LINEUP);
  });
});

describe("lcg", () => {
  it("is deterministic and stays in [0, 1)", () => {
    const a = lcg(20260809);
    const b = lcg(20260809);
    for (let i = 0; i < 1_000; i++) {
      const v = a();
      expect(v).toBe(b());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("gives different streams for different seeds", () => {
    const a = lcg(1);
    const b = lcg(2);
    expect(Array.from({ length: 8 }, a)).not.toEqual(Array.from({ length: 8 }, b));
  });
});

describe("buildLineup", () => {
  it("the original nine are frozen — the default fixture may not move", () => {
    const nine = buildLineup(9);
    expect(nine.wallets).toEqual(ORIGINAL_NINE);
    expect(nine.you).toBe(ORIGINAL_NINE[0]);
    expect(nine.entries.map((e) => unitsToUsd(e.stake))).toEqual(ORIGINAL_STAKES);
    expect(nine.entries.map((e) => e.side)).toEqual([0, 1, 0, 1, 0, 1, 0, 1, 0]);
  });

  it("the default IS nine, so an absent flag changes nothing", () => {
    expect(buildLineup(DEFAULT_LINEUP)).toEqual(buildLineup(9));
    expect(buildLineup(clampLineup(null))).toEqual(buildLineup(9));
  });

  it("is a prefix — growing the lineup never recasts the fighters already in it", () => {
    // This is what makes two screenshots at different sizes comparable: fighter 3 is the same $100
    // whale at 9 as at 16, so a difference between the two images is the LINEUP SIZE and not a
    // different cast wearing the same numbers.
    const sixteen = buildLineup(16);
    for (let n = MIN_LINEUP; n <= MAX_LINEUP; n++) {
      const some = buildLineup(n);
      expect(some.wallets, `lineup of ${n}`).toEqual(sixteen.wallets.slice(0, n));
      expect(some.entries, `lineup of ${n}`).toEqual(sixteen.entries.slice(0, n));
    }
  });

  it("builds exactly the requested count across the whole legal range", () => {
    for (let n = MIN_LINEUP; n <= MAX_LINEUP; n++) {
      const l = buildLineup(n);
      expect(l.wallets).toHaveLength(n);
      expect(l.entries).toHaveLength(n);
    }
  });

  it("clamps rather than trusting its argument", () => {
    expect(buildLineup(40).entries).toHaveLength(MAX_LINEUP);
    expect(buildLineup(0).entries).toHaveLength(MIN_LINEUP);
    expect(buildLineup(Number.NaN).entries).toHaveLength(DEFAULT_LINEUP);
  });

  it("populates both sides at every size, including the minimum", () => {
    for (let n = MIN_LINEUP; n <= MAX_LINEUP; n++) {
      const sides = buildLineup(n).entries.map((e) => e.side);
      const a = sides.filter((s) => s === 0).length;
      const b = sides.filter((s) => s === 1).length;
      expect(a, `side A at ${n}`).toBeGreaterThan(0);
      expect(b, `side B at ${n}`).toBeGreaterThan(0);
      // Alternating by index, so the split is as even as the count allows. A lopsided fixture would
      // settle the fight on arithmetic rather than on the sim.
      expect(Math.abs(a - b), `imbalance at ${n}`).toBeLessThanOrEqual(1);
      expect(a + b).toBe(n);
    }
  });

  it("puts the local player first and on side A at every size", () => {
    for (let n = MIN_LINEUP; n <= MAX_LINEUP; n++) {
      const l = buildLineup(n);
      expect(l.entries[0].wallet).toBe(l.you);
      expect(l.entries[0].side).toBe(0);
    }
  });

  it("issues 44-character base58 wallets, all distinct", () => {
    const l = buildLineup(MAX_LINEUP);
    for (const w of l.wallets) expect(w).toMatch(/^[1-9A-HJ-NP-Za-km-z]{44}$/);
    expect(new Set(l.wallets).size).toBe(MAX_LINEUP);
  });

  it("keeps every stake inside the fixture's stated $5–$100 band, with real spread", () => {
    // Stake is what `field.ts`'s `radiusFor` sizes a disc from. A flat table would field sixteen
    // identical circles and quietly retire the label-overlap case 16 fighters exists to stress, so
    // spread is a property worth asserting rather than eyeballing.
    const usd = buildLineup(MAX_LINEUP).entries.map((e) => unitsToUsd(e.stake));
    for (const v of usd) {
      expect(v).toBeGreaterThanOrEqual(5);
      expect(v).toBeLessThanOrEqual(100);
    }
    expect(Math.max(...usd) - Math.min(...usd)).toBeGreaterThanOrEqual(50);
    expect(new Set(usd).size).toBe(MAX_LINEUP);
  });

  it("is stable across calls — same count, same everything", () => {
    for (const n of [MIN_LINEUP, DEFAULT_LINEUP, MAX_LINEUP]) {
      expect(buildLineup(n)).toEqual(buildLineup(n));
    }
  });
});
