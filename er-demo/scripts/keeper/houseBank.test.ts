// WHAT THE HOUSE ENTERS, AND WHEN — the one piece of non-trivial pure logic the keeper owns.
//
// `houseSizing.ts` decides HOW MANY house fighters a lobby should hold and is tested on its own.
// This file tests the thing between that policy and the chain: `plannedHouseEntries`, which turns
// "the policy wants four, one side already has two of ours, and three of the six wallets are
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
import { CLOCK_SKEW_MARGIN_SECONDS, HOUSE_FILL_LEAD_SECONDS, MIN_FIGHTERS_TO_FIGHT } from "./config.ts";
import { HOUSE_FLOOR, HOUSE_MAX } from "./houseSizing.ts";
import { houseBankFrom, plannedHouseEntries } from "./houseBank.ts";

const bank = houseBankFrom(Array.from({ length: HOUSE_MAX }, () => Keypair.generate()));
const houseKey = (index: number) => bank.active[index]!.keypair.publicKey;

const LOBBY_CLOSES_AT = 1_800_000_000;
/** Comfortably before the fill stage is due — the seed stage's window. */
const EARLY = LOBBY_CLOSES_AT - HOUSE_FILL_LEAD_SECONDS - 20;
/** Inside the fill lead, where the house tops up to the policy's target. */
const FILL_TIME = LOBBY_CLOSES_AT - HOUSE_FILL_LEAD_SECONDS;

function fighter(wallet: PublicKey, side: 0 | 1): RawFighter {
  return { wallet, side, dead: 0, stake: new BN(1), hp: new BN(1), banked: new BN(0) };
}

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

const entriesOf = (round: RawRoundAccount, now: number) => plannedHouseEntries(bank, round, 7n, now).entries;

const sidesOf = (round: RawRoundAccount, now: number) => entriesOf(round, now).map((e) => e.side).sort();

const walletsOf = (round: RawRoundAccount, now: number) => entriesOf(round, now).map((e) => e.wallet.index);

describe("the seed stage", () => {
  it("puts the policy's floor into an empty lobby, one fighter per side", () => {
    const entries = entriesOf(roundWith([]), EARLY);
    expect(entries).toHaveLength(HOUSE_FLOOR);
    expect(entries.map((e) => e.side).sort()).toEqual([0, 1]);
  });

  it("still seeds when one real player is in, because one player cannot fight", () => {
    const round = roundWith([fighter(Keypair.generate().publicKey, 0)]);
    expect(entriesOf(round, EARLY)).toHaveLength(HOUSE_FLOOR);
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
    const partial = roundWith([fighter(houseKey(0), 0)]);
    const entries = entriesOf(partial, EARLY);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.side).toBe(1);
    expect(entries[0]!.wallet.index).not.toBe(0);
  });
});

describe("the fill stage", () => {
  it("tops an empty lobby up from the floor to the policy's target, keeping the sides even", () => {
    const seeded = roundWith([fighter(houseKey(0), 0), fighter(houseKey(1), 1)]);
    // 0 real -> the policy wants 4; two are already standing, one per side, so one more per side.
    expect(sidesOf(seeded, FILL_TIME)).toEqual([0, 1]);
  });

  it("adds nothing once real players have thrown the count back down", () => {
    // 1 real -> the policy wants 2, and the seed stage already put 2 in. The house is displaced by
    // arrivals rather than piling on top of them.
    const round = roundWith([
      fighter(houseKey(0), 0), fighter(houseKey(1), 1), fighter(Keypair.generate().publicKey, 0),
    ]);
    expect(entriesOf(round, FILL_TIME)).toEqual([]);
  });

  it("cannot un-enter fighters it already committed, and does not try", () => {
    // 2 real -> the policy wants 0 house, but two are already in the ring. Asking for a negative
    // shortfall must be silence, not a crash and not a nonsense entry.
    const round = roundWith([
      fighter(houseKey(0), 0), fighter(houseKey(1), 1),
      fighter(Keypair.generate().publicKey, 0), fighter(Keypair.generate().publicKey, 1),
    ]);
    expect(entriesOf(round, FILL_TIME)).toEqual([]);
  });

  it("covers an empty side even when the count rule has throttled the house out", () => {
    // Three real players all stacked on side 0: the count rule says no house fighters, but a round
    // with an empty side cannot be drawn. The one fighter it fields must stand on side 1.
    const round = roundWith([
      fighter(Keypair.generate().publicKey, 0),
      fighter(Keypair.generate().publicKey, 0),
      fighter(Keypair.generate().publicKey, 0),
    ]);
    expect(sidesOf(round, FILL_TIME)).toEqual([1]);
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

  it("runs out of wallets rather than reusing one that is already in the round", () => {
    // A wallet that entered again on its other side would be a fighter on both sides of a fight it
    // is funding — `enter` is keyed on (wallet, side), so the program would happily allow it.
    const round = roundWith(bank.active.map((w, i) => fighter(w.keypair.publicKey, (i % 2) as 0 | 1)));
    expect(entriesOf(round, FILL_TIME)).toEqual([]);
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
    const wallets = walletsOf(roundWith([]), FILL_TIME);
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
