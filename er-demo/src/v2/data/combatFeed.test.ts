// The combat feed is what the page says out loud about a fight, so the tests are about the three
// ways a narrator lies: reporting an exchange before the playhead reaches it, reporting one twice,
// and reporting one that involves a fighter who is not in the round.
//
// The fourth property under test is not correctness but cost. The stream runs to
// `finalCursor(fighterCount)` and the readouts re-render four times a second, so "does it avoid
// walking the array" is a behaviour worth pinning rather than a comment worth trusting.

import { describe, expect, it } from "vitest";
import type { HitEvent } from "../../sim/hitEvents.ts";
import { nameFor, shortKey, type FighterView, type Side } from "../contract.ts";
import { COMBAT_WINDOW, NO_COMBAT, combatFeed } from "./combatFeed.ts";

const YOU = "Y0urWa11etAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const WALLETS = [YOU, "Opp0nentAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "Th1rdAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"];

function fighterAt(id: number): FighterView {
  const wallet = WALLETS[id];
  return {
    id,
    wallet,
    short: shortKey(wallet),
    name: nameFor(wallet),
    side: (id % 2) as Side,
    stake: 1000n,
    hp: 1000n,
    banked: 0n,
    dead: false,
    isYou: wallet === YOU,
    avatarSrc: null,
  };
}

const FIGHTERS = [fighterAt(0), fighterAt(1), fighterAt(2)];

function hit(step: number, attackerId: number, defenderId: number, amount = 10n): HitEvent {
  return { step: BigInt(step), attackerId, defenderId, amount };
}

/** Three fighters trading, ascending by step exactly as `runFullFight` emits them. */
const STREAM: HitEvent[] = [
  hit(1, 1, 2),
  hit(2, 0, 1),
  hit(3, 2, 0),
  hit(4, 1, 2),
  hit(5, 2, 1),
];

describe("combatFeed", () => {
  it("reports nothing that has not happened yet", () => {
    // The cursor is the program's own `canonical_cursor()`. An event past it is one the canvas has
    // not drawn and the chain would not agree has occurred.
    const feed = combatFeed({ hitEvents: STREAM, fighters: FIGHTERS, stepsNow: 3 });
    expect(feed.recent.map((e) => e.step)).toEqual([1, 2, 3]);
    expect(feed.at).toBe(3);
  });

  it("includes the exchange landing exactly on the cursor", () => {
    // Inclusive at the boundary, matching the canvas: an off-by-one here holds every hit back by a
    // step, which at a two-fighter lineup's 4 steps/second is a quarter of a second of lag between
    // the impact on the field and the sentence about it.
    expect(combatFeed({ hitEvents: STREAM, fighters: FIGHTERS, stepsNow: 1 }).recent).toHaveLength(1);
    expect(combatFeed({ hitEvents: STREAM, fighters: FIGHTERS, stepsNow: 0 }).recent).toHaveLength(0);
  });

  it("floors a fractional cursor rather than rounding it up", () => {
    // `stepsNow` is elapsed seconds times a rate, so it is a real number. Rounding up would report an
    // exchange before it happened, which is the one direction that cannot be allowed.
    expect(combatFeed({ hitEvents: STREAM, fighters: FIGHTERS, stepsNow: 2.9 }).recent).toHaveLength(2);
    expect(combatFeed({ hitEvents: STREAM, fighters: FIGHTERS, stepsNow: -5 }).recent).toHaveLength(0);
  });

  it("resolves both parties to the fighters on screen", () => {
    const [first] = combatFeed({ hitEvents: STREAM, fighters: FIGHTERS, stepsNow: 1 }).recent;
    expect(first.attacker).toBe(FIGHTERS[1]);
    expect(first.defender).toBe(FIGHTERS[2]);
    expect(first.amount).toBe(10n);
  });

  it("is ascending by step, which the toast path depends on", () => {
    // A rail that announces step 5 before step 4 is telling the player the fight happened in an order
    // it did not. A log wanting newest-first reverses forty elements; the reverse is not free to undo.
    const steps = combatFeed({ hitEvents: STREAM, fighters: FIGHTERS, stepsNow: 99 }).recent.map(
      (e) => e.step,
    );
    expect(steps).toEqual([...steps].sort((a, b) => a - b));
  });

  it("flags an exchange in either direction as mine", () => {
    const feed = combatFeed({ hitEvents: STREAM, fighters: FIGHTERS, stepsNow: 99 });
    // Step 2 is you raiding; step 3 is somebody raiding you. Both are yours.
    expect(feed.mine.map((e) => e.step)).toEqual([2, 3]);
    expect(feed.mine.every((e) => e.attacker.isYou || e.defender.isYou)).toBe(true);
  });

  it("keeps `mine` a strict subset of `recent`, by identity", () => {
    // Both are cut from one window in one pass, so a consumer holding a `mine` entry and a consumer
    // holding the same entry out of `recent` are holding the same object — and cannot disagree about
    // what it says.
    const feed = combatFeed({ hitEvents: STREAM, fighters: FIGHTERS, stepsNow: 99 });
    for (const event of feed.mine) expect(feed.recent).toContain(event);
  });

  it("drops an exchange whose fighters cannot be resolved instead of throwing", () => {
    // `attackerId` indexes the array the stream was computed against. There is a poll-sized window on
    // entry to a fight where the roster and the stream disagree, and a narrator that threw there
    // would take the page down over a log line.
    const feed = combatFeed({
      hitEvents: [hit(1, 0, 9), hit(2, 0, 1)],
      fighters: FIGHTERS,
      stepsNow: 99,
    });
    expect(feed.recent.map((e) => e.step)).toEqual([2]);
  });

  it("keeps only the newest window when the fight has run long", () => {
    // The window is bounded so a settled 4,000-step fight does not allocate 4,000 objects on every
    // render of a log that shows twelve rows.
    const long = Array.from({ length: 500 }, (_, i) => hit(i + 1, 0, 1));
    const feed = combatFeed({ hitEvents: long, fighters: FIGHTERS, stepsNow: 500, limit: 10 });
    expect(feed.recent).toHaveLength(10);
    expect(feed.recent[0].step).toBe(491);
    expect(feed.recent[9].step).toBe(500);
  });

  it("sizes its default window to hold a full throttle interval of the fastest lineup", () => {
    // 16 fighters run at `stepsPerSecond(16) = 32` exchanges a second; the toast rail coalesces over
    // 3 seconds. A window shorter than that is a hit that happened and was never said.
    expect(COMBAT_WINDOW).toBeGreaterThanOrEqual(32 * 3);
  });

  it("finds the cursor without walking the stream", () => {
    // The binary search, pinned as behaviour rather than as a comment: a 4,000-event fight must cost
    // ~12 comparisons and not 4,000. The `step` getter counts every read the search performs.
    let reads = 0;
    const counted = Array.from({ length: 4096 }, (_, i) => {
      const step = BigInt(i + 1);
      return {
        get step() {
          reads += 1;
          return step;
        },
        attackerId: 0,
        defenderId: 1,
        amount: 1n,
      } as HitEvent;
    });
    const feed = combatFeed({ hitEvents: counted, fighters: FIGHTERS, stepsNow: 2048, limit: 4 });
    expect(feed.recent.map((e) => e.step)).toEqual([2045, 2046, 2047, 2048]);
    // 12 for the search over 4,096, plus one per event actually resolved.
    expect(reads).toBeLessThan(32);
  });

  it("has an empty answer that is one shared object", () => {
    // So a consumer memoising on `combat` is not re-run once a second by a lobby that is not fighting.
    expect(NO_COMBAT.recent).toHaveLength(0);
    expect(NO_COMBAT.mine).toHaveLength(0);
    expect(combatFeed({ hitEvents: [], fighters: FIGHTERS, stepsNow: 0 }).recent).toHaveLength(0);
  });
});
