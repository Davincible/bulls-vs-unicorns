// THE SIX THINGS THE HOUSE MUST NEVER DO, checked against EVERY lobby shape a forty-eight-seat round
// can hold, at five points across the arrival window, rather than against the handful anybody thought
// to write down.
//
// WHY THIS FILE EXISTS SEPARATELY FROM `houseBank.test.ts`. That file is a set of examples, and
// examples are how a policy gets argued: "1 real player, 9 house fighters" is a sentence somebody has
// to re-endorse. This file is the opposite discipline — no judgement calls, no numbers to re-endorse,
// six properties that must hold at every input and that nobody should ever want to change. It earns
// its place because it FOUND something: the per-side shortfall bug documented in
// `plannedHouseEntries` had survived review and the whole example suite, because it only appears when
// the house is at its target AND badly distributed, which is two conditions nobody thinks to combine.
// It then found two more — a treasury-rule regression and a seat-reservation breach — in the fix for
// the first, within a minute of each. Sweeping is cheaper than being clever.
//
// THE SECOND DIMENSION IS NOW THE RAMP POSITION, AND IT REPLACED A STAGE FLAG. The planner used to
// behave differently at exactly two moments — before the fill lead and inside it — so two was the
// whole sweep. The house now arrives on a schedule spread across the entry window, so "which moment"
// is a continuum, and the properties below have to hold at every point on it. Five positions, evenly
// spaced from the instant the window opens to the instant it closes, is what makes the treasury rule's
// sweep a claim about the WHOLE window rather than about the two ends of one.
//
// 86,580 shapes: 17,316 lobby shapes at each of the five ramp positions. The house-side loops were cut
// from six values a side to four to pay for the extra positions — the shapes past three house fighters
// a side are dominated by the ones below them, whereas a ramp position is a genuinely different
// question, so that is the cheaper dimension to spend.
//
// WHAT THE SWEEP ACTUALLY COSTS, MEASURED, BECAUSE THIS COMMENT USED TO CLAIM "COMFORTABLY
// SUB-SECOND" AND THAT WAS NEVER TRUE. It is about 25 seconds, and it was about the same before the
// ramp dimension existed (the old two-stage sweep of 71,490 shapes measures at 20-30s on the same
// machine). Essentially all of it is one line of production code: `classify` calls `toBase58()` once
// per seated fighter, base58 is repeated bignum division, and this file asks for roughly three million
// of them. The shape count is not the problem and trimming it would buy a few seconds at the cost of
// the coverage that found three real bugs. Recorded here rather than fixed because the fix is a change
// to how the keeper identifies a wallet, which is not a change to make in service of a test's clock.
//
// The real fighters are raw 32-byte pubkeys rather than generated keypairs: a real player is defined
// as "a wallet the bank does not hold", nothing here signs anything, and Ed25519 keygen would make
// this slow enough that somebody really would skip it.

import { describe, expect, it } from "vitest";
import { BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";

import type { RawFighter, RawRoundAccount } from "../../src/chain/program.ts";
import {
  HOUSE_ARRIVAL_TAIL_SECONDS, HOUSE_WALLET_COUNT, MIN_FIGHTERS_TO_FIGHT, REAL_PLAYER_GRACE_SECONDS,
  REAL_SEATS_RESERVED,
} from "./config.ts";
import { houseBankFrom, plannedHouseEntries, type HouseBank } from "./houseBank.ts";
import { houseFighterCount, type SideCounts } from "./houseSizing.ts";

const SEATS = 48;
const CLOSES_AT = 1_800_000_000;
/** Where in the arrival window each sweep position sits, from the moment it opens to the moment it
 *  closes. `0` and `1` are the two that carry weight — the thinnest board the planner will ever field
 *  with somebody in the room, and the board the round is actually drawn with — and the three between
 *  them are there because a ramp that was wrong only in its middle would otherwise pass. */
const RAMP_POSITIONS = [0, 0.25, 0.5, 0.75, 1] as const;

/** The instant a given ramp position corresponds to, on a lobby drawn at `CLOSES_AT`. Derived from the
 *  two constants that define the window rather than from a literal, so a retuned grace moves the sweep
 *  with it instead of quietly testing the wrong five moments. */
function whenAt(fraction: number): number {
  const span = REAL_PLAYER_GRACE_SECONDS - HOUSE_ARRIVAL_TAIL_SECONDS;
  return CLOSES_AT - REAL_PLAYER_GRACE_SECONDS + fraction * span;
}

const bank: HouseBank = houseBankFrom(Array.from({ length: HOUSE_WALLET_COUNT }, () => Keypair.generate()));

let stranger = 0;
/** A wallet the bank does not hold, which is the entire definition of a real player here. Cheap on
 *  purpose — see the file header. */
function realWallet(): PublicKey {
  const bytes = new Uint8Array(32);
  const n = ++stranger;
  bytes[0] = n & 0xff;
  bytes[1] = (n >> 8) & 0xff;
  bytes[31] = 7; // keeps it clear of the all-zero PublicKey.default the padding uses
  return new PublicKey(bytes);
}

function fighter(wallet: PublicKey, side: 0 | 1): RawFighter {
  return { wallet, side, dead: 0, stake: new BN(1), hp: new BN(1), banked: new BN(0) };
}

function roundWith(fighters: RawFighter[]): RawRoundAccount {
  const padded = [...fighters];
  while (padded.length < SEATS) padded.push(fighter(PublicKey.default, 0));
  return {
    lobbyClosesAt: new BN(CLOSES_AT), fighterCount: fighters.length, fighters: padded,
  } as unknown as RawRoundAccount;
}

interface Shape {
  /** How far through the arrival window the planner is asked. */
  ramp: number;
  /** Real fighters per side. */
  r0: number; r1: number;
  /** House fighters ALREADY standing, per side — including arrangements this keeper would not itself
   *  produce, because a restart, a partial send or a round seeded under another configuration can. */
  h0: number; h1: number;
}

/** Every lobby a forty-eight-seat round can hold, at every ramp position. The house-side loops stop at
 *  3 because the shapes past that are dominated by the ones below them, and because the sweep is meant
 *  to stay fast enough that nobody is tempted to skip it — see the file header on why that budget was
 *  spent on ramp positions rather than on house fighters. */
function everyShape(): Shape[] {
  const shapes: Shape[] = [];
  for (const ramp of RAMP_POSITIONS) {
    for (let r0 = 0; r0 <= SEATS; r0++) {
      for (let r1 = 0; r0 + r1 <= SEATS; r1++) {
        for (let h0 = 0; h0 <= 3; h0++) {
          for (let h1 = 0; h1 <= 3; h1++) {
            if (h0 + h1 > HOUSE_WALLET_COUNT) continue;
            if (r0 + r1 + h0 + h1 > SEATS) continue;
            shapes.push({ ramp, r0, r1, h0, h1 });
          }
        }
      }
    }
  }
  return shapes;
}

interface Outcome {
  label: string;
  /** Carried through so a property can ask about one position on the ramp — the two that matter are
   *  the end of the window, where the board must be whole, and every position at once, where the
   *  treasury rule must hold. */
  ramp: number;
  realTotal: number;
  /** The real fighters per side, which is the input the sizing policy is a function of — carried so a
   *  property can ask that policy what the board SHOULD hold rather than assuming it. */
  real: SideCounts;
  houseBefore: number;
  /** How many `enter` calls the planner asked for. */
  planned: number;
  houseAfter: number;
  side0After: number;
  side1After: number;
  freeSeatsAfter: number;
  /** Did the plan reach for a wallet already holding a fighter in this round? */
  reusedAWallet: boolean;
  /** Did the plan name the same wallet twice? */
  duplicatedAWallet: boolean;
}

function plan({ ramp, r0, r1, h0, h1 }: Shape): Outcome {
  const seated = [
    ...Array.from({ length: r0 }, () => fighter(realWallet(), 0 as const)),
    ...Array.from({ length: r1 }, () => fighter(realWallet(), 1 as const)),
    ...bank.active.slice(0, h0).map((w) => fighter(w.keypair.publicKey, 0 as const)),
    ...bank.active.slice(h0, h0 + h1).map((w) => fighter(w.keypair.publicKey, 1 as const)),
  ];
  const round = roundWith(seated);
  const { entries } = plannedHouseEntries(bank, round, 7n, whenAt(ramp), { drawAt: CLOSES_AT });

  const already = new Set(seated.map((f) => f.wallet.toBase58()));
  const picked = entries.map((e) => e.wallet.keypair.publicKey.toBase58());
  const added0 = entries.filter((e) => e.side === 0).length;
  const added1 = entries.length - added0;

  return {
    label: `ramp ${ramp}: ${r0}v${r1} real, ${h0}v${h1} house`,
    ramp,
    realTotal: r0 + r1,
    real: { side0: r0, side1: r1 },
    houseBefore: h0 + h1,
    planned: entries.length,
    houseAfter: h0 + h1 + entries.length,
    side0After: r0 + h0 + added0,
    side1After: r1 + h1 + added1,
    freeSeatsAfter: SEATS - (r0 + r1 + h0 + h1 + entries.length),
    reusedAWallet: picked.some((k) => already.has(k)),
    duplicatedAWallet: new Set(picked).size !== picked.length,
  };
}

const outcomes = everyShape().map(plan);

describe("what the house does to every lobby a round can hold", () => {
  it("sweeps every shape at every ramp position, so a passing run below is a claim about all of them", () => {
    // The number is written out rather than derived so that changing either loop has to come here and
    // say what the new sweep covers. 17,316 lobby shapes x 5 points across the arrival window.
    expect(outcomes.length).toBe(86_580);
    expect(new Set(outcomes.map((o) => o.ramp)).size).toBe(RAMP_POSITIONS.length);
  });

  it("never asks for a seat the round does not have", () => {
    // `enter` answers `RoundFull` past MAX_FIGHTERS, and a transaction guaranteed to fail is a fee
    // spent to learn nothing. Nothing outranks this bound — not the target, not the cover rule.
    for (const o of outcomes) expect(o.freeSeatsAfter, o.label).toBeGreaterThanOrEqual(0);
  });

  it("never enters a wallet that is already fighting in the round", () => {
    // A wallet on both sides would be one bot funding both ends of a fight with itself. `enter` is
    // keyed on (wallet, side), so the program would allow it.
    for (const o of outcomes) {
      expect(o.reusedAWallet, o.label).toBe(false);
      expect(o.duplicatedAWallet, o.label).toBe(false);
    }
  });

  it("NEVER makes a lobby with no real player in it capable of fighting", () => {
    // THE TREASURY RULE, and the property this whole file is really here to defend. The claim is
    // deliberately about what the planner CAUSES rather than about the state it finds: a lobby that
    // somehow already holds two house fighters and nobody real is unreachable under this policy — a
    // real player cannot un-enter, so `realCount` never falls — but if the planner is ever handed one,
    // it must not make it worse, and above all it must not push a one-fighter room to two.
    //
    // AT EVERY RAMP POSITION, AND THAT SWEEP IS THE PROOF THE RULE STILL BINDS. The arrival schedule
    // introduced a second thing the target is a function of — the clock — and the rule has to outrank
    // it at every value of it, not merely at the two moments the old two-stage planner had. This runs
    // the whole empty-room half of the shape space at five points across the window, so "the schedule
    // is never consulted when nobody real is in the room" stops being a claim about where an early
    // return sits in the source and becomes a measurement.
    for (const o of outcomes) {
      if (o.realTotal > 0) continue;
      expect(o.houseAfter, o.label).toBeLessThanOrEqual(Math.max(MIN_FIGHTERS_TO_FIGHT - 1, o.houseBefore));
    }
  });

  it("leaves every lobby holding a real player drawable, by the time it is drawn", () => {
    // Both sides occupied and at least `enough_to_fight` fighters, or the round reaches its deadline
    // with one instruction left that succeeds on it — `abandon_round` — and the person who turned up
    // and waited gets nothing while the round's ~0.0085 SOL of rent goes with it.
    //
    // ASSERTED AT THE END OF THE ARRIVAL WINDOW, WHICH IS THE HONEST PLACE FOR IT — the analogue of
    // "by the time it is drawn", and the last instant the planner can still fix anything. Earlier in
    // the window a lobby can be transiently lopsided: the fightability floor guarantees a round is
    // DRAWABLE from the first pass a real player is seen, but a shape that arrives already skewed —
    // from a restart, a partial send, or a round seeded under another configuration — is corrected as
    // the schedule fills the thinner side. That this passes at ramp position 1 for every shape and not
    // at position 0 is the ramp working rather than a gap.
    for (const o of outcomes) {
      if (o.ramp !== 1 || o.realTotal === 0) continue;
      if (o.freeSeatsAfter === 0 || o.houseAfter >= HOUSE_WALLET_COUNT) continue; // nothing left to fix it with
      expect(o.side0After + o.side1After, o.label).toBeGreaterThanOrEqual(MIN_FIGHTERS_TO_FIGHT);
      expect(o.side0After, o.label).toBeGreaterThan(0);
      expect(o.side1After, o.label).toBeGreaterThan(0);
    }
  });

  it("has the whole board in by the end of the window, so the ramp can never cause a short one", () => {
    // THE REGRESSION GUARD FOR THE EXACT BUG THE CONCURRENCY FIX LANDED TO KILL, now that there is a
    // second mechanism that could reintroduce it. A board that draws at six instead of ten is
    // invisible from the outside — no error, no failed transaction, a perfectly healthy keeper — and
    // it is indistinguishable from the empty-arena complaint this whole policy exists to answer. The
    // ramp is a scheduling change, and a scheduling change that lost fighters would be a policy
    // change nobody chose.
    //
    // The target is re-derived here from `houseFighterCount` and the seat reservation rather than read
    // back out of the planner, so this is a claim about the POLICY being satisfied and not a
    // restatement of whatever the planner did. It is stated as "at least", because the ceiling is what
    // the seat-reservation property below owns and because a pre-seated shape the keeper would never
    // have produced itself — every existing house fighter stacked on one side — legitimately ends up
    // above the target while it corrects the skew.
    for (const o of outcomes) {
      if (o.ramp !== 1 || o.realTotal === 0) continue;
      const wanted = Math.min(
        houseFighterCount(o.real),
        Math.max(0, SEATS - o.realTotal - REAL_SEATS_RESERVED),
      );
      expect(o.houseAfter, o.label).toBeGreaterThanOrEqual(wanted);
    }
  });

  it("keeps seats free for players who have not arrived yet", () => {
    // The house must never be the reason a visitor meets `RoundFull`. The single documented exception
    // is the cover fighter: one bot onto an empty side outranks the reservation, because an
    // unenterable round is bad and an undrawable one is worse. It is recognisable as exactly one entry
    // landing on a side that had nobody on it.
    for (const o of outcomes) {
      const coveringAnEmptySide = o.planned === 1 && (o.side0After === 1 || o.side1After === 1);
      if (coveringAnEmptySide || o.planned === 0) continue;
      if (o.houseAfter <= MIN_FIGHTERS_TO_FIGHT) continue; // the fightability floor also outranks it
      expect(o.freeSeatsAfter, o.label).toBeGreaterThanOrEqual(REAL_SEATS_RESERVED);
    }
  });
});
