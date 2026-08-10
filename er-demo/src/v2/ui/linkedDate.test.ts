// `linkedDateText` — the whole surface, because it is four lines and every one of them is a rule.
//
// EVERY CASE IS BUILT WITH LOCAL-TIME `Date` CONSTRUCTORS, never with a UTC epoch literal. The
// function reads `getDate()`/`getMonth()`/`getFullYear()`, which are local, so a test that pinned a
// UTC millisecond count would pass in London and fail in Auckland — for a function that is behaving
// correctly in both. Constructing the instant in local time asks the question the function answers.

import { describe, expect, it } from "vitest";
import { linkedDateText } from "./linkedDate.ts";

/** Local-time instant -> unix SECONDS, which is the unit `LinkRecord.linkedAt` carries. */
function sec(year: number, monthIndex: number, day: number, hour = 12): number {
  return Math.floor(new Date(year, monthIndex, day, hour).getTime() / 1000);
}

describe("linkedDateText", () => {
  it("prints day and short month, with no year, inside the current year", () => {
    const now = new Date(2026, 7, 20).getTime();
    expect(linkedDateText(sec(2026, 7, 8), now)).toBe("8 Aug");
  });

  it("adds the year once the date is not in the current one", () => {
    const now = new Date(2026, 7, 20).getTime();
    expect(linkedDateText(sec(2025, 7, 8), now)).toBe("8 Aug 2025");
    // Forward as well as back: a clock-skewed record dated next year must not read as this year's.
    expect(linkedDateText(sec(2027, 0, 1), now)).toBe("1 Jan 2027");
  });

  it("does not pad the day, and names every month", () => {
    const now = new Date(2026, 0, 1).getTime();
    expect(linkedDateText(sec(2026, 0, 1), now)).toBe("1 Jan");
    expect(linkedDateText(sec(2026, 11, 31), now)).toBe("31 Dec");
  });

  it("crosses the year boundary on the READER's year, not on a fixed offset", () => {
    // 31 Dec and 1 Jan are one day apart and land either side of the rule.
    const newYearsDay = new Date(2026, 0, 1).getTime();
    expect(linkedDateText(sec(2025, 11, 31), newYearsDay)).toBe("31 Dec 2025");
    expect(linkedDateText(sec(2026, 0, 1), newYearsDay)).toBe("1 Jan");
  });

  it("returns null rather than inventing a date, for every unusable timestamp", () => {
    const now = new Date(2026, 7, 20).getTime();
    // A zero is the shape a missing field arrives in, and "1 Jan 1970" would be this page asserting
    // it as a fact.
    expect(linkedDateText(0, now)).toBeNull();
    expect(linkedDateText(-1, now)).toBeNull();
    expect(linkedDateText(Number.NaN, now)).toBeNull();
    expect(linkedDateText(Number.POSITIVE_INFINITY, now)).toBeNull();
    // Past the range `Date` can represent: `getMonth()` is NaN there, which would otherwise index the
    // month table to `undefined` and print the word.
    expect(linkedDateText(9e15, now)).toBeNull();
  });

  it("treats seconds as seconds", () => {
    // The unit bug this file exists to catch: the same number read as milliseconds is 1970.
    const now = new Date(2026, 7, 20).getTime();
    const secs = sec(2026, 7, 8);
    expect(linkedDateText(secs, now)).toBe("8 Aug");
    expect(linkedDateText(secs * 1000, now)).not.toBe("8 Aug");
  });
});
