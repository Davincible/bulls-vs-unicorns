// BOT DISCLOSURE, tested as an obligation rather than as a feature.
//
// Two failures matter here and they are not symmetric. A FALSE NEGATIVE — a house fighter rendered
// as a person — is the misrepresentation README's "Bot disclosure in UI" exists to remove, and it is
// what the page did in every round until this module existed. A FALSE POSITIVE — a real player marked
// as one of ours — is an accusation the page has no standing to make. The tests below pin both
// directions, and pin the third state (nothing published a list at all) as its own answer rather than
// as a quiet version of "nobody is house".

import { describe, expect, it } from "vitest";
import { nameFor, shortKey, type FighterView, type LiveRound, type Side } from "../contract.ts";
import { houseDisclosureOf, houseNote, markHouseFighters, withHouseMarks } from "./houseFighters.ts";
import type { HouseRoster } from "./keeperStatus.ts";

const HOUSE_A = "H0useWa11etAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const HOUSE_B = "H0useWa11etBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const PLAYER = "P1ayerWa11etAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const YOU = "Y0urWa11etAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const DISCLOSURE = "The house seats wallets so a lobby is never empty.";

const ROSTER: HouseRoster = { house: { wallets: [HOUSE_A, HOUSE_B], disclosure: DISCLOSURE } };

function fighterAt(id: number, wallet: string, over: Partial<FighterView> = {}): FighterView {
  return {
    id,
    wallet,
    short: shortKey(wallet),
    name: nameFor(wallet),
    side: (id % 2) as Side,
    stake: 100n,
    hp: 100n,
    banked: 0n,
    house: false,
    dead: false,
    isYou: wallet === YOU,
    avatarSrc: null,
    ...over,
  };
}

const LINEUP: FighterView[] = [
  fighterAt(0, YOU),
  fighterAt(1, HOUSE_A),
  fighterAt(2, PLAYER),
  fighterAt(3, HOUSE_B),
];

describe("markHouseFighters", () => {
  it("marks the keeper's wallets and nobody else's", () => {
    const marked = markHouseFighters(LINEUP, ROSTER);
    expect(marked.map((f) => f.house)).toEqual([false, true, false, true]);
  });

  it("marks nobody at all when no keeper is publishing", () => {
    // The load-bearing rule: a page with no disclosure list has no basis to call anyone a bot, and
    // must not fall back to a guess (fighter count, stake shape, entry order — all of which look
    // like signals and are not).
    expect(markHouseFighters(LINEUP, null).every((f) => !f.house)).toBe(true);
  });

  it("returns the very same array when nothing changed", () => {
    // Not a micro-optimisation — this runs on every poll and every 250ms clock tick, and the canvas,
    // the extract terms and the combat feed are all memoised against `live.fighters`. A fresh array
    // of identical fighters would invalidate all three, four times a second, for no change.
    expect(markHouseFighters(LINEUP, null)).toBe(LINEUP);
    const marked = markHouseFighters(LINEUP, ROSTER);
    expect(markHouseFighters(marked, ROSTER)).toBe(marked);
  });

  it("clears a mark the keeper has withdrawn", () => {
    // A wallet dropped from the published list stops being ours. The alternative — marks that only
    // ever accumulate — would leave an accusation on screen that nothing on the page still backs.
    const marked = markHouseFighters(LINEUP, ROSTER);
    const narrower: HouseRoster = { house: { wallets: [HOUSE_A], disclosure: DISCLOSURE } };
    expect(markHouseFighters(marked, narrower).map((f) => f.house)).toEqual([
      false,
      true,
      false,
      false,
    ]);
  });

  it("leaves everything except `house` untouched", () => {
    const marked = markHouseFighters(LINEUP, ROSTER);
    // Positional ids especially: the hit stream names its parties by index into this array, so a
    // reorder here would silently repoint every hit in the fight.
    expect(marked.map((f) => f.id)).toEqual([0, 1, 2, 3]);
    expect(marked.map((f) => f.wallet)).toEqual(LINEUP.map((f) => f.wallet));
    expect(marked[1]).toEqual({ ...LINEUP[1], house: true });
  });
});

describe("withHouseMarks", () => {
  const live = { fighters: LINEUP, roundNo: 7n } as unknown as LiveRound;

  it("hands back the same round object when no mark changed", () => {
    expect(withHouseMarks(live, null)).toBe(live);
  });

  it("rebuilds only when a mark actually lands", () => {
    const marked = withHouseMarks(live, ROSTER);
    expect(marked).not.toBe(live);
    expect(marked?.fighters.map((f) => f.house)).toEqual([false, true, false, true]);
    expect(marked?.roundNo).toBe(7n);
  });

  it("passes a missing round straight through", () => {
    expect(withHouseMarks(null, ROSTER)).toBeNull();
  });
});

describe("houseDisclosureOf", () => {
  it("counts the marks, not the roster", () => {
    // The keeper's list can name wallets that are not in THIS round — it publishes a standing list,
    // and the page may be pinned to an older round with `?round=`. The count has to describe the
    // fighters on screen or the caption disagrees with the roster beside it.
    const marked = markHouseFighters(LINEUP, ROSTER);
    expect(houseDisclosureOf(marked, ROSTER)).toEqual({
      houseFighterCount: 2,
      realFighterCount: 2,
      note: DISCLOSURE,
    });
  });

  it("answers null — never zero — when nothing is publishing a list", () => {
    // THE RULE THIS TYPE EXISTS FOR. `house: false` everywhere means either "nobody here is ours" or
    // "nothing told us who is", and "0 house" claims the first while the page is in the second.
    expect(houseDisclosureOf(LINEUP, null)).toEqual({
      houseFighterCount: null,
      realFighterCount: null,
      note: null,
    });
  });

  it("reports an honest zero when a keeper IS publishing and none of its wallets are in", () => {
    // The other side of the same rule: with a list in hand, "none of them are ours" is a real,
    // checkable answer and must render as a figure rather than as a dash.
    const empty: HouseRoster = { house: { wallets: [], disclosure: DISCLOSURE } };
    expect(houseDisclosureOf(markHouseFighters(LINEUP, empty), empty)).toEqual({
      houseFighterCount: 0,
      realFighterCount: 4,
      note: DISCLOSURE,
    });
  });

  it("counts an empty round without inventing a fighter", () => {
    expect(houseDisclosureOf([], ROSTER)).toEqual({
      houseFighterCount: 0,
      realFighterCount: 0,
      note: DISCLOSURE,
    });
  });

  it("quotes the keeper's own sentence rather than one of ours", () => {
    expect(houseDisclosureOf(LINEUP, ROSTER).note).toBe(DISCLOSURE);
  });
});

// THE DISCLOSURE AS A SENTENCE — the same obligation one layer up, in the words a reader gets.
//
// It shipped from a view module as `All 1 of these fighters are other players`, which is the state a
// held-open lobby spends most of its life in: one house fighter, waiting for a person. A disclosure
// that reads as an unfilled template is a disclosure a reader discounts, so the grammar here is part
// of the obligation and not a polish item.

describe("houseNote", () => {
  const counted = (house: number | null) => ({
    houseFighterCount: house,
    realFighterCount: house === null ? null : 0,
    note: house === null ? null : DISCLOSURE,
  });

  it("says nothing was checked when nothing published a list, and never says nobody is ours", () => {
    const note = houseNote(counted(null), 4) ?? "";
    expect(note).toMatch(/cannot tell you/i);
    // The failure this whole module exists to prevent, at the sentence layer: an unbacked "0 house".
    expect(note).not.toMatch(/none of them is ours/i);
  });

  it("reads as English with a single fighter in the room, in both counted states", () => {
    // The state the live arena is in whenever the keeper is holding a lobby open.
    expect(houseNote(counted(1), 1)).toMatch(/^The one fighter here is ours, marked HOUSE below\./);
    expect(houseNote(counted(0), 1)).toBe("The one fighter here is another player, not ours.");
    for (const n of [houseNote(counted(1), 1), houseNote(counted(0), 1)]) {
      expect(n).not.toMatch(/\b1 of these 1 fighters\b|\bAll 1 of these fighters\b/);
    }
  });

  it("agrees its verb as well as its noun on a full lobby", () => {
    expect(houseNote(counted(1), 8)).toMatch(/^1 of these 8 fighters is ours/);
    expect(houseNote(counted(3), 8)).toMatch(/^3 of these 8 fighters are ours/);
    expect(houseNote(counted(0), 8)).toBe(
      "All 8 of these fighters are other players — none of them is ours.",
    );
  });

  it("appends the keeper's own sentence rather than paraphrasing it, and survives its absence", () => {
    expect(houseNote({ houseFighterCount: 2, realFighterCount: 6, note: DISCLOSURE }, 8)).toContain(
      DISCLOSURE,
    );
    // A roster with no disclosure string is still a roster: the count stands on its own.
    expect(houseNote({ houseFighterCount: 2, realFighterCount: 6, note: null }, 8)).toBe(
      "2 of these 8 fighters are ours, marked HOUSE below.",
    );
  });
});
