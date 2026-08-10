// WHAT THE HOUSE ENTERS, AND WHEN — the one piece of non-trivial pure logic the keeper owns.
//
// `houseSizing.ts` decides HOW MANY house fighters a lobby should hold and is tested on its own.
// This file tests the thing between that policy and the chain: `plannedHouseEntries`, which turns
// "the policy wants nine, one side already has two of ours, and three of the ten wallets are
// already in" into the exact list of `enter` calls to send.
//
// It earns its place on failure cost rather than on coverage. Get it wrong high and the lobby is
// asked for a seventeenth seat and every entry fails with `RoundFull`; get it wrong low and the
// round reaches its deadline under-subscribed, gets abandoned, and burns the ~0.0085 SOL of round
// rent that nothing reclaims — once per round, silently, forever. Neither shows up as an exception.
//
// The classifier is exercised for real (through `houseBankFrom`, with real keypairs) rather than
// stubbed, because "which fighters are ours" is the input everything else here is a function of, and
// a stub would test the arithmetic against an assumption instead of against the code that produces it.

import { describe, expect, it } from "vitest";
import { BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";

import type { RawFighter, RawRoundAccount } from "../../src/chain/program.ts";
import {
  CLOCK_SKEW_MARGIN_SECONDS, HOUSE_BOARD_TARGET, HOUSE_FILL_LEAD_SECONDS, HOUSE_WALLET_COUNT,
  MIN_FIGHTERS_TO_FIGHT, REAL_SEATS_RESERVED,
} from "./config.ts";
import { HOUSE_FLOOR, HOUSE_MAX_WITHOUT_REAL_PLAYER } from "./houseSizing.ts";
import { houseBankFrom, plannedHouseEntries } from "./houseBank.ts";
import { planLobby } from "./lobbyPolicy.ts";

const bank = houseBankFrom(Array.from({ length: HOUSE_WALLET_COUNT }, () => Keypair.generate()));
const houseKey = (index: number) => bank.active[index]!.keypair.publicKey;

const LOBBY_CLOSES_AT = 1_800_000_000;
/** Comfortably before the fill stage is due — the seed stage's window. */
const EARLY = LOBBY_CLOSES_AT - HOUSE_FILL_LEAD_SECONDS - 20;
/** Inside the fill lead, where the house tops up to the policy's target. */
const FILL_TIME = LOBBY_CLOSES_AT - HOUSE_FILL_LEAD_SECONDS;

function fighter(wallet: PublicKey, side: 0 | 1): RawFighter {
  return { wallet, side, dead: 0, stake: new BN(1), hp: new BN(1), banked: new BN(0) };
}

/** `n` real fighters, all on `side`. The identity of a real player is "a wallet the bank does not
 *  hold", so a fresh keypair is a fresh player. */
const players = (n: number, side: 0 | 1) =>
  Array.from({ length: n }, () => fighter(Keypair.generate().publicKey, side));

/** A round account with just the fields `plannedHouseEntries` reads. The fighter array is padded to
 *  sixteen because the function derives the seat ceiling from `fighters.length` rather than from a
 *  restated MAX_FIGHTERS — so a short array here would quietly change the behaviour under test. */
function roundWith(fighters: RawFighter[]): RawRoundAccount {
  const padded = [...fighters];
  while (padded.length < 16) padded.push(fighter(PublicKey.default, 0));
  return {
    lobbyClosesAt: new BN(LOBBY_CLOSES_AT),
    fighterCount: fighters.length,
    fighters: padded,
  } as unknown as RawRoundAccount;
}

/** The lobby view for a round running to its deadline. `drawAt` is the deadline because that is when
 *  such a lobby genuinely gets drawn; a keeper that has committed to an earlier close passes that
 *  instead, which several tests below do explicitly. */
const runningToDeadline = { drawAt: LOBBY_CLOSES_AT };

const entriesOf = (round: RawRoundAccount, now: number, lobby = runningToDeadline) =>
  plannedHouseEntries(bank, round, 7n, now, lobby).entries;

const sidesOf = (round: RawRoundAccount, now: number) => entriesOf(round, now).map((e) => e.side).sort();

const walletsOf = (round: RawRoundAccount, now: number) => entriesOf(round, now).map((e) => e.wallet.index);

describe("a lobby with nobody real in it", () => {
  // THE TREASURY RULE, AT THE ONE LAYER THAT ACTUALLY SENDS TRANSACTIONS. `houseSizing.test.ts` checks
  // the policy; this checks that no stage, clock or configuration of `plannedHouseEntries` can route
  // around it. It used to be a block about hold-open specifically — the rule was conditional on that
  // switch, and with it off the seed stage below put two fighters into an empty room and the round
  // fought itself at its deadline. The rule is now unconditional, so this block is too.

  it("puts exactly one house fighter in, so the chain itself refuses to draw the round", () => {
    // THE NUMBER IS CHOSEN FOR WHAT IT MAKES IMPOSSIBLE. At one fighter `enough_to_fight` fails, so
    // `close_lobby_and_draw` is refused for EVERYONE — not just for a keeper that declines to call
    // it, but for a permissionless caller racing the deadline. "No house-versus-house fights" stops
    // being a policy and becomes something the program enforces. And `lobby_is_dead` is true, so the
    // round can still be abandoned when nobody comes. See `HOUSE_MAX_WITHOUT_REAL_PLAYER`.
    const entries = entriesOf(roundWith([]), EARLY);
    expect(entries).toHaveLength(HOUSE_MAX_WITHOUT_REAL_PLAYER);
    expect(HOUSE_MAX_WITHOUT_REAL_PLAYER).toBeLessThan(MIN_FIGHTERS_TO_FIGHT);
  });

  it("gives the same answer at the fill stage, where the board policy would otherwise want ten", () => {
    // THE HOLE THIS CLOSES, AND THE REASON IT IS WORTH A TEST OF ITS OWN. The fill stage is the one
    // that reads `HOUSE_BOARD_TARGET`, so it is the stage a raised board target would have flowed
    // through into an empty room. Both stages now answer the treasury rule and neither consults the
    // board policy until somebody real is standing there.
    expect(HOUSE_BOARD_TARGET).toBeGreaterThan(MIN_FIGHTERS_TO_FIGHT);
    expect(entriesOf(roundWith([]), FILL_TIME)).toHaveLength(HOUSE_MAX_WITHOUT_REAL_PLAYER);
  });

  it("adds nothing once that one is in, however long the hold lasts", () => {
    // The cheap steady state, stated as a property: a held lobby costs nothing per pass, per minute
    // or per hour, and the only thing keeping that true is this returning an empty plan.
    const oneIn = roundWith([fighter(houseKey(0), 0)]);
    expect(entriesOf(oneIn, EARLY)).toHaveLength(0);
    expect(entriesOf(oneIn, LOBBY_CLOSES_AT - 3_500)).toHaveLength(0);
    expect(entriesOf(oneIn, FILL_TIME)).toHaveLength(0);
  });

  it("reaches its deadline in a state whose only legal next instruction is `abandon_round`", () => {
    // THE PROOF THE WHOLE POLICY IS ANSWERABLE FOR, END TO END AND IN ONE PLACE: seat the house into
    // an empty lobby exactly as the keeper would, let the clock run past the deadline, and ask the
    // keeper what it does next. It must say `abandon`, and it must say so because the round is
    // genuinely under `enough_to_fight` rather than because anyone chose to be careful.
    //
    // Rounds #24, #25 and #26 are this test, run against devnet. This is the version that runs in
    // 200 microseconds on every commit.
    const empty = roundWith([]);
    const seated = roundWith(entriesOf(empty, EARLY).map((e) => fighter(e.wallet.keypair.publicKey, e.side)));

    // The state the lobby is actually in when the backstop fires: house-only, and one short.
    expect(seated.fighterCount).toBeLessThan(MIN_FIGHTERS_TO_FIGHT);
    expect(bank.classify(seated).realCount).toBe(0);

    // Past the deadline and past the clock-skew margin, which is where the keeper stops waiting.
    const plan = planLobby({
      nowSec: LOBBY_CLOSES_AT + CLOCK_SKEW_MARGIN_SECONDS + 1,
      lobbyClosesAt: LOBBY_CLOSES_AT,
      fighterCount: seated.fighterCount,
      realFighterCount: 0,
      firstRealEntryObservedAtSec: null,
      holdOpen: true,
    });
    expect(plan.step).toEqual({ kind: "abandon" });

    // And with hold-open OFF, which is the configuration that used to fight this round rather than
    // abandon it. Same lobby, same answer — that equivalence is the change.
    expect(planLobby({
      nowSec: LOBBY_CLOSES_AT + CLOCK_SKEW_MARGIN_SECONDS + 1,
      lobbyClosesAt: LOBBY_CLOSES_AT,
      fighterCount: seated.fighterCount,
      realFighterCount: 0,
      firstRealEntryObservedAtSec: null,
      holdOpen: false,
    }).step).toEqual({ kind: "abandon" });
  });

  it("fills the house in around a real player the moment one arrives", () => {
    // The seed stage takes over in the same pass the classifier first sees a real fighter — so the
    // room populates AROUND the player rather than having been full before they got there. This is
    // the behaviour the single lone fighter buys, and it is why the treasury rule costs the product
    // nothing.
    const withPlayer = roundWith([fighter(houseKey(0), 0), fighter(Keypair.generate().publicKey, 1)]);
    expect(entriesOf(withPlayer, EARLY).length).toBeGreaterThan(0);
  });

  it("sizes the fill against the keeper's own close, not the backstop an hour away", () => {
    // THE SILENT FAILURE THIS PINS. A real player is in and the keeper will close entries in twenty
    // seconds; the fill stage has to be due against THAT, or it would come due an hour after the
    // fight had already been fought, and the house would never throttle against real arrivals at all.
    const withPlayer = roundWith([fighter(houseKey(0), 0), fighter(Keypair.generate().publicKey, 1)]);
    const closingSoon = { drawAt: LOBBY_CLOSES_AT - 3_580 };
    const fillDue = closingSoon.drawAt - HOUSE_FILL_LEAD_SECONDS;
    expect(entriesOf(withPlayer, fillDue, closingSoon).length).toBeGreaterThan(0);
  });

  it("plans nothing into the last moments before the keeper's own close", () => {
    // `enter` is refused at or past the instant the lobby is drawn, so an entry planned inside the
    // skew margin of the KEEPER's close is as wasted as one planned inside the chain deadline's.
    const closingSoon = { drawAt: LOBBY_CLOSES_AT - 3_580 };
    expect(entriesOf(roundWith([]), closingSoon.drawAt - CLOCK_SKEW_MARGIN_SECONDS, closingSoon)).toHaveLength(0);
  });
});

describe("the seed stage", () => {
  it("seeds the moment one real player is in, because one player cannot fight", () => {
    // The floor exists to make the round CAPABLE of fighting, which only becomes a goal worth having
    // once somebody real is in the room to fight. One per side, so the round is drawable rather than
    // merely populated.
    const round = roundWith([fighter(Keypair.generate().publicKey, 0)]);
    const entries = entriesOf(round, EARLY);
    expect(entries).toHaveLength(HOUSE_FLOOR);
    expect(entries.map((e) => e.side).sort()).toEqual([0, 1]);
  });

  it("stands down once the round can already fight without it", () => {
    const round = roundWith([
      fighter(Keypair.generate().publicKey, 0),
      fighter(Keypair.generate().publicKey, 1),
    ]);
    expect(round.fighterCount).toBeGreaterThanOrEqual(MIN_FIGHTERS_TO_FIGHT);
    expect(entriesOf(round, EARLY)).toEqual([]);
  });

  it("does not enter twice for fighters it has already seated", () => {
    const seeded = roundWith([fighter(houseKey(0), 0), fighter(houseKey(1), 1)]);
    expect(entriesOf(seeded, EARLY)).toEqual([]);
  });

  it("replaces only the entry that failed, and from a wallet that is not already seated", () => {
    // The seed stage sent two and one of them did not land. The next pass recounts from the chain
    // rather than from a remembered "we seeded" flag, so it asks for exactly the missing one.
    //
    // A real player is in the fixture because without one the treasury rule answers first and there
    // is no seed stage to be half-finished — which is itself worth noticing: the only lobby that can
    // be short of a seeded fighter is one somebody is waiting in.
    const partial = roundWith([fighter(houseKey(0), 0), ...players(1, 0)]);
    const entries = entriesOf(partial, EARLY);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.side).toBe(1);
    expect(entries[0]!.wallet.index).not.toBe(0);
  });
});

describe("the fill stage", () => {
  it("fills the board out around the one real player who turned up, evenly, on both sides", () => {
    // THE ROUND THE OWNER ASKED FOR, IN NUMBERS. The lobby held one house fighter while it waited;
    // somebody arrived; the fill stage brings the room to `HOUSE_BOARD_TARGET` and splits it 5-5 so
    // neither side is a queue. Live rounds #23, #27 and #28 ran four fighters in this same
    // sixteen-seat arena, which is the shape this replaces.
    const arrived = roundWith([fighter(houseKey(0), 1), ...players(1, 0)]);
    const entries = entriesOf(arrived, FILL_TIME);
    expect(entries).toHaveLength(8);
    expect(entries.filter((e) => e.side === 0)).toHaveLength(4);
    expect(entries.filter((e) => e.side === 1)).toHaveLength(4);
    // The board those entries produce: ten fighters, five a side, one of them a person.
    expect(arrived.fighterCount + entries.length).toBe(HOUSE_BOARD_TARGET);
  });

  it("adds nothing once the crowd is large enough to fill the board on its own", () => {
    // The displacement rule at its endpoint: ten real players want no house fighters at all. The
    // house is a market maker, not a participant — it just withdraws at ten now rather than at two.
    const round = roundWith([...players(5, 0), ...players(5, 1)]);
    expect(entriesOf(round, FILL_TIME)).toEqual([]);
  });

  it("cannot un-enter fighters it already committed, and does not try", () => {
    // A full board of real players arriving after the house had already seeded: the policy wants zero
    // house fighters and two are standing in the ring. Asking for a negative shortfall must be
    // silence, not a crash and not a nonsense entry.
    const round = roundWith([
      fighter(houseKey(0), 0), fighter(houseKey(1), 1), ...players(5, 0), ...players(5, 1),
    ]);
    expect(entriesOf(round, FILL_TIME)).toEqual([]);
  });

  it("covers an empty side even when the count rule has throttled the house out", () => {
    // Eleven real players all stacked on side 0: the count rule says no house fighters, but a round
    // with an empty side cannot be drawn. The one fighter it fields must stand on side 1. It takes
    // eleven rather than three now, because below the board target the count rule is still asking.
    expect(sidesOf(roundWith(players(11, 0)), FILL_TIME)).toEqual([1]);
  });

  it("covers an empty side even when it is already at its target, just badly arranged", () => {
    // THE ONE THE TOTAL-SHORTFALL ARITHMETIC MISSED. Five real players and five house fighters, all
    // ten of them on side 1. The policy wants five house fighters and five are standing, so the total
    // shortfall is zero — but side 0 is empty, so this lobby cannot be drawn at all, and the old
    // `target - houseCount` returned nothing and let it reach its deadline and be abandoned.
    //
    // `allocateHouseSides` always joins the smaller side, so this keeper does not arrange itself this
    // way; the fixture is built by hand. It is here because the cost of meeting it once (a round's
    // ~0.0085 SOL of rent, and players who turned up and got no fight) is far above the cost of
    // surviving it always.
    const stacked = roundWith([
      ...players(5, 1),
      ...bank.active.slice(0, 5).map((w) => fighter(w.keypair.publicKey, 1)),
    ]);
    const entries = entriesOf(stacked, FILL_TIME);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.side === 0)).toBe(true);
  });

  it("always leaves seats for players who have not arrived yet", () => {
    // THE PROMISE A RAISED BOARD TARGET COULD OTHERWISE BREAK: a visitor who clicks Enter and meets
    // `RoundFull` because the arena's own bots filled the room. Swept across every crowd size rather
    // than sampled, because the value that would break it is a config change made months from now.
    //
    // The exception is deliberate and is the one case where an unenterable round beats an undrawable
    // one: down at the fightability floor the house is fielding the `cover` fighter that makes a
    // lopsided lobby legal at all, and the reservation yields to it.
    for (let real = 1; real <= 16; real++) {
      const round = roundWith(players(real, 0));
      const planned = entriesOf(round, FILL_TIME).length;
      const free = round.fighters.length - real - planned;
      if (planned > MIN_FIGHTERS_TO_FIGHT) {
        expect(free, `${real} real`).toBeGreaterThanOrEqual(REAL_SEATS_RESERVED);
      }
      expect(free, `${real} real`).toBeGreaterThanOrEqual(0);
    }
  });

  it("never asks for a seat the program does not have", () => {
    // Fifteen real fighters, all on one side, and one seat left. The cover rule still wants a house
    // fighter on the empty side and there is exactly room for it.
    const fifteen = Array.from({ length: 15 }, () => fighter(Keypair.generate().publicKey, 0));
    expect(sidesOf(roundWith(fifteen), FILL_TIME)).toEqual([1]);

    // Sixteen, still all on one side: the cover rule wants a fighter on side 1 just as much, and
    // there is nowhere to put it. `enter` answers `RoundFull` past MAX_FIGHTERS, and a transaction
    // guaranteed to fail is a fee spent to learn nothing.
    const sixteen = [...fifteen, fighter(Keypair.generate().publicKey, 0)];
    expect(entriesOf(roundWith(sixteen), FILL_TIME)).toEqual([]);
  });

  it("never reaches for a wallet that is already in the round", () => {
    // A wallet that entered again on its other side would be a fighter on both sides of a fight it is
    // funding — `enter` is keyed on (wallet, side), so the program would happily allow it, and the
    // roster would show one bot beating itself up.
    //
    // Half the bank is already seated and the policy wants more, so this is the case where the naive
    // "take the first N wallets" would reoffend. Every wallet it picks must come from the other half.
    const seated = bank.active.slice(0, 5);
    const round = roundWith([...seated.map((w) => fighter(w.keypair.publicKey, 0)), ...players(1, 1)]);
    const picked = entriesOf(round, FILL_TIME).map((e) => e.wallet.index);
    expect(picked.length).toBeGreaterThan(0);
    expect(new Set(picked).size).toBe(picked.length);
    for (const index of picked) expect(index).toBeGreaterThanOrEqual(5);
  });

  it("stops planning entries once the deadline is too close to land one", () => {
    // `enter` refuses at or past `lobby_closes_at` against the ER's clock, so an entry planned inside
    // the skew margin is a fee spent on a `LobbyClosed`. Reachable rather than theoretical: the fill
    // stage starts twelve seconds out with up to four confirmed round-trips to make.
    expect(entriesOf(roundWith([]), LOBBY_CLOSES_AT - CLOCK_SKEW_MARGIN_SECONDS)).toEqual([]);
    expect(entriesOf(roundWith([]), LOBBY_CLOSES_AT + 5)).toEqual([]);
    // One second earlier there is still room, so the guard is a boundary rather than a blanket.
    expect(entriesOf(roundWith([]), LOBBY_CLOSES_AT - CLOCK_SKEW_MARGIN_SECONDS - 1)).not.toEqual([]);
  });

  it("gives every entry a distinct wallet", () => {
    // The fixture carries a real player, and that is load-bearing rather than incidental. It used to
    // be `roundWith([])`, which under the treasury rule now yields exactly ONE entry — so the
    // assertion had quietly become `Set([x]).size === 1` and would have stayed green against a
    // planner that handed the same wallet out nine times. A lobby with somebody in it is the only one
    // that produces a batch big enough for this to mean anything.
    const wallets = walletsOf(roundWith(players(1, 0)), FILL_TIME);
    expect(wallets.length).toBeGreaterThan(1);
    expect(new Set(wallets).size).toBe(wallets.length);
  });
});

describe("classification", () => {
  it("counts a wallet the bank does not hold as a real player, per side", () => {
    const round = roundWith([
      fighter(houseKey(0), 0),
      fighter(Keypair.generate().publicKey, 1),
      fighter(Keypair.generate().publicKey, 1),
    ]);
    const split = bank.classify(round);
    expect(split.houseCount).toBe(1);
    expect(split.realCount).toBe(2);
    expect(split.real).toEqual({ side0: 0, side1: 2 });
    expect(split.house).toEqual({ side0: 1, side1: 0 });
  });

  it("ignores the array's unused seats, which are zeroed defaults rather than fighters", () => {
    // `fighter_count` is seats TAKEN; the array behind it is always sixteen long. Counting the tail
    // would report a lobby of sixteen bots on side 0 in every round.
    const round = roundWith([fighter(Keypair.generate().publicKey, 0)]);
    expect(round.fighters).toHaveLength(16);
    expect(bank.classify(round).realCount).toBe(1);
  });
});
