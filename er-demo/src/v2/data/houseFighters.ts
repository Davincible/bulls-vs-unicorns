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

/**
 * THE DISCLOSURE, IN FULL, OVER THE TABLE THAT NAMES EVERY FIGHTER — 00-4's lede.
 *
 * A six-fighter lobby reads as six people, and until `HouseDisclosure` existed nothing on the page
 * said otherwise — `README.md`'s go-live list still carries "Bot disclosure in UI" open. The per-row
 * `HouseTag` says WHICH; this says what that means, because a reader meeting the word "House" in a
 * roster for the first time is owed more than a label.
 *
 * IT LIVES HERE RATHER THAN IN THE VIEW because it is the sentence form of `houseDisclosureOf` above
 * and is subject to exactly the rules that function exists to enforce — so it belongs where those
 * rules are written down and where they are tested. It was in `views/ArenaView.tsx`, where it could
 * not be, and it shipped `All 1 of these fighters are other players` from there.
 *
 * THE KEEPER'S OWN SENTENCE IS QUOTED RATHER THAN PARAPHRASED. `note` is written by the party making
 * the claim; restating it in this page's words would put a disclosure in the mouth of the surface
 * that benefits from it, and would drift from the keeper's the first time either changed. The one
 * clause this function adds is the count, which the keeper cannot know about the round on screen.
 *
 * ALL THREE STATES ARE DIFFERENT SENTENCES. Counted and non-zero, counted and zero, and not counted
 * at all — the third being the one that must never render as the second (see `HouseShare`).
 *
 * `undefined`, not `""`, when there is nothing to say: it is passed straight to `Section`'s optional
 * `lede`, and an empty string there renders an empty paragraph with its margins.
 */
export function houseNote(d: HouseDisclosure, total: number): string | undefined {
  const count = d.houseFighterCount;
  if (count === null) {
    return "Nothing is publishing a house list right now, so this page cannot tell you which of these fighters are ours. An unmarked fighter below is one we could not check, not one we have cleared.";
  }
  // A LOBBY OF ONE IS THE COMMON CASE HERE, NOT THE EDGE CASE — the keeper holds a lobby open with a
  // single house fighter in it until a real player arrives, which is most of an idle arena's life. So
  // both branches below get their own sentence rather than a plural one with the count swapped in:
  // "All 1 of these fighters are other players" is what shipped, and it reads as a template.
  if (count === 0) {
    return total === 1
      ? "The one fighter here is another player, not ours."
      : `All ${total} of these fighters are other players — none of them is ours.`;
  }
  // `count >= 1` here and `count <= total` always, so `total === 1` settles both numbers at once.
  const head =
    total === 1
      ? "The one fighter here is ours, marked HOUSE below."
      : `${count} of these ${total} fighters ${count === 1 ? "is" : "are"} ours, marked HOUSE below.`;
  return d.note === null ? head : `${head} ${d.note}`;
}
