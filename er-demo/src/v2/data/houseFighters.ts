// WHICH FIGHTERS ARE THE HOUSE'S — the rule, applied in one place, for every surface that lists a
// roster.
//
// THE OBLIGATION. The keeper seats house wallets so a lobby is never empty; `keeperStatus.ts`
// publishes the list and `isHouseWallet()` answers the question, and until now nothing called it. So
// a six-fighter lobby read as six people. README's go-live list carries "Bot disclosure in UI" as an
// open item and `isHouseWallet`'s own comment calls an undisclosed house fighter "a
// misrepresentation of who is in the round". This module is where that stops being true.
//
// TWO FUNCTIONS, ONE PASS EACH, AND THEY ARE MEANT TO BE CALLED TOGETHER. The marks and the count
// are the same fact at two resolutions — a roster showing five marked fighters beside a caption
// reading "3 house" is worse than either alone, because a reader cannot tell which one is broken.
// They are separate functions rather than one returning both because the fixture already carries its
// marks (they are baked into `mockData.ts`'s lineup, which is what the canvas and the rosters read)
// and only needs the count; keeping them apart is what lets both paths run the same counter.
//
// Pure and React-free, so every rule below is a unit test rather than a browser session.

import type { FighterView, HouseDisclosure, LiveRound } from "../contract.ts";
import { isHouseWallet, type HouseRoster } from "./keeperStatus.ts";

/**
 * Stamp `house` onto every fighter in a round, from the keeper's published list.
 *
 * `roster` is null whenever nothing may be marked — no keeper, or one whose heartbeat has expired.
 * `houseRosterOf` in `keeperFeed.ts` owns that judgement and its reasoning; here it simply means
 * every fighter comes back `house: false`, which is `FighterView.house`'s documented default and the
 * only honest answer a page with no disclosure list can give.
 *
 * IT RETURNS THE INPUT ARRAY WHEN NOTHING CHANGED, and that is not a micro-optimisation — it is what
 * keeps this out of the memo graph. `LiveRound` is rebuilt on every poll and every 250ms clock tick,
 * and the canvas, the extract terms and the combat feed are all memoised against `live.fighters`;
 * handing them a fresh array with identical contents four times a second would invalidate all three
 * for nothing. The common case on this page — no keeper running, or a lobby with no house in it —
 * allocates nothing at all.
 */
export function markHouseFighters(
  fighters: FighterView[],
  roster: HouseRoster | null,
): FighterView[] {
  let changed = false;
  const marked = fighters.map((f) => {
    const house = isHouseWallet(roster, f.wallet);
    if (house === f.house) return f;
    changed = true;
    return { ...f, house };
  });
  return changed ? marked : fighters;
}

/**
 * The same, for a whole round — and the form the provider actually calls.
 *
 * IDENTITY IS PRESERVED WHEN NOTHING CHANGED, all the way up to the `LiveRound` itself, for the
 * reason spelled out on `markHouseFighters`: this runs on every poll and every 250ms clock tick, and
 * a fresh round object with identical contents would invalidate every memo keyed on `live` four
 * times a second. Null passes straight through — there is nothing to mark on a page with no round.
 */
export function withHouseMarks(live: LiveRound | null, roster: HouseRoster | null): LiveRound | null {
  if (live === null) return null;
  const fighters = markHouseFighters(live.fighters, roster);
  return fighters === live.fighters ? live : { ...live, fighters };
}

/**
 * Count the marks, and say whether anything backs them.
 *
 * A NULL ROSTER MAKES BOTH COUNTS NULL, and that is the entire reason this returns a shape rather
 * than two numbers: `house: false` on every fighter means either "nobody in this round is ours" or
 * "nothing published a list to check against", and a caption reading "0 house" claims the first while
 * the page may well be in the second. Null forces a view to render `—`, which is UI-SPEC's rule for
 * an unbacked figure and the truthful sentence here. The fixture passes a roster of its own making
 * (see `mockData.ts`) and therefore counts, which is what keeps the disclosure reviewable with no
 * keeper anywhere near it.
 *
 * The counts come from the FIGHTERS, never from `KeeperRoundStatus.houseFighterCount` — which the
 * keeper does publish, and which is the wrong number to render. That one describes the round the
 * keeper was looking at when it last wrote its file, which is not necessarily the round on screen
 * (the page can be pinned to an older round with `?round=`, or reading one the keeper has already
 * moved past), and it is not derived from the same list the marks came from. Two independently
 * sourced numbers about one roster is two chances to disagree in front of a reader; this is the one
 * that cannot, because it is counted off the marks themselves.
 */
export function houseDisclosureOf(
  fighters: readonly FighterView[],
  roster: HouseRoster | null,
): HouseDisclosure {
  if (roster === null) return { houseFighterCount: null, realFighterCount: null, note: null };
  let house = 0;
  for (const f of fighters) if (f.house) house += 1;
  return {
    houseFighterCount: house,
    realFighterCount: fighters.length - house,
    // The keeper's own sentence, quoted rather than paraphrased: the party making the claim is the
    // party whose words the page should be putting in front of a player.
    note: roster.house.disclosure,
  };
}
