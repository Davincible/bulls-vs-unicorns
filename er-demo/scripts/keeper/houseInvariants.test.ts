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
//
// ────────────────────────────────────────────────────────────────────────────────────────────────
// AND A SECOND, MUCH SMALLER SWEEP UNDER `"house-only"` — WHY IT IS COMPLETE RATHER THAN A SHORTCUT
// ────────────────────────────────────────────────────────────────────────────────────────────────
//
// `KEEPER_HOUSE_ONLY_ROUNDS` retires the treasury rule on purpose (see `HOUSE_ONLY_ROUNDS_ENABLED`).
// The sweep above is NOT made conditional on it and NOT weakened by a lamport: it runs under
// `"unfightable"`, which is what every deployment that has not asked for the mode runs, and all six of
// its properties — including "NEVER makes a lobby with no real player in it capable of fighting" — hold
// at all 86,580 shapes exactly as they did before the mode existed. Its cost is unchanged. What is
// added is a second sweep of 330 shapes under the other policy, asserting the INVERSE property.
//
// 330 against 86,580 looks like a sample and is not one. Three facts close the gap, and each of them is
// checked somewhere rather than assumed:
//
//   1. The policy branches on ONE predicate — `realTotal === 0` — and on nothing else
//      (`houseFighterCount`).
//   2. The two policies produce IDENTICAL targets at every shape with a real player in it. That is the
//      agreement lemma in `houseSizing.test.ts`, swept over all 1,225 real-fighter arrangements a
//      forty-eight-seat round can hold, and it is why this file does not re-sweep them.
//   3. `plannedHouseEntries` is a function of that target plus the shape it was handed, and the seat
//      arithmetic below the target does not read the policy at all except through one predicate that
//      is provably `realCount > 0` under `"unfightable"`.
//
// So the only region in which the two sweeps could possibly differ is the empty room — and this file
// sweeps that region EXHAUSTIVELY: every house arrangement the bank can produce, at every ramp
// position. Not a sample of the interesting shapes; all of them.
//
// THE HOUSE LOOPS RUN TO `HOUSE_WALLET_COUNT` HERE WHERE THE SWEEP ABOVE STOPS AT 3, and that is a
// judgement about reachability rather than a budget. Under `"unfightable"` an empty room holds one
// fighter and a room with players in it is bounded by the board, so ten or thirty house fighters
// already standing is not a state the world produces. Under `"house-only"` the board itself runs to
// dozens, so a restart mid-lobby or a partial send genuinely leaves shapes like "thirty house fighters
// standing, badly split" on the table — which is exactly the region where the per-side arithmetic has
// already been wrong once.

import { describe, expect, it } from "vitest";
import { BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";

import type { RawFighter, RawRoundAccount } from "../../src/chain/program.ts";
import {
  HOUSE_ARRIVAL_TAIL_SECONDS, HOUSE_WALLET_COUNT, MIN_FIGHTERS_TO_FIGHT, REAL_PLAYER_GRACE_SECONDS,
  REAL_SEATS_RESERVED,
} from "./config.ts";
import { houseBankFrom, plannedHouseEntries, type HouseBank } from "./houseBank.ts";
import {
  allocateHouseSides, houseFighterCount, type EmptyRoomPolicy, type SideCounts,
} from "./houseSizing.ts";

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

/** `seats` IS A PARAMETER RATHER THAN ALWAYS `SEATS`, AND IT IS THE ONLY INSTRUMENT THIS FILE HAS FOR
 *  THE SEAT RESERVATION. `plannedHouseEntries` reads its seat count off `round.fighters.length` — the
 *  chain's own number, deliberately not a copy — so the padding here is what decides whether the
 *  reservation binds. Defaulted to `SEATS` so the two sweeps are untouched; see the ceiling test below
 *  for the shape that needs the other value and why an env override would not do. */
function roundWith(fighters: RawFighter[], seats: number = SEATS): RawRoundAccount {
  const padded = [...fighters];
  while (padded.length < seats) padded.push(fighter(PublicKey.default, 0));
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

/** THE EMPTY ROOM, EXHAUSTIVELY, which is the only region where the two policies can differ — see the
 *  file header for the three facts that make that a proof rather than a hope.
 *
 *  `r0 = r1 = 0` is not a narrowing, it IS the region. The house loops run to the whole bank rather
 *  than to 3, because under this policy the board runs to dozens and a partially-filled or badly-split
 *  house is a state a restart genuinely leaves behind. */
function everyHouseOnlyShape(): Shape[] {
  const shapes: Shape[] = [];
  for (const ramp of RAMP_POSITIONS) {
    for (let h0 = 0; h0 <= HOUSE_WALLET_COUNT; h0++) {
      for (let h1 = 0; h0 + h1 <= HOUSE_WALLET_COUNT; h1++) {
        shapes.push({ ramp, r0: 0, r1: 0, h0, h1 });
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
  /** The house fighters already standing, PER SIDE. Carried so a property can ask whether the shape it
   *  was handed is one this keeper could have produced itself — a house within the policy's own
   *  allocation — or a skew it is being asked to correct. The two deserve different claims: the first
   *  must land exactly on the target, the second is legitimately allowed above it. */
  houseBeforeSides: SideCounts;
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

function plan({ ramp, r0, r1, h0, h1 }: Shape, emptyRoom: EmptyRoomPolicy): Outcome {
  const seated = [
    ...Array.from({ length: r0 }, () => fighter(realWallet(), 0 as const)),
    ...Array.from({ length: r1 }, () => fighter(realWallet(), 1 as const)),
    ...bank.active.slice(0, h0).map((w) => fighter(w.keypair.publicKey, 0 as const)),
    ...bank.active.slice(h0, h0 + h1).map((w) => fighter(w.keypair.publicKey, 1 as const)),
  ];
  const round = roundWith(seated);
  const { entries } = plannedHouseEntries(bank, round, 7n, whenAt(ramp), { drawAt: CLOSES_AT, emptyRoom });

  const already = new Set(seated.map((f) => f.wallet.toBase58()));
  const picked = entries.map((e) => e.wallet.keypair.publicKey.toBase58());
  const added0 = entries.filter((e) => e.side === 0).length;
  const added1 = entries.length - added0;

  return {
    label: `${emptyRoom}, ramp ${ramp}: ${r0}v${r1} real, ${h0}v${h1} house`,
    ramp,
    realTotal: r0 + r1,
    real: { side0: r0, side1: r1 },
    houseBefore: h0 + h1,
    houseBeforeSides: { side0: h0, side1: h1 },
    planned: entries.length,
    houseAfter: h0 + h1 + entries.length,
    side0After: r0 + h0 + added0,
    side1After: r1 + h1 + added1,
    freeSeatsAfter: SEATS - (r0 + r1 + h0 + h1 + entries.length),
    reusedAWallet: picked.some((k) => already.has(k)),
    duplicatedAWallet: new Set(picked).size !== picked.length,
  };
}

// EXPLICITLY `"unfightable"`, AND NOT BY THE PARAMETER'S DEFAULT. This is the sweep that defends the
// treasury rule, so the policy it defends is named at the call rather than inherited — a default that
// changed would otherwise silently turn this file into a sweep of the other policy while every
// assertion still passed. Written as an arrow rather than `.map(plan)` for the same reason it always
// had to be: `Array.map` passes the INDEX as the second argument.
const outcomes = everyShape().map((shape) => plan(shape, "unfightable"));
const houseOnlyOutcomes = everyHouseOnlyShape().map((shape) => plan(shape, "house-only"));

describe("what the house does to every lobby a round can hold", () => {
  it("sweeps every shape at every ramp position, so a passing run below is a claim about all of them", () => {
    // The numbers are written out rather than derived so that changing any loop has to come here and
    // say what the new sweep covers. 17,316 lobby shapes x 5 points across the arrival window.
    expect(outcomes.length).toBe(86_580);
    expect(new Set(outcomes.map((o) => o.ramp)).size).toBe(RAMP_POSITIONS.length);

    // AND THE SECOND SWEEP, at the default bank of ten: 66 house arrangements — every (h0, h1) with
    // `h0 + h1 <= HOUSE_WALLET_COUNT`, which is (10+1)(10+2)/2 — across the same five ramp positions.
    // It is three orders of magnitude smaller than the sweep above and covers its region completely;
    // the file header is where that claim is argued rather than asserted.
    expect(houseOnlyOutcomes.length).toBe(330);
    expect(new Set(houseOnlyOutcomes.map((o) => o.ramp)).size).toBe(RAMP_POSITIONS.length);
    expect(houseOnlyOutcomes.every((o) => o.realTotal === 0)).toBe(true);
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
    // and waited gets nothing while the round's ~0.0235 SOL of rent sits parked for the retention
    // window. The rent comes back (`Abandoned` is terminal, so `close_round_account` reaches it); the
    // player does not, which is the half of this that was always the expensive half.
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

describe("and what it does to an empty lobby once the operator has asked for house-only rounds", () => {
  // THE MIRROR IMAGE OF THE SWEEP ABOVE. One property is exactly inverted — the room must now BE
  // capable of fighting — and every other one has to survive untouched, because none of them was ever
  // about the treasury rule. If this block and the block above ever agree about the first property,
  // one of them is broken.

  /** The house ceiling this shape is entitled to, re-derived from the policy and the seat reservation
   *  rather than read back out of the planner — the same construction the "whole board in by the end"
   *  property above uses, asked of the other policy. */
  function ceilingFor(o: { realTotal: number }): number {
    return Math.max(0, SEATS - o.realTotal - REAL_SEATS_RESERVED);
  }
  function wantedFor(o: { realTotal: number; real: SideCounts }): number {
    return Math.min(houseFighterCount(o.real, "house-only"), ceilingFor(o));
  }

  it("MAKES a lobby with no real player in it capable of fighting — the exact inverse of the treasury rule", () => {
    // THE NEW PROPERTY, AND THE ONLY ONE THAT IS DIFFERENT. Word for word, the sweep above asserts
    // "NEVER makes a lobby with no real player in it capable of fighting" and this asserts that it
    // does. That is not a contradiction, it is the whole feature: the two run under different policies,
    // in the same process, in the same run, and the operator picks which one their keeper is under.
    //
    // ASSERTED AT THE END OF THE ARRIVAL WINDOW for the same reason its counterpart is — that is "by
    // the time it is drawn", the last instant the planner can still fix anything, and earlier in the
    // window a shape that arrived already skewed is still being corrected.
    //
    // THE EXEMPTION IS NARROWER THAN ITS COUNTERPART'S ABOVE, AND IT HAD TO BE, because the obvious
    // one makes this test assert NOTHING. The sweep above skips a shape at `houseAfter >=
    // HOUSE_WALLET_COUNT` as "no free wallet left to fix it with", which is a rare state under a policy
    // that puts one fighter in an empty room. Under house-only the board runs to the size of the bank,
    // so at the end of the window EVERY shape reaches it — all 66 would have been skipped and this
    // would have been a green test that checked zero lobbies. Measured rather than reasoned about: the
    // first version of this file skipped 66 of 66.
    //
    // What "nothing left to fix it with" actually means is that the planner had no move available: no
    // free SEAT, or a bank already exhausted ONTO ONE SIDE before it was asked — which is genuinely
    // unfixable, since a wallet already fighting cannot be entered again. That is two shapes out of the
    // sixty-six (the whole bank on side 0, and the whole bank on side 1), and the other sixty-four are
    // asserted.
    //
    // WHAT IT COSTS IF IT IS EVER FALSE, AND IT IS NOT WHAT IT LOOKS LIKE. A house-only lobby that
    // reaches its deadline with a bare side IS drawn: `enough_to_fight` is `fighter_count >= 2` and has
    // no opinion about sides, and `close_lobby_and_draw` requires nothing beyond it. So the round is
    // not stuck and its rent is not lost — it settles, sweeps and closes on the ordinary schedule.
    //
    // What it produces instead is a round with NO FIGHT IN IT. `advance_fight` skips every pair whose
    // two fighters share a side, so a one-sided lineup lands zero exchanges however long it ticks;
    // `fight_is_over` is `a == 0 || b == 0` and is therefore true from the first instant, which its own
    // doc comment in lib.rs calls out as deliberate ("such a round contains no fight at all and should
    // be settleable immediately"). Every fighter finishes on the hp they entered with and the occupied
    // side collects the pot. That is a product failure rather than a treasury one, and it is why this
    // property is asserted here rather than left to the rent arithmetic to catch: nothing downstream
    // would ever report it. The mode's expensive edge is a DIFFERENT one — a draw that cannot LAND —
    // and it is priced in `HOUSE_ONLY_ROUNDS_ENABLED`.
    let asserted = 0;
    for (const o of houseOnlyOutcomes) {
      if (o.ramp !== 1) continue;
      const bankExhaustedOntoOneSide = o.houseBefore >= HOUSE_WALLET_COUNT
        && (o.houseBeforeSides.side0 === 0 || o.houseBeforeSides.side1 === 0);
      if (o.freeSeatsAfter === 0 || bankExhaustedOntoOneSide) continue; // nothing left to fix it with
      expect(o.houseAfter, o.label).toBeGreaterThanOrEqual(MIN_FIGHTERS_TO_FIGHT);
      expect(o.side0After, o.label).toBeGreaterThan(0);
      expect(o.side1After, o.label).toBeGreaterThan(0);
      asserted++;
    }
    // AND THE COUNT IS ASSERTED, which is the guard against this test quietly becoming vacuous again.
    // A property whose exemptions can swallow the whole sweep is not a property, and nothing about a
    // passing run would have said so. 64 of the 66 house arrangements; the two skipped are the whole
    // bank standing on one side.
    expect(asserted).toBe(64);
  });

  it("still keeps seats free for players who have not arrived yet", () => {
    // NOT RELAXED, AND IT IS THE ONE THAT MUST NOT BE. A house-only round is the round a visitor is
    // most likely to walk into — these are the rounds that run all day — so the promise that they find
    // a seat rather than `RoundFull` matters MORE here than under the policy that only ever fills a
    // room somebody was already standing in. Same claim, same single documented exception (the cover
    // fighter onto a bare side, which outranks the reservation because an unenterable round is bad and
    // an undrawable one is worse), asked of the other policy.
    //
    // ITS REACH IS MEASURED BUT NOT PINNED TO A LITERAL, unlike the two properties either side of it,
    // and the difference is what the number depends on. 64 and 36 there are structural — arrangements
    // of a bank — so a change that moved them is a change somebody should have to come here and
    // re-endorse. The count here (123 of the 330 when this was written) depends on WHICH shapes the
    // arrival schedule leaves at exactly one planned entry, so pinning it would fire on a re-tuned hash
    // with a message about seat reservations. Neither of these three exemptions can swallow the sweep
    // the way the drawability property's original one did; that is the failure being guarded against,
    // and it is guarded above.
    for (const o of houseOnlyOutcomes) {
      const coveringAnEmptySide = o.planned === 1 && (o.side0After === 1 || o.side1After === 1);
      if (coveringAnEmptySide || o.planned === 0) continue;
      if (o.houseAfter <= MIN_FIGHTERS_TO_FIGHT) continue; // the fightability floor also outranks it
      expect(o.freeSeatsAfter, o.label).toBeGreaterThanOrEqual(REAL_SEATS_RESERVED);
    }
  });

  it("never asks for a seat the round does not have, and never enters a wallet twice", () => {
    // Both unchanged from the sweep above, and both are about the chain rather than about the policy:
    // `enter` answers `RoundFull` past MAX_FIGHTERS, and it is keyed on (wallet, side) — so it would
    // happily let one bot fund both ends of a fight with itself. A mode that filled rooms faster is
    // exactly the mode in which a bug in either would show up first.
    for (const o of houseOnlyOutcomes) {
      expect(o.freeSeatsAfter, o.label).toBeGreaterThanOrEqual(0);
      expect(o.reusedAWallet, o.label).toBe(false);
      expect(o.duplicatedAWallet, o.label).toBe(false);
    }
  });

  it("lands exactly on the board the policy asked for, and never runs away from it", () => {
    // NO RUNAWAY, IN THE STRONGEST FORM THE SHAPE ALLOWS — and it is two claims rather than one,
    // because the sweep deliberately includes arrangements this keeper could not have produced.
    //
    //   A SHAPE THE KEEPER COULD HAVE PRODUCED ITSELF — one whose standing house sits inside the
    //   policy's own per-side allocation — must land EXACTLY on the target by the end of the window.
    //   Not "at most", not "at least": exactly. That is the claim that catches both directions at once,
    //   a board that quietly draws short and a mode that forgets the target and fills the room.
    //
    //   A SKEWED SHAPE — more house fighters on one side than the allocation wants — is legitimately
    //   allowed above the target while it corrects the skew, which is the same carve-out the "whole
    //   board in by the end" property makes above and for the same reason. What binds there is the SEAT
    //   ceiling, plus the single cover fighter that is permitted to reach past it.
    //
    // The target is re-derived from `houseFighterCount(real, "house-only")` and the seat reservation,
    // never read back out of the planner, so this is a claim about the POLICY being satisfied rather
    // than a restatement of whatever the planner did.
    let pinnedExactly = 0;
    for (const o of houseOnlyOutcomes) {
      const wanted = wantedFor(o);
      const allocation = allocateHouseSides(wanted, o.real);
      const wanted0 = allocation.filter((s) => s === 0).length;
      const tidy = o.houseBeforeSides.side0 <= wanted0
        && o.houseBeforeSides.side1 <= wanted - wanted0;

      if (tidy) {
        expect(o.houseAfter, o.label).toBeLessThanOrEqual(wanted);
        if (o.ramp === 1) {
          expect(o.houseAfter, o.label).toBe(wanted);
          pinnedExactly++;
        }
      } else {
        expect(o.houseAfter, o.label).toBeLessThanOrEqual(Math.max(ceilingFor(o), o.houseBefore + 1));
      }
    }
    // The exact-equality branch is the one worth having, so its reach is asserted rather than assumed —
    // 36 of the 66 arrangements are ones this keeper could have produced itself, and every one of them
    // lands on the target to the fighter. Without this line a change that made `tidy` never true would
    // leave a green test asserting only the loose bound.
    expect(pinnedExactly).toBe(36);
  });

  it("holds the house at seats − REAL_SEATS_RESERVED when the reservation binds below the board — the production 39-of-48 case", () => {
    // THE ARITHMETIC THE DOCUMENTATION MADE LOAD-BEARING AND THE SWEEP ABOVE NEVER REACHES. The boot
    // banner, `scripts/keeper/README.md` and `fly.toml` all now quote a house-only round as fielding
    // THIRTY-NINE fighters and not forty-eight, with nine seats standing empty for the whole lobby.
    // That figure is `houseCeiling = seats - REAL_SEATS_RESERVED` winning a `Math.min` against the
    // board — and at this file's configuration it never wins. The sweep runs at the code default
    // `HOUSE_WALLET_COUNT = 10` against `SEATS = 48`, so the ceiling is 39, the board is 10, and the
    // `min` picks the board in all 330 shapes. The ceiling branch is dead code under test, and the
    // number three documents quote ships unexercised.
    //
    // PRODUCTION IS THE OPPOSITE CONFIGURATION, which is the whole reason this matters: `fly.toml`
    // sets 48 wallets and a board of 48 as secrets, so there the ceiling is the ONLY binding term and
    // the board never binds at all. The branch this file cannot reach is the branch every live
    // house-only round is decided by.
    //
    // A SHORT ROUND RATHER THAN AN ENV OVERRIDE, because `config.ts` reads `process.env` at module
    // load and its constants are frozen by the time any test runs — moving them would mean a separate
    // vitest process or a mocked module, and either buys a second configuration of this file that
    // somebody has to keep in step. The seat count needs neither: `plannedHouseEntries` takes it from
    // `round.fighters.length`, the chain's own number rather than a copy, so a twelve-seat round asks
    // the same question a forty-eight-seat round asks under a forty-eight-wallet bank. Twelve seats
    // against a reservation of nine leaves a ceiling of three, which is comfortably below the board of
    // ten, and three is then the only answer the policy can give.
    //
    // Asked of `plannedHouseEntries` directly rather than through `plan`, since threading a seat count
    // through `Shape`, `plan` and `Outcome` would change the two sweeps to serve one example.
    const shortSeats = 12;
    const board = houseFighterCount({ side0: 0, side1: 0 }, "house-only");
    const ceiling = shortSeats - REAL_SEATS_RESERVED;
    // The premise, asserted rather than assumed: if a retuned grace or board ever made the board the
    // smaller term again, this test would silently go back to measuring the board and the ceiling
    // would be untested once more — with nothing to say so.
    expect(ceiling, "the reservation must be the binding term or this test measures the board")
      .toBeLessThan(board);

    const { entries, houseTarget } = plannedHouseEntries(
      bank, roundWith([], shortSeats), 7n, whenAt(1),
      { drawAt: CLOSES_AT, emptyRoom: "house-only" },
    );
    expect(houseTarget).toBe(ceiling);
    expect(entries.length).toBe(ceiling);
    // AND THE NINE SEATS ARE ACTUALLY THERE, which is the promise the figure exists to make. The
    // ceiling is only worth asserting because a visitor who clicks Enter finds a seat; a board that
    // landed on the right number while filling the room would satisfy the line above and break the
    // thing it is for.
    expect(shortSeats - entries.length).toBe(REAL_SEATS_RESERVED);
  });

  it("fills the room gradually here too, because the ramp never knew about the treasury rule", () => {
    // THE PROPERTY THAT FALLS OUT FOR FREE, checked because "for free" is a claim. `house-only` deletes
    // an early return and adds nothing, so the arrival schedule, the side allocation and the stake band
    // all apply to an empty room exactly as they apply to a room somebody walked into. A house-only
    // lobby therefore fills one fighter at a time across the window rather than appearing in a single
    // frame — which is the difference between an arena and a screensaver.
    //
    // Asked of the empty bank only, since that is the shape the keeper actually produces when it opens
    // a round: nothing standing, everything to come.
    const fresh = houseOnlyOutcomes
      .filter((o) => o.houseBefore === 0)
      .sort((a, b) => a.ramp - b.ramp)
      .map((o) => o.houseAfter);
    expect(fresh).toHaveLength(RAMP_POSITIONS.length);
    for (let i = 1; i < fresh.length; i++) {
      expect(fresh[i]!, `board at ramp position ${i}`).toBeGreaterThanOrEqual(fresh[i - 1]!);
    }
    expect(new Set(fresh).size, `distinct board sizes across the window: ${fresh.join(", ")}`)
      .toBeGreaterThanOrEqual(3);
    // And it is drawable from the very first pass, which is the fightability floor doing for a
    // house-only room exactly what it does for a lobby with one real player standing in it.
    expect(fresh[0]!).toBeGreaterThanOrEqual(MIN_FIGHTERS_TO_FIGHT);
  });
});
