// The house's policy, argued against the only two things it can be wrong about: whether a round can
// happen at all, and whether the room still belongs to the house once real people are in it.
//
// The ladder is spelled out here as literal numbers rather than recomputed from the constants, on
// purpose. Restating the formula in the test would make it agree with itself no matter what the
// constants were changed to; writing "1 real player, 9 house fighters" means that anybody who moves
// `KEEPER_HOUSE_DISPLACEMENT` has to come here and say out loud what the new arena looks like. That
// is the whole value of this file — the constants are judgement calls, and these are the consequences
// a person has to re-endorse before the judgement changes.
//
// SO THESE LITERALS DESCRIBE THE DEFAULTS, and a run with `KEEPER_HOUSE_*` set in the environment
// will fail them. That is correct rather than brittle: the defaults are the shipped product, and a CI
// run that quietly agreed with whatever was exported in the shell would be checking nothing. The one
// place a configured value is asserted instead is the exposure ceiling, which has to keep meaning
// something on a machine that has retuned the band.

import { describe, expect, it } from "vitest";
import { MIN_STAKE_USD, STAKE_CAP_USD, STAKE_PRESETS, UNITS_PER_USD, unitsToUsd } from "../../src/v2/contract.ts";
import {
  HOUSE_BOARD_TARGET,
  HOUSE_DISPLACEMENT,
  HOUSE_STAKE_MAX_USD,
  HOUSE_STAKE_MIN_USD,
  HOUSE_WALLET_COUNT,
  MIN_FIGHTERS_TO_FIGHT,
} from "./config.ts";
import {
  HOUSE_MAX_WITHOUT_REAL_PLAYER,
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

/** Every lobby above EXCEPT the empty one, which the treasury rule answers before any of the board
 *  policy is consulted and which therefore breaks properties that are true of every other shape. */
const everyLobbyWithSomebodyIn = () => everyLobby().filter((r) => r.side0 + r.side1 > 0);

describe("the treasury rule", () => {
  // The operator's standing instruction, in the words they gave it: "we don't do runs on only house
  // players, to protect the treasury." Everything in this block is that sentence, checked. It is
  // first in the file because it OVERRIDES the board policy below rather than interacting with it.

  it("puts one house fighter into a room with nobody real in it, and never a second", () => {
    expect(houseFighterCount({ side0: 0, side1: 0 })).toBe(1);
    expect(HOUSE_MAX_WITHOUT_REAL_PLAYER).toBe(1);
  });

  it("keeps that room BELOW the count the chain will draw a fight from", () => {
    // THE REASON ONE RATHER THAN TWO, and the reason this is an invariant rather than a preference.
    // At one fighter `enough_to_fight` fails, so `close_lobby_and_draw` is refused for EVERYONE — not
    // merely declined by a keeper that could have called it, but rejected by the program even for a
    // permissionless caller racing the deadline. And `lobby_is_dead` — "past the deadline and not
    // `enough_to_fight`" — is therefore TRUE, so `abandon_round` is the one instruction left that
    // succeeds. That is the pair of facts that made rounds #24, #25 and #26 abandon cleanly instead
    // of fighting themselves.
    expect(houseFighterCount({ side0: 0, side1: 0 })).toBeLessThan(MIN_FIGHTERS_TO_FIGHT);
  });

  it("holds at whatever board target this process was configured with", () => {
    // HONEST ABOUT ITS OWN REACH, because the stronger claim is the one a reader will assume. The rule
    // IS structural — an early return in `houseFighterCount`, taken before `HOUSE_BOARD_TARGET` and
    // `HOUSE_DISPLACEMENT` are read at all, so no value of either can reach past it — but this test
    // exercises exactly ONE configuration: whatever `config.ts` loaded from the ambient environment.
    // Those constants are read at module load, so a second setting cannot be reached from inside this
    // process. The trap it pins is therefore "somebody raised the target and the empty room grew with
    // it", checked against the target actually in force rather than against a hardcoded 10.
    expect(HOUSE_BOARD_TARGET).toBeGreaterThanOrEqual(MIN_FIGHTERS_TO_FIGHT);
    expect(houseFighterCount({ side0: 0, side1: 0 })).toBe(HOUSE_MAX_WITHOUT_REAL_PLAYER);
  });
});

describe("houseFighterCount", () => {
  it("holds the board at ten and gives up one seat per real arrival: 1, 9, 8, 7", () => {
    // THE POLICY REVERSAL, SPELLED OUT AS THE ARENA A PLAYER WALKS INTO. The previous ladder was
    // 4, 2, 0, 0 — the house was scaffolding that left completely once two real players could fight
    // each other, so the board SHRANK as the arena got busier and live rounds #23, #27 and #28 each
    // ran four fighters in a sixteen-seat room. Now the house holds the board at `HOUSE_BOARD_TARGET`
    // and its share of that board falls one-for-one, so the room stays full and turns human.
    //
    // The jump from 1 to 9 is the treasury rule ending and the board rule starting, at the exact
    // moment a real player makes a fight legitimate.
    //
    // Sides kept balanced from the second row on so this sees the COUNT rule alone — the cover rule
    // gets its own test below, and a lopsided fixture here would quietly be testing both at once.
    expect(houseFighterCount({ side0: 0, side1: 0 })).toBe(1);
    expect(houseFighterCount({ side0: 1, side1: 0 })).toBe(9);
    expect(houseFighterCount({ side0: 1, side1: 1 })).toBe(8);
    expect(houseFighterCount({ side0: 2, side1: 1 })).toBe(7);
  });

  it("keeps the room the same size however much of it is human", () => {
    // The property the ladder above is three samples of, and the one sentence that describes the
    // whole policy: total fighters = `HOUSE_BOARD_TARGET`, until there are more real players than
    // that and the house is gone.
    for (const real of everyLobbyWithSomebodyIn()) {
      const realTotal = real.side0 + real.side1;
      if (realTotal >= HOUSE_BOARD_TARGET) continue; // past the target the house has nothing left to yield
      const total = realTotal + houseFighterCount(real);
      expect(total, `${real.side0}v${real.side1}`).toBe(HOUSE_BOARD_TARGET);
    }
  });

  it("leaves entirely once the crowd is big enough to fill the board on its own", () => {
    // The house is a market maker, not a participant: it is still the case that it withdraws
    // completely, just at ten real players rather than at two. Both sides occupied, so the cover rule
    // is not holding a fighter in the room for a different reason.
    for (let side0 = 5; side0 <= 8; side0++) {
      for (let side1 = 5; side1 <= 8; side1++) {
        expect(houseFighterCount({ side0, side1 }), `${side0}v${side1}`).toBe(0);
      }
    }
  });

  it("never lets a lobby somebody is standing in fall under the two fighters `close_lobby_and_draw` demands", () => {
    // `enough_to_fight` is a `require!`, not a preference. A lobby with a real player in it that the
    // house throttled to a single fighter would reach its deadline with one instruction left that
    // succeeds on it, `abandon_round` — a person who turned up, waited, and got no fight.
    //
    // The EMPTY lobby is excluded because for it the opposite is the requirement, which is the whole
    // of the treasury rule above.
    for (const real of everyLobbyWithSomebodyIn()) {
      const total = real.side0 + real.side1 + houseFighterCount(real);
      expect(total, `${real.side0}v${real.side1}`).toBeGreaterThanOrEqual(MIN_FIGHTERS_TO_FIGHT);
    }
  });

  it("still covers an empty side when the count rule has thrown the house out", () => {
    // Eleven real players stacked on one side is a queue, not a fight, and no number of further real
    // entrants fixes it — they are free to stack too. This is the one case where the house adds a
    // fighter to a room that does not need more fighters, and the alternative is a round that cannot
    // be drawn at all. It takes eleven now rather than three, because below the board target the
    // count rule is already asking for fighters.
    expect(houseFighterCount({ side0: 11, side1: 0 })).toBe(1);
    expect(allocateHouseSides(1, { side0: 11, side1: 0 })).toEqual([1]);
    expect(houseFighterCount({ side0: 0, side1: 12 })).toBe(1);
    expect(allocateHouseSides(1, { side0: 0, side1: 12 })).toEqual([0]);
  });

  it("never fields more fighters than the keeper has wallets", () => {
    for (const real of everyLobby()) {
      const n = houseFighterCount(real);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThanOrEqual(HOUSE_WALLET_COUNT);
      expect(Number.isInteger(n)).toBe(true);
    }
  });

  it("puts a bounded amount of house money on the board, and this is where that number is stated", () => {
    // THE EXPOSURE LINE. Conservation gives "house loss on a round <= total house stake in it", so
    // the worst round this policy can construct is the fullest house board at the top of the stake
    // band. Written out as a literal so that raising `KEEPER_HOUSE_BOARD_TARGET` or
    // `KEEPER_HOUSE_STAKE_MAX_USD` has to come here and re-endorse the number — which is the same
    // discipline the ladder above exists for, applied to money instead of to fighters.
    //
    //   worst case   9 fighters x $20  = $180   (one real player, board at ten)
    //   typical      9 fighters x $12.50 = ~$113  (mean of the band)
    //   before       2 fighters x $27.50 = ~$55
    //
    // Against an expected fee revenue of ZERO — measured, not argued: house-wallet P&L is exactly
    // minus the fee those wallets pay, and that fee returns to the treasury the house owns. The house
    // is not paid for carrying this; it carries it to have an arena worth walking into.
    //
    // ASKED OF THE POLICY, NOT OF THE CONSTANTS. `HOUSE_BOARD_TARGET - HOUSE_DISPLACEMENT` is the same
    // number in the common case and is not the same claim: it never calls `houseFighterCount`, so
    // deleting the `HOUSE_WALLET_COUNT` clamp or rewriting the throttle would leave this green while
    // real exposure moved. It is also wrong at the edges — at target 1 it computes 0 where the policy
    // actually fields 1, because `HOUSE_FLOOR` carries that case.
    const busiestHouseBoard = Math.max(...everyLobby().map(houseFighterCount));
    expect(busiestHouseBoard).toBe(HOUSE_BOARD_TARGET - HOUSE_DISPLACEMENT);
    expect(busiestHouseBoard * HOUSE_STAKE_MAX_USD).toBeLessThanOrEqual(180);
  });
});

describe("allocateHouseSides", () => {
  it("leaves both sides of the lobby occupied, in every lobby the policy fields a fight into", () => {
    // The guarantee that makes `cover` worth having: it is not enough to field the right NUMBER of
    // house fighters if they all pick the same side as each other.
    //
    // The empty lobby is excluded, and its exclusion is the treasury rule again rather than a gap: a
    // room with nobody real in it gets ONE fighter, which necessarily leaves a side empty, which is
    // one more reason the chain will not draw it.
    for (const real of everyLobbyWithSomebodyIn()) {
      const sides = allocateHouseSides(houseFighterCount(real), real);
      const side0 = real.side0 + sides.filter((s) => s === 0).length;
      const side1 = real.side1 + sides.filter((s) => s === 1).length;
      expect(side0, `${real.side0}v${real.side1}`).toBeGreaterThan(0);
      expect(side1, `${real.side0}v${real.side1}`).toBeGreaterThan(0);
    }
  });

  it("hands back exactly the number of assignments it was asked for", () => {
    for (let count = 0; count <= HOUSE_WALLET_COUNT; count++) {
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
      const stakes = new Set(Array.from({ length: HOUSE_WALLET_COUNT }, (_, i) => houseStake(roundNo, i)));
      expect(stakes.size, `round ${roundNo}`).toBeGreaterThanOrEqual(2);
    }
  });

  it("moves the same wallet's stake across the whole band from round to round", () => {
    // Otherwise wallet #0 would be "the $8 bot" forever, which is the same tell one wallet at a time.
    //
    // Stated as "covers the band" rather than as a fixed count of distinct values, because the band
    // is now configurable and a literal threshold would be a claim about its width rather than about
    // the hash. Two hundred rounds over a band this narrow should reach every rung; if a future band
    // is wide enough that it does not, that is a fact about the band and this is where it surfaces.
    const span = HOUSE_STAKE_MAX_USD - HOUSE_STAKE_MIN_USD + 1;
    const stakes = new Set(Array.from({ length: 200 }, (_, i) => houseStake(i + 1, 0)));
    expect(stakes.size).toBe(span);
  });

  it("always lands on a whole dollar inside the published band", () => {
    for (let roundNo = 1; roundNo <= 500; roundNo++) {
      for (let i = 0; i < HOUSE_WALLET_COUNT; i++) {
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
