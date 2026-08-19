// The arithmetic under eight tables, and the one property none of them can assert for themselves:
// that a table which is not capping anything hands back the array it was given.

import { describe, expect, it } from "vitest";
import {
  ROW_CAP,
  ROW_CAP_BOARD,
  ROW_CAP_NESTED,
  ROW_CAP_PROOF,
  ROW_CAP_RECENT,
  capRows,
  rowCapLabel,
} from "./rowCap.ts";

/** A list of `n` distinct rows, so a slice can be checked by value and not only by length. */
const rows = (n: number): readonly number[] => Array.from({ length: n }, (_, i) => i);

describe("capRows", () => {
  it("shows the top N of the order it was given, and says how many it kept back", () => {
    const c = capRows(rows(24), 5, false);
    expect(c.rows).toEqual([0, 1, 2, 3, 4]);
    expect(c.hidden).toBe(19);
  });

  it("caps nothing when the list is exactly the cap", () => {
    const c = capRows(rows(5), 5, false);
    expect(c.rows).toHaveLength(5);
    expect(c.hidden).toBe(0);
  });

  it("caps nothing when the list is shorter than the cap", () => {
    const c = capRows(rows(2), 5, false);
    expect(c.rows).toEqual([0, 1]);
    expect(c.hidden).toBe(0);
  });

  it("holds an empty table at empty rather than inventing a control for it", () => {
    // The rule this pins: `Empty` still renders for a genuinely empty table, and a cap must never
    // turn "no fighters yet" into a bare "show 0 more".
    const c = capRows(rows(0), 5, false);
    expect(c.rows).toEqual([]);
    expect(c.hidden).toBe(0);
  });

  it("shows everything once expanded", () => {
    const c = capRows(rows(24), 5, true);
    expect(c.rows).toHaveLength(24);
  });

  it("keeps reporting what the cap holds back while expanded, so the control survives its own press", () => {
    // The defect this exists for: a `hidden` that fell to 0 on expand would unmount the button that
    // had just taken the press, and focus would drop to the top of the document.
    expect(capRows(rows(24), 5, true).hidden).toBe(19);
    expect(capRows(rows(24), 5, false).hidden).toBe(19);
  });

  it("never reports a negative count, whatever cap it is handed", () => {
    expect(capRows(rows(3), 100, false).hidden).toBe(0);
    expect(capRows(rows(0), 10, true).hidden).toBe(0);
  });

  it("caps to nothing when asked to, without going negative", () => {
    const c = capRows(rows(4), 0, false);
    expect(c.rows).toEqual([]);
    expect(c.hidden).toBe(4);
  });

  it("returns the SAME ARRAY when it drops nothing", () => {
    // THE ONE THAT IS NOT A FORMALITY. `live.fighters` is rebuilt four times a second and several of
    // these tables feed memos keyed on the array they are handed; a fresh copy per render from a
    // table that is capping nothing would invalidate those memos for no benefit at all.
    const source = rows(5);
    expect(capRows(source, 5, false).rows).toBe(source);
    expect(capRows(source, 10, false).rows).toBe(source);
    expect(capRows(source, 2, true).rows).toBe(source);
  });

  it("copies only when it genuinely caps, leaving the caller's array alone", () => {
    const source = rows(9);
    const c = capRows(source, 4, false);
    expect(c.rows).not.toBe(source);
    expect(source).toHaveLength(9);
  });
});

describe("rowCapLabel", () => {
  it("names what pressing reveals and how much of it", () => {
    expect(rowCapLabel(19, false, "fighter")).toBe("Show the rest — 19 fighters");
  });

  it("says it will collapse again, in the same words over the same count", () => {
    // Same element, same position, one verb changed — the two states have to read as one control.
    expect(rowCapLabel(19, true, "fighter")).toBe("Hide the rest — 19 fighters");
  });

  it("agrees with its noun at one", () => {
    expect(rowCapLabel(1, false, "round")).toBe("Show the rest — 1 round");
    expect(rowCapLabel(1, true, "round")).toBe("Hide the rest — 1 round");
  });

  it("carries the state in words, so nothing on it is said in colour alone", () => {
    expect(rowCapLabel(4, false, "player")).toContain("Show");
    expect(rowCapLabel(4, true, "player")).toContain("Hide");
  });
});

describe("the caps themselves", () => {
  it("orders every cap by how much the reader asked to be there", () => {
    // 00-6 hands everything past three rows to a whole screen; 00's other tables show a glance; a
    // board someone navigated to shows twice that. The relation is the argument — if a future edit
    // makes the arena screen show more than the leaderboard, this is the line that should stop it.
    expect(ROW_CAP_RECENT).toBeLessThan(ROW_CAP);
    expect(ROW_CAP).toBeLessThan(ROW_CAP_BOARD);
    expect(ROW_CAP_NESTED).toBeLessThanOrEqual(ROW_CAP_BOARD);
  });

  it("keeps every cap a positive whole number of rows", () => {
    for (const cap of [ROW_CAP, ROW_CAP_BOARD, ROW_CAP_NESTED, ROW_CAP_PROOF, ROW_CAP_RECENT]) {
      expect(Number.isInteger(cap)).toBe(true);
      expect(cap).toBeGreaterThan(0);
    }
  });
});
