// The house's policy, argued against the only two things it can be wrong about: whether a round can
// happen at all, and whether the room still belongs to the house once real people are in it.
//
// The ladder is spelled out here as literal numbers rather than recomputed from the constants, on
// purpose. Restating the formula in the test would make it agree with itself no matter what the
// constants were changed to; writing "1 real player, 2 house fighters" means that anybody who moves
// `DISPLACEMENT` has to come here and say out loud what the new arena looks like. That is the whole
// value of this file — the constants are judgement calls, and these are the consequences a person has
// to re-endorse before the judgement changes.

import { describe, expect, it } from "vitest";
import { MIN_STAKE_USD, STAKE_CAP_USD, STAKE_PRESETS, UNITS_PER_USD, unitsToUsd } from "../../src/v2/contract.ts";
import {
  HOUSE_MAX,
  HOUSE_STAKE_MAX_USD,
  HOUSE_STAKE_MIN_USD,
  allocateHouseSides,
  houseFighterCount,
  houseStake,
  type SideCounts,
} from "./houseSizing.ts";

/** Every real-lobby shape worth asking about, both sides swept past the point the house has left. */
function everyLobby(): SideCounts[] {
  const lobbies: SideCounts[] = [];
  for (let side0 = 0; side0 <= 8; side0++) {
    for (let side1 = 0; side1 <= 8; side1++) lobbies.push({ side0, side1 });
  }
  return lobbies;
}

describe("houseFighterCount", () => {
  it("walks down the throttle ladder as real players arrive: 4, 2, 0, 0", () => {
    // Sides kept balanced so this test sees the COUNT rule alone — the cover rule gets its own test
    // below, and a lopsided fixture here would quietly be testing both at once.
    expect(houseFighterCount({ side0: 0, side1: 0 })).toBe(4);
    expect(houseFighterCount({ side0: 1, side1: 0 })).toBe(2);
    expect(houseFighterCount({ side0: 1, side1: 1 })).toBe(0);
    expect(houseFighterCount({ side0: 2, side1: 1 })).toBe(0);
  });

  it("leaves entirely the moment two real players can fight each other", () => {
    // The point of the whole policy: the house is not a participant, it is scaffolding.
    for (let side0 = 1; side0 <= 8; side0++) {
      for (let side1 = 1; side1 <= 8; side1++) {
        expect(houseFighterCount({ side0, side1 }), `${side0}v${side1}`).toBe(0);
      }
    }
  });

  it("never lets a lobby fall under the two fighters `close_lobby_and_draw` demands", () => {
    // `enough_to_fight` is a `require!`, not a preference. A lobby the house throttled to a single
    // fighter has one instruction left that will succeed on it, and it is `abandon_round`.
    for (const real of everyLobby()) {
      const total = real.side0 + real.side1 + houseFighterCount(real);
      expect(total, `${real.side0}v${real.side1}`).toBeGreaterThanOrEqual(2);
    }
  });

  it("still covers an empty side when the count rule has thrown the house out", () => {
    // Three real players stacked on one side is a queue, not a fight, and no number of further real
    // entrants fixes it — they are free to stack too. This is the one case where the house adds a
    // fighter to a room that does not need more fighters, and the alternative is a round that cannot
    // be drawn at all.
    expect(houseFighterCount({ side0: 3, side1: 0 })).toBe(1);
    expect(allocateHouseSides(1, { side0: 3, side1: 0 })).toEqual([1]);
    expect(houseFighterCount({ side0: 0, side1: 6 })).toBe(1);
    expect(allocateHouseSides(1, { side0: 0, side1: 6 })).toEqual([0]);
  });

  it("never fields more fighters than the keeper has wallets", () => {
    for (const real of everyLobby()) {
      const n = houseFighterCount(real);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThanOrEqual(HOUSE_MAX);
      expect(Number.isInteger(n)).toBe(true);
    }
  });
});

describe("allocateHouseSides", () => {
  it("leaves both sides of the lobby occupied, in every lobby the policy fields into", () => {
    // The guarantee that makes `cover` worth having: it is not enough to field the right NUMBER of
    // house fighters if they all pick the same side as each other.
    for (const real of everyLobby()) {
      const sides = allocateHouseSides(houseFighterCount(real), real);
      const side0 = real.side0 + sides.filter((s) => s === 0).length;
      const side1 = real.side1 + sides.filter((s) => s === 1).length;
      expect(side0, `${real.side0}v${real.side1}`).toBeGreaterThan(0);
      expect(side1, `${real.side0}v${real.side1}`).toBeGreaterThan(0);
    }
  });

  it("hands back exactly the number of assignments it was asked for", () => {
    for (let count = 0; count <= HOUSE_MAX; count++) {
      const sides = allocateHouseSides(count, { side0: 0, side1: 0 });
      expect(sides).toHaveLength(count);
      expect(sides.every((s) => s === 0 || s === 1)).toBe(true);
    }
  });

  it("splits an empty room evenly, starting on side 0", () => {
    // Reproducibility, not fairness: the two sides are symmetric, but a lineup that alternates the
    // same way every time is one that can be re-derived from the round number later.
    expect(allocateHouseSides(4, { side0: 0, side1: 0 })).toEqual([0, 1, 0, 1]);
  });

  it("joins the thinner side of a lopsided lobby first", () => {
    expect(allocateHouseSides(2, { side0: 3, side1: 0 })).toEqual([1, 1]);
  });
});

describe("houseStake", () => {
  it("is the same stake every time it is asked, which is what makes a round debuggable later", () => {
    // A round's lineup has to be re-derivable from its number alone, months later, after its accounts
    // have been closed. `Math.random()` would make every question about a strange-looking pot
    // unanswerable the moment the keeper process exited.
    for (const [roundNo, walletIndex] of [[1, 0], [7, 3], [214, 5], [99_999, 1]]) {
      const first = houseStake(roundNo, walletIndex);
      expect(houseStake(roundNo, walletIndex)).toBe(first);
      expect(houseStake(roundNo, walletIndex)).toBe(first);
    }
  });

  it("gives the round's bots visibly different stakes, so the roster reads as a market", () => {
    // N identical stakes is the tell that gives a bot lineup away at a glance. Observed minimum over
    // rounds 1..500 is four distinct values among six wallets; two is the claim worth enforcing.
    for (let roundNo = 1; roundNo <= 500; roundNo++) {
      const stakes = new Set(Array.from({ length: HOUSE_MAX }, (_, i) => houseStake(roundNo, i)));
      expect(stakes.size, `round ${roundNo}`).toBeGreaterThanOrEqual(2);
    }
  });

  it("moves the same wallet's stake from round to round", () => {
    // Otherwise wallet #0 would be "the $8 bot" forever, which is the same tell one wallet at a time.
    const stakes = new Set(Array.from({ length: 200 }, (_, i) => houseStake(i + 1, 0)));
    expect(stakes.size).toBeGreaterThan(20);
  });

  it("always lands on a whole dollar inside the published band", () => {
    for (let roundNo = 1; roundNo <= 500; roundNo++) {
      for (let i = 0; i < HOUSE_MAX; i++) {
        const stake = houseStake(roundNo, i);
        expect(stake % UNITS_PER_USD, `round ${roundNo} wallet ${i}`).toBe(0n);
        const usd = unitsToUsd(stake);
        expect(usd, `round ${roundNo} wallet ${i}`).toBeGreaterThanOrEqual(HOUSE_STAKE_MIN_USD);
        expect(usd, `round ${roundNo} wallet ${i}`).toBeLessThanOrEqual(HOUSE_STAKE_MAX_USD);
      }
    }
  });

  it("stays inside the range a real player is actually offered", () => {
    // The band is a claim ABOUT `STAKE_PRESETS`: house fighters must neither be dwarfed by a player
    // at the smallest preset nor dwarf one. Re-pegging the preset ladder without revisiting the
    // house policy breaks that claim silently, and this is where it stops being silent.
    expect(HOUSE_STAKE_MIN_USD).toBe(Math.min(...STAKE_PRESETS));
    expect(HOUSE_STAKE_MAX_USD).toBeLessThan(Math.max(...STAKE_PRESETS));
    expect(STAKE_PRESETS).toContain(HOUSE_STAKE_MAX_USD);
    expect(HOUSE_STAKE_MIN_USD).toBeGreaterThanOrEqual(MIN_STAKE_USD);
    expect(HOUSE_STAKE_MAX_USD).toBeLessThanOrEqual(STAKE_CAP_USD);
  });
});
